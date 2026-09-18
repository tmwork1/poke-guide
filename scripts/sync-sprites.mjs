import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import sharp from "sharp";

const REPOSITORY = "tmwork1/poke-sprites";
const BRANCH = "main";
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "public");
const STATE_PATH = join(ROOT, "scripts", "sync-sprites.state.json");
const TREE_URL = `https://api.github.com/repos/${REPOSITORY}/git/trees/${BRANCH}?recursive=1`;
const RAW_ROOT = `https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}`;
const TYPE_IDS = new Map([
  ["ノーマル", 1], ["かくとう", 2], ["ひこう", 3], ["どく", 4], ["じめん", 5],
  ["いわ", 6], ["むし", 7], ["ゴースト", 8], ["はがね", 9], ["ほのお", 10],
  ["みず", 11], ["くさ", 12], ["でんき", 13], ["エスパー", 14], ["こおり", 15],
  ["ドラゴン", 16], ["あく", 17], ["フェアリー", 18], ["ステラ", 19],
]);
// 同期元のディレクトリと拡張子。webp が基本だが、アイテムだけは Real-ESRGAN で
// 拡大した upscaled/(384px PNG、webp 版は poke-sprites に無い)を取り、こちら側で
// 表示サイズ(96px)へ縮小する。poke-sprites の 96px webp をそのまま使うより縮小の
// サンプリングが効き、拡大時のノイズが落ちてエッジが滑らかになる。
const SOURCES = [
  { prefix: "sprites/pokemon-artwork/webp/", extension: ".webp" },
  { prefix: "sprites/pokemon-champion/webp/", extension: ".webp" },
  { prefix: "sprites/items/upscaled/", extension: ".png" },
  { prefix: "sprites/types/webp/", extension: ".webp" },
  { prefix: "sprites/tera-types/webp/", extension: ".webp" },
  { prefix: "sprites/ui/webp/", extension: ".webp" },
];
const ITEM_SOURCE_PREFIX = "sprites/items/upscaled/";
const ITEM_SOURCE_EXTENSION = ".png";
const ITEM_ICON_SIZE = 96;

function usage(message) {
  if (message) console.error(`エラー: ${message}`);
  console.log("使い方: npm run sync-sprites -- [--force] [--dry-run] [--names 名前1,名前2] [--limit 件数]");
  process.exit(message ? 1 : 0);
}

function parseArgs() {
  const args = { force: false, dryRun: false, names: null, limit: null };
  const values = process.argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--force") args.force = true;
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--names") args.names = values[++index] ?? usage("--names には値が必要です");
    else if (value === "--limit") {
      const limit = Number(values[++index]);
      if (!Number.isInteger(limit) || limit < 1) usage("--limit は 1 以上の整数です");
      args.limit = limit;
    } else if (value === "--help" || value === "-h") usage();
    else usage(`未知のオプションです: ${value}`);
  }
  return args;
}

// poke-sprites/scripts/common.py の to_filename と同じ規則。
function toSpriteFilename(name) {
  return name.replaceAll(":", "：");
}

function rawUrl(path) {
  return `${RAW_ROOT}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchWithRetry(url, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "poke-guide-sync-sprites/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${label} の取得に失敗しました: ${lastError.message}`);
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return state?.version === 1 && state.files && typeof state.files === "object" ? state : { version: 1, files: {} };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, files: {} };
    throw new Error(`SHA 台帳を読み込めません: ${error.message}`);
  }
}

async function loadTree() {
  const response = await fetch(TREE_URL, { headers: { "User-Agent": "poke-guide-sync-sprites/1.0" } });
  if (!response.ok) throw new Error(`GitHub tree API の取得に失敗しました: HTTP ${response.status}`);
  const data = await response.json();
  if (data.truncated) throw new Error("GitHub tree API の結果が切り詰められました");
  return new Map(data.tree
    .filter((entry) => entry.type === "blob" && SOURCES.some(({ prefix, extension }) => entry.path.startsWith(prefix) && entry.path.endsWith(extension)))
    .map((entry) => [entry.path, entry.sha]));
}

function makeTask(sourcePath, sha, outputPath, name, resize = null) {
  return { sourcePath, sha, outputPath, name, resize };
}

function sourcePath(category, name) {
  return `sprites/${category}/webp/${toSpriteFilename(name)}.webp`;
}

