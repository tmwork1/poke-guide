import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getOpggUsageManifest, getOpggUsageList, getOpggUsagePokemon } from '../src/lib/opgg-usage.ts';

function fakeKv(store: Record<string, unknown>): KVNamespace {
	return {
		get: async (key: string) => store[key] ?? null,
	} as unknown as KVNamespace;
}

describe('OP.GG使用率データの全角数字を半角へ正規化する', () => {
	it('getOpggUsageManifest: season.pokemonのnameを半角化する', async () => {
		const kv = fakeKv({
			current: { schemaVersion: 1, manifestVersion: 'v1', publishedAt: '2026-01-01' },
			'v1:seasons': {
				schemaVersion: 2,
				seasons: [
					{
						id: 's1',
						directory: 'dir',
						version: 'v1',
						pokemon: [{ slug: 'raichu', name: 'ライチュウ' }, { slug: 'porygon2', name: 'ポリゴン２' }],
					},
				],
			},
		});
		const manifest = await getOpggUsageManifest(kv);
		assert.equal(manifest?.seasons[0]?.pokemon?.[1]?.name, 'ポリゴン2');
	});

	it('getOpggUsageList: pokemon[].name と single配下のRankedRow.nameを半角化する', async () => {
		const kv = fakeKv({
			'v1:season:dir:list': {
				schemaVersion: 1,
				fetchedAt: '2026-01-01',
				pokemon: [
					{
						slug: 'raichu',
						name: 'ライチュウ',
						single: { moves: [{ rank: 1, name: '１０まんボルト', usageRate: 50 }] },
					},
				],
			},
		});
		const season = { id: 's1', directory: 'dir', version: 'v1' };
		const list = await getOpggUsageList(kv, season);
		assert.equal(list?.pokemon[0]?.single.moves?.[0]?.name, '10まんボルト');
	});

	it('getOpggUsagePokemon: formats.single配下の各カテゴリのnameを半角化する', async () => {
		const kv = fakeKv({
			'v1:season:dir:pokemon:raichu': {
				schemaVersion: 3,
				fetchedAt: '2026-01-01',
				name: 'ライチュウ',
				formats: {
					single: {
						moves: [{ rank: 1, name: '１０まんボルト', usageRate: 50 }],
						teammates: [{ rank: 1, name: 'ポリゴン２', usageRate: 10 }],
					},
				},
			},
		});
		const season = { id: 's1', directory: 'dir', version: 'v1' };
		const pokemon = await getOpggUsagePokemon(kv, season, 'raichu');
		assert.equal(pokemon?.formats.single.moves?.[0]?.name, '10まんボルト');
		assert.equal(pokemon?.formats.single.teammates?.[0]?.name, 'ポリゴン2');
	});
});
