// @ts-check
import { defineConfig, envField } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),
  devToolbar: {
    enabled: false,
  },
  // dev serverはWSL内で動くが、ファイルはWindows側(/mnt/c配下)で編集されるため、
  // デフォルトのfs.watch(inotify)だとWindows側の保存イベントを検知できずHMRが効かないことがある。
  // ポーリング監視に切り替えて確実に変更を拾う。
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
