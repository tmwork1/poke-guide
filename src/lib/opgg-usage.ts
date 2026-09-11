import { hasSingleBattleData, type EvRankedRow, type RankedRow, type SingleFormatData } from './battle-data-card.ts';
import { normalizeTermName } from './text-normalize.ts';
import pokemonMasterRaw from '../../public/master-data/autocomplete/pokemon.json' with { type: 'json' };

export const OPGG_USAGE_CACHE_TTL = 60 * 60;

interface MasterEntry {
	name: string;
	dexNo: number;
	forme: string | null;
}
const MASTER_LIST = pokemonMasterRaw as MasterEntry[];

export interface OpggUsageSeason {
	id: string;
	label?: string;
	directory: string;
	fetchedAt?: string;
	isCurrent?: boolean;
	collectionMode?: string;
	version: string;
	pokemon?: Array<{ slug: string; name: string }>;
}

export interface OpggUsageSeasonManifest {
	schemaVersion: 2;
	currentSeasonId?: string;
	seasons: OpggUsageSeason[];
}

interface CurrentPointer {
	schemaVersion: 1;
	manifestVersion: string;
	publishedAt: string;
}

export interface OpggUsagePokemon {
	schemaVersion: 3;
	fetchedAt: string;
	name: string;
	formats: { single: SingleFormatData };
}

export interface OpggUsageList {
	schemaVersion: 1;
	fetchedAt: string;
	pokemon: Array<{ slug: string; name: string; single: SingleFormatData }>;
}

export interface OpggUsageBattleDataEntry {
	name: string;
	single: SingleFormatData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCurrentPointer(value: unknown): value is CurrentPointer {
	return isRecord(value) && value.schemaVersion === 1 && typeof value.manifestVersion === 'string';
}

function isSeasonManifest(value: unknown): value is OpggUsageSeasonManifest {
	return isRecord(value) && value.schemaVersion === 2 && Array.isArray(value.seasons);
}

function isUsageList(value: unknown): value is OpggUsageList {
	return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.pokemon);
}

function isUsagePokemon(value: unknown): value is OpggUsagePokemon {
	return isRecord(value) && value.schemaVersion === 3 && typeof value.name === 'string' && isRecord(value.formats);
}

const MASTER_NAMES = new Set(MASTER_LIST.map((entry) => entry.name));

/** リージョンフォーム。OP.GGは接頭辞、マスターデータは括弧の接尾辞で表す。 */
const REGION_FORMS = ['アローラ', 'ガラル', 'ヒスイ', 'パルデア'] as const;

/**
 * OP.GG表記の種族名を、マスターデータ側の表記に読み替える候補を優先順に並べる。
 *
 * 実データで確認できたずれは3種類:
 *   括弧前の空白と接尾辞  「イエッサン (オスのすがた)」→「イエッサン(オス)」
 *   リージョンの前後      「アローラペルシアン」      →「ペルシアン(アローラ)」
 *   マスタ側にフォルム無し 「イッカネズミ (3びきかぞく)」→「イッカネズミ」
 *
 * 規則で決め打ちすると将来別のフォルムを誤変換しうるので、候補を作るだけにして
 * 採用の可否はマスターデータに存在するかどうかで決める(normalizeSpeciesName)。
 */
