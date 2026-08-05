// 匿名集計サジェスト機能・第3段階(ダミーデータ投入)。
// refresh_popular_builds()(migrations/009_popular_build_suggestions.sql)は種族ごとに
// k-匿名性の閾値(既定 min_sample_size=5)以上のサンプルが無いと suggestions テーブルへ
// 書き込まない。ローカル/開発環境で性格・アイテム・テラス・技サジェストの表示を確認するには
// 種族ごとに十分なサンプル数を持つ owned_pokemon が必要なため、このスクリプトで複数の
// ダミーユーザーに分散したダミー個体を大量投入する。
//
// 実行方法(seed-dev-user.mjs / refresh-suggestions.mjs と同じ pg + DATABASE_URL の接続方式):
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/db/seed-dummy-owned-pokemon.mjs
//
// 投入後、集計に反映するには refresh-suggestions.mjs を実行する:
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/db/refresh-suggestions.mjs
// (npm run seed-dummy-owned-pokemon && npm run refresh-suggestions)
//
// このスクリプトは何度実行しても安全(ダミーユーザーは決定的UUIDでON CONFLICT DO NOTHING、
// owned_pokemon 側は毎回新規INSERTのため、繰り返し実行するとサンプル数が増えていく)。
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set. Export it (local default: postgresql://postgres:postgres@127.0.0.1:54322/postgres).');
  process.exit(1);
}

// ダミーユーザー: seed-dev-user.mjs の DEV_USER_ID ('00000000-0000-0000-0000-000000000001')
// と衝突しないよう、末尾を 101〜125 にした決定的UUIDを使う(1ユーザーに集中させず、
// 複数ユーザーの集合知に近い分布にするため25人)。
const DUMMY_USER_COUNT = 25;
const dummyUsers = Array.from({ length: DUMMY_USER_COUNT }, (_, i) => {
  const n = 101 + i;
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    email: `dummy-user-${n}@localhost`,
    name: `ダミーユーザー${n}`,
  };
});

// 種族ごとの性格/アイテム/テラス/技候補プールは scripts/db/dummy-species-pools.mjs へ切り出した
// (ダメージ計算サジェストの検証データ投入 seed-dummy-damage-calcs.mjs が同じ語彙を必要とするため。
//  中身は移設時点から変更していない)。
import { SPECIES_POOLS } from './dummy-species-pools.mjs';

const MIN_INDIVIDUALS_PER_SPECIES = 20;
const MAX_INDIVIDUALS_PER_SPECIES = 40;
// 収集拒否(collection_opt_out_until に未来日付)を混ぜる割合(1〜2割程度)
const OPT_OUT_RATIO = 0.15;

function randomInt(min, max) {
  // [min, max] 両端含む
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickOne(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

// 重み付きランダムサンプリング(重複なし)。weighted reservoir 的な単純実装:
// 候補が尽きるか n 件選び終わるまで、残った候補の重み比でランダムに1件ずつ抜き取る。
function weightedSampleWithoutReplacement(pool, n) {
  const remaining = pool.map((item) => ({ ...item }));
  const result = [];
  const count = Math.min(n, remaining.length);
  for (let i = 0; i < count; i++) {
    const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    result.push(remaining[idx].value);
    remaining.splice(idx, 1);
  }
  return result;
}

function weightedPickOne(pool) {
  return weightedSampleWithoutReplacement(pool, 1)[0];
}

// evs: 6要素、各0〜32(owned-pokemon-validation.ts の isStatArray(evs, 32)と同形式)。
// 全部32である必要はなく、ある程度ばらけさせる(0〜32の一様乱数を4刻みで丸める程度)。
function randomEvs() {
  return Array.from({ length: 6 }, () => {
    const raw = randomInt(0, 8) * 4; // 0,4,8,...,32
    return Math.min(raw, 32);
  });
}

const FIXED_IVS = [31, 31, 31, 31, 31, 31]; // チャンピオンズルール: IV=31固定

function buildOwnedPokemonRows() {
  const rows = [];
  for (const pool of SPECIES_POOLS) {
    const individualCount = randomInt(MIN_INDIVIDUALS_PER_SPECIES, MAX_INDIVIDUALS_PER_SPECIES);
    for (let i = 0; i < individualCount; i++) {
      const user = pickOne(dummyUsers);
      const isOptedOut = Math.random() < OPT_OUT_RATIO;
      const optOutUntil = isOptedOut
        ? new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString() // now() + 15日(未来日付)
        : null;
      rows.push({
        user_id: user.id,
        species_name: pool.species,
        nature: weightedPickOne(pool.natures),
        item_name: weightedPickOne(pool.items),
        tera_type: weightedPickOne(pool.teras),
        move_names: weightedSampleWithoutReplacement(pool.moves, 4),
        evs: randomEvs(),
        collection_opt_out_until: optOutUntil,
      });
    }
  }
  return rows;
}

async function insertDummyUsers(client) {
  for (const user of dummyUsers) {
    await client.query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       VALUES ($1, 'authenticated', 'authenticated', $2, '{"provider":"dev","providers":["dev"]}'::jsonb, $3::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.email, JSON.stringify({ full_name: user.name })]
    );
  }
  console.log(`Dummy users ready: ${dummyUsers.length}`);
}

async function insertOwnedPokemon(client, rows) {
  // 1行ずつ素朴にINSERTする(投入件数は最大でも種族数×40程度で高々数百件のため、
  // 多行VALUESにまとめる最適化は行わず可読性を優先する)。
  for (const row of rows) {
    await client.query(
      `INSERT INTO owned_pokemon
         (user_id, nickname, species_name, level, nature, ability_name, item_name, tera_type,
          evs, ivs, move_names, memo, tags, is_pinned, collection_opt_out_until)
       VALUES
         ($1, NULL, $2, 50, $3, NULL, $4, $5,
          $6::jsonb, $7::jsonb, $8, NULL, '{}', false, $9)`,
      [
        row.user_id,
        row.species_name,
        row.nature,
        row.item_name,
        row.tera_type,
        JSON.stringify(row.evs),
        JSON.stringify(FIXED_IVS),
        row.move_names,
        row.collection_opt_out_until,
      ]
    );
  }
  console.log(`Dummy owned_pokemon inserted: ${rows.length}`);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await insertDummyUsers(client);
    const rows = buildOwnedPokemonRows();
    await insertOwnedPokemon(client, rows);

    const optedOutCount = rows.filter((r) => r.collection_opt_out_until !== null).length;
    console.log(`  (うち収集拒否中: ${optedOutCount}件, 種族数: ${SPECIES_POOLS.length})`);
    console.log('Next: run `npm run refresh-suggestions` (or `node scripts/db/refresh-suggestions.mjs`) to recompute suggestions.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
