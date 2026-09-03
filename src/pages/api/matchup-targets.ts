// GET /api/matchup-targets: チーム編集画面の「相性チェック」用の相手候補。
// OP.GG の現行シーズン使用率ランキングと、その採用技データを返す。
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggUsageList, getOpggUsageManifest, sortOpggSeasons } from '../../lib/opgg-usage';
import { resolveDexNo } from '../../lib/species-dex';
import { MATCHUP_TOP_N, type PopularMoveOption } from '../../lib/team-matchup';

export const prerender = false;

const MAX_LIMIT = 50;

interface MatchupTarget {
	speciesName: string;
	dexNo: number | null;
	moves: PopularMoveOption[];
}

const CACHE_HEADERS = {
	'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
};

export async function GET({ url }: APIContext): Promise<Response> {
	const limitParam = url.searchParams.get('limit');
	let limit = MATCHUP_TOP_N;
	if (limitParam !== null) {
		const value = Number(limitParam);
		if (!Number.isInteger(value) || value < 1) return badRequest('limit must be a positive integer');
		limit = Math.min(value, MAX_LIMIT);
	}

	try {
		const season = sortOpggSeasons(await getOpggUsageManifest(env.OPGG_USAGE))[0];
		if (!season) return jsonResponse({ data: [] }, 200, CACHE_HEADERS);

		const seasonList = await getOpggUsageList(env.OPGG_USAGE, season);
		if (!seasonList) return jsonResponse({ data: [] }, 200, CACHE_HEADERS);

		// KV の配列順は OP.GG の使用率ランキング順。
		const data: MatchupTarget[] = seasonList.pokemon.slice(0, limit).map((pokemon) => ({
			speciesName: pokemon.name,
			dexNo: resolveDexNo(pokemon.name),
			moves: (pokemon.single.moves ?? [])
				.filter((move) => move.usageRate !== null)
				.map((move) => ({ value: move.name, ratio: move.usageRate! })),
		}));

		return jsonResponse({ data }, 200, CACHE_HEADERS);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error('[matchup-targets] failed to load OP.GG usage:', error);
		return jsonResponse({ data: [] }, 200, CACHE_HEADERS);
	}
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
