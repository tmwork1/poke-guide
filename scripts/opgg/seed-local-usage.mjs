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
 *   (docs/perf/reports/README.md「横断課題1: 計測網の穴」)。
 *
 * 使い方:
 *   node scripts/opgg/seed-local-usage.mjs              # 235件を投入
 *   node scripts/opgg/seed-local-usage.mjs --limit 50   # 件数を変えて投入
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

// 本番のOP.GGシングル使用率は、ランキング掲載ぶんの約235種族ぶんが1シーズンに入る。
const DEFAULT_LIMIT = 235;
// 1カテゴリあたりの行数。OP.GGの各カードは上位N件だけを出す。
const ROWS = { moves: 10, items: 10, abilities: 5, natures: 5, evs: 5, teammates: 10 };
const NATURES = ['いじっぱり', 'ようき', 'ひかえめ', 'おくびょう', 'ずぶとい', 'しんちょう', 'わんぱく', 'おだやか'];
const EV_KEYS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];

function options(argv) {
  const result = { limit: DEFAULT_LIMIT, clear: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: node scripts/opgg/seed-local-usage.mjs [--limit n] [--clear]');
      process.exit(0);
    }
    if (flag === '--clear') { result.clear = true; continue; }
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

async function loadMaster(name) {
  return JSON.parse(await readFile(new URL(name, MASTER), 'utf8'));
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

function evRows(count, random) {
  const rows = [];
  let rate = 20 + random() * 40;
  for (let rank = 1; rank <= count; rank += 1) {
    // 合計508(4振り基準)に寄せた配分を作る。値そのものの妥当性より、行数と形が本番同等であることを優先する。
    const values = {};
    let remaining = 508;
    for (const [index, key] of EV_KEYS.entries()) {
      const max = Math.min(252, remaining - (EV_KEYS.length - index - 1) * 0);
      const value = index === EV_KEYS.length - 1 ? Math.min(252, remaining) : Math.floor(random() * Math.min(max, 253) / 4) * 4;
      values[key] = value;
      remaining -= value;
    }
    rows.push({ rank, usageRate: Math.round(rate * 10) / 10, values });
    rate = Math.max(0.5, rate * (0.55 + random() * 0.3));
  }
  return rows;
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

async function main() {
  const config = options(process.argv.slice(2));

  if (config.clear) {
    // current ポインタさえ消せば opgg-usage.ts は「データなし」として扱う。
    // 個々のバージョン付きキーは残るが、参照されないので実害はない。
    await wrangler(['kv', 'key', 'delete', '--binding', 'OPGG_USAGE', '--local', 'current']);
    console.log('Deleted the "current" pointer. OP.GG-backed pages will show the empty state again.');
    return;
  }

  const [pokemonMaster, moves, items, abilities] = await Promise.all([
    loadMaster('pokemon.json'),
    loadMaster('moves.json'),
    loadMaster('items.json'),
    loadMaster('abilities.json'),
  ]);

  // OP.GGの使用率はベースフォルムでしか集計されない(opgg-usage.ts の resolveOpggSpeciesName)。
  // メガ等のフォルム違いを入れても引かれないので、forme が null の種族だけを対象にする。
  const species = pokemonMaster.filter((entry) => entry.forme === null).slice(0, config.limit);
  if (species.length === 0) throw new Error('No base-forme species found in pokemon.json.');

  const moveNames = moves.map((move) => move.name);
  const itemNames = items.map((item) => item.name);
  const abilityNames = abilities.map((ability) => ability.name);
  const speciesNames = species.map((entry) => entry.name);

  const version = 'vlocal-seed-1';
  const seasonId = 'local-seed-season';
  const directory = 'id-' + Buffer.from(seasonId).toString('base64url');
  const fetchedAt = new Date().toISOString();

  const pairs = [];
  const listPokemon = [];
  for (const [index, entry] of species.entries()) {
    const random = createRandom(index + 1);
    const slug = 'seed-' + entry.dexNo;
    const single = {
      moves: rankedRows(moveNames.slice(index % 50), ROWS.moves, random),
      items: rankedRows(itemNames.slice(index % 50), ROWS.items, random),
      abilities: rankedRows(abilityNames.slice(index % 50), ROWS.abilities, random),
      natures: rankedRows(NATURES, ROWS.natures, random),
      evs: evRows(ROWS.evs, random),
      teammates: rankedRows(speciesNames.filter((name) => name !== entry.name), ROWS.teammates, random),
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
  console.log('Restart `npm run dev` if it was started before this seed, then re-run `npm run test:perf`.');
}

main().catch((error) => { console.error('Seeding failed: ' + error.message); process.exitCode = 1; });
