// GET /api/suggestions: サジェスト表示枠のための空枠読み出しAPI (開発プラン §3 Phase2-4)。
// suggestions は cron / GitHub Actions バッチ (Phase 5) が書き込む集計結果の閲覧専用テーブル。
// 公開閲覧のみなので service_role は使わず、RLS の suggestions_public_read ポリシー
// (migrations/002_enable_rls.sql) を経由する anon クライアントで読む (最小権限の原則)。
import type { APIContext } from 'astro';
import { jsonResponse, methodNotAllowed } from './_shared';
import { getSupabasePublicClient } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function GET({ request }: APIContext): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  if (!kind) {
    return jsonResponse({ error: 'kind is required' }, 400);
  }

  const subjectKey = url.searchParams.get('subject_key');

  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return jsonResponse({ error: 'limit must be a positive integer' }, 400);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const supabase = await getSupabasePublicClient();
  let query = supabase.from('suggestions').select('*').eq('kind', kind);
  if (subjectKey !== null) {
    query = query.eq('subject_key', subjectKey);
  }

  const { data, error } = await query.order('computed_at', { ascending: false }).limit(limit);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch suggestions:', error);
    return jsonResponse({ error: 'Failed to fetch suggestions' }, 500);
  }

  return jsonResponse({ data: data ?? [] }, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
