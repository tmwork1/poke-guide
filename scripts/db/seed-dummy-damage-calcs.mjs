// ダメージ計算のサジェスト(ユーザー要望、2026-08-05)の検証用データ投入。
// migrations/020_damage_calc_suggestions.sql の refresh_damage_calc_suggestions() は
// 「同じ型/種族で、ダメージ計算を1件以上持つ個体」が k-匿名性の閾値(既定 min_sample_size=5)
// 以上ないと suggestions を書き出さない。既存の seed-dummy-owned-pokemon.mjs は個体
// (owned_pokemon)しか作らず opponent_notes を1件も作らないため、そのままではサジェストが
// 永久に空になる。このスクリプトが既存のダミー個体に「よく行われているダメージ計算」を
// 分布つきで付与する。
//
// 実行方法(seed-dummy-owned-pokemon.mjs と同じ pg + DATABASE_URL の接続方式):
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/db/seed-dummy-damage-calcs.mjs
//
// 前後に必要な手順:
//   1. npm run seed-dummy-owned-pokemon   … 個体が無ければ先に作る
//   2. npm run backfill-archetypes        … archetype_id を埋める(型粒度の集計に必要)
//   3. このスクリプト
//   4. npm run refresh-suggestions        … refresh_popular_builds() 経由で 020 が走る
//
// 何度実行しても壊れないが、実行のたびにカードが増える(既にダメージ計算を持っている個体は
// 対象外にする、というスキップ判定を入れてあるので、通常は2回目以降ほぼ何も投入しない)。
//
// ⚠️ ここで作る opponent_notes は本番の保存経路(POST /api/opponent-notes)を通らないため、
// 匿名二重記録(damage_calcs/events)は発生しない。020 の集計は opponent_notes を直接見るので
// サジェストの検証には影響しない。
import { Client } from 'pg';
import { SPECIES_POOLS } from './dummy-species-pools.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set. Export it (local default: postgresql://postgres:postgres@127.0.0.1:54322/postgres).');
  process.exit(1);
}

// seed-dummy-owned-pokemon.mjs と同じダミーユーザー(末尾101〜125)だけを対象にする。
// 開発用ログインユーザー(seed-dev-user.mjs の ...0001)の個体には触らない ── 手で作った
// カードが混ざると、画面で確認しているものが投入データなのか自分の入力なのか分からなくなるため。
const DUMMY_USER_IDS = Array.from({ length: 25 }, (_, i) =>
  `00000000-0000-0000-0000-${String(101 + i).padStart(12, '0')}`,
);

// 1個体あたりに付けるダメージ計算カードの枚数。
const MIN_CARDS_PER_POKEMON = 2;
const MAX_CARDS_PER_POKEMON = 5;

const FIXED_IVS = [31, 31, 31, 31, 31, 31]; // チャンピオンズルール: IV=31固定

