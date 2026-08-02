// src/lib/archetypes.ts (findOrCreateArchetype) を実DBに対して検証する統合テスト
// (tests/db/owned-pokemon-lib.test.ts と同じ DATABASE_URL/SUPABASE_URL/SUPABASE_SECRET_KEY/
// RUN_DB_TESTS ゲート付きパターン)。
//
// archetypes は非個人情報の公開マスターデータ(migrations/015_archetypes.sql)のため、
// owned-pokemon-lib.test.ts のような userId 分離の検証は不要。ここでは
// 「同一キーの再呼び出しで重複作成されないこと」「キーの一部が違えば別行になること」
// 「同時呼び出しでも同一idに収束すること(23505再試行のカバレッジ)」を検証する。
//
// 実行方法(ローカルSupabaseスタックが `supabase start` 済み、migrations/015まで適用済みであること):
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_SECRET_KEY=<ローカルのservice_roleキー> \
//   RUN_DB_TESTS=1 node --test tests/db/archetypes-lib.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { findOrCreateArchetype } from '../../src/lib/archetypes.ts';
import type { ArchetypeKey } from '../../src/lib/archetype.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const shouldRun = RUN_DB_TESTS && !!DATABASE_URL && !!SUPABASE_URL && !!SUPABASE_SECRET_KEY;

// 他のテスト・実データと衝突しない専用の接頭辞を種族名に付けて、after()でまとめて掃除できるようにする。
const TEST_PREFIX = 'archetypes-lib-test:';

function makeKey(overrides: Partial<ArchetypeKey> = {}): ArchetypeKey {
  return {
    speciesName: `${TEST_PREFIX}種族A`,
    abilityName: 'テスト特性',
    itemName: 'テストアイテム',
    role: 'physical_attacker',
    ...overrides,
  };
}

describe('src/lib/archetypes.ts の findOrCreateArchetype', {
  skip: shouldRun
    ? false
    : 'DATABASE_URL/SUPABASE_URL/SUPABASE_SECRET_KEY/RUN_DB_TESTS が未設定のためスキップ(ローカルSupabaseスタックへのDB接続を伴う統合テスト)',
}, () => {
  let admin: Client;
  let supabase: SupabaseClient;

  before(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    supabase = createClient(SUPABASE_URL as string, SUPABASE_SECRET_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  after(async () => {
    await admin.query('DELETE FROM archetypes WHERE species_name LIKE $1', [`${TEST_PREFIX}%`]);
    await admin.end();
  });

  it('初回呼び出しで新規行が作成されidが返る', async () => {
    const result = await findOrCreateArchetype(makeKey(), supabase);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(typeof result.data, 'string');
  });

  it('同一キーでの再呼び出しは既存行のidを返し、行が重複作成されない', async () => {
    const key = makeKey({ speciesName: `${TEST_PREFIX}種族B` });
    const first = await findOrCreateArchetype(key, supabase);
    const second = await findOrCreateArchetype(key, supabase);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.data, second.data);

    const { rows } = await admin.query(
      'SELECT count(*) FROM archetypes WHERE species_name = $1 AND ability_name = $2 AND item_name = $3 AND role = $4',
      [key.speciesName, key.abilityName, key.itemName, key.role],
    );
    assert.equal(Number(rows[0].count), 1);
  });

  it('role/ability_name/item_nameのいずれかが異なれば別行になる', async () => {
    const speciesName = `${TEST_PREFIX}種族C`;
    const base = await findOrCreateArchetype(makeKey({ speciesName }), supabase);
    const differentRole = await findOrCreateArchetype(
      makeKey({ speciesName, role: 'bulky' }),
      supabase,
    );
    const differentAbility = await findOrCreateArchetype(
      makeKey({ speciesName, abilityName: '別の特性' }),
      supabase,
    );
    assert.equal(base.ok && differentRole.ok && differentAbility.ok, true);
    if (!base.ok || !differentRole.ok || !differentAbility.ok) return;
    assert.notEqual(base.data, differentRole.data);
    assert.notEqual(base.data, differentAbility.data);
    assert.notEqual(differentRole.data, differentAbility.data);
  });

  it('同一キーへの同時呼び出しでも同一idに収束する(unique制約違反の再試行カバレッジ)', async () => {
    const key = makeKey({ speciesName: `${TEST_PREFIX}種族D` });
    const results = await Promise.all([
      findOrCreateArchetype(key, supabase),
      findOrCreateArchetype(key, supabase),
      findOrCreateArchetype(key, supabase),
    ]);
    assert.equal(
      results.every((r) => r.ok),
      true,
    );
    const ids = results.map((r) => (r.ok ? r.data : null));
    assert.equal(new Set(ids).size, 1);

    const { rows } = await admin.query(
      'SELECT count(*) FROM archetypes WHERE species_name = $1 AND ability_name = $2 AND item_name = $3 AND role = $4',
      [key.speciesName, key.abilityName, key.itemName, key.role],
    );
    assert.equal(Number(rows[0].count), 1);
  });
});
