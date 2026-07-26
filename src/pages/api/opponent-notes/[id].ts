// GET/PUT/DELETE /api/opponent-notes/:id (育成データ管理計画.md §8 Phase D-1)。
// PUT は保存成功後、匿名化コピーを damage_calcs/events へ二重記録する(§4.2・§4.4、Phase D-3)。
//
// 認証必須(401)。実際のクエリは全て src/lib/opponent-notes.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れによる他人データ露出を防ぐための設計、
// 詳細は src/lib/opponent-notes.ts 冒頭のコメント参照)。
// 対象が存在しない場合と他人の所有物である場合はいずれも同じ404を返し、存在の有無を漏らさない
// (src/pages/api/owned-pokemon/[id].ts と同じ方針)。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, isValidUuid, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
import { getSessionUser } from '../../../lib/user-session';
import { getSupabaseAdminClient } from '../../../lib/supabase';
import { validateOpponentNoteRequestBody } from '../../../lib/opponent-notes-validation';
import { deleteOpponentNote, getOpponentNote, updateOpponentNote } from '../../../lib/opponent-notes';
import { getOwnedPokemon } from '../../../lib/owned-pokemon';
import { recordOpponentNoteAnonymized } from '../../../lib/opponent-note-secondary-record';
import { opponentNotesRateLimiter } from '../../../lib/rate-limit';

export const prerender = false;

function notFound(): Response {
  return jsonResponse({ error: 'Opponent note not found' }, 404);
}

export async function GET({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const supabase = await getSupabaseAdminClient();
  const result = await getOpponentNote(user.id, id, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ data: result.data }, 200);
}

export async function PUT({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = opponentNotesRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const body = await readJsonBody<unknown>(request);
  if (body.response) return body.response;

  // 更新時は owned_pokemon_id の付け替えを許可しない(紐づく個体は作成時に固定)。
  const validation = validateOpponentNoteRequestBody(body.data ?? {}, { requireOwnedPokemonId: false });
  if (!validation.ok) return badRequest(validation.error);

  const supabase = await getSupabaseAdminClient();
  const result = await updateOpponentNote(user.id, id, validation.value, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  // 主目的(opponent_notes更新)は成功済み。以降は副次記録であり、失敗してもレスポンスには
  // 影響させない(§4.2・damage-calcs.tsと同じ方針)。
  const ownedPokemon = await getOwnedPokemon(user.id, result.data.owned_pokemon_id, supabase);
  if (ownedPokemon.ok && ownedPokemon.data) {
    await recordOpponentNoteAnonymized(supabase, ownedPokemon.data, result.data);
  } else if (!ownedPokemon.ok) {
    // eslint-disable-next-line no-console
    console.error('[opponent-notes/:id] Failed to fetch owned pokemon for anonymized recording:', ownedPokemon.error);
  }

  return jsonResponse({ data: result.data }, 200);
}

export async function DELETE({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = opponentNotesRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const supabase = await getSupabaseAdminClient();
  const result = await deleteOpponentNote(user.id, id, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ data: { id } }, 200);
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'DELETE']);
export const PATCH = POST;
