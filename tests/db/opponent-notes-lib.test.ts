// src/lib/opponent-notes.ts の userId分離・owned_pokemon所有権検証を実DBに対して検証する
// 統合テスト(育成データ管理計画.md §8 Phase D-4、tests/db/owned-pokemon-lib.test.ts と同じ
// スキップパターン)。
//
// opponent_notes は owned_pokemon_id で親個体に紐づくため、owned-pokemon-lib.test.ts には無かった
// 新しいリスクがある: 「userBが、userAのowned_pokemonのidをowned_pokemon_idに指定して、自分
// (userB)のuser_idでopponent_notesを作成できてしまう」ことをcreateOpponentNoteが防いでいるかを
// 検証するのが本テストの核心(D-1の所有権検証)。
//
// 実行方法(ローカルSupabaseスタックが `supabase start` 済みであること):
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_SECRET_KEY=<ローカルのservice_roleキー> \
//   RUN_DB_TESTS=1 node --test tests/db/opponent-notes-lib.test.ts
// (migrations/001〜005 が適用済みのローカルSupabaseスタックに対して実行すること。
//  DATABASE_URL/RUN_DB_TESTSが未設定の場合はスキップされる)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createOwnedPokemon } from '../../src/lib/owned-pokemon.ts';
import type { OwnedPokemonRequestBody } from '../../src/lib/owned-pokemon-validation.ts';
import {
  createOpponentNote,
  deleteOpponentNote,
  getOpponentNote,
  listOpponentNotes,
  updateOpponentNote,
} from '../../src/lib/opponent-notes.ts';
import type { OpponentNoteRequestBody } from '../../src/lib/opponent-notes-validation.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const shouldRun = RUN_DB_TESTS && !!DATABASE_URL && !!SUPABASE_URL && !!SUPABASE_SECRET_KEY;

function makeOwnedPokemonInput(overrides: Partial<OwnedPokemonRequestBody> = {}): OwnedPokemonRequestBody {
  return {
    species_name: 'ピカチュウ',
    level: 50,
    nature: null,
    ability_name: null,
    item_name: null,
    tera_type: null,
    evs: [0, 0, 0, 0, 0, 0],
    ivs: [31, 31, 31, 31, 31, 31],
    move_names: [],
    memo: null,
    tags: [],
    ...overrides,
  };
}

function makeOpponentNoteInput(overrides: Partial<OpponentNoteRequestBody> = {}): OpponentNoteRequestBody {
  return {
    owned_pokemon_id: null,
    opponent_build: { name: 'カイリュー' },
    field: {},
    move_name: '10まんボルト',
    client_result: null,
    memo: null,
    ...overrides,
  };
}

