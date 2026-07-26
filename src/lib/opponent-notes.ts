// opponent_notes への読み書きを集約する、HTTP/セッションの知識を一切持たないデータアクセス層
// (育成データ管理計画.md §8 Phase D-1)。src/lib/owned-pokemon.ts と同じ設計方針を踏襲する。
//
// ##### 最重要: このファイルが「他人のデータへの唯一の砦」であること #####
// poke-commons の書き込みAPIは全て getSupabaseAdminClient()(service_role、RLSを常にバイパスする)
// 経由で実行する設計のため、opponent_notes のRLSポリシー(migrations/005_owned_pokemon_rls.sql)は
// この経路には一切効かない。「ログイン中のユーザーが自分以外のメモを閲覧・改ざんできない」ことを
// 保証するのは、この下の各関数が発行するクエリに必ず含む `.eq('user_id', userId)` のみである。
//
// ##### opponent_notes 固有の追加リスク: owned_pokemon_id のなりすまし #####
// opponent_notes は owned_pokemon_id で親の個体に紐づくため、owned-pokemon.ts には無かった
// 新しいリスクがある。「userBが、userAの owned_pokemon の id を owned_pokemon_id に指定して、
// 自分(userB)の user_id で opponent_notes を作成できてしまう」ことを防ぐため、
// createOpponentNote は必ず対象の owned_pokemon_id が呼び出し元 userId の所有物であることを
// (`owned_pokemon` テーブルに対して `.eq('id', owned_pokemon_id).eq('user_id', userId)` が
// 存在するかで)確認してから INSERT する。この存在確認は呼び出し元(APIルート)には持たせず、
// 必ずこの関数内で完結させる。
//
// この不変条件(「opponent_notes.user_id は常に、紐づく owned_pokemon.user_id と一致する」)が
// createOpponentNote 経由でのみ成立している限り、list/get/update/delete が
// `.eq('user_id', userId)` だけで安全に絞り込める(owned_pokemon 側を毎回JOINし直す必要がない)。
//
// テスト: tests/db/opponent-notes-lib.test.ts で
//   - userAが自分のowned_pokemonに紐づくopponent_notesを作成・取得できる
//   - userBがuserAのopponent_notesを取得・更新・削除できない
//   - userBが、userAのowned_pokemon_idを指定してcreateOpponentNote(userB, ...)を呼んでも
//     作成できない(このライブラリの所有権検証の核心)
//   - 存在しないIDと他人所有のIDが同じ結果(null/false)になる(存在漏洩防止)
// を実DBに対して検証している。

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OpponentNoteRequestBody } from './opponent-notes-validation';

// UI層(対戦相手メモの入力フォーム)がインポートして使うための型。実体は
// opponent-notes-validation.ts で定義している(バリデーションロジックと乖離させないため、
// ここでは re-export のみ行う)。
export type {
  OpponentAttackInput,
  OpponentFieldInput,
  OpponentClientResultInput,
} from './opponent-notes-validation';

