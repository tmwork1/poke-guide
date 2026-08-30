// 匿名セッション識別子 (session_hash) の生成ロジック (開発プラン §2.4 匿名化ポリシー)。
//
// IP・UA は一切保存しない。代わりに、非個人情報のランダムなセッションID（Cookie）+
// 当日の日付文字列(UTC) + SESSION_HASH_SECRET を HMAC-SHA256 にかけた値を session_hash として
// 保存する。日付が変わるとハッシュ値も変わるため、同一セッションであっても日をまたいだ
// 長期追跡はできない。
//
// Cloudflare Workers（および Node.js）の両方で動くよう、Node の `crypto` モジュールではなく
// Web Crypto API (`crypto.subtle`) を使う。`crypto` はグローバルに存在する前提（Workers ランタイム・
// Node.js 18+ の両方で利用可能）。
//
// astro:middleware や cloudflare:workers に依存しない純粋な関数として切り出し、
// node --test で環境非依存にユニットテストできるようにする（src/lib/rate-limit.ts と同じ方針）。

export const SESSION_COOKIE_NAME = 'pc_sid';
// 400日 = Chrome 等が Set-Cookie の Max-Age に課す実質的な上限に合わせる。
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

// 当日の日付文字列 (YYYY-MM-DD, UTC基準) を返す。session_hash の日次ローテーションに使う。
export function getUtcDateString(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

// セッションCookieに載せる非個人情報のランダムID。
export function generateSessionId(): string {
	return crypto.randomUUID();
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

// session_hash = HMAC-SHA256(secret, `${sessionId}:${dateStr}`) の16進文字列。
// 同じセッション・同じ日付なら常に同じ値になり、日付が変われば別の値になる。
export function computeSessionHash(
	sessionId: string,
	secret: string,
	dateStr: string = getUtcDateString(),
): Promise<string> {
	// events/searchesは匿名ロールに公開されるため、空のHMAC鍵を許すと第三者がsession_hashを
	// 再計算できて匿名化が成立しない。環境設定漏れをそのまま保存処理へ流さず明示的に停止する。
	if (secret.trim() === '') {
		throw new Error('SESSION_HASH_SECRET is not configured');
	}
	return hmacSha256Hex(secret, `${sessionId}:${dateStr}`);
}
