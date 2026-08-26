// GET /api/owned-pokemon: ログイン中ユーザーの所有個体一覧 (育成データ管理計画.md §8 Phase C-1)。
// POST /api/owned-pokemon: 個体の新規作成。
//
// 認証必須(401)。実際のクエリは全て src/lib/owned-pokemon.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れによる他人データ露出を防ぐための設計、
// 詳細は src/lib/owned-pokemon.ts 冒頭のコメント参照)。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, jsonResponse, methodNotAllowed, readRequiredJsonBody } from './_shared';
import { getSessionUser } from '../../lib/user-session';
import { getSupabaseAdminClient } from '../../lib/supabase';
import { validateOwnedPokemonRequestBody } from '../../lib/owned-pokemon-validation';
import { createOwnedPokemon, listOwnedPokemon, type OwnedPokemonSort } from '../../lib/owned-pokemon';
import { ownedPokemonRateLimiter } from '../../lib/rate-limit';

export const prerender = false;

const VALID_SORTS: OwnedPokemonSort[] = ['updated_at', 'last_used_at'];

function parseSort(value: string | null): OwnedPokemonSort | undefined {
  return VALID_SORTS.includes(value as OwnedPokemonSort) ? (value as OwnedPokemonSort) : undefined;
}

export async function GET({ request, cookies, url }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const sort = parseSort(url.searchParams.get('sort'));
  const tagsParam = url.searchParams.get('tags');
  const tags = tagsParam
    ? tagsParam
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : undefined;
  const search = url.searchParams.get('search')?.trim() || undefined;

  const supabase = await getSupabaseAdminClient();
  const result = await listOwnedPokemon(user.id, { sort, tags, search }, supabase);
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

  const rateLimit = ownedPokemonRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;

  const validation = validateOwnedPokemonRequestBody(body.data);
  if (!validation.ok) return badRequest(validation.error);

  const supabase = await getSupabaseAdminClient();
  const result = await createOwnedPokemon(user.id, validation.value, supabase);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, 500);
  }
  return jsonResponse({ data: result.data }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
