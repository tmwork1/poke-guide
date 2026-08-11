#!/usr/bin/env node

/** Fetches the public, server-rendered OP.GG Pokemon Champions usage tables. */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ORIGIN = 'https://op.gg';
const LOCALE = 'ja';
const BASE = `/${LOCALE}/pokemon-champions`;
const OUTPUT = 'data/opgg-champions-usage';
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
  const result = { output: OUTPUT, limit: Infinity, delayMs: 350 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: npm run fetch:opgg-champions-usage -- [--output directory] [--limit n] [--delay-ms n]');
      process.exit(0);
    }
    if (flag === '--cleanup-only') { result.cleanupOnly = true; continue; }
    if (flag === '--normalize-files') { result.normalizeFiles = true; continue; }
    const key = { '--output': 'output', '--limit': 'limit', '--delay-ms': 'delayMs' }[flag];
    const value = argv[++i];
    if (!key || !value) throw new Error(`Invalid option: ${flag}`);
    result[key] = key === 'output' ? value : Number(value);
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
function displayPokemonName(slug, pokemonName) {
  // OP.GG's Japanese page labels Hisui forms with the base species name only.
  // Keep their files and in-app names distinct just as other forms (e.g. Rotom) are.
  return slug.endsWith('-hisui') ? `ヒスイ${pokemonName}` : pokemonName;
}
async function normalizeFileNames(directory, completed) {
  const normalized = new Map();
  const moves = [];
  for (const [slug, entry] of completed) {
    const file = pokemonFileName(entry.name, slug, normalized);
    normalized.set(slug, { ...entry, file });
    if (entry.file !== file) moves.push({ slug, from: entry.file, to: file });
  }
  // Two phases make renames safe even if two legacy names need to swap.
  for (const move of moves) await rename(`${directory}/${move.from}`, `${directory}/.${move.slug}.rename-tmp`);
  for (const move of moves) await rename(`${directory}/.${move.slug}.rename-tmp`, `${directory}/${move.to}`);
  return normalized;
}
async function main() {
  const config = options(process.argv.slice(2));
  const destination = resolve(config.output);
  await mkdir(destination, { recursive: true });
  const completed = await loadIndex(`${destination}/index.json`);
  if (config.cleanupOnly) {
    await cleanStaleOutput(destination, completed);
    console.log(`Removed stale generated JSON files from ${destination}`);
    return;
  }
  if (config.normalizeFiles) {
    const normalized = await normalizeFileNames(destination, completed);
    await saveJson(`${destination}/index.json`, {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      pokemon: [...normalized].map(([slug, entry]) => ({ slug, ...entry })),
    });
    await cleanStaleOutput(destination, normalized);
    console.log(`Normalized Pokemon file names in ${destination}`);
    return;
  }
  const tier = `${ORIGIN}${BASE}/tier`;
  const found = slugs(await get(tier)).slice(0, config.limit);
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
      const displayName = displayPokemonName(slug, pokemonName);
      const file = pokemonFileName(displayName, slug, completed);
      const pokemon = { schemaVersion: 1, fetchedAt: new Date().toISOString(), name: displayName, formats: { single: parse(singleHtml), double: parse(doubleHtml) } };
      await saveJson(`${destination}/${file}`, pokemon);
      const previous = completed.get(slug);
      completed.set(slug, { name: displayName, file });
      if (previous?.file && previous.file !== file) {
        await unlink(`${destination}/${previous.file}`).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      await saveJson(`${destination}/index.json`, {
        schemaVersion: 1,
        fetchedAt: new Date().toISOString(),
        // slug is a stable source identifier for resilient re-runs; the data files themselves need only the Japanese name.
        pokemon: found.filter((entrySlug) => completed.has(entrySlug)).map((entrySlug) => ({ slug: entrySlug, ...completed.get(entrySlug) })),
      });
      console.log(`[${index + 1}/${found.length}] ${slug} saved`);
    } catch (error) {
      failures.push({ slug, message: error.message });
      console.error(`[${index + 1}/${found.length}] ${slug} failed: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} Pokemon could not be updated. Existing data was kept; retry the command. Failed slugs: ${failures.map(({ slug }) => slug).join(', ')}`);
  }
  await cleanStaleOutput(destination, completed);
  console.log(`Saved ${found.length} Pokemon files to ${destination}`);
}
main().catch((error) => { console.error(`Collection failed: ${error.message}`); process.exitCode = 1; });
