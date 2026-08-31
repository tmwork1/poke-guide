// GET /api/teams: ログイン中ユーザーのチーム一覧(メンバー込み)。
// POST /api/teams: 空チームの新規作成(ボディ不要。/box の「空個体を作る」に倣う)。
//
// 認証必須(401)。実際のクエリは全て src/lib/team.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れによる他人データ露出を防ぐための設計、
// 詳細は src/lib/team.ts 冒頭のコメント参照)。
import type { APIContext } from 'astro';
import { isSameOrigin, jsonResponse, methodNotAllowed } from './_shared';
import { getSessionUser } from '../../lib/user-session';
import { getSupabaseAdminClient } from '../../lib/supabase';
import { createTeam, listTeams, listTeamsPage } from '../../lib/team';
import { teamsRateLimiter } from '../../lib/rate-limit';

export const prerender = false;

export async function GET({ request, cookies, url }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const supabase = await getSupabaseAdminClient();
  const offsetParam = url.searchParams.get('offset');
  const limitParam = url.searchParams.get('limit');
  const wantsPage = offsetParam !== null || limitParam !== null;
  const offset = Number(offsetParam ?? '0');
  const limit = Number(limitParam ?? '24');
  if (wantsPage && (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 48)) {
    return jsonResponse({ error: 'Invalid pagination parameters' }, 400);
  }
  if (wantsPage) {
    const page = await listTeamsPage(user.id, supabase, offset, limit);
    if (!page.ok) return jsonResponse({ error: page.error }, 500);
    return jsonResponse(page.data, 200);
  }
  const result = await listTeams(user.id, supabase);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, 500);
  }
  return jsonResponse({ teams: result.data }, 200);
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = teamsRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const supabase = await getSupabaseAdminClient();
  const result = await createTeam(user.id, supabase);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, 500);
  }
  return jsonResponse({ team: result.data }, 201);
}

export const PUT = () => methodNotAllowed(['GET', 'POST']);
export const PATCH = PUT;
export const DELETE = PUT;
