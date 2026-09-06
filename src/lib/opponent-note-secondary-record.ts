// opponent_notes の保存(主目的)成功後に実行する、damage_calcs/events への匿名二重記録
// (育成データ管理計画.md §4.2・§4.4、§8 Phase D-3)。
//
// src/pages/api/opponent-notes.ts の POST・src/pages/api/opponent-notes/[id].ts の PUT の
// 両方から呼び出す共通ロジックのため、ここに切り出す(damage-calcs.ts が持つロジックと同型だが、
// 呼び出し元が2箇所あるため重複させずに1箇所にまとめる)。
//
// 「主目的の書き込みが成功していれば、副次的な集計用の書き込みが失敗してもリクエスト全体は
// 失敗させない」という既存 damage-calcs.ts と同じ方針を踏襲する。このファイルの
// recordOpponentNoteAnonymized() は例外を投げず、失敗時は console.error でログするだけに留める。
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonymizeOpponentNote } from './opponent-note-anonymize';
import { computeSessionHash, getUtcDateString } from './session-hash';
import { readEnv } from '../config/env';
import type { OwnedPokemonRecord } from './owned-pokemon';
import type { OpponentNoteRecord } from './opponent-notes';
import { createLogError } from './log.ts';

// session_hash の扱い(計画書§4.4、実装時に確定)。
// - user_id そのもの・user_id から逆算可能な値は使わない
// - 既存の computeSessionHash(sessionId, secret, dateStr) をそのまま流用し、sessionId には
//   ユーザー個別ではない固定の定数文字列を渡す。「ログイン由来の匿名記録である」ことを示しつつ
//   日次ローテーションもされ、user_id との対応関係は一切残らない。
const ANONYMIZED_SESSION_ID = 'owned-pokemon-anonymized';

const logError = createLogError('opponent-note-secondary-record');

export async function recordOpponentNoteAnonymized(
  supabase: SupabaseClient,
  ownedPokemon: OwnedPokemonRecord,
  opponentNote: OpponentNoteRecord,
): Promise<void> {
  try {
    const { attacker_name, defender_name, move_name, attacker_build, defender_build, field, client_result } =
      anonymizeOpponentNote(ownedPokemon, opponentNote);

    // damage_calcs.move_name は NOT NULL 制約だが、opponent_notes.move_name は未入力(null)を
    // 許容する(技を決めずにメモを作り始めるケースがあるため)。move_name が無い状態では
    // 「何の技によるダメージ計算か」が定まらず、そもそも damage_calcs/events へ記録する意味のある
    // データにならないため、ここで静かにスキップする(move_name未入力のたびにNOT NULL違反で
    // INSERTが失敗しログに残り続ける、という無意味なエラーの発生を避ける)。
    if (!move_name) {
      return;
    }

    const secret = readEnv('SESSION_HASH_SECRET');
    const sessionHash = await computeSessionHash(ANONYMIZED_SESSION_ID, secret, getUtcDateString());

    const { error: damageCalcError } = await supabase.from('damage_calcs').insert({
      attacker_name,
      defender_name,
      move_name,
      attacker_build,
      defender_build,
      field,
      client_result: client_result ?? null,
      session_hash: sessionHash,
    });
    if (damageCalcError) {
      logError('Failed to insert damage_calcs', damageCalcError);
    }

    // events への二重記録: 集計は入力(計算条件)のみに依存する方針のため、client_result は
    // ここには含めない(damage_calcs.client_result にのみ保存する。damage-calcs.ts と同じ方針)。
    // event_type は既存の 'damage_calc'(/damage-calc からの手動送信専用)とは分け、
    // 'opponent_note' という新しい値を使う(events.event_type列コメントの追加、計画書§8 Phase D-3)。
    const { error: eventError } = await supabase.from('events').insert({
      event_type: 'opponent_note',
      payload: { attacker_name, defender_name, move_name, attacker_build, defender_build, field },
      session_hash: sessionHash,
    });
    if (eventError) {
      logError('Failed to insert events (opponent_note)', eventError);
    }
  } catch (error) {
    // computeSessionHash 等が予期せず例外を投げても、主目的(opponent_notes保存)の成功レスポンスは
    // 妨げない(このtry/catch自体が呼び出し元への「絶対に失敗させない」保証)。
    logError('Unexpected error', error);
  }
}
