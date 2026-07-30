// 開発・検証用の手動集計スクリプト。本番の実行経路は Cloudflare Cron Trigger
// (src/worker.ts の scheduled ハンドラ、wrangler.jsonc triggers.crons)であり、これはローカル/
// ステージング環境で refresh_popular_builds() の動作を手元確認するためのものにすぎない。
//
// 実行方法:
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/db/refresh-suggestions.mjs
//
// (run-migrations.mjs と同じ pg + DATABASE_URL の接続方式)
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL not set. Export it (local default: postgresql://postgres:postgres@127.0.0.1:54322/postgres).');
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log('Running refresh_popular_builds()...');
    await client.query('SELECT refresh_popular_builds();');
    console.log('refresh_popular_builds() completed successfully.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Failed to run refresh_popular_builds():', e);
  process.exit(1);
});
