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
import { createTeam, listTeams, type TeamSort } from '../../lib/team';
import { teamsRateLimiter } from '../../lib/rate-limit';

export const prerender = false;

const VALID_SORTS: TeamSort[] = ['updated_at', 'name'];

function parseSort(value: string | null): TeamSort | undefined {
  return VALID_SORTS.includes(value as TeamSort) ? (value as TeamSort) : undefined;
}

export async function GET({ request, cookies, url }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const sort = parseSort(url.searchParams.get('sort'));
  const search = url.searchParams.get('search')?.trim() || undefined;

  const supabase = await getSupabaseAdminClient();
  const result = await listTeams(user.id, { sort, search }, supabase);
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
