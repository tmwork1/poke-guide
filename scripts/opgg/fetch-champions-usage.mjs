#!/usr/bin/env node

/** Fetches the public, server-rendered OP.GG Pokemon Champions usage tables. */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ORIGIN = 'https://op.gg';
const LOCALE = 'ja';
const BASE = `/${LOCALE}/pokemon-champions`;
const OUTPUT = 'data/opgg-champions-usage';
const POKEMON_NAME_MAP = new URL('../../config/opgg-champions-pokemon-map.json', import.meta.url);
const TYPES = { single: 'sb', double: 'db' };
const LABEL = {
  moves: '\u308f\u3056', items: '\u6301\u3061\u7269', abilities: '\u7279\u6027',
  natures: '\u6027\u683c\u88dc\u6b63', evs: '\u52aa\u529b\u5024', teammates: '\u9078\u51fa\u30dd\u30b1\u30e2\u30f3',
};
const EVS = [
  ['hp', 'HP'], ['attack', '\u3053\u3046\u3052\u304d'], ['defense', '\u307c\u3046\u304e\u3087'],
  ['specialAttack', '\u3068\u304f\u3053\u3046'], ['specialDefense', '\u3068\u304f\u307c\u3046'], ['speed', '\u3059\u3070\u3084\u3055'],
];

