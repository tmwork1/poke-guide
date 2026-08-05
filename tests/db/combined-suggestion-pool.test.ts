// migrations/021_combined_suggestion_pool.sql の検証(実DBに対する統合テスト。
// tests/db/archetypes-lib.test.ts と同じ DATABASE_URL/RUN_DB_TESTS ゲート付きパターン)。
//
// 2026-08-05 のユーザー指示「サジェストの集計元は、本アプリに登録されているデータと
// 過去のランキングデータを(重みづけなしで)合算したプールにする」を、退行しやすい
// 4点に絞って固定する:
//   1. アプリに登録した個体が使用率プールへ入る(合算されている)
//   2. 収集拒否中(008 の collection_opt_out_until)の個体はプールへ入らない
//   3. k-匿名性(既定5)未満の種族は行ごと返らない
//   4. アプリで組んだチームが共起プール(team_partner_species_stats)へ入る
// あわせて、非公開ビューが anon から読めないことも確認する(合算プールには
// owned_pokemon / teams という非公開データが入っているため、ここが崩れると情報漏洩になる)。
//
// 実行方法(ローカルSupabaseスタックが `supabase start` 済み、migrations/021まで適用済みであること):
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   RUN_DB_TESTS=1 node --test tests/db/combined-suggestion-pool.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const shouldRun = RUN_DB_TESTS && !!DATABASE_URL;

// 実データ・他テストと絶対に衝突しない種族名を使う。集計は種族名でGROUP BYするだけなので、
// マスターデータに存在しない名前でも問題なく数えられる。
const TEST_PREFIX = 'combined-pool-test:';
const SPECIES_MANY = `${TEST_PREFIX}多数種`; // k-匿名性を満たす数だけ登録する
const SPECIES_FEW = `${TEST_PREFIX}少数種`; // k-匿名性に満たない数だけ登録する
const SPECIES_OPT_OUT = `${TEST_PREFIX}収集拒否種`;
const SPECIES_PARTNER_A = `${TEST_PREFIX}相棒A`;
const SPECIES_PARTNER_B = `${TEST_PREFIX}相棒B`;

const MIN_SAMPLE = 5;

interface UsageRow {
  regulation: string;
  species_key: string;
  pokemon: number;
  total_pokemon: number;
  team_equivalents: number;
}