// 相手として登場するポケモンの「環境で一般的な1つの型」。集計(020)は相手ビルドを項目ごとの
// 最頻値で返すため、1種族につき代表ビルドを1つ決めておけば、サジェストのカードにその
// 持ち物・テラス・努力値がそのまま出る(=画面で値の流れを目視確認できる)。
// 種族名・特性名・持ち物名・技名は SPECIES_POOLS(実在確認済み)から採るか、そこに無いものは
// public/master-data/autocomplete/ に実在する表記を使う。
const OPPONENT_PRESETS = {
  カイリュー: { abilityName: 'マルチスケイル', nature: 'いじっぱり', itemName: 'こだわりハチマキ', teraType: 'ノーマル', evs: [8, 32, 0, 0, 0, 26] },
  ハバタクカミ: { abilityName: 'こだいかっせい', nature: 'おくびょう', itemName: 'こだわりメガネ', teraType: 'フェアリー', evs: [4, 0, 0, 30, 0, 32] },
  パオジアン: { abilityName: 'わざわいのつるぎ', nature: 'ようき', itemName: 'きあいのタスキ', teraType: 'ゴースト', evs: [0, 32, 0, 0, 0, 32] },
  ディンルー: { abilityName: 'わざわいのうつわ', nature: 'わんぱく', itemName: 'たべのこし', teraType: 'みず', evs: [32, 0, 26, 0, 8, 0] },
  イーユイ: { abilityName: 'わざわいのたま', nature: 'ひかえめ', itemName: 'こだわりスカーフ', teraType: 'ほのお', evs: [0, 0, 0, 32, 0, 32] },
  ガブリアス: { abilityName: 'さめはだ', nature: 'ようき', itemName: 'いのちのたま', teraType: 'はがね', evs: [0, 32, 0, 0, 0, 32] },
  ミミッキュ: { abilityName: 'ばけのかわ', nature: 'いじっぱり', itemName: 'いのちのたま', teraType: 'ゴースト', evs: [0, 32, 0, 0, 4, 30] },
  ドラパルト: { abilityName: 'クリアボディ', nature: 'ようき', itemName: 'こだわりスカーフ', teraType: 'ゴースト', evs: [0, 32, 0, 0, 0, 32] },
  サーフゴー: { abilityName: 'おうごんのからだ', nature: 'ひかえめ', itemName: 'たべのこし', teraType: 'みず', evs: [26, 0, 8, 32, 0, 0] },
  キラフロル: { abilityName: 'どくのトゲ', nature: 'おくびょう', itemName: 'きあいのタスキ', teraType: 'くさ', evs: [0, 0, 0, 32, 0, 32] },
  ボーマンダ: { abilityName: 'いかく', nature: 'ようき', itemName: 'とつげきチョッキ', teraType: 'はがね', evs: [0, 32, 0, 0, 0, 32] },
  カビゴン: { abilityName: 'あついしぼう', nature: 'わんぱく', itemName: 'たべのこし', teraType: 'フェアリー', evs: [32, 0, 32, 0, 2, 0] },
  ハッサム: { abilityName: 'テクニシャン', nature: 'いじっぱり', itemName: 'こだわりハチマキ', teraType: 'はがね', evs: [8, 32, 0, 0, 0, 26] },
  ドヒドイデ: { abilityName: 'さいせいりょく', nature: 'ずぶとい', itemName: 'くろいヘドロ', teraType: 'はがね', evs: [32, 0, 32, 0, 2, 0] },
};

