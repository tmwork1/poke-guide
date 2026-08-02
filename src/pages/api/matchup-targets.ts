// GET /api/matchup-targets: チーム編集画面の「相性チェック」(ユーザー要望、2026-08-02)が
// 相手にする「使用率上位N体」と、その採用技を返す。
//
// ■ 何を返すか
// 上位入賞チーム(ranked_teams、010/011)での採用チーム数が多い順に N 体。各体について、
// 集計済みの採用技(suggestions.kind='popular_move'、009/014)を採用率つきでそのまま渡す。
// 「攻撃技だけを上位4つ」に絞る判断はクライアント側(src/lib/team-matchup.ts の
// pickOpponentAttackMoves)が行う ── 技が攻撃技かどうかの判定に必要な
// public/master-data/detail/moves.json(103KB)はクライアントが既に読み込んでおり
// (loadMoveDetailMap)、Worker 側へ持ち込む理由が無いため。
//
// ■ 認証は不要
// 参照するのは ranked_* / suggestions という公開集計データだけで、ユーザー個別の情報は
// 一切扱わない。既存の GET /api/suggestions と同じく anon クライアント(RLSの公開読み取り
// ポリシー経由)で読む(最小権限の原則)。
//
// ■ レギュレーションでは絞らない
// ranked_species_usage()(016)はシーズン横断の採用数しか返さず、レギュレーション別の
// 採用率は集計されていない(suggestions 側には '種族|M-A' のスコープがあるが、
// 「上位N体は誰か」を決める側には無い)。ユーザー指示にもレギュレーション別の要求は無いため、
// ここでは横断の採用率で上位N体を決める(将来レギュレーション別にするなら 016 に
// 引数つきの関数を足す必要がある)。
import type { APIContext } from 'astro';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getSupabasePublicClient } from '../../lib/supabase';
import { resolveDexNo } from '../../lib/species-dex';
import { MATCHUP_TOP_N, type PopularMoveOption } from '../../lib/team-matchup';

export const prerender = false;

// 上限。相性チェックは1体につき「チーム6体 × 技4本」のダメージ計算をブラウザ内 Pyodide で
// 走らせるため、体数がそのまま計算時間に効く。UI が要求するのは20体で、その2倍強を上限とする。
const MAX_LIMIT = 50;

interface MatchupTarget {
	speciesName: string;
	dexNo: number | null;
	/** その種族を採用していた上位入賞チーム数 */
	usageTeams: number;
	/** 母集団(上位入賞チームの総数) */
	totalTeams: number;
	/**
	 * 採用技と採用率(降順)。集計の母数が min_sample_size(既定5)に満たない種族では
	 * 空配列になる ── 「技のデータが無い」であって「技が無い」ではないので、UI 側は
	 * 防御側の計算をスキップして「データなし」と示す。
	 */
	moves: PopularMoveOption[];
}

interface RankedSpeciesUsageRow {
	species_key: string;
	teams: number;
	total_teams: number;
}

interface PopularMovePayload {
	sample_size: number;
	options: { value: string; count: number; ratio: number }[];
}

export async function GET({ url }: APIContext): Promise<Response> {
	const limitParam = url.searchParams.get('limit');
	let limit = MATCHUP_TOP_N;
	if (limitParam !== null) {
		const value = Number(limitParam);
		if (!Number.isInteger(value) || value < 1) return badRequest('limit must be a positive integer');
		limit = Math.min(value, MAX_LIMIT);
	}

	const supabase = await getSupabasePublicClient();

	const { data: usageData, error: usageError } = await supabase.rpc('ranked_species_usage');
	if (usageError) {
		// eslint-disable-next-line no-console
		console.error('[matchup-targets] ranked_species_usage failed:', usageError);
		return jsonResponse({ error: 'Failed to load matchup targets' }, 500);
	}

	const usage = ((usageData ?? []) as RankedSpeciesUsageRow[])
		.slice()
		// 採用数の降順。同数のときは種族名で決めて、リクエストごとに順位が入れ替わらないようにする
		// (ranked_species_usage() は GROUP BY だけで ORDER BY を持たないため、順序は保証されない)。
		.sort((a, b) => b.teams - a.teams || a.species_key.localeCompare(b.species_key, 'ja'))
		.slice(0, limit);

	if (usage.length === 0) {
		return jsonResponse({ data: [], meta: { totalTeams: 0 } }, 200);
	}

	const speciesKeys = usage.map((u) => u.species_key);
	const { data: moveData, error: moveError } = await supabase
		.from('suggestions')
		.select('subject_key, payload')
		.eq('kind', 'popular_move')
		.in('subject_key', speciesKeys);
	if (moveError) {
		// eslint-disable-next-line no-console
		console.error('[matchup-targets] popular_move lookup failed:', moveError);
		return jsonResponse({ error: 'Failed to load matchup targets' }, 500);
	}

	const movesBySpecies = new Map<string, PopularMoveOption[]>();
	for (const row of (moveData ?? []) as { subject_key: string; payload: PopularMovePayload }[]) {
		const options = (row.payload?.options ?? []).map((o) => ({ value: o.value, ratio: Number(o.ratio) }));
		movesBySpecies.set(row.subject_key, options);
	}

	const data: MatchupTarget[] = usage.map((u) => ({
		speciesName: u.species_key,
		dexNo: resolveDexNo(u.species_key),
		usageTeams: u.teams,
		totalTeams: u.total_teams,
		moves: movesBySpecies.get(u.species_key) ?? [],
	}));

	return jsonResponse({ data, meta: { totalTeams: usage[0]?.total_teams ?? 0 } }, 200);
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
