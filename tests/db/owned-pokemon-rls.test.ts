// owned_pokemon / opponent_notes の RLS ポリシー実地テスト (migrations/004・005)。
//
// 本人以外のユーザーが他人の owned_pokemon/opponent_notes 行を閲覧・編集・削除できないことを
// 実際のPostgres(RLS込み)に対して検証する。既存の tests/*.test.ts はいずれもDB接続を伴わない
// 純粋関数のバリデーションテストだが、これはRLSポリシーという「DBそのものの挙動」を検証する
// 性質上、実DB接続が必須となる。
//
// 実行方法:
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres RUN_DB_TESTS=1 \
//     node --test tests/db/owned-pokemon-rls.test.ts
// (migrations/001〜005 が適用済みのDBに対して実行すること。CIの `migrations` ジョブでは
//  `npm run migrate` 実行後に自動実行される。DATABASE_URL/RUN_DB_TESTS が未設定の場合は、
//  誤って開発者のローカルSupabase等に対して実行してしまう事故を防ぐため、このテストはスキップ
//  される)
//
// CIのマイグレーション検証(Stub Supabase auth schema)が用意する auth.uid() は常にNULLを返す
// 簡易スタブ(DDL検証専用)のため、RLSの実挙動を検証するにはユーザーごとに戻り値を切り替えられる
// 実装が必要。本テストではSupabase本番の実装と同じ「GUC (request.jwt.claims) を読む」方式に
// auth.uid() を上書きしてから検証する。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const shouldRun = RUN_DB_TESTS && !!DATABASE_URL;

