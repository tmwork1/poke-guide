// GET /api/matchup-targets: チーム編集画面の「相性チェック」用の相手候補。
// OP.GG の現行シーズン使用率ランキングと、その採用技データを返す。
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggUsageList, getOpggUsageManifest, sortOpggSeasons } from '../../lib/opgg-usage';
import { resolveDexNo } from '../../lib/species-dex';
import {
	expandMatchupTargetForms,
	MATCHUP_TARGET_LIMIT,
	MATCHUP_TOP_N,
	opponentEvsFromOpgg,
	type MatchupMegaForm,
	type MatchupTargetForm,
	type PopularMoveOption,
} from '../../lib/team-matchup';
import megaStonesRaw from '../../../public/master-data/autocomplete/mega-stones.json';
import pokemonMasterRaw from '../../../public/master-data/autocomplete/pokemon.json';

export const prerender = false;

const MAX_LIMIT = MATCHUP_TARGET_LIMIT;

interface MatchupTarget {
	speciesName: string;
	dexNo: number | null;
	moves: PopularMoveOption[];
	/** 相手の想定個体。いずれも OP.GG の採用率1位で、データが無ければ null(呼び出し側が既定値へ退避)。 */
	abilityName: string | null;
	nature: string | null;
	evs: number[] | null;
	forms: MatchupTargetForm[];
}

interface PokemonMasterEntry {
	name: string;
	dexNo: number;
	forme: string | null;
}

interface MegaStoneEntry {
	species: string;
	item: string;
}

const MASTER_LIST = pokemonMasterRaw as PokemonMasterEntry[];
const MEGA_STONE_BY_SPECIES = new Map(
	(megaStonesRaw as MegaStoneEntry[]).map((entry) => [entry.species, entry.item]),
);

function megaFormsForDexNo(dexNo: number | null): MatchupMegaForm[] {
	if (dexNo === null) return [];
	return MASTER_LIST.flatMap((entry) => {
		if (!entry.forme?.startsWith('Mega')) return [];
		if (entry.dexNo !== dexNo) return [];
		const megaStoneName = MEGA_STONE_BY_SPECIES.get(entry.name);
		return megaStoneName ? [{ speciesName: entry.name, dexNo: entry.dexNo, megaStoneName }] : [];
	});
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
		const data: MatchupTarget[] = seasonList.pokemon.slice(0, limit).map((pokemon) => {
			const dexNo = resolveDexNo(pokemon.name);
			const baseForm = { speciesName: pokemon.name, dexNo };
			return {
				...baseForm,
				// 採用率順に並んだ配列の先頭が1位(getOpggUsageList は並びを変えない)。
				abilityName: pokemon.single.abilities?.[0]?.name ?? null,
				nature: pokemon.single.natures?.[0]?.name ?? null,
				evs: opponentEvsFromOpgg(pokemon.single.evs?.[0]?.values),
				moves: (pokemon.single.moves ?? [])
					.filter((move) => move.usageRate !== null)
					.map((move) => ({ value: move.name, ratio: move.usageRate! })),
				forms: expandMatchupTargetForms(baseForm, megaFormsForDexNo(dexNo), pokemon.single.items),
			};
		});

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
