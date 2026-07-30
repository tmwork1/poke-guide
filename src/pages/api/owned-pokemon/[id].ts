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
import { deleteOwnedPokemon, getOwnedPokemon, updateOwnedPokemon, updatePinStatus } from '../../../lib/owned-pokemon';
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

// PATCH /api/owned-pokemon/:id: is_pinned のみを更新する軽量経路(41-B2、round-41.md)。
// PUT(全項目上書き契約、§6.2)とは別の追加経路であり、PUTの契約は変更しない。
// updatePinStatus() は is_pinned 列だけを UPDATE し updated_at には触れないため、
// 「更新順」表示中にお気に入りをトグルしても対象個体自身の表示順位置が動かないことを保証する
// (round-40.mdの40-B1が「トグルした個体自身が動くことは許容」としていた判断を、
// round-41.mdの41-B2がここで撤回した)。
export async function PATCH({ request, cookies, params }: APIContext): Promise<Response> {
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

  // このエンドポイントは { is_pinned: boolean } のみを受け付ける(それ以外のフィールドは
  // 全項目上書き契約のPUTの役割のため、ここでは受け付けない)。
  const payload = body.data;
  const isPlainObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload);
  const isPinned = isPlainObject ? (payload as { is_pinned?: unknown }).is_pinned : undefined;
  if (!isPlainObject || typeof isPinned !== 'boolean' || Object.keys(payload as object).length !== 1) {
    return badRequest('Request body must be exactly { is_pinned: boolean }');
  }

  const supabase = await getSupabaseAdminClient();
  const result = await updatePinStatus(user.id, id, isPinned, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ data: result.data }, 200);
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'PATCH', 'DELETE']);
