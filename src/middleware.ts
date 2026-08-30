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
import { applySecurityHeaders } from './lib/security-headers';
import { getSessionUser } from './lib/user-session';

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = await getSessionUser(context.request, context.cookies).catch(() => null);
  const response = await next();

  // CSPはHTML以外では実質的な効果を持たないが、JSON APIに付与してもクライアントに害はない。
  // APIを含めて一律適用することでルートごとの設定差を避けるため、4つのヘッダを全て付与する。
  return applySecurityHeaders(response, context.url.pathname);
});
