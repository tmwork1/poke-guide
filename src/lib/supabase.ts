// Cloudflare 実行環境とローカル環境の両方で動く Supabase クライアント生成処理
// (poke-research の src/lib/supabase.ts と同じ方針)。
import { readEnv } from '../config/env';

export async function getSupabaseAdminClient() {
	const SUPABASE_URL = readEnv('SUPABASE_URL');
	const SUPABASE_SECRET_KEY = readEnv('SUPABASE_SECRET_KEY');

	const { createClient } = await import('@supabase/supabase-js');

	if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
		// 開発中は環境変数が未設定でも手元で動かすことがあるため警告に留める
		// eslint-disable-next-line no-console
		console.warn('Supabase env vars not set: SUPABASE_URL or SUPABASE_SECRET_KEY');
	}

	// SUPABASE_SECRET_KEY (service_role) は RLS を常にバイパスする。書き込みは匿名ロールに
	// ポリシーが無いため、このサービスロールクライアントを使うサーバ側APIのみが行う
	// (migrations/002_enable_rls.sql)。公開閲覧はここでは扱わない。
	return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
		detectSessionInUrl: false,
		auth: { autoRefreshToken: false, persistSession: false },
	});
}

// 公開閲覧専用 (anon ロール)。RLS の *_public_read ポリシー (migrations/002_enable_rls.sql) を
// 経由してのみ読み取れる、最小権限のクライアント。書き込みAPIと違い service_role は不要 -
// 閲覧系エンドポイントで誤って書き込み権限を持たせないための最小権限の原則。
// 公開キー用でセッションを保持しない(persistSession: false)ため、リクエストをまたいで
// 使い回しても利用者の状態は漏れない。管理者・ユーザー認証付きクライアントは対象外。
let publicClientPromise: ReturnType<typeof createSupabasePublicClient> | null = null;

export function getSupabasePublicClient() {
	publicClientPromise ??= createSupabasePublicClient().catch((error) => {
		publicClientPromise = null;
		throw error;
	});
	return publicClientPromise;
}

async function createSupabasePublicClient() {
	const SUPABASE_URL = readEnv('SUPABASE_URL');
	const SUPABASE_PUBLISHABLE_KEY = readEnv('SUPABASE_PUBLISHABLE_KEY');

	const { createClient } = await import('@supabase/supabase-js');

	if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
		// eslint-disable-next-line no-console
		console.warn('Supabase env vars not set: SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY');
	}

	return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
		detectSessionInUrl: false,
		auth: { autoRefreshToken: false, persistSession: false },
	});
}