describe('migrations/021 の合算プール(combined_species_usage / team_partner_species_stats)', {
  skip: shouldRun
    ? false
    : 'DATABASE_URL/RUN_DB_TESTS が未設定のためスキップ(ローカルSupabaseスタックへのDB接続を伴う統合テスト)',
}, () => {
  let admin: Client;
  const userId = '00000000-0000-4000-8000-0000000c0021';
  const teamIds: string[] = [];

  async function usage(regulation = ''): Promise<Map<string, UsageRow>> {
    const res = await admin.query<UsageRow>(
      'SELECT * FROM combined_species_usage($1, $2)',
      [MIN_SAMPLE, regulation],
    );
    return new Map(res.rows.map((r) => [r.species_key, r]));
  }

  async function insertOwned(speciesName: string, count: number, optOut = false): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const res = await admin.query<{ id: string }>(
        `INSERT INTO owned_pokemon (user_id, species_name, collection_opt_out_until)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, speciesName, optOut ? new Date(Date.now() + 86_400_000).toISOString() : null],
      );
      ids.push(res.rows[0].id);
    }
    return ids;
  }

  before(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      userId,
      'combined-pool-test@example.com',
    ]);
  });

  after(async () => {
    // owned_pokemon / teams / team_members はいずれも auth.users への ON DELETE CASCADE。
    await admin.query('DELETE FROM auth.users WHERE id = $1', [userId]);
    await admin.end();
  });

  it('アプリに登録した個体が横断スコープの使用率プールへ合算される', async () => {
    const before = await usage();
    const baseTotal = before.values().next().value?.total_pokemon ?? 0;

    await insertOwned(SPECIES_MANY, MIN_SAMPLE);

    const after = await usage();
    const row = after.get(SPECIES_MANY);
    assert.ok(row, 'アプリだけに存在する種族が使用率プールに出てくること');
    assert.equal(row.pokemon, MIN_SAMPLE, '1個体1票で数えられること');
    assert.equal(
      row.total_pokemon,
      baseTotal + MIN_SAMPLE,
      '母集団の総個体数もアプリ側の登録分だけ増えること(重みづけなしの単純合算)',
    );
  });

  it('収集拒否中(008)の個体はプールへ入らない', async () => {
    await insertOwned(SPECIES_OPT_OUT, MIN_SAMPLE + 2, true);
    const rows = await usage();
    assert.equal(
      rows.get(SPECIES_OPT_OUT),
      undefined,
      'k-匿名性の閾値を超える件数を登録しても、収集拒否中なら1票も入らないこと',
    );
  });

  it('k-匿名性の閾値未満の種族は行ごと返らない', async () => {
    await insertOwned(SPECIES_FEW, MIN_SAMPLE - 1);
    const rows = await usage();
    assert.equal(rows.get(SPECIES_FEW), undefined, `${MIN_SAMPLE}件未満の種族は出さないこと`);

    // 閾値を1に下げれば同じデータでも出てくる(消えているのが閾値のせいであることの確認)。
    const loose = await admin.query<UsageRow>('SELECT * FROM combined_species_usage($1, $2)', [1, '']);
    const row = loose.rows.find((r) => r.species_key === SPECIES_FEW);
    assert.equal(row?.pokemon, MIN_SAMPLE - 1);
  });

  it('レギュレーション未設定の個体は横断スコープにだけ入る(013/014と同じ規則)', async () => {
    const cross = await usage('');
    const scoped = await usage('M-A');
    assert.ok(cross.get(SPECIES_MANY), '横断スコープには入ること');
    assert.equal(scoped.get(SPECIES_MANY), undefined, 'レギュレーション別スコープには入らないこと');
  });

  it('アプリで組んだチームが共起プールへ入る', async () => {
    // 2体以上のチームだけが共起プールへ入る(021: 1体のチームはペアを作れないため)。
    const [a] = await insertOwned(SPECIES_PARTNER_A, 1);
    const [b] = await insertOwned(SPECIES_PARTNER_B, 1);
    const [a2] = await insertOwned(SPECIES_PARTNER_A, 1);
    const [b2] = await insertOwned(SPECIES_PARTNER_B, 1);

    for (const pair of [[a, b], [a2, b2]]) {
      const team = await admin.query<{ id: string }>(
        'INSERT INTO teams (user_id, name) VALUES ($1, $2) RETURNING id',
        [userId, `${TEST_PREFIX}チーム`],
      );
      teamIds.push(team.rows[0].id);
      for (const [slot, ownedId] of pair.entries()) {
        await admin.query(
          'INSERT INTO team_members (team_id, user_id, owned_pokemon_id, slot) VALUES ($1, $2, $3, $4)',
          [team.rows[0].id, userId, ownedId, slot + 1],
        );
      }
    }

    // p_min_candidate_teams は既定5だが、テストデータは2チームしか作らないので1へ下げる。
    // 検証したいのは「アプリのチームが母集団に入っているか」であって閾値そのものではない。
    const res = await admin.query<{ candidate_species: string; co_teams: number; total_teams: number }>(
      'SELECT * FROM team_partner_species_stats($1, $2, $3)',
      [[SPECIES_PARTNER_A], 2, 1],
    );
    const hit = res.rows.find((r) => r.candidate_species === SPECIES_PARTNER_B);
    assert.ok(hit, 'アプリのチームで組んだ2体が共起として拾われること');
    assert.equal(hit.co_teams, 2, '同居した2チームが1チーム1票で数えられること');
  });

  it('合算プールの非公開ビューは anon から読めない', async () => {
    const views = [
      'combined_team_species',
      'combined_team_archetypes',
      'app_team_species',
      'app_team_archetypes',
      'combined_archetype_modal_ability',
    ];
    for (const view of views) {
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE anon');
      await assert.rejects(
        () => admin.query(`SELECT 1 FROM ${view} LIMIT 1`),
        /permission denied/,
        `${view} は anon に公開してはいけない(owned_pokemon / teams を含むため)`,
      );
      await admin.query('ROLLBACK');
    }
  });
});