// 「この種族を育てている人がよく行うダメージ計算」の分布。1エントリ =
// (攻守の向き, 相手種族, 技) の3つ組で、020 の集計単位とそのまま同じ。
//   direction: 'attack'  … この個体が攻撃側。move は**この個体の技**。
//   direction: 'defense' … 相手が攻撃側。move は**相手の技**。
// weight は重み付き抽選の相対値。itemWeights を書くと、その持ち物を持つ個体だけ重みが
// 差し替わる ── 型(種族名|持ち物名|role)ごとにサジェストの並びが変わることを画面で
// 確認できるようにするための仕掛けで、実際のプレイヤーの傾向(こだわり系は殴る計算、
// 耐久系は受ける計算をよくする)にも沿う。
const MATCHUPS = {
  カイリュー: [
    { direction: 'attack', opponent: 'ドヒドイデ', move: 'じしん', weight: 30, itemWeights: { こだわりハチマキ: 60 } },
    { direction: 'attack', opponent: 'ハバタクカミ', move: 'しんそく', weight: 45, itemWeights: { こだわりハチマキ: 70 } },
    { direction: 'attack', opponent: 'ディンルー', move: 'げきりん', weight: 25 },
    { direction: 'defense', opponent: 'ハバタクカミ', move: 'ムーンフォース', weight: 35, itemWeights: { たべのこし: 70, ゴツゴツメット: 60 } },
    { direction: 'defense', opponent: 'パオジアン', move: 'つららおとし', weight: 40, itemWeights: { たべのこし: 75, ゴツゴツメット: 70 } },
    { direction: 'defense', opponent: 'ミミッキュ', move: 'じゃれつく', weight: 20 },
  ],
  ハバタクカミ: [
    { direction: 'attack', opponent: 'カイリュー', move: 'ムーンフォース', weight: 50 },
    { direction: 'attack', opponent: 'ディンルー', move: 'シャドーボール', weight: 25, itemWeights: { こだわりメガネ: 55 } },
    { direction: 'attack', opponent: 'ドヒドイデ', move: 'マジカルシャイン', weight: 15 },
    { direction: 'defense', opponent: 'パオジアン', move: 'ふいうち', weight: 45 },
    { direction: 'defense', opponent: 'サーフゴー', move: 'ゴールドラッシュ', weight: 30, itemWeights: { とつげきチョッキ: 65 } },
    { direction: 'defense', opponent: 'イーユイ', move: 'かえんほうしゃ', weight: 25, itemWeights: { とつげきチョッキ: 55 } },
  ],
  パオジアン: [
    { direction: 'attack', opponent: 'ディンルー', move: 'つららおとし', weight: 40 },
    { direction: 'attack', opponent: 'サーフゴー', move: 'ふいうち', weight: 35, itemWeights: { こだわりハチマキ: 65 } },
    { direction: 'attack', opponent: 'カビゴン', move: 'せいなるつるぎ', weight: 30 },
    { direction: 'defense', opponent: 'カイリュー', move: 'しんそく', weight: 45, itemWeights: { きあいのタスキ: 70 } },
    { direction: 'defense', opponent: 'ハッサム', move: 'バレットパンチ', weight: 30 },
  ],
  ディンルー: [
    { direction: 'attack', opponent: 'イーユイ', move: 'じしん', weight: 45 },
    { direction: 'attack', opponent: 'キラフロル', move: 'ヘビーボンバー', weight: 20 },
    { direction: 'defense', opponent: 'ハバタクカミ', move: 'ムーンフォース', weight: 40, itemWeights: { とつげきチョッキ: 70 } },
    { direction: 'defense', opponent: 'ガブリアス', move: 'じしん', weight: 35 },
    { direction: 'defense', opponent: 'パオジアン', move: 'せいなるつるぎ', weight: 30, itemWeights: { たべのこし: 60 } },
  ],
  イーユイ: [
    { direction: 'attack', opponent: 'ハッサム', move: 'かえんほうしゃ', weight: 45, itemWeights: { こだわりメガネ: 70 } },
    { direction: 'attack', opponent: 'カビゴン', move: 'あくのはどう', weight: 25 },
    { direction: 'attack', opponent: 'ドヒドイデ', move: 'オーバーヒート', weight: 20 },
    { direction: 'defense', opponent: 'パオジアン', move: 'ふいうち', weight: 40 },
    { direction: 'defense', opponent: 'ドラパルト', move: 'ドラゴンアロー', weight: 30 },
  ],
  ガブリアス: [
    { direction: 'attack', opponent: 'キラフロル', move: 'じしん', weight: 45 },
    { direction: 'attack', opponent: 'サーフゴー', move: 'アイアンヘッド', weight: 25 },
    { direction: 'attack', opponent: 'カイリュー', move: 'げきりん', weight: 30, itemWeights: { こだわりスカーフ: 60 } },
    { direction: 'defense', opponent: 'ハバタクカミ', move: 'ムーンフォース', weight: 30 },
    { direction: 'defense', opponent: 'ミミッキュ', move: 'じゃれつく', weight: 25 },
  ],
  ミミッキュ: [
    { direction: 'attack', opponent: 'カイリュー', move: 'じゃれつく', weight: 45 },
    { direction: 'attack', opponent: 'ドラパルト', move: 'シャドークロー', weight: 30, itemWeights: { いのちのたま: 55 } },
    { direction: 'attack', opponent: 'ディンルー', move: 'ドレインパンチ', weight: 15 },
    { direction: 'defense', opponent: 'ハッサム', move: 'バレットパンチ', weight: 35 },
    { direction: 'defense', opponent: 'サーフゴー', move: 'ゴールドラッシュ', weight: 25 },
  ],
  ドラパルト: [
    { direction: 'attack', opponent: 'カビゴン', move: 'ドラゴンアロー', weight: 40 },
    { direction: 'attack', opponent: 'ハバタクカミ', move: 'ゴーストダイブ', weight: 25 },
    { direction: 'attack', opponent: 'ハッサム', move: 'かえんほうしゃ', weight: 20, itemWeights: { こだわりメガネ: 50 } },
    { direction: 'defense', opponent: 'ミミッキュ', move: 'じゃれつく', weight: 35 },
    { direction: 'defense', opponent: 'イーユイ', move: 'かえんほうしゃ', weight: 25 },
  ],
  サーフゴー: [
    { direction: 'attack', opponent: 'ハバタクカミ', move: 'ゴールドラッシュ', weight: 45 },
    { direction: 'attack', opponent: 'カイリュー', move: 'あくのはどう', weight: 20 },
    { direction: 'defense', opponent: 'パオジアン', move: 'せいなるつるぎ', weight: 40, itemWeights: { たべのこし: 65 } },
    { direction: 'defense', opponent: 'ガブリアス', move: 'じしん', weight: 35 },
    { direction: 'defense', opponent: 'ディンルー', move: 'じしん', weight: 25 },
  ],
  キラフロル: [
    { direction: 'attack', opponent: 'カイリュー', move: 'パワージェム', weight: 30 },
    { direction: 'attack', opponent: 'ドヒドイデ', move: 'エナジーボール', weight: 20 },
    { direction: 'defense', opponent: 'ガブリアス', move: 'じしん', weight: 50, itemWeights: { きあいのタスキ: 75 } },
    { direction: 'defense', opponent: 'ディンルー', move: 'じしん', weight: 35 },
    { direction: 'defense', opponent: 'カイリュー', move: 'しんそく', weight: 25 },
  ],
  ボーマンダ: [
    { direction: 'attack', opponent: 'ハッサム', move: 'だいもんじ', weight: 35 },
    { direction: 'attack', opponent: 'ディンルー', move: 'げきりん', weight: 30 },
    { direction: 'attack', opponent: 'カビゴン', move: 'すてみタックル', weight: 20 },
    { direction: 'defense', opponent: 'ハバタクカミ', move: 'ムーンフォース', weight: 40, itemWeights: { とつげきチョッキ: 65 } },
    { direction: 'defense', opponent: 'パオジアン', move: 'つららおとし', weight: 30 },
  ],
  カビゴン: [
    { direction: 'attack', opponent: 'ハバタクカミ', move: 'すてみタックル', weight: 30 },
    { direction: 'attack', opponent: 'ドヒドイデ', move: 'じしん', weight: 20 },
    { direction: 'defense', opponent: 'パオジアン', move: 'せいなるつるぎ', weight: 50, itemWeights: { たべのこし: 70 } },
    { direction: 'defense', opponent: 'イーユイ', move: 'かえんほうしゃ', weight: 35 },
    { direction: 'defense', opponent: 'ドラパルト', move: 'ドラゴンアロー', weight: 30 },
  ],
  ハッサム: [
    { direction: 'attack', opponent: 'ハバタクカミ', move: 'バレットパンチ', weight: 45, itemWeights: { こだわりハチマキ: 70 } },
    { direction: 'attack', opponent: 'カイリュー', move: 'アイアンヘッド', weight: 30 },
    { direction: 'attack', opponent: 'ディンルー', move: 'インファイト', weight: 20 },
    { direction: 'defense', opponent: 'イーユイ', move: 'かえんほうしゃ', weight: 45 },
    { direction: 'defense', opponent: 'ガブリアス', move: 'じしん', weight: 25 },
  ],
  ドヒドイデ: [
    { direction: 'attack', opponent: 'カイリュー', move: 'ねっとう', weight: 30 },
    { direction: 'attack', opponent: 'ガブリアス', move: 'ねっとう', weight: 25 },
    { direction: 'defense', opponent: 'カイリュー', move: 'じしん', weight: 55, itemWeights: { くろいヘドロ: 75 } },
    { direction: 'defense', opponent: 'ハバタクカミ', move: 'シャドーボール', weight: 40 },
    { direction: 'defense', opponent: 'サーフゴー', move: 'ゴールドラッシュ', weight: 30 },
  ],
};

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// 重み付きサンプリング(重複なし)。seed-dummy-owned-pokemon.mjs の同名関数と同じ実装だが、
// あちらは { value, weight } の配列を扱うのに対し、こちらは重みが個体の持ち物で変わるため
// 呼び出し側で重みを解決してから渡す形にしている。
function weightedSampleWithoutReplacement(entries, n) {
  const remaining = entries.map((entry) => ({ ...entry }));
  const result = [];
  const count = Math.min(n, remaining.length);
  for (let i = 0; i < count; i++) {
    const totalWeight = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) break;
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= remaining[idx].weight;
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    result.push(remaining[idx].entry);
    remaining.splice(idx, 1);
  }
  return result;
}

