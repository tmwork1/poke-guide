// PUT /api/owned-pokemon/:id/share: 個体の公開/非公開切り替え + share_slug 発行
// (docs/plan/ui_plan.md、builds廃止に伴う owned_pokemon への公開共有機能の統合)。
//
// 認証必須(401)。実際のクエリは src/lib/owned-pokemon.ts の setOwnedPokemonSharing へ委譲し、
// このファイル自身は生の Supabase クエリを書かない(../[id].ts と同じ設計方針)。
// 対象が存在しない場合と他人の所有物である場合はいずれも同じ404を返し、存在の有無を漏らさない。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, isValidUuid, jsonResponse, methodNotAllowed, readJsonBody } from '../../_shared';
import { getSessionUser } from '../../../../lib/user-session';
import { getSupabaseAdminClient } from '../../../../lib/supabase';
import { setOwnedPokemonSharing } from '../../../../lib/owned-pokemon';
import { ownedPokemonRateLimiter } from '../../../../lib/rate-limit';

export const prerender = false;

function notFound(): Response {
  return jsonResponse({ error: 'Owned pokemon not found' }, 404);
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

  const payload = (body.data ?? {}) as Record<string, unknown>;
  if (typeof payload.is_public !== 'boolean') {
    return badRequest('is_public must be a boolean');
  }

  const supabase = await getSupabaseAdminClient();
  const result = await setOwnedPokemonSharing(user.id, id, payload.is_public, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse(
    { data: { share_slug: result.data.share_slug, is_public: result.data.is_public } },
    200,
  );
}

export const GET = () => methodNotAllowed(['PUT']);
export const POST = GET;
export const PATCH = GET;
export const DELETE = GET;
