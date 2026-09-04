// src/pages/box/[id].astro が使うブラウザ専用のフォームヘルパー(育成データ管理計画.md
// §8 Phase C-3・C-4)。旧 src/pages/box/new.astro と共有していたが、個体追加が自動登録
// フローに変わったため new.astro は廃止済み。
// src/pages/builds/new.astro の loadAutocomplete()/readEv() 等と同じ実装パターン。
// IVは「チャンピオンズ」ルールで常に31固定のため readIv は廃止済み(呼び出し元は常に31を直接送る)。
// SSR環境(Astroのフロントマター)からは呼び出さないこと(document/fetchに依存する)。

export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export const MOVE_SLOTS = [1, 2, 3, 4];

export function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`要素が見つかりません: #${id}`);
  }
  return found as T;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function readEv(stat: string): number {
  const raw = Number(el<HTMLInputElement>(`ev-${stat}`).value);
  if (!Number.isFinite(raw)) return 0;
  return clamp(raw, 0, 32);
}

export function readMoveNames(): string[] {
  return MOVE_SLOTS.map((slot) => el<HTMLInputElement>(`move-${slot}`).value.trim()).filter((name) => name !== '');
}

// タグ入力(カンマ区切りテキスト)のヘルパー parseTagsInput / formatTagsForInput は、
// 個体編集画面から「その他の設定(レベル・タグ・ピン留め・共有)」を廃止して呼び出し元が
// 無くなったため削除した。タグ自体はDBに残り、ボックス一覧の絞り込みは引き続き機能する。

export function sortPokemonNamesByOpggRanking(
  names: readonly string[],
  rankedNames: readonly string[],
): string[] {
  const ranks = new Map(rankedNames.map((name, index) => [name, index]));
  return names
    .map((name, index) => ({ name, index, rank: ranks.get(name) }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.index - b.index)
    .map(({ name }) => name);
}

export interface DatalistPokemonEntry {
  name: string;
  dexNo: number;
  forme: string | null;
}

// pokemon-list datalistの並び順を種族選択モーダル(species-select-dialog.tsのrenderGrid)と
// 揃える: 通常種はopgg順に並べ、メガシンカは通常フォルムの直後に挿入する。opgg順位はメガ
// シンカ自体をほぼランキングしないため、sortPokemonNamesByOpggRankingに全種族名をそのまま
// 渡すとメガシンカだけ末尾側の未ランク集団に紛れて本来の位置(通常フォルム直後)から離れる。
// damage-calc-page/secondary-bar.tsの相手ポケモン候補(/damage-calc単独ページ)からも使う。
export function orderPokemonEntriesForDatalist(
  entries: readonly DatalistPokemonEntry[],
  rankedNames: readonly string[],
): string[] {
  const isMega = (entry: DatalistPokemonEntry): boolean => entry.forme?.startsWith('Mega') ?? false;
  const nonMegaEntries = entries.filter((entry) => !isMega(entry));
  const megaEntries = entries.filter(isMega);
  const nonMegaByName = new Map(nonMegaEntries.map((entry) => [entry.name, entry]));
  const sortedNonMega = sortPokemonNamesByOpggRanking(nonMegaEntries.map((entry) => entry.name), rankedNames)
    .map((name) => nonMegaByName.get(name)!);

  const megaByDex = new Map<number, DatalistPokemonEntry[]>();
  for (const mega of megaEntries) {
    const megas = megaByDex.get(mega.dexNo) ?? [];
    megas.push(mega);
    megaByDex.set(mega.dexNo, megas);
  }

  const ordered: DatalistPokemonEntry[] = [];
  const usedDex = new Set<number>();
  for (const entry of sortedNonMega) {
    ordered.push(entry);
    const megas = megaByDex.get(entry.dexNo);
    if (megas && !usedDex.has(entry.dexNo)) {
      ordered.push(...megas);
      usedDex.add(entry.dexNo);
    }
  }
  for (const [dexNo, megas] of megaByDex) {
    if (!usedDex.has(dexNo)) ordered.push(...megas);
  }

  return ordered.map((entry) => entry.name);
}

function readOpggRankedSpeciesNames(): string[] | null {
  const embedded = document.getElementById('box-opgg-ranked-species');
  if (!embedded) return null;
  try {
    const parsed = JSON.parse(embedded.textContent ?? '[]');
    return Array.isArray(parsed) && parsed.every((name) => typeof name === 'string') ? parsed : [];
  } catch (err) {
    console.warn('OP.GG ranking data could not be parsed', err);
    return [];
  }
}

function replaceDatalistOptions(datalist: HTMLDataListElement, names: readonly string[]): void {
  const fragment = document.createDocumentFragment();
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    fragment.appendChild(option);
  }
  datalist.replaceChildren(fragment);
}

async function fillDatalist(res: Response, datalistId: string): Promise<void> {
  const datalist = el<HTMLDataListElement>(datalistId);
  if (datalistId === 'pokemon-list') {
    const list = (await res.json()) as Array<{ name: string; dexNo?: number; forme?: string | null }>;
    const entries = list.map(({ name, dexNo, forme }) => ({ name, dexNo: dexNo ?? 0, forme: forme ?? null }));
    const rankedNames = readOpggRankedSpeciesNames() ?? [];
    replaceDatalistOptions(datalist, orderPokemonEntriesForDatalist(entries, rankedNames));
    return;
  }
  const list = (await res.json()) as Array<{ name: string }>;
  const names = list.map(({ name }) => name);
  const fragment = document.createDocumentFragment();
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    fragment.appendChild(option);
  }
  datalist.appendChild(fragment);
}

// オートコンプリート用の軽量JSON(build:master-data 生成物)を datalist に反映する
// (育成データ管理計画.md §6.3・§8 Phase C-4。src/pages/builds/new.astro と同じデータソース)。
export async function loadAutocomplete(): Promise<void> {
  try {
    const [pokemonRes, moveRes, abilityRes, itemRes] = await Promise.all([
      fetch('/master-data/autocomplete/pokemon.json'),
      fetch('/master-data/autocomplete/moves.json'),
      fetch('/master-data/autocomplete/abilities.json'),
      fetch('/master-data/autocomplete/items.json'),
    ]);
    await Promise.all([
      fillDatalist(pokemonRes, 'pokemon-list'),
      fillDatalist(moveRes, 'move-list'),
      fillDatalist(abilityRes, 'ability-list'),
      fillDatalist(itemRes, 'item-list'),
    ]);
  } catch (err) {
    console.warn('オートコンプリート用データの読み込みに失敗しました', err);
  }
}