export interface OpponentNoteRecord {
  id: string;
  owned_pokemon_id: string;
  user_id: string;
  opponent_build: Record<string, unknown>;
  field: Record<string, unknown>;
  move_name: string | null;
  client_result: Record<string, unknown> | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export type OpponentNoteResult<T> = { ok: true; data: T } | { ok: false; error: string };

// createOpponentNote専用の結果型。「owned_pokemon_idが呼び出し元の所有物でない」ケースを
// 汎用のDBエラーと区別できるようにし、APIルート側で404(存在しない/他人の所有物)と
// 500(予期しないDBエラー)を出し分けられるようにする。
export type CreateOpponentNoteResult =
  | { ok: true; data: OpponentNoteRecord }
  | { ok: false; error: string; ownedPokemonNotFound?: boolean };

const OPPONENT_NOTE_COLUMNS =
  'id, owned_pokemon_id, user_id, opponent_build, field, move_name, client_result, memo, created_at, updated_at';

function logError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[opponent-notes] ${context}:`, error);
}

// 指定した owned_pokemon_id が userId の所有物として実在するかを確認する。
async function isOwnedPokemonOwnedByUser(
  userId: string,
  ownedPokemonId: string,
  supabase: SupabaseClient,
): Promise<{ ok: true; owned: boolean } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('owned_pokemon')
    .select('id')
    .eq('id', ownedPokemonId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logError('isOwnedPokemonOwnedByUser failed', error);
    return { ok: false, error: 'Failed to verify owned pokemon ownership' };
  }
  return { ok: true, owned: data != null };
}

// 指定した owned_pokemon_id に紐づくメモ一覧を返す。owned_pokemon_id が存在しない/他人の所有物の
// 場合でも、opponent_notes.user_id による絞り込み(createOpponentNoteが維持する不変条件)により
// 自然に空配列になる(この関数自身で owned_pokemon を再チェックする必要はない)。
export async function listOpponentNotes(
  userId: string,
  ownedPokemonId: string,
  supabase: SupabaseClient,
): Promise<OpponentNoteResult<OpponentNoteRecord[]>> {
  const { data, error } = await supabase
    .from('opponent_notes')
    .select(OPPONENT_NOTE_COLUMNS)
    .eq('owned_pokemon_id', ownedPokemonId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    logError('listOpponentNotes failed', error);
    return { ok: false, error: 'Failed to list opponent notes' };
  }
  return { ok: true, data: (data ?? []) as OpponentNoteRecord[] };
}

// 見つからない場合と他人の所有物である場合を区別せず null を返す(存在漏洩防止)。
export async function getOpponentNote(
  userId: string,
  id: string,
  supabase: SupabaseClient,
): Promise<OpponentNoteResult<OpponentNoteRecord | null>> {
  const { data, error } = await supabase
    .from('opponent_notes')
    .select(OPPONENT_NOTE_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logError('getOpponentNote failed', error);
    return { ok: false, error: 'Failed to fetch opponent note' };
  }
  return { ok: true, data: (data as OpponentNoteRecord | null) ?? null };
}

export async function createOpponentNote(
  userId: string,
  input: OpponentNoteRequestBody,
  supabase: SupabaseClient,
): Promise<CreateOpponentNoteResult> {
  if (!input.owned_pokemon_id) {
    // バリデーション層(requireOwnedPokemonId: true)を通っていれば発生しないはずだが、
    // このファイル単体で不変条件を守るための防御的チェック。
    return { ok: false, error: 'owned_pokemon_id is required', ownedPokemonNotFound: true };
  }

  // ##### 所有権検証(このファイル最重要事項) #####
  // 呼び出し元(APIルート)には存在確認ロジックを持たせず、必ずここで完結させる。
  const ownership = await isOwnedPokemonOwnedByUser(userId, input.owned_pokemon_id, supabase);
  if (!ownership.ok) {
    return { ok: false, error: ownership.error };
  }
  if (!ownership.owned) {
    return { ok: false, error: 'Owned pokemon not found', ownedPokemonNotFound: true };
  }

  const { data, error } = await supabase
    .from('opponent_notes')
    .insert({
      owned_pokemon_id: input.owned_pokemon_id,
      user_id: userId, // リクエストボディ由来の値は一切使わない(なりすまし防止)
      opponent_build: input.opponent_build,
      field: input.field,
      move_name: input.move_name,
      client_result: input.client_result,
      memo: input.memo,
    })
    .select(OPPONENT_NOTE_COLUMNS)
    .single();

  if (error || !data) {
    logError('createOpponentNote failed', error);
    return { ok: false, error: 'Failed to create opponent note' };
  }
  return { ok: true, data: data as OpponentNoteRecord };
}

// 対象が存在しない、または他人の所有物の場合は data: null を返す(0件更新。存在漏洩防止)。
// owned_pokemon_id の付け替えは許可しない(input には含まれない設計、バリデーション層で担保)。
export async function updateOpponentNote(
  userId: string,
  id: string,
  input: OpponentNoteRequestBody,
  supabase: SupabaseClient,
): Promise<OpponentNoteResult<OpponentNoteRecord | null>> {
  const { data, error } = await supabase
    .from('opponent_notes')
    .update({
      opponent_build: input.opponent_build,
      field: input.field,
      move_name: input.move_name,
      client_result: input.client_result,
      memo: input.memo,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行を更新できてしまう(このファイルの最重要事項)
    .select(OPPONENT_NOTE_COLUMNS)
    .maybeSingle();

  if (error) {
    logError('updateOpponentNote failed', error);
    return { ok: false, error: 'Failed to update opponent note' };
  }
  return { ok: true, data: (data as OpponentNoteRecord | null) ?? null };
}

// 削除できた場合は true、対象が存在しない/他人の所有物の場合は false を返す。
export async function deleteOpponentNote(
  userId: string,
  id: string,
  supabase: SupabaseClient,
): Promise<OpponentNoteResult<boolean>> {
  const { data, error } = await supabase
    .from('opponent_notes')
    .delete()
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行を削除できてしまう(このファイルの最重要事項)
    .select('id');

  if (error) {
    logError('deleteOpponentNote failed', error);
    return { ok: false, error: 'Failed to delete opponent note' };
  }
  return { ok: true, data: (data ?? []).length > 0 };
}