async function buildTasks(tree) {
  const pokemon = JSON.parse(await readFile(join(PUBLIC_DIR, "master-data", "autocomplete", "pokemon.json"), "utf8"));
  const tasks = [];
  const warnings = { artwork: [], champion: [], types: [], teraTypes: [], ui: [] };

  for (const entry of pokemon) {
    const artwork = sourcePath("pokemon-artwork", entry.name);
    if (tree.has(artwork)) tasks.push(makeTask(artwork, tree.get(artwork), `pokemon-artwork/${entry.imageId}.webp`, entry.name));
    else warnings.artwork.push(entry.name);

    const champion = sourcePath("pokemon-champion", entry.name);
    if (tree.has(champion)) {
      tasks.push(makeTask(champion, tree.get(champion), `pokemon-champion-sprites/icon/${entry.imageId}.webp`, entry.name, 96));
      tasks.push(makeTask(champion, tree.get(champion), `pokemon-champion-sprites/medium/${entry.imageId}.webp`, entry.name, 192));
    } else warnings.champion.push(entry.name);
  }

  for (const [path, sha] of tree) {
    if (path.startsWith(ITEM_SOURCE_PREFIX)) {
      const name = basename(path, ITEM_SOURCE_EXTENSION);
      tasks.push(makeTask(path, sha, `item-icons/${name}.webp`, name, ITEM_ICON_SIZE));
    }
  }

  for (const [name, typeId] of TYPE_IDS) {
    const type = sourcePath("types", name);
    if (tree.has(type)) tasks.push(makeTask(type, tree.get(type), `type-icons/${typeId}.webp`, name));
    else warnings.types.push(name);
    const tera = sourcePath("tera-types", name);
    if (tree.has(tera)) tasks.push(makeTask(tera, tree.get(tera), `type-icons/tera/${typeId}.webp`, name));
    else warnings.teraTypes.push(name);
  }

  const ui = sourcePath("ui", "テラスタル");
  if (tree.has(ui)) tasks.push(makeTask(ui, tree.get(ui), "ui-icons/テラスタル.webp", "テラスタル"));
  else warnings.ui.push("テラスタル");
  return { tasks, warnings };
}

function summarize(tasks) {
  const count = (prefix) => new Set(tasks.filter((task) => task.sourcePath.startsWith(prefix)).map((task) => task.sourcePath)).size;
  return {
    artwork: count("sprites/pokemon-artwork/"),
    champion: count("sprites/pokemon-champion/"),
    items: count("sprites/items/"),
    types: count("sprites/types/"),
    teraTypes: count("sprites/tera-types/"),
    ui: count("sprites/ui/"),
  };
}

