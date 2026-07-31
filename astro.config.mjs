// @ts-check
import { defineConfig, envField } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),
  // dev serverはWSL上で動く一方、リポジトリはWindows側(NTFS)を/mnt/c経由でマウントしている。
  // Windows側のエディタ/ツールが書いたファイル変更はWSL側のinotifyでは検知できないことがある
  // (drvfs/9pの制約)ため、ポーリング方式に切り替えて確実に反映させる。
  vite: {
    server: {
      watch: {
        usePolling: true,
      },
    },
  },
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      SUPABASE_PUBLISHABLE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      DATABASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      SESSION_HASH_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
      ADMIN_USERNAME: envField.string({ context: 'server', access: 'secret', optional: true }),
      ADMIN_PASSWORD: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