function resolveWeights(matchups, itemName) {
  return matchups.map((m) => ({
    entry: m,
    weight: (itemName && m.itemWeights && m.itemWeights[itemName]) || m.weight,
  }));
}

// 投入前に、参照している種族名・技名がプール(=実在確認済みの語彙)に含まれているかを確かめる。
// タイポで存在しない技名を入れると、画面上はカードが出るのにダメージ計算だけが失敗する
// (原因の分かりにくい)状態になるため、投入前に落とす。
function validateMatchups() {
  const movesBySpecies = new Map(SPECIES_POOLS.map((p) => [p.species, new Set(p.moves.map((m) => m.value))]));
  const problems = [];
  for (const [species, matchups] of Object.entries(MATCHUPS)) {
    if (!movesBySpecies.has(species)) problems.push(`未知の種族: ${species}`);
    for (const m of matchups) {
      if (!OPPONENT_PRESETS[m.opponent]) problems.push(`${species}: 相手 ${m.opponent} のビルド定義が無い`);
      // 技の持ち主は direction で入れ替わる(attack なら自分、defense なら相手)。
      const owner = m.direction === 'defense' ? m.opponent : species;
      const known = movesBySpecies.get(owner);
      // プールに無い技名でも実在はしうる(プールは代表的な4〜8技しか列挙していない)ため、
      // 落とさず警告にとどめる。存在しない技名の混入は目視で気づけるようにする。
      if (known && !known.has(m.move)) problems.push(`[warn] ${species}: ${owner} の技プールに ${m.move} が無い`);
    }
  }
  return problems;
}

