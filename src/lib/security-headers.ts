// 静的アセットは Cloudflare Workers Static Assets が public/_headers を読み取って配信する一方、SSRレスポンスは
// Worker が動的に返すため、この定義を middleware からも付与する。public/_headers の /* ブロックと完全に同じ内容を
// 保つこと。片方だけを変更すると静的アセットとSSRページで防御内容が食い違うため、必ず両方を更新する。
export const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy':
		"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://raw.githubusercontent.com https://img.gamewith.jp; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self'",
} as const;

// /speed-chart, /data/speed-chart はボックス編集画面のすばやさ調整モーダルが同一オリジンiframeとして
// 埋め込む2ページ。frame-ancestors 'none' / X-Frame-Options: DENY のままだとブラウザがiframe化そのものを
// 拒否しモーダルが開けなくなるため、この2パスに限り自オリジンからのフレーム化のみ許可する。
const FRAMABLE_PATHNAMES = new Set(['/speed-chart', '/data/speed-chart']);

// 各ルートが既に同名ヘッダを設定していても、全レスポンスで同じ防御ポリシーを使うため set() でここに集約した値で上書きする。
// Astroの middleware が next() から受け取る Response の Headers は変更可能なので、本文を読み直す new Response() は不要である。
export function applySecurityHeaders(response: Response, pathname?: string): Response {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}

	if (pathname && FRAMABLE_PATHNAMES.has(pathname)) {
		response.headers.set('X-Frame-Options', 'SAMEORIGIN');
		response.headers.set(
			'Content-Security-Policy',
			SECURITY_HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
		);
	}

	return response;
}