describe('owned_pokemon / opponent_notes の RLS (本人限定ポリシー)', { skip: shouldRun ? false : 'DATABASE_URL/RUN_DB_TESTS が未設定のためスキップ(DB接続を伴う統合テスト。CIのmigrationsジョブでのみ実行)' }, () => {
  let admin: Client;
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  let ownedPokemonId: string;
  let opponentNoteId: string;

  async function clientAs(userId: string | null): Promise<Client> {
    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    await c.query('SET ROLE authenticated');
    if (userId) {
      // 実Supabase(PostgREST)がリクエストごとに設定するGUCと同じキーを使う。
      await c.query("SELECT set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: userId }),
      ]);
    }
    return c;
  }

  // migrations/006 で追加された owned_pokemon_select_public ポリシー(is_public = true の行を
  // anon/authenticated に公開)と、anonロールへの新規GRANT SELECTを検証するためのヘルパー。
  // 実際のPostgREST未認証リクエストと同じく、認証GUC(request.jwt.claims)は一切設定しない。
  async function clientAsAnon(): Promise<Client> {
    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    await c.query('SET ROLE anon');
    return c;
  }

  before(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();

    // CIの「Stub Supabase auth schema」ステップが用意する auth.uid() は常にNULLを返す
    // DDL検証専用スタブのため、ここでは実Supabaseと同じGUCベースの実装に差し替える。
    //
    // ただし実際のSupabase(ローカルDocker版・本番とも)では auth スキーマは supabase_admin が
    // 所有し、postgres ロールはスーパーユーザーではない(実機検証で判明。hosted Supabaseの権限
    // モデルをローカルでも忠実に再現しているため)。そのため postgres 接続では
    // `CREATE OR REPLACE FUNCTION auth.uid()` 自体が `permission denied for schema auth`
    // (42501) で拒否される。もっとも実際のSupabaseにはこの関数と全く同じGUCベースの実装が
    // 最初から入っているため、この差し替えは「auth.uid()がまだ用意されていないCIスタブでのみ
    // 必要な処置」であり、実Supabaseに対しては権限エラーを許容してそのままスキップしてよい。
    try {
      await admin.query(`
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
        LANGUAGE sql STABLE AS $$
          SELECT COALESCE(
            NULLIF(current_setting('request.jwt.claim.sub', true), ''),
            (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          )::uuid
        $$;
      `);
    } catch (error) {
      if ((error as { code?: string }).code !== '42501') {
        throw error;
      }
    }

    await admin.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
      userA,
      'rls-test-user-a@example.com',
      userB,
      'rls-test-user-b@example.com',
    ]);
  });

  after(async () => {
    // owned_pokemon/opponent_notesはON DELETE CASCADEでauth.usersの削除に追従して消える。
    await admin.query('DELETE FROM auth.users WHERE id IN ($1, $2)', [userA, userB]);
    await admin.end();
  });

  it('userAは自分のowned_pokemonをINSERT/SELECTできる', async () => {
    const asA = await clientAs(userA);
    try {
      const insertRes = await asA.query(
        'INSERT INTO owned_pokemon (user_id, species_name) VALUES ($1, $2) RETURNING id',
        [userA, 'ピカチュウ'],
      );
      ownedPokemonId = insertRes.rows[0].id;

      const selectRes = await asA.query('SELECT * FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(selectRes.rowCount, 1);
      assert.equal(selectRes.rows[0].species_name, 'ピカチュウ');
    } finally {
      await asA.end();
    }
  });

  it('userBは他人のuser_idを騙ってowned_pokemonをINSERTできない(WITH CHECK違反)', async () => {
    const asB = await clientAs(userB);
    try {
      await assert.rejects(() =>
        asB.query('INSERT INTO owned_pokemon (user_id, species_name) VALUES ($1, $2)', [userA, 'コイキング']),
      );
    } finally {
      await asB.end();
    }
  });

  it('userBはuserAのowned_pokemonをSELECTできない(0件)', async () => {
    const asB = await clientAs(userB);
    try {
      const res = await asB.query('SELECT * FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rowCount, 0);
    } finally {
      await asB.end();
    }
  });

  it('userBはuserAのowned_pokemonをUPDATEできない(0件更新)', async () => {
    const asB = await clientAs(userB);
    try {
      const res = await asB.query('UPDATE owned_pokemon SET species_name = $1 WHERE id = $2', ['乗っ取り', ownedPokemonId]);
      assert.equal(res.rowCount, 0);
    } finally {
      await asB.end();
    }

    // 実際に更新されていないことをuserA視点でも確認する。
    const asA = await clientAs(userA);
    try {
      const res = await asA.query('SELECT species_name FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rows[0].species_name, null);
    } finally {
      await asA.end();
    }
  });

  it('userBはuserAのowned_pokemonをDELETEできない(0件削除)', async () => {
    const asB = await clientAs(userB);
    try {
      const res = await asB.query('DELETE FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rowCount, 0);
    } finally {
      await asB.end();
    }

    const asA = await clientAs(userA);
    try {
      const res = await asA.query('SELECT id FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rowCount, 1);
    } finally {
      await asA.end();
    }
  });

  it('未認証(auth.uid()がNULL)ではowned_pokemonへアクセスできない', async () => {
    const asAnon = await clientAs(null);
    try {
      const res = await asAnon.query('SELECT * FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rowCount, 0);
    } finally {
      await asAnon.end();
    }
  });

  it('is_public = true の行はanonロール(認証GUCなし)からSELECTできる(migrations/006の公開共有ポリシー)', async () => {
    const asA = await clientAs(userA);
    let publicOwnedPokemonId: string;
    try {
      const insertRes = await asA.query(
        "INSERT INTO owned_pokemon (user_id, species_name, is_public, share_slug) VALUES ($1, $2, true, $3) RETURNING id",
        [userA, 'コイキング', `anon-rls-test-${crypto.randomUUID()}`],
      );
      publicOwnedPokemonId = insertRes.rows[0].id;
    } finally {
      await asA.end();
    }

    const asAnon = await clientAsAnon();
    try {
      const res = await asAnon.query('SELECT * FROM owned_pokemon WHERE id = $1', [publicOwnedPokemonId]);
      assert.equal(res.rowCount, 1);
      assert.equal(res.rows[0].species_name, 'コイキング');
      assert.equal(res.rows[0].is_public, true);
    } finally {
      await asAnon.end();
    }
  });

  it('is_public = false の他人の行はanonロールからSELECTできない(anonへのGRANT追加で誤って全開放していないことの回帰確認)', async () => {
    const asAnon = await clientAsAnon();
    try {
      // ownedPokemonId は is_public のデフォルト値(false)のまま(この時点ではまだ削除されていない)。
      const res = await asAnon.query('SELECT * FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rowCount, 0);
    } finally {
      await asAnon.end();
    }
  });

  it('userAは自分のowned_pokemonに紐づくopponent_notesをINSERT/SELECTできる', async () => {
    const asA = await clientAs(userA);
    try {
      const insertRes = await asA.query(
        'INSERT INTO opponent_notes (owned_pokemon_id, user_id, move_name) VALUES ($1, $2, $3) RETURNING id',
        [ownedPokemonId, userA, 'でんきショック'],
      );
      opponentNoteId = insertRes.rows[0].id;

      const selectRes = await asA.query('SELECT * FROM opponent_notes WHERE id = $1', [opponentNoteId]);
      assert.equal(selectRes.rowCount, 1);
    } finally {
      await asA.end();
    }
  });

  it('userBは他人のuser_idを騙ってopponent_notesをINSERTできない(WITH CHECK違反)', async () => {
    const asB = await clientAs(userB);
    try {
      await assert.rejects(() =>
        asB.query(
          'INSERT INTO opponent_notes (owned_pokemon_id, user_id, move_name) VALUES ($1, $2, $3)',
          [ownedPokemonId, userA, 'たいあたり'],
        ),
      );
    } finally {
      await asB.end();
    }
  });

  it('userBはuserAのopponent_notesをSELECT/UPDATE/DELETEできない', async () => {
    const asB = await clientAs(userB);
    try {
      const sel = await asB.query('SELECT * FROM opponent_notes WHERE id = $1', [opponentNoteId]);
      assert.equal(sel.rowCount, 0);

      const upd = await asB.query('UPDATE opponent_notes SET memo = $1 WHERE id = $2', ['乗っ取りメモ', opponentNoteId]);
      assert.equal(upd.rowCount, 0);

      const del = await asB.query('DELETE FROM opponent_notes WHERE id = $1', [opponentNoteId]);
      assert.equal(del.rowCount, 0);
    } finally {
      await asB.end();
    }
  });

  it('userAは自分のowned_pokemon/opponent_notesを削除でき、opponent_notesはCASCADEで消える', async () => {
    const asA = await clientAs(userA);
    try {
      const res = await asA.query('DELETE FROM owned_pokemon WHERE id = $1', [ownedPokemonId]);
      assert.equal(res.rowCount, 1);

      const noteRes = await asA.query('SELECT id FROM opponent_notes WHERE id = $1', [opponentNoteId]);
      assert.equal(noteRes.rowCount, 0);
    } finally {
      await asA.end();
    }
  });
});