describe('src/lib/opponent-notes.ts のuserId分離・owned_pokemon所有権検証', {
  skip: shouldRun
    ? false
    : 'DATABASE_URL/SUPABASE_URL/SUPABASE_SECRET_KEY/RUN_DB_TESTS が未設定のためスキップ(ローカルSupabaseスタックへのDB接続を伴う統合テスト)',
}, () => {
  let admin: Client;
  let supabase: SupabaseClient;
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  let ownedPokemonIdA: string;
  let ownedPokemonIdB: string;
  let opponentNoteId: string;

  before(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
      userA,
      'opponent-notes-lib-test-user-a@example.com',
      userB,
      'opponent-notes-lib-test-user-b@example.com',
    ]);

    supabase = createClient(SUPABASE_URL as string, SUPABASE_SECRET_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const ownedA = await createOwnedPokemon(userA, makeOwnedPokemonInput({ species_name: 'userAの個体' }), supabase);
    assert.equal(ownedA.ok, true);
    if (!ownedA.ok) throw new Error('setup failed');
    ownedPokemonIdA = ownedA.data.id;

    const ownedB = await createOwnedPokemon(userB, makeOwnedPokemonInput({ species_name: 'userBの個体' }), supabase);
    assert.equal(ownedB.ok, true);
    if (!ownedB.ok) throw new Error('setup failed');
    ownedPokemonIdB = ownedB.data.id;
  });

  after(async () => {
    // owned_pokemon/opponent_notes は ON DELETE CASCADE で auth.users の削除に追従して消える。
    await admin.query('DELETE FROM auth.users WHERE id IN ($1, $2)', [userA, userB]);
    await admin.end();
  });

  it('userAは自分のowned_pokemonに紐づくopponent_notesを作成・取得できる', async () => {
    const created = await createOpponentNote(
      userA,
      makeOpponentNoteInput({ owned_pokemon_id: ownedPokemonIdA, memo: 'userAのメモ' }),
      supabase,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    opponentNoteId = created.data.id;
    assert.equal(created.data.user_id, userA);
    assert.equal(created.data.owned_pokemon_id, ownedPokemonIdA);
    assert.equal(created.data.memo, 'userAのメモ');

    const fetched = await getOpponentNote(userA, opponentNoteId, supabase);
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    assert.equal(fetched.data?.id, opponentNoteId);

    const listed = await listOpponentNotes(userA, ownedPokemonIdA, supabase);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(
      listed.data.some((n) => n.id === opponentNoteId),
      true,
    );
  });

  it(
    '【D-1の所有権検証の核心】userBが、userAのowned_pokemon_idを指定してcreateOpponentNote(userB, ...)を呼んでも作成できない',
    async () => {
      const result = await createOpponentNote(
        userB,
        makeOpponentNoteInput({ owned_pokemon_id: ownedPokemonIdA, memo: '乗っ取り試行' }),
        supabase,
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.ownedPokemonNotFound, true);

      // 実際にDBへ作成されていないことを確認する(userA視点でリストしても増えていない)。
      const listed = await listOpponentNotes(userA, ownedPokemonIdA, supabase);
      assert.equal(listed.ok, true);
      if (!listed.ok) return;
      assert.equal(
        listed.data.some((n) => n.memo === '乗っ取り試行'),
        false,
      );
    },
  );

  it('userBは自分のowned_pokemonに対してはopponent_notesを作成できる(所有権検証が正当な操作を妨げない)', async () => {
    const created = await createOpponentNote(
      userB,
      makeOpponentNoteInput({ owned_pokemon_id: ownedPokemonIdB, memo: 'userBのメモ' }),
      supabase,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.data.user_id, userB);
    assert.equal(created.data.owned_pokemon_id, ownedPokemonIdB);
  });

  it('userBはuserAのopponent_notesをgetOpponentNoteで取得できない(nullが返る)', async () => {
    const result = await getOpponentNote(userB, opponentNoteId, supabase);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, null);
  });

  it('userBはuserAのopponent_notesをlistOpponentNotesの一覧に含められない', async () => {
    const result = await listOpponentNotes(userB, ownedPokemonIdA, supabase);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.data.some((n) => n.id === opponentNoteId),
      false,
    );
  });

  it('userBはuserAのopponent_notesをupdateOpponentNoteで更新できない(0件更新でdata:null)', async () => {
    const result = await updateOpponentNote(userB, opponentNoteId, makeOpponentNoteInput({ memo: '改ざん' }), supabase);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, null);

    // 実際に更新されていないことをuserA視点でも確認する。
    const check = await getOpponentNote(userA, opponentNoteId, supabase);
    assert.equal(check.ok, true);
    if (!check.ok) return;
    assert.equal(check.data?.memo, 'userAのメモ');
  });

  it('userBはuserAのopponent_notesをdeleteOpponentNoteで削除できない(false)', async () => {
    const result = await deleteOpponentNote(userB, opponentNoteId, supabase);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data, false);

    // 実際に削除されていないことをuserA視点でも確認する。
    const check = await getOpponentNote(userA, opponentNoteId, supabase);
    assert.equal(check.ok, true);
    if (!check.ok) return;
    assert.notEqual(check.data, null);
  });

  it('userAは自分のupdateOpponentNote/deleteOpponentNoteを実行できる', async () => {
    const updated = await updateOpponentNote(userA, opponentNoteId, makeOpponentNoteInput({ memo: '更新後' }), supabase);
    assert.equal(updated.ok, true);
    if (updated.ok) assert.equal(updated.data?.memo, '更新後');

    const deleted = await deleteOpponentNote(userA, opponentNoteId, supabase);
    assert.equal(deleted.ok, true);
    if (deleted.ok) assert.equal(deleted.data, true);
  });

  it('存在しないIDと他人所有のIDに対するget/update/deleteは同じ結果(null/false)を返す(存在漏洩防止)', async () => {
    // userBの個体に紐づく既存メモ(他人所有)をuserA視点で試す。
    const otherOwned = await createOpponentNote(userB, makeOpponentNoteInput({ owned_pokemon_id: ownedPokemonIdB }), supabase);
    assert.equal(otherOwned.ok, true);
    if (!otherOwned.ok) return;
    const otherUsersNoteId = otherOwned.data.id;

    const missingId = crypto.randomUUID();

    const fetchedMissing = await getOpponentNote(userA, missingId, supabase);
    assert.equal(fetchedMissing.ok, true);
    if (fetchedMissing.ok) assert.equal(fetchedMissing.data, null);

    const fetchedOthers = await getOpponentNote(userA, otherUsersNoteId, supabase);
    assert.equal(fetchedOthers.ok, true);
    if (fetchedOthers.ok) assert.equal(fetchedOthers.data, null);

    const updatedMissing = await updateOpponentNote(userA, missingId, makeOpponentNoteInput(), supabase);
    assert.equal(updatedMissing.ok, true);
    if (updatedMissing.ok) assert.equal(updatedMissing.data, null);

    const updatedOthers = await updateOpponentNote(userA, otherUsersNoteId, makeOpponentNoteInput(), supabase);
    assert.equal(updatedOthers.ok, true);
    if (updatedOthers.ok) assert.equal(updatedOthers.data, null);

    const deletedMissing = await deleteOpponentNote(userA, missingId, supabase);
    assert.equal(deletedMissing.ok, true);
    if (deletedMissing.ok) assert.equal(deletedMissing.data, false);

    const deletedOthers = await deleteOpponentNote(userA, otherUsersNoteId, supabase);
    assert.equal(deletedOthers.ok, true);
    if (deletedOthers.ok) assert.equal(deletedOthers.data, false);
  });

  it('存在しないowned_pokemon_idを指定したcreateOpponentNoteはownedPokemonNotFoundで拒否する', async () => {
    const missingOwnedPokemonId = crypto.randomUUID();
    const result = await createOpponentNote(userA, makeOpponentNoteInput({ owned_pokemon_id: missingOwnedPokemonId }), supabase);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.ownedPokemonNotFound, true);
  });
});