function displayNames(names, max = 20) {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} …ほか ${names.length - max}件`;
}

function filterTasks(tasks, args) {
  let filtered = tasks;
  if (args.names) {
    const requested = new Set(args.names.split(",").map((name) => name.trim()).filter(Boolean));
    filtered = filtered.filter((task) => requested.has(task.name));
    const found = new Set(filtered.map((task) => task.name));
    const unknown = [...requested].filter((name) => !found.has(name));
    if (unknown.length) console.warn(`警告: 対象画像が見つからない和名: ${unknown.join(", ")}`);
  }
  if (args.limit) {
    const sources = [...new Set(filtered.map((task) => task.sourcePath))].slice(0, args.limit);
    filtered = filtered.filter((task) => sources.includes(task.sourcePath));
  }
  return filtered;
}

// アプリが参照しうるアイテム(items.json)のうち、poke-sprites に画像が無いものを洗い出す。
// ポケモンと違いアイテムは和名がそのままファイル名なので対応表は要らないが、新規アイテムが
// master-data に入って poke-sprites 側が追随していない状況は検出したい。
async function findMissingItemImages(tree) {
  const remote = new Set([...tree.keys()].filter((path) => path.startsWith(ITEM_SOURCE_PREFIX)).map((path) => basename(path, ITEM_SOURCE_EXTENSION)));
  const items = JSON.parse(await readFile(join(PUBLIC_DIR, "master-data", "autocomplete", "items.json"), "utf8"));
  return [...new Set(items.map((item) => item.name))].filter((name) => !remote.has(toSpriteFilename(name))).sort();
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function copyUnchangedOutputs(allTasks, state, stage) {
  const copied = new Set();
  for (const task of allTasks) {
    if (state.files[task.sourcePath] !== task.sha || copied.has(task.outputPath)) continue;
    const source = join(PUBLIC_DIR, task.outputPath);
    if (await exists(source)) {
      const destination = join(stage, task.outputPath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
      copied.add(task.outputPath);
    }
  }
}

async function writeTask(task, data, destinationRoot) {
  const destination = join(destinationRoot, task.outputPath);
  await mkdir(dirname(destination), { recursive: true });
  if (task.resize) {
    await sharp(data).resize(task.resize, task.resize, { fit: "contain", withoutEnlargement: true }).webp({ quality: 90 }).toFile(destination);
  } else {
    await writeFile(destination, data);
  }
}

async function mapConcurrent(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  }));
}

async function replaceDirectories(stage) {
  for (const directory of ["pokemon-artwork", "pokemon-champion-sprites", "item-icons", "type-icons", "ui-icons"]) {
    const live = join(PUBLIC_DIR, directory);
    const replacement = join(stage, directory);
    await rm(live, { recursive: true, force: true });
    if (await exists(replacement)) await rename(replacement, live);
  }
}

async function main() {
  const args = parseArgs();
  const [state, tree] = await Promise.all([readState(), loadTree()]);
  const { tasks: allTasks, warnings } = await buildTasks(tree);
  const tasks = filterTasks(allTasks, args);
  const counts = summarize(allTasks);
  const missingItemImages = await findMissingItemImages(tree);
  const sources = [...new Map(tasks.map((task) => [task.sourcePath, { sha: task.sha, name: task.name }])).entries()];
  const changed = sources.filter(([path, value]) => args.force || state.files[path] !== value.sha);

  console.log(`対象ソース: 公式絵 ${counts.artwork}件 / 立ち絵 ${counts.champion}件 / アイテム ${counts.items}件 / タイプ ${counts.types}件 / テラスタイプ ${counts.teraTypes}件 / UI ${counts.ui}件`);
  console.log(`今回の対象: ${sources.length}件（出力 ${tasks.length}件）、取得対象: ${changed.length}件${args.force ? " (--force)" : ""}`);
  if (args.dryRun) {
    console.log("dry-run: 取得・書き込み・削除は行いません。");
    return;
  }

  const partial = Boolean(args.names || args.limit);
  const stage = partial ? PUBLIC_DIR : join(PUBLIC_DIR, `.sync-sprites-stage-${process.pid}`);
  if (!partial) {
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    await copyUnchangedOutputs(allTasks, state, stage);
  }
  const destination = partial ? PUBLIC_DIR : stage;
  const downloaded = new Set();
  await mapConcurrent(sources, 12, async ([path, value]) => {
    const needsDownload = args.force || state.files[path] !== value.sha || !(await Promise.all(tasks.filter((task) => task.sourcePath === path).map((task) => exists(join(destination, task.outputPath))))).every(Boolean);
    if (!needsDownload) return;
    const data = await fetchWithRetry(rawUrl(path), path);
    await Promise.all(tasks.filter((task) => task.sourcePath === path).map((task) => writeTask(task, data, destination)));
    downloaded.add(path);
    state.files[path] = value.sha;
  });

  if (!partial) {
    await replaceDirectories(stage);
    await rm(stage, { recursive: true, force: true });
  }
  // 同期元から外れたパス(アイテムの旧 sprites/items/webp/ など)を台帳に残さない。
  const files = Object.fromEntries(Object.entries(state.files).filter(([path]) => tree.has(path)));
  await writeFile(STATE_PATH, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, "utf8");
  console.log(`同期完了: ダウンロード ${downloaded.size}件 / 出力 ${tasks.length}件${partial ? "（絞り込み実行のため既存ディレクトリは維持）" : ""}`);
  console.log(`スキップ: 公式絵 ${warnings.artwork.length}件 / 立ち絵 ${warnings.champion.length}件 / タイプ ${warnings.types.length}件 / テラタイプ ${warnings.teraTypes.length}件 / UI ${warnings.ui.length}件`);
  if (warnings.artwork.length) console.warn(`警告: 公式絵がない和名: ${displayNames(warnings.artwork)}`);
  if (warnings.champion.length) console.warn(`警告: 立ち絵がない和名: ${displayNames(warnings.champion)}`);
  if (missingItemImages.length) {
    console.warn(`警告: poke-sprites に画像が無いアイテム ${missingItemImages.length}件: ${displayNames(missingItemImages)}`);
  }
}

main().catch((error) => {
  console.error(`同期に失敗しました: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
