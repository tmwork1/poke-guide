// Google ログインのコールバック。認可コードをセッションに交換し Cookie へ保存する。
// poke-commons には public.users のようなプロフィールミラーテーブルを作らない設計のため
// (育成データ管理計画.md §3.1)、poke-research の callback.ts にある public.users への
// upsert 処理は移植しない。
import type { APIContext } from 'astro';
import { createUserSupabaseClient } from '../../../lib/user-session';
import { jsonResponse, methodNotAllowed } from '../_shared';

export const prerender = false;

export async function GET({ request, cookies, redirect }: APIContext) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return jsonResponse({ error: 'Missing authorization code' }, 400);
  }

  const supabase = createUserSupabaseClient(request, cookies);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  return redirect('/box');
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
