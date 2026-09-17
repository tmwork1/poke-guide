// astro dev が使う通常／匿名の固定ユーザー(src/lib/user-session.ts と同じ id)を auth.users に
// 登録する。poke-commons には public.users のようなプロフィールミラーテーブルを
// 作らない設計のため(育成データ管理計画.md §3.1)、poke-research 版と異なり auth.users への
// 挿入のみを行う。
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set. Export it (local default: postgresql://postgres:postgres@127.0.0.1:54322/postgres).');
  process.exit(1);
}

const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
const DEV_USER_EMAIL = 'dev@localhost';
const DEV_USER_NAME = 'ローカル開発ユーザー';
const DEV_ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000002';

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, '{"provider":"dev","providers":["dev"]}'::jsonb, $3::jsonb, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [DEV_USER_ID, DEV_USER_EMAIL, JSON.stringify({ full_name: DEV_USER_NAME })]
    );
    await client.query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', NULL, '{"provider":"dev","providers":["dev"]}'::jsonb, '{}'::jsonb, true, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [DEV_ANONYMOUS_USER_ID],
    );
    const { rows } = await client.query('SELECT id, email, is_anonymous FROM auth.users WHERE id = ANY($1::uuid[]) ORDER BY id', [[DEV_USER_ID, DEV_ANONYMOUS_USER_ID]]);
    console.log('Dev users ready:', rows);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
