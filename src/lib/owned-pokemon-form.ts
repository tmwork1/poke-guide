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

export type SpeciesUsageByRegulation = Record<string, Record<string, number>>;

let pokemonNamesInPhysicalOrder: string[] | null = null;

export function sortPokemonNamesByUsage(
  names: readonly string[],
  usage: Readonly<Record<string, number>>,
): string[] {
  return names
    .map((name, index) => ({ name, index }))
    .sort((a, b) => (usage[b.name] ?? 0) - (usage[a.name] ?? 0) || a.index - b.index)
    .map(({ name }) => name);
}

export function readSpeciesUsageData(): SpeciesUsageByRegulation | null {
  const embedded = document.getElementById('box-species-usage-data');
  if (!embedded) return null;
  try {
    return JSON.parse(embedded.textContent ?? '{}') as SpeciesUsageByRegulation;
  } catch (err) {
    console.warn('種族使用率データの読み込みに失敗しました', err);
    return {};
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
  const list = (await res.json()) as Array<{ name: string }>;
  const datalist = el<HTMLDataListElement>(datalistId);
  const names = list.map(({ name }) => name);
  if (datalistId === 'pokemon-list') {
    pokemonNamesInPhysicalOrder = names;
    const regulation = (document.getElementById('regulation') as HTMLSelectElement | null)?.value ?? '';
    const usageByRegulation = readSpeciesUsageData();
    replaceDatalistOptions(
      datalist,
      usageByRegulation === null ? names : sortPokemonNamesByUsage(names, usageByRegulation[regulation.trim()] ?? {}),
    );
    return;
  }
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

// 種族名から図鑑ページへのリンク(pokemonDetailHref)は、個体編集画面の「図鑑で見る」を
// 廃止したことで呼び出し元が無くなったため削除した。ポケモン名→URLパスセグメントの変換が
// 再び必要になった場合は src/lib/pokemon-slug.ts の toPokemonPathSegment を使うこと。
