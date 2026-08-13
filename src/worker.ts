// Astro の fetch ハンドラを合成する Worker エントリ。wrangler.jsonc の "main" をこのファイルに向けている。
// scheduled ハンドラは集計 cron ジョブ。
import { handle } from '@astrojs/cloudflare/handler';
import { getSupabaseAdminClient } from './lib/supabase';

export default {
	async fetch(request, env, ctx) {
		return handle(request, env, ctx);
	},

	async scheduled(event, env, ctx) {
		// wrangler.jsonc の triggers.crons から呼ばれる。集計対象が1ジョブのみのため分スロット分岐は行わない。
		// (ジョブが増えたら event.cron の値で分岐する)
		// getSupabaseAdminClient は cloudflare:workers の env を直接読む (src/config/env.ts) ため、
		// ここで受け取った env 引数を渡す必要はない (他の API ルートと同じ流儀)。
		const supabase = await getSupabaseAdminClient();
		const { error } = await supabase.rpc('refresh_popular_builds');

		if (error) {
			// events.ts / suggestions.ts と同じ温度感: 失敗を例外で伝播させず記録のみ行う
			// (次回の cron 実行で再度集計されるため、ここで実行自体を失敗扱いにする必要はない)。
			// eslint-disable-next-line no-console
			console.error('Failed to refresh popular builds:', error);
		}
	},
} satisfies ExportedHandler<Env>;
