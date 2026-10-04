#!/usr/bin/env node
// OP.GG の採用技(fetch-champions-usage.mjs --moves-out の出力)のうち、jpoke の learnset に無いものを
// config/opgg-learnset-supplement.json へ追記する。build:master-data がこのファイルを learnset へ合流させる。
// OP.GG は上位の技しか載せないため、過去の取得分を消さないよう和集合で更新する。
// 比較には生成済みの public/master-data/detail/*.json を使うので、先に npm run build:master-data が要る。
//
// 使い方: node scripts/opgg/update-learnset-supplement.mjs <moves.json>
import { readFile, writeFile } from 'node:fs/promises';

const SUPPLEMENT = new URL('../../config/opgg-learnset-supplement.json', import.meta.url);
const POKEMON_DETAIL = new URL('../../public/master-data/detail/pokemon.json', import.meta.url);
const MOVES_DETAIL = new URL('../../public/master-data/detail/moves.json', import.meta.url);

const movesPath = process.argv[2];
if (!movesPath) throw new Error('Usage: node scripts/opgg/update-learnset-supplement.mjs <moves.json>');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const [opgg, detail, moves, original] = await Promise.all([
  readJson(movesPath),
  readJson(POKEMON_DETAIL),
  readJson(MOVES_DETAIL),
  readFile(SUPPLEMENT, 'utf8'),
]);
const learnsets = new Map(detail.map(({ name, learnset }) => [name, new Set(learnset ?? [])]));
const moveNames = new Set(moves.map(({ name }) => name));
const file = JSON.parse(original);
const pokemon = file.pokemon ?? {};
const added = new Set();

for (const [name, opggMoves] of Object.entries(opgg.pokemon ?? {})) {
  const learnset = learnsets.get(name);
  if (!learnset) {
    console.warn(`警告: マスターデータに無い種族名です: ${name}`);
    continue;
  }
  for (const move of opggMoves) {
    if (learnset.has(move)) continue;
    if (!moveNames.has(move)) {
      console.warn(`警告: マスターデータに無い技名です: ${name} / ${move}`);
      continue;
    }
    pokemon[name] = [...new Set([...(pokemon[name] ?? []), move])];
    added.add(`${name} / ${move}`);
  }
}

const compare = (a, b) => a.localeCompare(b, 'ja');
file.pokemon = Object.fromEntries(
  Object.entries(pokemon)
    .sort(([a], [b]) => compare(a, b))
    .map(([name, list]) => [name, [...list].sort(compare)]),
);
const next = JSON.stringify(file, null, 2) + '\n';
if (next !== original) await writeFile(SUPPLEMENT, next, 'utf8');
console.log(`learnset 補完: ${added.size} 件追加${added.size ? `(${[...added].join('、')})` : ''}`);
