#!/usr/bin/env node
/**
 * ローカルのMiniflare KV(OPGG_USAGE)へ、本番相当の「形と量」を持つ合成使用率データを投入する。
 *
 * 【なぜ実データを取りに行かないのか】
 *   `fetch-champions-usage.mjs --local` は op.gg から実データを取れるが、
 *   (1) 取得のたびに中身が変わるので計測の再現性がない、(2) op.gg のHTML構造変更で壊れる、
 *   (3) 235件を順次取得するのに数分かかる、という理由でパフォーマンス計測の土台には向かない。
 *   ここで作るのは「件数・カテゴリ数・1カテゴリあたりの行数」を本番に合わせた合成データで、
 *   正規化処理・描画件数のコストは本番相当になる。使用率の分布そのものは本物ではない。
 *
 * 【なぜ必要か】
 *   wrangler.jsonc の OPGG_USAGE を remote: false にした副作用で、ローカルKVは空スタートになる
 *   (docs/perf/dashboard.md「✅ 解消済み」節)。その結果 /data・/box/data・/box/matchup は
 *   dev では常に空状態しか描画せず、実データ経路のコストがどの計測にも現れない
 *   (docs/perf/reports/README.md「横断課題1: 計測網の穴」)。バトルデータカードのように
 *   「使用率データがある場合だけ描画される」UIも、投入前は存在自体を確認できない。
 *
 * 【技・特性はその種族が実際に覚える/持てるものを使う】
 *   全種族で同じ名前プールから引くと、カードの行が個体の選択値と一生一致せず、
 *   「選択中の行をハイライト」のようなUIをローカルで確認できない。技は learnsets.json、
 *   特性は pokemon-core.json のその種族ぶんから引く。
 *
 * 使い方:
 *   node scripts/opgg/seed-local-usage.mjs              # ボックス内の種族を優先しつつ235件を投入
 *   node scripts/opgg/seed-local-usage.mjs --limit 50   # 件数を変えて投入
 *   node scripts/opgg/seed-local-usage.mjs --no-db      # DB参照をやめ、図鑑番号順だけで選ぶ
 *   node scripts/opgg/seed-local-usage.mjs --clear      # 投入したデータを消す(currentポインタを削除)
 *
 * KVのキー構造は fetch-champions-usage.mjs と同一で、src/lib/opgg-usage.ts が読む形に合わせてある。
 *   current                                  -> { schemaVersion: 1, manifestVersion, publishedAt }
 *   <version>:seasons                        -> OpggUsageSeasonManifest (schemaVersion: 2)
 *   <version>:season:<dir>:list              -> OpggUsageList (schemaVersion: 1)
 *   <version>:season:<dir>:pokemon:<slug>    -> OpggUsagePokemon (schemaVersion: 3)
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MASTER = new URL('../../public/master-data/autocomplete/', import.meta.url);
const DETAIL = new URL('../../public/master-data/detail/', import.meta.url);
const ENV_LOCAL = new URL('../../.env.local', import.meta.url);

// 本番のOP.GGシングル使用率は、ランキング掲載ぶんの約235種族ぶんが1シーズンに入る。
// 件数を変えると docs/perf の計測値と比較できなくなるので、既定値は動かさない。
const DEFAULT_LIMIT = 235;
// 1カテゴリあたりの行数。OP.GGの各カードは上位N件だけを出す。
const ROWS = { moves: 10, items: 10, abilities: 5, natures: 5, evs: 5, teammates: 10 };
const NATURES = ['いじっぱり', 'ようき', 'ひかえめ', 'おくびょう', 'ずぶとい', 'しんちょう', 'わんぱく', 'おだやか'];
const EV_KEYS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];

function options(argv) {
  const result = { limit: DEFAULT_LIMIT, clear: false, useDb: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: node scripts/opgg/seed-local-usage.mjs [--limit n] [--no-db] [--clear]');
      process.exit(0);
    }
    if (flag === '--clear') { result.clear = true; continue; }
    if (flag === '--no-db') { result.useDb = false; continue; }
    if (flag === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit must be a positive integer');
      result.limit = value;
      continue;
    }
    throw new Error('Invalid option: ' + flag);
  }
  return result;
}

/**
 * 乱数は固定シードにする。実行のたびに中身が変わると、計測値の差が「改善したのか
 * データが変わったのか」判別できなくなるため。
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function loadJson(base, name) {
  return JSON.parse(await readFile(new URL(name, base), 'utf8'));
}

/** 固定シードのFisher-Yatesで並べ替える。種族ごとに違う顔ぶれが上位に来るようにするため。 */
function shuffled(names, random) {
  const pool = [...names];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

/** 使用率は上位ほど高く、単調減少する実データの形に寄せる。 */
function rankedRows(names, count, random) {
  const rows = [];
  let rate = 30 + random() * 50;
  for (let rank = 1; rank <= count && rank <= names.length; rank += 1) {
    rows.push({ rank, name: names[(rank - 1) % names.length], usageRate: Math.round(rate * 10) / 10 });
    rate = Math.max(0.5, rate * (0.55 + random() * 0.3));
  }
  return rows;
}

/**
 * OP.GG(チャンピオンズ)の努力値は本アプリと同じ0〜32スケールで返ってくる
 * (src/lib/stats.ts の chmpToLegacyEffort 付近のコメント)。0〜252スケールで入れると
 * 個体編集フォームの値と桁が合わず、努力値行の照合が一生一致しなくなる。
 */
function evRows(count, random, fixed = []) {
  const rows = [];
  let rate = 20 + random() * 40;
  for (let rank = 1; rank <= count; rank += 1) {
    const preset = fixed[rank - 1];
    const values = preset ?? randomEvValues(random);
    rows.push({ rank, usageRate: Math.round(rate * 10) / 10, values });
    rate = Math.max(0.5, rate * (0.55 + random() * 0.3));
  }
  return rows;
}

/** 合計64前後(実データの配分と同程度)に収まる0〜32の配分を作る。 */
function randomEvValues(random) {
  const values = {};
  let remaining = 64;
  for (const [index, key] of EV_KEYS.entries()) {
    const value = index === EV_KEYS.length - 1
      ? Math.min(32, remaining)
      : Math.min(32, Math.max(0, Math.round(random() * Math.min(32, remaining))));
    values[key] = value;
    remaining = Math.max(0, remaining - value);
  }
  return values;
}

async function wrangler(args) {
  return execFile('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
}

/** 1件ずつ put すると件数ぶんプロセスを起動することになるので、bulk put で1回にまとめる。 */
async function bulkPut(pairs) {
  const directory = await mkdtemp(join(tmpdir(), 'opgg-seed-'));
  const path = join(directory, 'bulk.json');
  try {
    await writeFile(path, JSON.stringify(pairs.map(([key, value]) => ({ key, value: JSON.stringify(value) }))), 'utf8');
    await wrangler(['kv', 'bulk', 'put', path, '--binding', 'OPGG_USAGE', '--local']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * ローカルDBのボックスに入っている個体を、種族ごとの所持数が多い順に返す。
 *
 * 図鑑番号順で235件を切ると初代〜2世代しか入らず、手元の個体には一件も当たらない
 * (=バトルデータタブがdevで一度も描画されない)ので、実際に持っている種族を先に入れる。
 * さらに、手持ちの構成(特性・もちもの・性格・技)を使用率上位に混ぜることで、
 * 「選択中の行をハイライト」のようなUIがローカルでも必ず当たる状態にする。
 *
 * DBが落ちている・.env.localが無い場合でも投入自体は続行できるよう、空配列を返す。
 */
async function loadOwnedBuilds() {
  let connectionString;
  try {
    connectionString = (await readFile(ENV_LOCAL, 'utf8')).match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
  } catch {
    connectionString = undefined;
  }
  if (!connectionString) {
    console.warn('DATABASE_URL not found in .env.local; falling back to dex order.');
    return [];
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query(`
      select o.species_name, o.ability_name, o.item_name, o.nature, o.move_names, o.evs
      from owned_pokemon o
      join (select species_name, count(*) as total from owned_pokemon group by 1) c
        on c.species_name = o.species_name
      order by c.total desc, o.species_name, o.created_at
    `);
    return rows;
  } catch (error) {
    console.warn('Could not read owned_pokemon (' + error.message + '); falling back to dex order.');
    return [];
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * 投入対象の種族を決める。手持ちの種族を先頭に置き、残りを図鑑番号順で埋める。
 * OP.GGの使用率はメガフォルムではベースフォルムに集計される(opgg-usage.ts の
 * resolveOpggSpeciesName)ので、メガは対応するベースフォルムへ寄せる。メガ以外の
 * フォルム違い(リージョン・すがた)は独立した名前で引かれるため、手持ちにあるぶんは
 * そのフォルム名のまま投入する。
 */
function selectSpecies(master, ownedRows, limit) {
  const byName = new Map(master.map((entry) => [entry.name, entry]));
  const baseByDexNo = new Map(master.filter((entry) => entry.forme === null).map((entry) => [entry.dexNo, entry]));
  const selected = new Map();
  const ownedByName = new Map();

  for (const row of ownedRows) {
    const entry = byName.get(row.species_name);
    if (!entry) continue;
    const target = entry.forme?.startsWith('Mega') ? baseByDexNo.get(entry.dexNo) : entry;
    if (!target) continue;
    if (!selected.has(target.name)) {
      if (selected.size >= limit) continue;
      selected.set(target.name, target);
      ownedByName.set(target.name, { abilities: [], items: [], natures: [], moves: [], evs: [] });
    }
    const build = ownedByName.get(target.name);
    for (const [key, value] of [['abilities', row.ability_name], ['items', row.item_name], ['natures', row.nature]]) {
      if (value && !build[key].includes(value)) build[key].push(value);
    }
    for (const move of row.move_names ?? []) {
      if (move && !build.moves.includes(move)) build.moves.push(move);
    }
    if (Array.isArray(row.evs) && row.evs.length === EV_KEYS.length) {
      const values = Object.fromEntries(EV_KEYS.map((key, index) => [key, Number(row.evs[index]) || 0]));
      const signature = JSON.stringify(values);
      if (!build.evs.some((existing) => JSON.stringify(existing) === signature)) build.evs.push(values);
    }
  }
  for (const entry of master) {
    if (selected.size >= limit) break;
    if (entry.forme !== null || selected.has(entry.name)) continue;
    selected.set(entry.name, entry);
  }
  return { species: [...selected.values()], ownedByName };
}

/** 手持ちの値を先頭に、残りをプールから重複なく詰める。 */
function preferring(preferred, pool) {
  const seen = new Set(preferred);
  return [...preferred, ...pool.filter((name) => !seen.has(name))];
}

async function main() {
  const config = options(process.argv.slice(2));

  if (config.clear) {
    // current ポインタさえ消せば opgg-usage.ts は「データなし」として扱う。
    // 個々のバージョン付きキーは残るが、参照されないので実害はない。
    await wrangler(['kv', 'key', 'delete', '--binding', 'OPGG_USAGE', '--local', 'current']);
    console.log('Deleted the "current" pointer. OP.GG-backed pages will show the empty state again.');
    return;
  }

  const [pokemonMaster, moves, items, abilities, megaStones, learnsets, core] = await Promise.all([
    loadJson(MASTER, 'pokemon.json'),
    loadJson(MASTER, 'moves.json'),
    loadJson(MASTER, 'items.json'),
    loadJson(MASTER, 'abilities.json'),
    loadJson(MASTER, 'mega-stones.json'),
    loadJson(DETAIL, 'learnsets.json'),
    loadJson(DETAIL, 'pokemon-core.json'),
  ]);

  const ownedRows = config.useDb ? await loadOwnedBuilds() : [];
  const { species, ownedByName } = selectSpecies(pokemonMaster, ownedRows, config.limit);
  if (species.length === 0) throw new Error('No species found in pokemon.json.');

  const allMoveNames = moves.map((move) => move.name);
  const allAbilityNames = abilities.map((ability) => ability.name);
  // メガストーンは対応する1種族しか持てないので、全種族共通のもちものプールからは外す。
  const megaStoneNames = new Set(megaStones.map((stone) => stone.item));
  const itemNames = items.map((item) => item.name).filter((name) => !megaStoneNames.has(name));
  const coreByName = new Map(core.map((entry) => [entry.name, entry]));
  // フォルム違いはベースと図鑑番号が同じなので、slugを図鑑番号だけで作ると衝突する。
  const masterIndexByName = new Map(pokemonMaster.map((entry, index) => [entry.name, index]));
  const speciesNames = species.map((entry) => entry.name);

  const version = 'vlocal-seed-1';
  const seasonId = 'local-seed-season';
  const directory = 'id-' + Buffer.from(seasonId).toString('base64url');
  const fetchedAt = new Date().toISOString();

  const pairs = [];
  const listPokemon = [];
  for (const [index, entry] of species.entries()) {
    const masterIndex = masterIndexByName.get(entry.name) ?? index;
    const random = createRandom(masterIndex * 31 + 1);
    const slug = 'seed-' + entry.dexNo + (entry.forme === null ? '' : '-f' + masterIndex);
    // マスターデータにその種族の技/特性が無い場合(取りこぼし)だけ全体プールで埋める。
    const learnset = learnsets[entry.name];
    const ownAbilities = coreByName.get(entry.name)?.abilities;
    // ボックスにいる種族は、実際の構成を上位に混ぜて「選択中の行」が必ず存在する状態にする。
    const owned = ownedByName.get(entry.name) ?? { abilities: [], items: [], natures: [], moves: [], evs: [] };
    const single = {
      moves: rankedRows(preferring(owned.moves, shuffled(learnset?.length ? learnset : allMoveNames, random)), ROWS.moves, random),
      items: rankedRows(preferring(owned.items, shuffled(itemNames, random)), ROWS.items, random),
      abilities: rankedRows(preferring(owned.abilities, shuffled(ownAbilities?.length ? ownAbilities : allAbilityNames, random)), ROWS.abilities, random),
      natures: rankedRows(preferring(owned.natures, shuffled(NATURES, random)), ROWS.natures, random),
      evs: evRows(ROWS.evs, random, owned.evs),
      teammates: rankedRows(shuffled(speciesNames.filter((name) => name !== entry.name), random), ROWS.teammates, random),
    };
    pairs.push([`${version}:season:${directory}:pokemon:${slug}`, { schemaVersion: 3, fetchedAt, name: entry.name, formats: { single } }]);
    listPokemon.push({ slug, name: entry.name, single });
  }

  pairs.push([`${version}:season:${directory}:list`, { schemaVersion: 1, fetchedAt, pokemon: listPokemon }]);
  pairs.push([`${version}:seasons`, {
    schemaVersion: 2,
    currentSeasonId: seasonId,
    seasons: [{
      id: seasonId,
      label: 'ローカル検証用シーズン',
      directory,
      fetchedAt,
      isCurrent: true,
      collectionMode: 'current-snapshot',
      version,
      pokemon: listPokemon.map(({ slug, name }) => ({ slug, name })),
    }],
  }]);
  // current の差し替えが最後。これが入るまで opgg-usage.ts からは何も見えない。
  pairs.push(['current', { schemaVersion: 1, manifestVersion: version, publishedAt: fetchedAt }]);

  await bulkPut(pairs);
  console.log(`Seeded ${species.length} Pokemon (${pairs.length} KV keys) as ${version} into the local OPGG_USAGE namespace.`);
  if (ownedByName.size > 0) console.log(`Prioritised ${ownedByName.size} species found in the local owned_pokemon table (their builds are seeded into the top ranks).`);
  console.log('Restart `npm run dev` if it was started before this seed, then re-run `npm run test:perf`.');
}

main().catch((error) => { console.error('Seeding failed: ' + error.message); process.exitCode = 1; });
