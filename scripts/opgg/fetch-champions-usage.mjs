#!/usr/bin/env node
// OP.GG single-battle usage tables -> Cloudflare KV. No filesystem output.
import { readFile } from 'node:fs/promises';

const ORIGIN = 'https://op.gg';
const BASE = '/ja/pokemon-champions';
const MAP = new URL('../../config/opgg-champions-pokemon-map.json', import.meta.url);
const NAMESPACE = process.env.OPGG_USAGE_NAMESPACE_ID ?? 'f165418c82fa4eac9dff837ddaa8e4ab';
const LABEL = { moves: 'わざ', items: '持ち物', abilities: '特性', natures: '性格補正', evs: '努力値', teammates: '選出ポケモン' };
const EVS = [['hp', 'HP'], ['attack', 'こうげき'], ['defense', 'ぼうぎょ'], ['specialAttack', 'とくこう'], ['specialDefense', 'とくぼう'], ['speed', 'すばやさ']];

function options(argv) {
  const result = { limit: Infinity, delayMs: 350, season: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: npm run fetch:opgg-champions-usage -- [--season id] [--limit n] [--delay-ms n]');
      console.log('Requires CLOUDFLARE_API_TOKEN (Workers KV Storage:Edit) and CLOUDFLARE_ACCOUNT_ID.');
      process.exit(0);
    }
    const key = { '--season': 'season', '--limit': 'limit', '--delay-ms': 'delayMs' }[flag];
    const value = argv[++i];
    if (!key || !value) throw new Error('Invalid option: ' + flag);
    result[key] = key === 'season' ? value : Number(value);
    if (key !== 'season' && (!Number.isInteger(result[key]) || result[key] < 1)) throw new Error(flag + ' must be a positive integer');
  }
  return result;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function get(url) {
  const res = await fetch(url, { headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'ja-JP,ja;q=0.9', cookie: '_opbt=sb' } });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText + ': ' + url);
  return res.text();
}
function text(html) { return html.replace(/<!--.*?-->/gs, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function section(html, label) {
  const start = html.indexOf('>' + label + '</div>');
  if (start < 0) return '';
  const after = start + label.length + 6;
  const end = html.indexOf('text-center text-sm font-semibold text-indigo-50">', after);
  return html.slice(after, end < 0 ? html.length : end);
}
function divAt(html, start) {
  const tags = /<\/?div\b[^>]*>/g; tags.lastIndex = start; let depth = 0; let tag;
  while ((tag = tags.exec(html))) { depth += tag[0][1] === '/' ? -1 : 1; if (depth === 0) return html.slice(start, tags.lastIndex); }
  throw new Error('Unclosed usage entry');
}
function cards(html) {
  const result = []; const re = /<div\b(?=[^>]*\bclass="[^"]*\brelative\b[^"\n]*\bgrid\b[^"\n]*\bmin-h-16\b)[^>]*>/g; let match;
  while ((match = re.exec(html))) { const card = divAt(html, match.index); result.push(card); re.lastIndex = match.index + card.length; }
  return result;
}
function rankRate(card) { const value = text(card); return { rank: Number(value.match(/^(\d+)\s/)?.[1]) || null, usageRate: Number(value.match(/(\d+(?:\.\d+)?)%/)?.[1]) || null }; }
function label(card) { const match = card.match(/<span\b[^>]*class="[^"]*\btruncate\b[^"]*\bfont-semibold\b[^"]*"[^>]*>([^<]+)<\/span>/); return match ? text(match[1]) : null; }
// 選出ポケモン(teammates)カードは対象の /pokedex/<slug> へのリンクを持つ。moves/items等のカードは持たないため slug は null になる。
function cardSlug(card) { const match = card.match(new RegExp(BASE.replaceAll('/', '\\/') + '\\/pokedex\\/([^"?#/]+)')); return match ? match[1] : null; }
// nameMap(opgg-champions-pokemon-map.json)は本来ページ自身の種族名にのみ適用していたが、
// 選出ポケモン欄の種族名はカード内リンクの slug から同じ表記ゆれ(フォルム名の言い回し違い)を持つため、
// ここでも同じ nameMap を適用してjpoke/マスターデータ側の短縮名に揃える。
function entries(html, heading, nameMap) { return cards(section(html, heading)).map((card) => { const slug = cardSlug(card); return { ...rankRate(card), name: (slug && nameMap?.get(slug)) ?? label(card) }; }).filter((entry) => entry.name); }
function evEntries(html) {
  return cards(section(html, LABEL.evs)).map((card) => {
    const values = Object.fromEntries(EVS.map(([key, japanese]) => { const found = card.match(new RegExp('>' + japanese + '</span><span[^>]*>(\\d+)</span>')); return [key, found ? Number(found[1]) : null]; }));
    return { ...rankRate(card), values };
  }).filter((entry) => Object.values(entry.values).some((value) => value !== null));
}
function parse(html, nameMap) {
  const rendered = html.replace(/<!--.*?-->/gs, ' ');
  return { updatedAt: text(rendered.match(/更新日\s*([^<]{1,80})/)?.[1] ?? '') || null, moves: entries(html, LABEL.moves, nameMap), items: entries(html, LABEL.items, nameMap), abilities: entries(html, LABEL.abilities, nameMap), natures: entries(html, LABEL.natures, nameMap), evs: evEntries(html), teammates: entries(html, LABEL.teammates, nameMap) };
}
function name(html) { return text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '').replace(/^#\d+\s*/, '') || null; }
function slugs(html) { const re = new RegExp(BASE.replaceAll('/', '\\/') + '\\/pokedex\\/([^"?#/]+)', 'g'); return [...new Set([...html.matchAll(re)].map((match) => match[1]))]; }
function seasons(html) {
  const payload = html.replaceAll('\\"', '"');
  const idsMatch = payload.match(/"seasonOptionIds":(\[[^\]]+\])/);
  const currentMatch = payload.match(/"seasons":\[\{"id":"([^"]+)","label":"[^"]+","comparisonLabel"/);
  if (!idsMatch || !currentMatch) throw new Error('Current season was not found in the OP.GG tier payload.');
  const ids = JSON.parse(idsMatch[1]).filter((id) => typeof id === 'string');
  const labels = new Map(ids.map((id) => [id, payload.match(new RegExp('"id":"' + id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '","label":"([^"]+)"'))?.[1] ?? id]));
  return { ids, labels, currentId: currentMatch[1] };
}
function seasonDir(id) { return 'id-' + Buffer.from(id).toString('base64url'); }
function version() { return 'v' + Date.now() + '-' + crypto.randomUUID().slice(0, 8); }
function kv() {
  const token = process.env.CLOUDFLARE_API_TOKEN; const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.');
  const url = (key) => 'https://api.cloudflare.com/client/v4/accounts/' + account + '/storage/kv/namespaces/' + NAMESPACE + '/values/' + encodeURIComponent(key);
  async function request(key, init = {}) {
    const res = await fetch(url(key), { ...init, headers: { authorization: 'Bearer ' + token, ...init.headers } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('KV ' + (init.method ?? 'GET') + ' ' + key + ' failed: ' + res.status + ' ' + await res.text());
    return res;
  }
  return { getJson: async (key) => { const res = await request(key); return res ? res.json() : null; }, putJson: (key, value) => request(key, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }), delete: (key) => request(key, { method: 'DELETE' }) };
}
async function main() {
  const config = options(process.argv.slice(2)); const storage = kv();
  const tier = await get(ORIGIN + BASE + '/tier'); const available = seasons(tier);
  config.season ??= available.currentId;
  if (!available.ids.includes(config.season)) throw new Error('--season must be an OP.GG season id from the current tier payload.');
  const found = slugs(tier).slice(0, config.limit); if (!found.length) throw new Error('No Pokemon detail URLs found.');
  const directory = seasonDir(config.season); const pendingKey = 'pending:season:' + directory;
  const current = await storage.getJson('current'); const currentManifest = current?.manifestVersion ? await storage.getJson(current.manifestVersion + ':seasons') : null;
  const publishedVersion = currentManifest?.seasons?.find((entry) => entry?.id === config.season)?.version;
  const staged = await storage.getJson(pendingKey);
  const pending = staged?.schemaVersion === 1 && staged.seasonId === config.season && staged.version !== publishedVersion && staged.completed ? staged : { schemaVersion: 1, seasonId: config.season, version: version(), startedAt: new Date().toISOString(), completed: {} };
  await storage.putJson(pendingKey, pending);
  const nameMap = new Map(Object.entries(JSON.parse(await readFile(MAP, 'utf8')).pokemon)); const failures = [];
  console.log('Fetching ' + found.length + ' Pokemon sequentially into ' + pending.version + ' (single only)...');
  for (const [index, slug] of found.entries()) {
    const key = pending.version + ':season:' + directory + ':pokemon:' + slug;
    try {
      const existing = pending.completed[slug] ? await storage.getJson(key) : null;
      if (existing?.schemaVersion === 3 && existing?.formats?.single) { console.log('[' + (index + 1) + '/' + found.length + '] ' + slug + ' already staged'); continue; }
      const html = await get(ORIGIN + BASE + '/pokedex/' + slug); await sleep(config.delayMs);
      const sourceName = name(html); if (!sourceName) throw new Error('Pokemon name was not found in the page.');
      const pokemon = { schemaVersion: 3, fetchedAt: new Date().toISOString(), name: nameMap.get(slug) ?? sourceName, formats: { single: parse(html, nameMap) } };
      await storage.putJson(key, pokemon); pending.completed[slug] = { name: pokemon.name, fetchedAt: pokemon.fetchedAt }; await storage.putJson(pendingKey, pending);
      console.log('[' + (index + 1) + '/' + found.length + '] ' + slug + ' staged');
    } catch (error) { failures.push({ slug, message: error.message }); console.error('[' + (index + 1) + '/' + found.length + '] ' + slug + ' failed: ' + error.message); }
  }
  if (failures.length) throw new Error(failures.length + ' Pokemon could not be staged. Retry to resume ' + pending.version + '. Failed slugs: ' + failures.map(({ slug }) => slug).join(', '));
  const listPokemon = [];
  for (const slug of found) { const value = await storage.getJson(pending.version + ':season:' + directory + ':pokemon:' + slug); if (value?.schemaVersion !== 3 || !value?.formats?.single) throw new Error('Staged data is missing for ' + slug); listPokemon.push({ slug, name: value.name, single: value.formats.single }); }
  const publishedAt = new Date().toISOString();
  await storage.putJson(pending.version + ':season:' + directory + ':list', { schemaVersion: 1, fetchedAt: publishedAt, pokemon: listPokemon });
  const old = Array.isArray(currentManifest?.seasons) ? currentManifest.seasons : [];
  const season = { id: config.season, label: available.labels.get(config.season) ?? config.season, directory, version: pending.version, fetchedAt: publishedAt, isCurrent: config.season === available.currentId, collectionMode: 'current-snapshot', pokemon: listPokemon.map(({ slug, name }) => ({ slug, name })) };
  const manifest = { schemaVersion: 2, currentSeasonId: available.currentId, seasons: [...old.filter((entry) => entry?.id !== config.season), season].map((entry) => ({ ...entry, isCurrent: entry.id === available.currentId })) };
  await storage.putJson(pending.version + ':seasons', manifest);
  // The final pointer swap is the atomic commit; older versions remain for rollback.
  await storage.putJson('current', { schemaVersion: 1, manifestVersion: pending.version, publishedAt });
  await storage.delete(pendingKey);
  console.log('Published ' + found.length + ' Pokemon records as ' + pending.version + '.');
}
main().catch((error) => { console.error('Collection failed: ' + error.message); process.exitCode = 1; });
