import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set. Export it (local default: postgresql://postgres:postgres@127.0.0.1:54322/postgres).');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await client.query('SELECT public.delete_stale_anonymous_users()');
  console.log('Stale anonymous users cleanup completed.');
} finally {
  await client.end();
}
