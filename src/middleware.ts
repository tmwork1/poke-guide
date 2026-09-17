// Google ログイン(Supabase Auth)のセッションを全リクエストで locals.user に載せる。
// 個体管理機能専用の認証レーンであり、ダメージ計算・検索等の既存の匿名ルートはそもそも
// locals.user を参照しないため、ここで値をセットするだけでは挙動に一切影響しない
// (強制認証・保護ロジックはあえて追加しない)。
// ボックス(/box)自体が Astro.locals.user の有無でログインボタン/ログアウトボタンを出し分ける
// 設計のため(育成データ管理計画.md §8 Phase A-3)、ミドルウェア側での強制リダイレクトも行わない。
// /api/auth/** はセッション確立前のリクエストを扱う経路であり、locals.user をセットする以外の
// 保護は元々存在しないため、この方針のもとでは自動的に対象外になる。
// 加えて、静的アセットには届かないSSRレスポンスのセキュリティヘッダもここで付与する。
import { defineMiddleware } from 'astro:middleware';
import { ensureAnonymousStarterData } from './lib/data/anonymous-starter-data';
import { applySecurityHeaders } from './lib/security-headers';
import { createUserSupabaseClient, getSessionUser, toSessionUser } from './lib/user-session';

function isAnonymousAppPage(pathname: string): boolean {
  return pathname === '/box' || pathname.startsWith('/box/') || pathname === '/team' || pathname.startsWith('/team/');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const isEligiblePage = context.request.method === 'GET' && isAnonymousAppPage(context.url.pathname);
  let user = await getSessionUser(context.request, context.cookies).catch(() => null);

  // Only user-data HTML pages create an anonymous session. API and public pages remain
  // unauthenticated so their existing 401/cache behavior does not change.
  if (!user && isEligiblePage) {
    try {
      const supabase = createUserSupabaseClient(context.request, context.cookies);
      const { data, error } = await supabase.auth.signInAnonymously();
      if (!error && data.user) user = toSessionUser(data.user);
    } catch (error) {
      // Rate limits or Auth outages leave the page in its existing signed-out state.
      console.error('[middleware] Anonymous sign-in failed:', error);
    }
  }

  context.locals.user = user;
  if (isEligiblePage && user?.isAnonymous) {
    try {
      await ensureAnonymousStarterData(user.id);
    } catch (error) {
      // Keep the authenticated page usable even if starter-data provisioning is retried later.
      console.error('[middleware] Anonymous starter-data provisioning failed:', error);
    }
  }
  const response = await next();

  // CSPはHTML以外では実質的な効果を持たないが、JSON APIに付与してもクライアントに害はない。
  // APIを含めて一律適用することでルートごとの設定差を避けるため、4つのヘッダを全て付与する。
  return applySecurityHeaders(response, context.url.pathname);
});