function options(argv) {
  const result = { output: OUTPUT, limit: Infinity, delayMs: 350, season: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: npm run fetch:opgg-champions-usage -- [--season season-id] [--output directory] [--limit n] [--delay-ms n]');
      process.exit(0);
    }
    if (flag === '--cleanup-only') { result.cleanupOnly = true; continue; }
    if (flag === '--normalize-files') { result.normalizeFiles = true; continue; }
    const key = { '--output': 'output', '--limit': 'limit', '--delay-ms': 'delayMs', '--season': 'season' }[flag];
    const value = argv[++i];
    if (!key || !value) throw new Error(`Invalid option: ${flag}`);
    result[key] = key === 'output' || key === 'season' ? value : Number(value);
    if (key !== 'output' && (!Number.isInteger(result[key]) || result[key] < 1)) throw new Error(`${flag} must be a positive integer`);
  }
  return result;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function get(url, battleType) {
  const response = await fetch(url, { headers: {
    accept: 'text/html,application/xhtml+xml', 'accept-language': 'ja-JP,ja;q=0.9',
    // The battle-mode toggle is stored by the public site in this cookie.
    ...(battleType ? { cookie: `_opbt=${TYPES[battleType]}` } : {}),
  } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}
function text(html) {
  return html.replace(/<!--.*?-->/gs, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function section(html, label) {
  // Usage-category labels are divs (the page's other "moves" labels are tabs).
  const start = html.indexOf(`>${label}</div>`);
  if (start < 0) return '';
  const after = start + label.length + 6;
  const end = html.indexOf('text-center text-sm font-semibold text-indigo-50">', after);
  return html.slice(after, end < 0 ? html.length : end);
}
function divAt(html, start) {
  const tags = /<\/?div\b[^>]*>/g; tags.lastIndex = start;
  let depth = 0; let tag;
  while ((tag = tags.exec(html))) {
    depth += tag[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  throw new Error('Unclosed usage entry');
}
function cards(html) {
  const list = []; const re = /<div\b(?=[^>]*\bclass="[^"]*\brelative\b[^"\n]*\bgrid\b[^"\n]*\bmin-h-16\b)[^>]*>/g; let match;
  while ((match = re.exec(html))) { const card = divAt(html, match.index); list.push(card); re.lastIndex = match.index + card.length; }
  return list;
}
function rankRate(card) {
  const value = text(card);
  return { rank: Number(value.match(/^(\d+)\s/)?.[1]) || null, usageRate: Number(value.match(/(\d+(?:\.\d+)?)%/)?.[1]) || null };
}
function label(card) {
  const match = card.match(/<span\b[^>]*class="[^"]*\btruncate\b[^"]*\bfont-semibold\b[^"]*"[^>]*>([^<]+)<\/span>/);
  return match ? text(match[1]) : null;
}
function entries(html, heading) {
  return cards(section(html, heading)).map((card) => ({
    ...rankRate(card), name: label(card),
  })).filter((entry) => entry.name);
}
function evEntries(html) {
  return cards(section(html, LABEL.evs)).map((card) => {
    const values = Object.fromEntries(EVS.map(([key, japanese]) => {
      const found = card.match(new RegExp(`>${japanese}</span><span[^>]*>(\\d+)</span>`));
      return [key, found ? Number(found[1]) : null];
    }));
    return { ...rankRate(card), values };
  }).filter((entry) => Object.values(entry.values).some((value) => value !== null));
}
function parse(html) {
  const renderedHtml = html.replace(/<!--.*?-->/gs, ' ');
  const updatedAt = text(renderedHtml.match(/\u66f4\u65b0\u65e5\s*([^<]{1,80})/)?.[1] ?? '') || null;
  return {
    updatedAt,
    moves: entries(html, LABEL.moves), items: entries(html, LABEL.items), abilities: entries(html, LABEL.abilities),
    natures: entries(html, LABEL.natures), evs: evEntries(html), teammates: entries(html, LABEL.teammates),
  };
}
function name(html) { return text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '').replace(/^#\d+\s*/, '') || null; }
function slugs(html) {
  const re = new RegExp(`${BASE.replaceAll('/', '\\/')}\\/pokedex\\/([^"?#/]+)`, 'g');
  return [...new Set([...html.matchAll(re)].map((match) => match[1]))];
}
function availableSeasons(html) {
  // The Next/RSC payload serializes its embedded JSON with escaped quotes.
  // Normalize only those delimiters before extracting the tier metadata.
  const payload = html.replaceAll('\\"', '"');
  const optionIds = payload.match(/"seasonOptionIds":(\[[^\]]+\])/);
  const selected = payload.match(/"seasons":\[\{"id":"([^"]+)","label":"[^"]+","comparisonLabel"/);
  if (!optionIds || !selected) throw new Error('Current season was not found in the OP.GG tier payload.');
  const ids = JSON.parse(optionIds[1]).filter((id) => typeof id === 'string');
  if (!ids.includes(selected[1])) throw new Error('OP.GG tier payload has an inconsistent selected season.');
  const labels = new Map(ids.map((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = payload.match(new RegExp(`"id":"${escaped}","label":"([^"]+)"`));
    return [id, match?.[1] ?? id];
  }));
  return { ids, labels, currentId: selected[1] };
}
function seasonDirectoryName(id) {
  // Keep the upstream identifier out of the filesystem entirely: even a
  // superficially safe id can be a Windows-reserved device name.
  return `id-${Buffer.from(id).toString('base64url')}`;
}
async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  // A crash can leave only the temporary file; the app always sees the last valid JSON.
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(`${path}.tmp`, path);
}
async function loadIndex(path) {
  try {
    const index = JSON.parse(await readFile(path, 'utf8'));
    return new Map((Array.isArray(index.pokemon) ? index.pokemon : [])
      .filter((entry) => typeof entry?.slug === 'string' && typeof entry?.name === 'string')
      .map((entry) => [entry.slug, { name: entry.name, file: entry.file ?? `${entry.slug}.json` }]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error(`Could not read existing index: ${error.message}`);
  }
}
async function cleanStaleOutput(directory, completed) {
  // This directory is owned exclusively by this collector. Keep the current index and files it names.
  const keep = new Set(['index.json', ...[...completed.values()].map((entry) => entry.file)]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json') && !keep.has(entry.name)) {
      await unlink(`${directory}/${entry.name}`);
    }
  }
}
function pokemonFileName(pokemonName, slug, completed) {
  // Windows permits Japanese file names; replace only characters forbidden by Windows filesystems.
  const safeName = pokemonName.replace(/[\\/:*?"<>|]/g, '＿').trim();
  if (!safeName || safeName === '.' || safeName === '..') throw new Error(`Unsafe Pokemon name for file name: ${pokemonName}`);
  const usedFiles = new Set([...completed].filter(([entrySlug]) => entrySlug !== slug).map(([, entry]) => entry.file));
  if (!usedFiles.has(`${safeName}.json`)) return `${safeName}.json`;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${safeName}（${suffix}）.json`;
    if (!usedFiles.has(candidate)) return candidate;
  }
}
async function loadPokemonNameMap() {
  const data = JSON.parse(await readFile(POKEMON_NAME_MAP, 'utf8'));
  if (data.schemaVersion !== 1 || !data.pokemon || typeof data.pokemon !== 'object' || Array.isArray(data.pokemon)) {
    throw new Error(`Invalid OP.GG Pokemon name map: ${POKEMON_NAME_MAP.pathname}`);
  }
  const entries = Object.entries(data.pokemon);
  if (entries.some(([slug, name]) => !slug || typeof name !== 'string' || !name)) {
    throw new Error(`Invalid OP.GG Pokemon name-map entry: ${POKEMON_NAME_MAP.pathname}`);
  }
  return new Map(entries);
}
function jpokePokemonName(slug, opggPokemonName, nameMap) {
  // Most Japanese names already match jpoke. Form names that differ are centrally managed in config/.
  return nameMap.get(slug) ?? opggPokemonName;
}
async function normalizeFileNames(directory, completed, nameMap) {
  const normalized = new Map();
  const moves = [];
  for (const [slug, entry] of completed) {
    const name = jpokePokemonName(slug, entry.name, nameMap);
    const file = pokemonFileName(name, slug, normalized);
    normalized.set(slug, { ...entry, name, file });
    if (entry.file !== file) moves.push({ slug, from: entry.file, to: file });
  }
  // Two phases make renames safe even if two legacy names need to swap.
  for (const move of moves) await rename(`${directory}/${move.from}`, `${directory}/.${move.slug}.rename-tmp`);
  for (const move of moves) await rename(`${directory}/.${move.slug}.rename-tmp`, `${directory}/${move.to}`);
  for (const [slug, entry] of normalized) {
    const contents = JSON.parse(await readFile(`${directory}/${entry.file}`, 'utf8'));
    if (contents.name !== entry.name) await saveJson(`${directory}/${entry.file}`, { ...contents, name: entry.name });
  }
  return normalized;
}
async function main() {
  const config = options(process.argv.slice(2));
  const destination = resolve(config.output);
  const tier = `${ORIGIN}${BASE}/tier`;
  const tierHtml = await get(tier);
  const seasonOptions = availableSeasons(tierHtml);
  config.season ??= seasonOptions.currentId;
  if (!seasonOptions.ids.includes(config.season)) {
    throw new Error(`--season must be an OP.GG season id from the current tier payload: ${seasonOptions.ids.join(', ')}`);
  }
  const seasonDirName = seasonDirectoryName(config.season);
  const seasonDirectory = `${destination}/seasons/${seasonDirName}`;
  await mkdir(seasonDirectory, { recursive: true });
  const nameMap = await loadPokemonNameMap();
  const completed = await loadIndex(`${seasonDirectory}/index.json`);
  if (config.cleanupOnly) {
    await cleanStaleOutput(seasonDirectory, completed);
    console.log(`Removed stale generated JSON files from ${seasonDirectory}`);
    return;
  }
  if (config.normalizeFiles) {
    const normalized = await normalizeFileNames(seasonDirectory, completed, nameMap);
    await saveJson(`${seasonDirectory}/index.json`, {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      pokemon: [...normalized].map(([slug, entry]) => ({ slug, ...entry })),
    });
    await cleanStaleOutput(seasonDirectory, normalized);
    console.log(`Normalized Pokemon file names in ${seasonDirectory}`);
    return;
  }
  const found = slugs(tierHtml).slice(0, config.limit);
  if (!found.length) throw new Error('No Pokemon detail URLs found on the public tier page.');
  const failures = [];
  console.log(`Fetching ${found.length} Pokemon sequentially (each Pokemon is saved to its own file immediately)...`);
  for (const [index, slug] of found.entries()) {
    const sourceUrl = `${ORIGIN}${BASE}/pokedex/${slug}`;
    try {
      const singleHtml = await get(sourceUrl, 'single'); await sleep(config.delayMs);
      const doubleHtml = await get(sourceUrl, 'double'); await sleep(config.delayMs);
      const pokemonName = name(singleHtml);
      if (!pokemonName) throw new Error('Pokemon name was not found in the page.');
      const displayName = jpokePokemonName(slug, pokemonName, nameMap);
      const file = pokemonFileName(displayName, slug, completed);
      const previous = completed.get(slug);
      const fetchedAt = new Date().toISOString();
      const formats = { single: parse(singleHtml), double: parse(doubleHtml) };
      // schemaVersion 2 keeps the v1 `formats` snapshot for existing readers while
      // storing independently collected snapshots under an explicit season key.
      const existing = previous ? JSON.parse(await readFile(`${seasonDirectory}/${previous.file}`, 'utf8')) : null;
      const seasons = { ...(existing?.seasons ?? {}), [config.season]: { fetchedAt, formats } };
      const pokemon = { schemaVersion: 2, fetchedAt, name: displayName, formats, seasons };
      await saveJson(`${seasonDirectory}/${file}`, pokemon);
      completed.set(slug, { name: displayName, file });
      if (previous?.file && previous.file !== file) {
        await unlink(`${seasonDirectory}/${previous.file}`).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      await saveJson(`${seasonDirectory}/index.json`, {
        schemaVersion: 1,
        fetchedAt: new Date().toISOString(),
        // slug is a stable source identifier for resilient re-runs; the data files themselves need only the Japanese name.
        pokemon: found.filter((entrySlug) => completed.has(entrySlug)).map((entrySlug) => ({ slug: entrySlug, ...completed.get(entrySlug) })),
      });
      let manifest = { schemaVersion: 1, seasons: [] };
      try { manifest = JSON.parse(await readFile(`${destination}/seasons.json`, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const seasonEntry = {
        id: config.season,
        label: seasonOptions.labels.get(config.season) ?? config.season,
        directory: `seasons/${seasonDirName}`,
        fetchedAt,
        isCurrent: config.season === seasonOptions.currentId,
        collectionMode: 'current-snapshot',
      };
      manifest.seasons = [
        ...(Array.isArray(manifest.seasons) ? manifest.seasons : []).filter((entry) => entry?.id !== config.season),
        seasonEntry,
      ].map((entry) => ({ ...entry, isCurrent: entry.id === seasonOptions.currentId }));
      manifest.currentSeasonId = seasonOptions.currentId;
      await saveJson(`${destination}/seasons.json`, manifest);
      console.log(`[${index + 1}/${found.length}] ${slug} saved`);
    } catch (error) {
      failures.push({ slug, message: error.message });
      console.error(`[${index + 1}/${found.length}] ${slug} failed: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} Pokemon could not be updated. Existing data was kept; retry the command. Failed slugs: ${failures.map(({ slug }) => slug).join(', ')}`);
  }
  await cleanStaleOutput(seasonDirectory, completed);
  console.log(`Saved ${found.length} Pokemon files to ${seasonDirectory}`);
}
main().catch((error) => { console.error(`Collection failed: ${error.message}`); process.exitCode = 1; });
