// GET /api/opponent-notes: 指定した owned_pokemon_id に紐づく対戦相手メモ一覧
// (育成データ管理計画.md §8 Phase D-1)。
// POST /api/opponent-notes: 対戦相手メモの新規作成。保存成功後、匿名化コピーを
// damage_calcs/events へ二重記録する(§4.2・§4.4、Phase D-3)。
//
// 認証必須(401)。実際のクエリは全て src/lib/opponent-notes.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れ・owned_pokemon所有権チェック漏れによる
// 他人データ露出を防ぐための設計、詳細は src/lib/opponent-notes.ts 冒頭のコメント参照)。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, isValidUuid, jsonResponse, methodNotAllowed, readJsonBody } from './_shared';
import { getSessionUser } from '../../lib/user-session';
import { getSupabaseAdminClient } from '../../lib/supabase';
import { validateOpponentNoteRequestBody } from '../../lib/opponent-notes-validation';
import { createOpponentNote, listOpponentNotes } from '../../lib/opponent-notes';
import { getOwnedPokemon } from '../../lib/owned-pokemon';
import { opponentNotesRateLimiter } from '../../lib/rate-limit';
import { recordOpponentNoteAnonymized } from '../../lib/opponent-note-secondary-record';

export const prerender = false;

export async function GET({ request, cookies, url }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const ownedPokemonId = url.searchParams.get('owned_pokemon_id');
  if (!isValidUuid(ownedPokemonId)) {
    return badRequest('owned_pokemon_id query parameter is required and must be a valid uuid');
  }

  const supabase = await getSupabaseAdminClient();
  // owned_pokemon_id が他人の個体である場合でも、opponent_notes.user_id による絞り込み
  // (createOpponentNoteが維持する不変条件)により自然に空配列が返る。存在有無を漏らさないため
  // ここで別途 owned_pokemon の存在確認は行わない。
  const result = await listOpponentNotes(user.id, ownedPokemonId, supabase);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, 500);
  }
  return jsonResponse({ data: result.data }, 200);
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = opponentNotesRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const body = await readJsonBody<unknown>(request);
  if (body.response) return body.response;

  const validation = validateOpponentNoteRequestBody(body.data ?? {}, { requireOwnedPokemonId: true });
  if (!validation.ok) return badRequest(validation.error);

  const supabase = await getSupabaseAdminClient();
  const result = await createOpponentNote(user.id, validation.value, supabase);
  if (!result.ok) {
    if (result.ownedPokemonNotFound) {
      return jsonResponse({ error: 'Owned pokemon not found' }, 404);
    }
    return jsonResponse({ error: result.error }, 500);
  }

  // 主目的(opponent_notes保存)は成功済み。以降は副次記録であり、失敗してもレスポンスには
  // 影響させない(§4.2・damage-calcs.tsと同じ方針)。
  const ownedPokemon = await getOwnedPokemon(user.id, result.data.owned_pokemon_id, supabase);
  if (ownedPokemon.ok && ownedPokemon.data) {
    await recordOpponentNoteAnonymized(supabase, ownedPokemon.data, result.data);
  } else if (!ownedPokemon.ok) {
    // eslint-disable-next-line no-console
    console.error('[opponent-notes] Failed to fetch owned pokemon for anonymized recording:', ownedPokemon.error);
  }

  return jsonResponse({ data: result.data }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