function speciesNameCandidates(name: string): string[] {
	const candidates = [name];
	const withoutSpace = name.replace(/\s+\(/, '(');
	candidates.push(withoutSpace);
	const parsed = withoutSpace.match(/^(.+?)\((.+)\)$/);
	if (parsed) {
		const [, base, form] = parsed;
		candidates.push(`${base}(${form.replace(/(のすがた|なすがた|フェザー)$/, '')})`);
		candidates.push(base);
	}
	for (const region of REGION_FORMS) {
		if (withoutSpace.startsWith(region) && withoutSpace.length > region.length) {
			candidates.push(`${withoutSpace.slice(region.length)}(${region})`);
		}
	}
	return candidates;
}

/**
 * OP.GG由来の種族名を、マスターデータ(vendor/jpoke由来)の表記へ揃える。
 * どの候補もマスタに無ければ元の表記のまま返す(知らない名前を勝手に変えない)。
 */
export function normalizeSpeciesName(name: string): string {
	const normalized = normalizeTermName(name);
	for (const candidate of speciesNameCandidates(normalized)) {
		if (MASTER_NAMES.has(candidate)) return candidate;
	}
	return normalized;
}

// OP.GGは技名・種族名の数字や英字を全角で表記するため(例:「１０まんボルト」「ＤＤラリアット」)、
// マスターデータ側の表記(半角)に揃えてから返す。種族名はさらにフォルム表記のずれも吸収する。
// 本アプリ内で表示する名称はすべてこの正規化を経由させ、表記揺れを作らない。
function normalizeRankedRows(rows: RankedRow[] | undefined): RankedRow[] | undefined {
	return rows?.map((row) => ({ ...row, name: normalizeTermName(row.name) }));
}

function normalizeSpeciesRankedRows(rows: RankedRow[] | undefined): RankedRow[] | undefined {
	return rows?.map((row) => ({ ...row, name: normalizeSpeciesName(row.name) }));
}

function normalizeSingleFormatData(single: SingleFormatData): SingleFormatData {
	return {
		...single,
		abilities: normalizeRankedRows(single.abilities),
		natures: normalizeRankedRows(single.natures),
		items: normalizeRankedRows(single.items),
		moves: normalizeRankedRows(single.moves),
		// チームメイトは種族名。
		teammates: normalizeSpeciesRankedRows(single.teammates),
	};
}

async function getJson(kv: KVNamespace, key: string): Promise<unknown | null> {
	try {
		return await kv.get(key, { type: 'json', cacheTtl: OPGG_USAGE_CACHE_TTL });
	} catch (error) {
		// astro dev のローカルKVが未投入の場合も、画面は既存の空状態を表示する。
		console.warn(`[opgg-usage] Could not read KV key "${key}":`, error);
		return null;
	}
}

export async function getOpggUsageManifest(kv: KVNamespace): Promise<OpggUsageSeasonManifest | null> {
	const pointer = await getJson(kv, 'current');
	if (!isCurrentPointer(pointer)) return null;

	const manifest = await getJson(kv, `${pointer.manifestVersion}:seasons`);
	if (!isSeasonManifest(manifest)) return null;
	return {
		...manifest,
		seasons: manifest.seasons.map((season) => ({
			...season,
			pokemon: season.pokemon?.map((entry) => ({ ...entry, name: normalizeSpeciesName(entry.name) })),
		})),
	};
}

export async function getOpggUsageList(kv: KVNamespace, season: OpggUsageSeason): Promise<OpggUsageList | null> {
	const list = await getJson(kv, `${season.version}:season:${season.directory}:list`);
	if (!isUsageList(list)) return null;
	return {
		...list,
		pokemon: list.pokemon.map((entry) => ({
			...entry,
			name: normalizeSpeciesName(entry.name),
			single: normalizeSingleFormatData(entry.single),
		})),
	};
}

// /data のSSRと共有APIで同じ種族・ランキング順を使い、遅延描画時に別のカードを対応付けない。
export async function getOpggUsageBattleDataList(
	kv: KVNamespace,
	season: OpggUsageSeason,
): Promise<OpggUsageBattleDataEntry[]> {
	const list = await getOpggUsageList(kv, season);
	if (!list?.pokemon) return [];
	return list.pokemon
		.filter((item) => hasSingleBattleData({ formats: { single: item.single } }))
		.map((item) => ({ name: item.name, single: item.single }));
}

export async function getOpggUsagePokemon(
	kv: KVNamespace,
	season: OpggUsageSeason,
	slug: string,
): Promise<OpggUsagePokemon | null> {
	const pokemon = await getJson(kv, `${season.version}:season:${season.directory}:pokemon:${slug}`);
	if (!isUsagePokemon(pokemon)) return null;
	return {
		...pokemon,
		name: normalizeSpeciesName(pokemon.name),
		formats: { single: normalizeSingleFormatData(pokemon.formats.single) },
	};
}

// マニフェストのシーズン一覧を「現在シーズンを先頭に、以降は取得日時の新しい順」に並べる。
// box/data.astro・data/index.astro・api/opgg-usage.ts で同じ並び順を使う(表示/検索の一貫性のため)。
export function sortOpggSeasons(manifest: OpggUsageSeasonManifest | null): OpggUsageSeason[] {
	const seasons = manifest?.seasons ?? [];
	return [...seasons].sort((a, b) => {
		const currentSeasonId = manifest?.currentSeasonId;
		const aIsCurrent = a.isCurrent || a.id === currentSeasonId;
		const bIsCurrent = b.isCurrent || b.id === currentSeasonId;
		if (aIsCurrent && !bIsCurrent) return -1;
		if (bIsCurrent && !aIsCurrent) return 1;
		return String(b.fetchedAt ?? '').localeCompare(String(a.fetchedAt ?? ''));
	});
}

// OP.GGの使用率データは進化前のベースフォルムでしか集計されない
// (メガシンカは対戦中の行動であり、チーム編成時点の選択肢ではないため)。
// 種族名がメガフォルムの場合は、同じdexNoのベースフォルム(forme: null)名に読み替える。
export function resolveOpggSpeciesName(speciesName: string): string {
	const entry = MASTER_LIST.find((item) => item.name === speciesName);
	if (!entry?.forme?.startsWith('Mega')) return speciesName;
	const base = MASTER_LIST.find((item) => item.dexNo === entry.dexNo && item.forme === null);
	return base?.name ?? speciesName;
}

export type OpggUsageCategory = 'moves' | 'items' | 'abilities' | 'natures' | 'evs';

// わざ/持ち物/特性/性格選択UIの「人気」列用。種族名から、現在(なければ直近)シーズンの
// シングルバトル使用率一覧(指定カテゴリ)を返す。見つからなければnull。
// evsだけ他カテゴリと戻り値の形が異なる(RankedRowではなくEvRankedRow)ため、オーバーロードで
// カテゴリごとに戻り値の型を絞る。
export async function getOpggUsageCategory(
	kv: KVNamespace,
	speciesName: string,
	category: 'evs',
): Promise<EvRankedRow[] | null>;
export async function getOpggUsageCategory(
	kv: KVNamespace,
	speciesName: string,
	category: Exclude<OpggUsageCategory, 'evs'>,
): Promise<RankedRow[] | null>;
export async function getOpggUsageCategory(
	kv: KVNamespace,
	speciesName: string,
	category: OpggUsageCategory,
): Promise<RankedRow[] | EvRankedRow[] | null> {
	const manifest = await getOpggUsageManifest(kv);
	const lookupName = resolveOpggSpeciesName(speciesName);
	for (const season of sortOpggSeasons(manifest)) {
		const slug = season.pokemon?.find((entry) => entry.name === lookupName)?.slug;
		if (!slug) continue;
		const pokemon = await getOpggUsagePokemon(kv, season, slug);
		const rows = pokemon?.formats?.single?.[category];
		if (rows && rows.length > 0) return rows;
	}
	return null;
}

/** バトルデータカード用に、現在(なければ直近)シーズンの全カテゴリをまとめて返す。 */
export async function getOpggUsageSingle(
	kv: KVNamespace,
	speciesName: string,
): Promise<SingleFormatData | null> {
	const manifest = await getOpggUsageManifest(kv);
	const lookupName = resolveOpggSpeciesName(speciesName);
	for (const season of sortOpggSeasons(manifest)) {
		const slug = season.pokemon?.find((entry) => entry.name === lookupName)?.slug;
		if (!slug) continue;
		const single = (await getOpggUsagePokemon(kv, season, slug))?.formats?.single;
		if (single) return single;
	}
	return null;
}
