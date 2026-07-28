// GET/PUT/DELETE /api/owned-pokemon/:id (育成データ管理計画.md §8 Phase C-1)。
//
// 認証必須(401)。実際のクエリは全て src/lib/owned-pokemon.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れによる他人データ露出を防ぐための設計、
// 詳細は src/lib/owned-pokemon.ts 冒頭のコメント参照)。
// 対象が存在しない場合と他人の所有物である場合はいずれも同じ404を返し、存在の有無を漏らさない。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, isValidUuid, jsonResponse, methodNotAllowed, readRequiredJsonBody } from '../_shared';
import { getSessionUser } from '../../../lib/user-session';
import { getSupabaseAdminClient } from '../../../lib/supabase';
import { validateOwnedPokemonRequestBody } from '../../../lib/owned-pokemon-validation';
import { deleteOwnedPokemon, getOwnedPokemon, updateOwnedPokemon } from '../../../lib/owned-pokemon';
import { ownedPokemonRateLimiter } from '../../../lib/rate-limit';

export const prerender = false;

function notFound(): Response {
  return jsonResponse({ error: 'Owned pokemon not found' }, 404);
}

export async function GET({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const supabase = await getSupabaseAdminClient();
  const result = await getOwnedPokemon(user.id, id, supabase);
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

  const rateLimit = ownedPokemonRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;

  // PUT は「全項目を毎回送る」置換契約(育成データ管理計画.md §6.2)のため、置換対象の
  // 全フィールドが payload に存在することを必須にする(mode: 'replace')。これが無いと
  // {} のような部分的なpayloadが検証を素通りし、既存データが既定値で全消去されてしまう
  // (2026-07に実際に発生したデータ消失バグ、owned-pokemon-validation.ts のコメント参照)。
  const validation = validateOwnedPokemonRequestBody(body.data, { mode: 'replace' });
  if (!validation.ok) return badRequest(validation.error);

  const supabase = await getSupabaseAdminClient();
  const result = await updateOwnedPokemon(user.id, id, validation.value, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ data: result.data }, 200);
}

export async function DELETE({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = ownedPokemonRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const supabase = await getSupabaseAdminClient();
  const result = await deleteOwnedPokemon(user.id, id, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ data: { id } }, 200);
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'DELETE']);
export const PATCH = POST;
