// Google ログイン(Supabase Auth)向けの Cookie ベースセッション処理。
// 個体管理機能(Phase C予定)専用のログインレーンであり、ダメージ計算・検索・builds等の
// 既存の匿名機能は参照しない(poke-research の src/lib/user-session.ts を移植・簡素化)。
import { createServerClient } from '@supabase/ssr';
import type { AstroCookies, AstroCookieSetOptions } from 'astro';
import { readEnv } from '../config/env';

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  return header
    .split(';')
    .map((pair) => {
      const index = pair.indexOf('=');
      if (index === -1) return { name: pair.trim(), value: '' };
      return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
    })
    .filter((cookie) => cookie.name.length > 0);
}

export function createUserSupabaseClient(request: Request, cookies: AstroCookies) {
  const SUPABASE_URL = readEnv('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = readEnv('SUPABASE_PUBLISHABLE_KEY');

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get('cookie'));
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookies.set(name, value, options as AstroCookieSetOptions);
        }
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

function toSessionUser(user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> }): SessionUser {
  const metadata = user.user_metadata ?? {};
  const displayName = (metadata.full_name as string | undefined) ?? (metadata.name as string | undefined) ?? null;
  return { id: user.id, email: user.email ?? null, displayName };
}

// `astro dev` 実行時のみ使うダミーユーザー。本番ビルドでは import.meta.env.DEV が false になるため使われない。
// scripts/db/seed-dev-user.mjs で同じ id を auth.users に登録しておくことで、
// Google Cloud Console 側の設定が無くてもローカルで個体管理機能(Phase C)まで検証できる。
export const DEV_SESSION_USER: SessionUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'dev@localhost',
  displayName: 'ローカル開発ユーザー',
};

// devモードのみ参照するゲスト強制cookie。`/api/auth/login`・`/api/auth/logout` は
// このDEVショートカットの手前で素通りしてしまい効果が無い(実測済み)ため、
// `src/components/DebugAuthToggle.astro` はSupabaseの実セッションではなくこのcookieを
// 直接書き換えてゲスト/ログイン表示を切り替える。本番では import.meta.env.DEV が false に
// なり、この分岐自体に到達しない。
const DEV_FORCE_GUEST_COOKIE = 'poke-dev-force-guest';

export async function getSessionUser(request: Request, cookies: AstroCookies): Promise<SessionUser | null> {
  if (import.meta.env.DEV) {
    if (cookies.get(DEV_FORCE_GUEST_COOKIE)?.value === '1') return null;
    return DEV_SESSION_USER;
  }

  const supabase = createUserSupabaseClient(request, cookies);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return toSessionUser(data.user);
}
