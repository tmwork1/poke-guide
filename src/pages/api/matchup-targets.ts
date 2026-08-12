// GET /api/matchup-targets: チーム編集画面の「相性チェック」が相手にする
// 「使用率上位N体」と、その採用技を返す。
//
// ■ 何を返すか
// 合算プール(アプリに登録された個体 + 上位入賞チームの個体、migrations/021)での採用数が
// 多い順に N 体。各体について、集計済みの採用技(suggestions.kind='popular_move'、009/014)を
// 採用率つきでそのまま渡す。採用技(popular_move)も同じ合算プールから集計されている
// (011)ため、採用数(usageTeams)の母集団と一致する。
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
// combined_species_usage() はレギュレーション別のスコープも返せる(021)が、ここでは
// 横断スコープ(p_regulation = '')で上位N体を決める。レギュレーション別にしたくなったら
// 引数を差し替えるだけでよい。
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
	/** その種族の採用数(合算プール内の個体数。ランキング側では採用チーム数と一致する) */
	usageTeams: number;
	/** 母集団のチーム相当数(ランキングの実チーム数 + アプリ個体数 ÷ 6。migrations/021) */
	totalTeams: number;
	/**
	 * 採用技と採用率(降順)。集計の母数が min_sample_size(既定5)に満たない種族では
	 * 空配列になる ── 「技のデータが無い」であって「技が無い」ではないので、UI 側は
	 * 防御側の計算をスキップして「データなし」と示す。
	 */
	moves: PopularMoveOption[];
}

interface CombinedSpeciesUsageRow {
	regulation: string;
	species_key: string;
	pokemon: number;
	total_pokemon: number;
	team_equivalents: number;
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

	const { data: usageData, error: usageError } = await supabase.rpc('combined_species_usage', {
		p_regulation: '',
	});
	if (usageError) {
		// eslint-disable-next-line no-console
		console.error('[matchup-targets] combined_species_usage failed:', usageError);
		return jsonResponse({ error: 'Failed to load matchup targets' }, 500);
	}

	const usage = ((usageData ?? []) as CombinedSpeciesUsageRow[])
		.slice()
		// 採用数の降順。同数のときは種族名で決めて、リクエストごとに順位が入れ替わらないようにする
		// (combined_species_usage() は GROUP BY だけで ORDER BY を持たないため、順序は保証されない)。
		.sort((a, b) => b.pokemon - a.pokemon || a.species_key.localeCompare(b.species_key, 'ja'))
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
		usageTeams: u.pokemon,
		totalTeams: u.team_equivalents,
		moves: movesBySpecies.get(u.species_key) ?? [],
	}));

	return jsonResponse({ data, meta: { totalTeams: usage[0]?.team_equivalents ?? 0 } }, 200);
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
