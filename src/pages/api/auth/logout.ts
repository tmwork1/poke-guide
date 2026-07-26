// セッションを破棄し Cookie を削除、トップページへ戻す。
import type { APIContext } from 'astro';
import { createUserSupabaseClient } from '../../../lib/user-session';
import { isSameOrigin, jsonResponse, methodNotAllowed } from '../_shared';

export const prerender = false;

export async function POST({ request, cookies, redirect }: APIContext) {
  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const supabase = createUserSupabaseClient(request, cookies);
  await supabase.auth.signOut();
  return redirect('/');
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
