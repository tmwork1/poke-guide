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

// 種族ごとの性格/アイテム/テラス/技候補プール。名前は public/master-data/autocomplete/
// (pokemon.json / items.json / moves.json)に実在することを確認済み(存在しない名前だと
// オートコンプリート等と整合しなくなるため)。性格名は vendor/jpoke/src/jpoke/data/nature.py の
// NATURE_MODIFIER キーに実在する表記、テラスタイプは src/lib/tera-types.ts の TERA_TYPES に
// 実在する表記を使う。weight は重み付きランダムサンプリングの相対重み(合計100である必要はない)。
const SPECIES_POOLS = [
  {
    species: 'カイリュー',
    natures: [
      { value: 'いじっぱり', weight: 40 },
      { value: 'ようき', weight: 35 },
      { value: 'ずぶとい', weight: 15 },
      { value: 'わんぱく', weight: 10 },
    ],
    items: [
      { value: 'こだわりハチマキ', weight: 35 },
      { value: 'いのちのたま', weight: 30 },
      { value: 'たべのこし', weight: 20 },
      { value: 'ゴツゴツメット', weight: 15 },
    ],
    teras: [
      { value: 'ほのお', weight: 30 },
      { value: 'はがね', weight: 25 },
      { value: 'ノーマル', weight: 25 },
      { value: 'みず', weight: 20 },
    ],
    moves: [
      { value: 'じしん', weight: 30 },
      { value: 'げきりん', weight: 25 },
      { value: 'しんそく', weight: 20 },
      { value: 'りゅうのまい', weight: 20 },
      { value: 'つばめがえし', weight: 15 },
      { value: 'アイアンヘッド', weight: 15 },
      { value: 'とんぼがえり', weight: 10 },
      { value: 'ステルスロック', weight: 5 },
    ],
  },
  {
    species: 'ハバタクカミ',
    natures: [
      { value: 'ひかえめ', weight: 35 },
      { value: 'おくびょう', weight: 35 },
      { value: 'おだやか', weight: 15 },
      { value: 'ずぶとい', weight: 15 },
    ],
    items: [
      { value: 'いのちのたま', weight: 30 },
      { value: 'こだわりメガネ', weight: 25 },
      { value: 'とつげきチョッキ', weight: 25 },
      { value: 'たべのこし', weight: 20 },
    ],
    teras: [
      { value: 'フェアリー', weight: 30 },
      { value: 'ゴースト', weight: 25 },
      { value: 'みず', weight: 25 },
      { value: 'でんき', weight: 20 },
    ],
    moves: [
      { value: 'ムーンフォース', weight: 30 },
      { value: 'シャドーボール', weight: 25 },
      { value: 'なやみのタネ', weight: 20 },
      { value: 'ちょうはつ', weight: 20 },
      { value: 'こごえるかぜ', weight: 15 },
      { value: 'マジカルシャイン', weight: 10 },
      { value: 'しんぴのまもり', weight: 10 },
      { value: 'ドレインパンチ', weight: 5 },
    ],
  },
  {
    species: 'パオジアン',
    natures: [
      { value: 'いじっぱり', weight: 40 },
      { value: 'ようき', weight: 35 },
      { value: 'わんぱく', weight: 15 },
      { value: 'ゆうかん', weight: 10 },
    ],
    items: [
      { value: 'くろいてっきゅう', weight: 30 },
      { value: 'いのちのたま', weight: 25 },
      { value: 'こだわりスカーフ', weight: 20 },
      { value: 'きあいのタスキ', weight: 15 },
    ],
    teras: [
      { value: 'あく', weight: 30 },
      { value: 'みず', weight: 25 },
      { value: 'くさ', weight: 25 },
      { value: 'はがね', weight: 20 },
    ],
    moves: [
      { value: 'つららばり', weight: 25 },
      { value: 'ふいうち', weight: 20 },
      { value: 'つるぎのまい', weight: 20 },
      { value: 'けたぐり', weight: 15 },
      { value: 'インファイト', weight: 15 },
      { value: 'こおりのつぶて', weight: 15 },
      { value: 'どくづき', weight: 10 },
      { value: 'かわらわり', weight: 5 },
    ],
  },
  {
    species: 'ディンルー',
    natures: [
      { value: 'わんぱく', weight: 35 },
      { value: 'のんき', weight: 25 },
      { value: 'ずぶとい', weight: 20 },
      { value: 'ゆうかん', weight: 20 },
    ],
    items: [
      { value: 'たべのこし', weight: 30 },
      { value: 'ゴツゴツメット', weight: 30 },
      { value: 'しんかのきせき', weight: 25 },
      { value: 'オボンのみ', weight: 15 },
    ],
    teras: [
      { value: 'みず', weight: 30 },
      { value: 'くさ', weight: 25 },
      { value: 'はがね', weight: 25 },
      { value: 'あく', weight: 20 },
    ],
    moves: [
      { value: 'じしん', weight: 30 },
      { value: 'いわなだれ', weight: 20 },
      { value: 'ステルスロック', weight: 20 },
      { value: 'どくどく', weight: 15 },
      { value: 'あくび', weight: 15 },
      { value: 'ボディプレス', weight: 10 },
      { value: 'てっぺき', weight: 10 },
      { value: 'ふいうち', weight: 10 },
    ],
  },
  {
    species: 'イーユイ',
    natures: [
      { value: 'ひかえめ', weight: 35 },
      { value: 'おくびょう', weight: 25 },
      { value: 'おだやか', weight: 20 },
      { value: 'ずぶとい', weight: 20 },
    ],
    items: [
      { value: 'いのちのたま', weight: 30 },
      { value: 'こだわりメガネ', weight: 25 },
      { value: 'とつげきチョッキ', weight: 25 },
      { value: 'たべのこし', weight: 20 },
    ],
    teras: [
      { value: 'ほのお', weight: 30 },
      { value: 'あく', weight: 25 },
      { value: 'フェアリー', weight: 25 },
      { value: 'みず', weight: 20 },
    ],
    moves: [
      { value: 'かえんだん', weight: 25 },
      { value: 'マジカルフレイム', weight: 20 },
      { value: 'ちょうはつ', weight: 20 },
      { value: 'なやみのタネ', weight: 15 },
      { value: 'ミラーコート', weight: 10 },
      { value: 'じこさいせい', weight: 10 },
      { value: 'パワージェム', weight: 5 },
      { value: 'どくどく', weight: 5 },
    ],
  },
  {
    species: 'ガブリアス',
    natures: [
      { value: 'いじっぱり', weight: 35 },
      { value: 'ようき', weight: 35 },
      { value: 'ゆうかん', weight: 15 },
      { value: 'わんぱく', weight: 15 },
    ],
    items: [
      { value: 'いのちのたま', weight: 25 },
      { value: 'こだわりスカーフ', weight: 25 },
      { value: 'たつじんのおび', weight: 20 },
      { value: 'きあいのタスキ', weight: 20 },
    ],
    teras: [
      { value: 'ドラゴン', weight: 25 },
      { value: 'じめん', weight: 25 },
      { value: 'はがね', weight: 25 },
      { value: 'みず', weight: 25 },
    ],
    moves: [
      { value: 'じしん', weight: 30 },
      { value: 'げきりん', weight: 20 },
      { value: 'つるぎのまい', weight: 20 },
      { value: 'いわなだれ', weight: 15 },
      { value: 'とんぼがえり', weight: 15 },
      { value: 'ステルスロック', weight: 10 },
      { value: 'からをやぶる', weight: 10 },
      { value: 'しんそく', weight: 10 },
    ],
  },
  {
    species: 'ミミッキュ',
    natures: [
      { value: 'いじっぱり', weight: 40 },
      { value: 'ようき', weight: 35 },
      { value: 'ずぶとい', weight: 15 },
      { value: 'わんぱく', weight: 10 },
    ],
    items: [
      { value: 'いのちのたま', weight: 25 },
      { value: 'たべのこし', weight: 25 },
      { value: 'ゴツゴツメット', weight: 20 },
      { value: 'きあいのタスキ', weight: 20 },
    ],
    teras: [
      { value: 'フェアリー', weight: 30 },
      { value: 'ゴースト', weight: 30 },
      { value: 'ノーマル', weight: 20 },
      { value: 'はがね', weight: 20 },
    ],
    moves: [
      { value: 'じゃれつく', weight: 30 },
      { value: 'シャドーボール', weight: 25 },
      { value: 'つるぎのまい', weight: 20 },
      { value: 'どくづき', weight: 15 },
      { value: 'おにび', weight: 15 },
      { value: 'マジカルシャイン', weight: 10 },
      { value: 'あくび', weight: 10 },
      { value: 'ちょうはつ', weight: 10 },
    ],
  },
  {
    species: 'ドラパルト',
    natures: [
      { value: 'ようき', weight: 40 },
      { value: 'いじっぱり', weight: 30 },
      { value: 'おくびょう', weight: 15 },
      { value: 'ずぶとい', weight: 15 },
    ],
    items: [
      { value: 'こだわりスカーフ', weight: 25 },
      { value: 'いのちのたま', weight: 30 },
      { value: 'こだわりメガネ', weight: 20 },
      { value: 'きあいのタスキ', weight: 15 },
    ],
    teras: [
      { value: 'ゴースト', weight: 25 },
      { value: 'ドラゴン', weight: 25 },
      { value: 'フェアリー', weight: 20 },
      { value: 'はがね', weight: 20 },
    ],
    moves: [
      { value: 'シャドーボール', weight: 25 },
      { value: 'げきりん', weight: 20 },
      { value: 'とんぼがえり', weight: 20 },
      { value: 'りゅうせいぐん', weight: 15 },
      { value: 'ふいうち', weight: 15 },
      { value: 'マジカルシャイン', weight: 10 },
      { value: 'ちょうはつ', weight: 10 },
      { value: 'しんそく', weight: 10 },
    ],
  },
  {
    species: 'サーフゴー',
    natures: [
      { value: 'ひかえめ', weight: 30 },
      { value: 'おくびょう', weight: 25 },
      { value: 'ようき', weight: 20 },
      { value: 'いじっぱり', weight: 20 },
    ],
    items: [
      { value: 'たべのこし', weight: 25 },
      { value: 'いのちのたま', weight: 25 },
      { value: 'とつげきチョッキ', weight: 20 },
      { value: 'きあいのタスキ', weight: 15 },
    ],
    teras: [
      { value: 'はがね', weight: 25 },
      { value: 'ゴースト', weight: 25 },
      { value: 'みず', weight: 20 },
      { value: 'くさ', weight: 20 },
    ],
    moves: [
      { value: 'シャドーボール', weight: 25 },
      { value: 'ラスターカノン', weight: 20 },
      { value: 'どくどく', weight: 15 },
      { value: 'あくび', weight: 15 },
      { value: 'じこさいせい', weight: 15 },
      { value: 'マジカルシャイン', weight: 10 },
      { value: 'ちょうはつ', weight: 10 },
      { value: 'コメットパンチ', weight: 10 },
    ],
  },
  {
    species: 'キラフロル',
    natures: [
      { value: 'おくびょう', weight: 30 },
      { value: 'ひかえめ', weight: 25 },
      { value: 'おだやか', weight: 20 },
      { value: 'ずぶとい', weight: 25 },
    ],
    items: [
      { value: 'きあいのタスキ', weight: 25 },
      { value: 'いのちのたま', weight: 25 },
      { value: 'たべのこし', weight: 20 },
      { value: 'ものしりメガネ', weight: 20 },
    ],
    teras: [
      { value: 'どく', weight: 25 },
      { value: 'いわ', weight: 25 },
      { value: 'くさ', weight: 25 },
      { value: 'エスパー', weight: 25 },
    ],
    moves: [
      { value: 'パワージェム', weight: 25 },
      { value: 'どくづき', weight: 20 },
      { value: 'どくどく', weight: 15 },
      { value: 'ちょうはつ', weight: 15 },
      { value: 'なやみのタネ', weight: 10 },
      { value: 'ミラーコート', weight: 5 },
      { value: 'だいちのちから', weight: 10 },
      { value: 'がんせきふうじ', weight: 10 },
    ],
  },
  {
    species: 'ボーマンダ',
    natures: [
      { value: 'いじっぱり', weight: 35 },
      { value: 'ようき', weight: 30 },
      { value: 'ゆうかん', weight: 20 },
      { value: 'わんぱく', weight: 15 },
    ],
    items: [
      { value: 'いのちのたま', weight: 30 },
      { value: 'こだわりスカーフ', weight: 20 },
      { value: 'たつじんのおび', weight: 20 },
      { value: 'きあいのタスキ', weight: 15 },
    ],
    teras: [
      { value: 'はがね', weight: 25 },
      { value: 'ノーマル', weight: 25 },
      { value: 'みず', weight: 25 },
      { value: 'ドラゴン', weight: 25 },
    ],
    moves: [
      { value: 'げきりん', weight: 25 },
      { value: 'じしん', weight: 20 },
      { value: 'つるぎのまい', weight: 20 },
      { value: 'しんそく', weight: 15 },
      { value: 'とんぼがえり', weight: 10 },
      { value: 'いわなだれ', weight: 10 },
      { value: 'ステルスロック', weight: 5 },
      { value: 'からをやぶる', weight: 5 },
    ],
  },
  {
    species: 'カビゴン',
    natures: [
      { value: 'わんぱく', weight: 30 },
      { value: 'いじっぱり', weight: 25 },
      { value: 'のんき', weight: 25 },
      { value: 'ずぶとい', weight: 20 },
    ],
    items: [
      { value: 'たべのこし', weight: 30 },
      { value: 'ゴツゴツメット', weight: 25 },
      { value: 'しんかのきせき', weight: 20 },
      { value: 'オボンのみ', weight: 15 },
    ],
    teras: [
      { value: 'ノーマル', weight: 30 },
      { value: 'フェアリー', weight: 25 },
      { value: 'みず', weight: 25 },
      { value: 'はがね', weight: 20 },
    ],
    moves: [
      { value: 'ボディプレス', weight: 20 },
      { value: 'じしん', weight: 20 },
      { value: 'あくび', weight: 15 },
      { value: 'どくどく', weight: 15 },
      { value: 'いばる', weight: 10 },
      { value: 'からをやぶる', weight: 15 },
      { value: 'ちいさくなる', weight: 5 },
      { value: 'マッハパンチ', weight: 10 },
    ],
  },
  {
    species: 'ハッサム',
    natures: [
      { value: 'いじっぱり', weight: 35 },
      { value: 'わんぱく', weight: 25 },
      { value: 'ずぶとい', weight: 20 },
      { value: 'ようき', weight: 20 },
    ],
    items: [
      { value: 'とつげきチョッキ', weight: 25 },
      { value: 'たべのこし', weight: 25 },
      { value: 'ゴツゴツメット', weight: 25 },
      { value: 'いのちのたま', weight: 20 },
    ],
    teras: [
      { value: 'みず', weight: 25 },
      { value: 'はがね', weight: 25 },
      { value: 'ノーマル', weight: 25 },
      { value: 'どく', weight: 25 },
    ],
    moves: [
      { value: 'とんぼがえり', weight: 25 },
      { value: 'ばくれつパンチ', weight: 20 },
      { value: 'つるぎのまい', weight: 20 },
      { value: 'とびひざげり', weight: 15 },
      { value: 'インファイト', weight: 15 },
      { value: 'マッハパンチ', weight: 10 },
      { value: 'アイアンヘッド', weight: 10 },
      { value: 'ふいうち', weight: 5 },
    ],
  },
  {
    species: 'ドヒドイデ',
    natures: [
      { value: 'わんぱく', weight: 30 },
      { value: 'しんちょう', weight: 25 },
      { value: 'のんき', weight: 20 },
      { value: 'ずぶとい', weight: 25 },
    ],
    items: [
      { value: 'たべのこし', weight: 30 },
      { value: 'ゴツゴツメット', weight: 30 },
      { value: 'しんかのきせき', weight: 20 },
      { value: 'オボンのみ', weight: 20 },
    ],
    teras: [
      { value: 'くさ', weight: 25 },
      { value: 'でんき', weight: 25 },
      { value: 'エスパー', weight: 25 },
      { value: 'みず', weight: 25 },
    ],
    moves: [
      { value: 'どくどく', weight: 25 },
      { value: 'あくび', weight: 20 },
      { value: 'じこさいせい', weight: 20 },
      { value: 'ボディプレス', weight: 15 },
      { value: 'ミラーコート', weight: 10 },
      { value: 'とおせんぼう', weight: 10 },
      { value: 'がんせきふうじ', weight: 10 },
      { value: 'てっぺき', weight: 5 },
    ],
  },
];

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