function buildNoteRows(pokemon) {
  const matchups = MATCHUPS[pokemon.species_name];
  if (!matchups) return [];
  const cardCount = randomInt(MIN_CARDS_PER_POKEMON, MAX_CARDS_PER_POKEMON);
  const picked = weightedSampleWithoutReplacement(resolveWeights(matchups, pokemon.item_name), cardCount);
  return picked.map((m, index) => {
    const preset = OPPONENT_PRESETS[m.opponent];
    return {
      owned_pokemon_id: pokemon.id,
      user_id: pokemon.user_id,
      opponent_build: {
        name: m.opponent,
        nature: preset.nature,
        abilityName: preset.abilityName,
        itemName: preset.itemName,
        teraType: preset.teraType,
        evs: preset.evs,
        ivs: FIXED_IVS,
      },
      // 本番の保存経路(src/lib/box-id/damage-calc.ts の saveRow)が書く形と同じにする:
      // direction と attacks[] を field に持ち、move_name には attacks[0].moveName を入れる。
      field: {
        direction: m.direction,
        attacks: [{ moveName: m.move, hitCount: 1 }],
        order: index * 1000,
      },
      move_name: m.move,
    };
  });
}

async function fetchTargetPokemon(client) {
  // 既にダメージ計算を持っている個体は対象外(再実行でカードが際限なく増えないようにする)。
  const { rows } = await client.query(
    `SELECT p.id, p.user_id, p.species_name, p.item_name
       FROM owned_pokemon p
      WHERE p.user_id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM opponent_notes n WHERE n.owned_pokemon_id = p.id)
      ORDER BY p.id`,
    [DUMMY_USER_IDS],
  );
  return rows;
}

async function insertNotes(client, notes) {
  // 1行ずつ素朴にINSERTする(高々数千件のため、多行VALUESにまとめる最適化はしない。
  // seed-dummy-owned-pokemon.mjs の insertOwnedPokemon と同じ方針)。
  for (const note of notes) {
    await client.query(
      `INSERT INTO opponent_notes (owned_pokemon_id, user_id, opponent_build, field, move_name, client_result, memo)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NULL, NULL)`,
      [note.owned_pokemon_id, note.user_id, JSON.stringify(note.opponent_build), JSON.stringify(note.field), note.move_name],
    );
  }
}

async function main() {
  const problems = validateMatchups();
  const fatal = problems.filter((p) => !p.startsWith('[warn]'));
  for (const p of problems) console.warn(p);
  if (fatal.length > 0) {
    console.error(`Matchup定義に${fatal.length}件の問題があります。投入を中止します。`);
    process.exit(2);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const targets = await fetchTargetPokemon(client);
    if (targets.length === 0) {
      console.log('対象の個体がありません(すべてダメージ計算を持っているか、ダミー個体が未投入です)。');
      console.log('個体が無い場合は先に `npm run seed-dummy-owned-pokemon` を実行してください。');
      return;
    }
    const notes = targets.flatMap(buildNoteRows);
    await insertNotes(client, notes);
    console.log(`Dummy opponent_notes inserted: ${notes.length} (対象個体: ${targets.length})`);

    const { rows: coverage } = await client.query(
      `SELECT p.species_name, count(DISTINCT p.id) AS pokemon_with_calcs
         FROM owned_pokemon p
         JOIN opponent_notes n ON n.owned_pokemon_id = p.id
        WHERE p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now()
        GROUP BY p.species_name
        ORDER BY 2 DESC`,
    );
    console.log('種族ごとの母集団(収集拒否を除く、ダメージ計算を持つ個体数):');
    for (const row of coverage) console.log(`  ${row.species_name}: ${row.pokemon_with_calcs}`);
    console.log('Next: `npm run backfill-archetypes` (型粒度に必要) → `npm run refresh-suggestions`');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
