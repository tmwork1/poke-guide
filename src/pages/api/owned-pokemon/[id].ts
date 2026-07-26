// GET/PUT/DELETE /api/owned-pokemon/:id (育成データ管理計画.md §8 Phase C-1)。
//
// 認証必須(401)。実際のクエリは全て src/lib/owned-pokemon.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れによる他人データ露出を防ぐための設計、
// 詳細は src/lib/owned-pokemon.ts 冒頭のコメント参照)。
// 対象が存在しない場合と他人の所有物である場合はいずれも同じ404を返し、存在の有無を漏らさない。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, isValidUuid, jsonResponse, methodNotAllowed, readJsonBody } from '../_shared';
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

  const body = await readJsonBody<unknown>(request);
  if (body.response) return body.response;

  const validation = validateOwnedPokemonRequestBody(body.data ?? {});
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
