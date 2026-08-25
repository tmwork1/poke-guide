import type { SingleFormatData } from './battle-data-card';

export const OPGG_USAGE_CACHE_TTL = 60 * 60;

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
	return isSeasonManifest(manifest) ? manifest : null;
}

export async function getOpggUsageList(kv: KVNamespace, season: OpggUsageSeason): Promise<OpggUsageList | null> {
	const list = await getJson(kv, `${season.version}:season:${season.directory}:list`);
	return isUsageList(list) ? list : null;
}

export async function getOpggUsagePokemon(
	kv: KVNamespace,
	season: OpggUsageSeason,
	slug: string,
): Promise<OpggUsagePokemon | null> {
	const pokemon = await getJson(kv, `${season.version}:season:${season.directory}:pokemon:${slug}`);
	return isUsagePokemon(pokemon) ? pokemon : null;
}
