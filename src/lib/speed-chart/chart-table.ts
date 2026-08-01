// すばやさ早見表(/speed-chart)の早見表本体(ChartTable.astro)のブラウザ側ロジック。
//
// 責務(確定した設計のファイル分割表):
//   - マスターデータの取得(public/master-data/ 配下をブラウザから fetch する。既存の
//     pokemon-master-data.ts 等と同じ「クライアント側で1回fetchする」流儀に揃える)
//   - レギュレーション切替(R-12: 「現在のレギュレーション」はこのモジュールが所有する)
//   - 行の描画(R-13: 1行=「実数値/ポケモン群/この個体」の横一列。「この個体」セルの中身は
//     owned-panel.ts に描画を委譲する。このファイル自身はセルの中身を知らない)
//   - 実数値ジャンプ・現在地スクロール(R-6/R-8)
//
// 共有状態の向き(R-12): 「個体の現在のS実数値」は owned-panel.ts が所有する。このファイルは
// document 上の CustomEvent(OWNED_CURRENT_VALUE_EVENT)を購読するだけで、owned-panel.ts の
// 内部変数を直接参照しない(クロージャ共有はしない)。逆方向(レギュレーション変更)は
// このファイルが initOwnedPanel() を import 経由で都度呼び直す(登録パターン。
// box-id/shared-core.ts の registerLeftPanelBridge と同じ「明示的な関数呼び出し」方式)。
//
// マスターデータのJSON importではなくfetchを使う理由: src/lib/pokemon-master-data.ts や
// src/lib/sprite-urls.ts など既存のブラウザ専用モジュールと同じ流儀(public/master-data/ 配下は
// ビルド後の静的アセットとしてfetchする)に揃えるため。src/lib/speed-chart.ts はSSR/ブラウザ
// 両対応の純粋関数のみを提供し、データの読み込み自体は呼び出し側の責務(ファイル冒頭コメント参照)。
import {
  buildSpeedChartPopulation,
  buildSpeedChartRows,
  getEffectiveSpeedModifiers,
  SPEED_SPREADS,
  type AdoptionRateData,
  type EffectiveSpeedModifier,
  type SpeedChartConfig,
  type SpeedChartEntry,
  type SpeedChartForm,
  type SpeedChartRow,
  type SpeedModifierEntry,
  type SpeedModifierMultiplier,
  type SpeedModifiersData,
} from '../speed-chart';
import { spriteUrl } from '../pokemon-master-data';
import {
  initOwnedPanel,
  OWNED_CURRENT_VALUE_EVENT,
  type OwnedCurrentValueEventDetail,
  type OwnedPanelController,
} from './owned-panel';
import type { OwnedPokemonRecord } from '../owned-pokemon';

interface PokemonAutocompleteEntry {
  name: string;
  regulations: string[];
  imageId: number;
}
interface PokemonDetailEntry {
  name: string;
  baseStats: number[];
  abilities: string[];
  learnset: string[];
}
interface MegaStoneEntry {
  species: string;
  item: string;
}
interface ItemAutocompleteEntry {
  name: string;
  regulations: string[];
}

interface MasterData {
  pokemonAutocomplete: PokemonAutocompleteEntry[];
  pokemonDetail: PokemonDetailEntry[];
  megaStones: MegaStoneEntry[];
  itemAutocomplete: ItemAutocompleteEntry[];
  speedModifiers: SpeedModifiersData;
}

const ROOT_SELECTOR = '.speed-chart-table';

export async function initSpeedChartPage(): Promise<void> {
  const root = document.querySelector<HTMLElement>(ROOT_SELECTOR);
  if (!root) return;

  const initialRegulation = root.dataset.regulation ?? '';
  const ownedId = root.dataset.ownedId || null;
  const hasOwnedPanel = root.dataset.hasOwnedPanel === 'true';

  const config = readEmbeddedJson<SpeedChartConfig>('speed-chart-config');
  const adoptionByRegulation = readEmbeddedJson<Record<string, AdoptionRateData>>('speed-chart-adoption-data') ?? {};
  const ownedRecord = hasOwnedPanel ? readEmbeddedJson<OwnedPokemonRecord>('speed-chart-owned-record') : null;

  const statusEl = document.getElementById('speed-chart-status');
  const tableEl = document.getElementById('speed-chart-rows');
  const bodyEl = document.getElementById('speed-chart-rows-body');
  const regSelect = document.getElementById('speed-chart-regulation-select') as HTMLSelectElement | null;
  const jumpInput = document.getElementById('speed-chart-jump-input') as HTMLInputElement | null;
  const jumpButton = document.getElementById('speed-chart-jump-button');
  const backButton = document.getElementById('speed-chart-back-to-current');

  if (!config || !statusEl || !tableEl || !bodyEl) {
    if (statusEl) statusEl.textContent = '設定の読み込みに失敗しました。';
    return;
  }

  let masterData: MasterData;
  try {
    masterData = await loadMasterData();
  } catch (err) {
    statusEl.textContent = 'マスターデータの読み込みに失敗しました。';
    // eslint-disable-next-line no-console
    console.error('[speed-chart] failed to load master data', err);
    return;
  }

  const effectiveModifiers = getEffectiveSpeedModifiers(masterData.speedModifiers, config);
  const scarfEntry = findScarfItemEntry(masterData.speedModifiers.items);
  const imageIdByName = new Map(masterData.pokemonAutocomplete.map((p) => [p.name, p.imageId]));

  const rowElements = new Map<number, HTMLElement>();
  const formsByName = new Map<string, SpeedChartForm>();
  let ownedController: OwnedPanelController | null = null;
  let currentRegulation = initialRegulation;
  let currentHighlightValue: number | null = null;
  let lastKnownOwnedValue: number | null = null;
  let hasScrolledInitially = false;

  function render(regulation: string): void {
    currentRegulation = regulation;
    const population = buildSpeedChartPopulation(
      regulation,
      masterData.pokemonAutocomplete,
      masterData.pokemonDetail,
      masterData.megaStones,
      masterData.itemAutocomplete,
    );
    formsByName.clear();
    for (const form of population) formsByName.set(form.name, form);

    const adoptionData = adoptionByRegulation[regulation];
    const rows = buildSpeedChartRows(population, effectiveModifiers, config!.adoptionRate, adoptionData);

    ownedController = null;
    if (hasOwnedPanel && ownedRecord) {
      const ownedForm = formsByName.get(ownedRecord.species_name);
      if (ownedForm) {
        const scarfUsable =
          !ownedForm.isMega &&
          !!scarfEntry &&
          masterData.itemAutocomplete.some((item) => item.name === scarfEntry.name && item.regulations.includes(regulation));
        ownedController = initOwnedPanel({
          ownedRecord,
          baseSpeed: ownedForm.baseSpeed,
          scarfModifier: scarfUsable ? scarfEntry!.modifier : null,
          scarfItemName: scarfUsable ? scarfEntry!.name : null,
        });
      }
    }

    renderRows(rows);

    // R-6/R-8: 初期表示時だけ現在地へ自動スクロールする(以後のレギュレーション切替では
    // スクロールしない。ownedController.getCurrentValue() は panel が所有する値をここで
    // 直接読むだけで、panel側の内部変数へは踏み込まない)。
    if (ownedController) {
      const value = ownedController.getCurrentValue();
      lastKnownOwnedValue = value;
      applyHighlight(value);
      if (!hasScrolledInitially && ownedId) {
        hasScrolledInitially = true;
        scrollToValue(value);
      }
    }
  }

  function renderRows(rows: SpeedChartRow[]): void {
    rowElements.clear();
    bodyEl!.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'speed-chart-row';
      rowEl.dataset.value = String(row.value);

      const valueCell = document.createElement('div');
      valueCell.className = 'speed-chart-value-cell tnum';
      valueCell.textContent = String(row.value);
      rowEl.appendChild(valueCell);

      const groupCell = document.createElement('div');
      groupCell.className = 'speed-chart-group-cell';
      groupCell.appendChild(buildGroupsElement(row.entries, formsByName, imageIdByName));
      rowEl.appendChild(groupCell);

      const ownedCell = document.createElement('div');
      ownedCell.className = 'speed-chart-owned-cell';
      if (ownedController) {
        ownedCell.appendChild(ownedController.renderCell(row.value));
      } else {
        ownedCell.appendChild(buildDashCell());
      }
      rowEl.appendChild(ownedCell);

      fragment.appendChild(rowEl);
      rowElements.set(row.value, rowEl);
    }

    bodyEl!.appendChild(fragment);
    statusEl!.hidden = true;
    tableEl!.hidden = false;

    if (currentHighlightValue !== null) {
      // renderRowsの直後は新しいDOMに対してハイライトを付け直す必要がある
      // (render()側のapplyHighlight呼び出しより前にDOMが作られるため)。
      const value = currentHighlightValue;
      currentHighlightValue = null;
      applyHighlight(value);
    }
  }

  function applyHighlight(value: number): void {
    if (currentHighlightValue !== null) {
      rowElements.get(currentHighlightValue)?.classList.remove('is-current-row');
    }
    currentHighlightValue = value;
    rowElements.get(value)?.classList.add('is-current-row');
  }

  function scrollToValue(value: number): void {
    const el = findNearestRowElement(value);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function findNearestRowElement(targetValue: number): HTMLElement | null {
    if (rowElements.has(targetValue)) return rowElements.get(targetValue) ?? null;
    // R-8: 「その値以上で最も近い行」まで昇順に探す。
    const values = Array.from(rowElements.keys()).sort((a, b) => a - b);
    for (const v of values) {
      if (v >= targetValue) return rowElements.get(v) ?? null;
    }
    // targetValueが全行より大きい場合は最大値(実数値降順の先頭行)へ。
    return values.length > 0 ? rowElements.get(values[values.length - 1]) ?? null : null;
  }

  document.addEventListener(OWNED_CURRENT_VALUE_EVENT, (event) => {
    const detail = (event as CustomEvent<OwnedCurrentValueEventDetail>).detail;
    lastKnownOwnedValue = detail.value;
    // R-12: 「行のハイライトを描き直すだけ」。セル内部の3状態描画自体はowned-panel.tsが行う。
    applyHighlight(detail.value);
  });

  regSelect?.addEventListener('change', () => {
    const next = regSelect.value;
    if (!next || next === currentRegulation) return;
    render(next);
    // 要件11: 変更時にURLの?regをhistory.replaceStateで書き換える(ページ遷移はしない)。
    const url = new URL(window.location.href);
    url.searchParams.set('reg', next);
    window.history.replaceState(null, '', url);
  });

  function jumpToInputValue(): void {
    if (!jumpInput) return;
    const value = Number.parseInt(jumpInput.value, 10);
    if (!Number.isFinite(value)) return;
    scrollToValue(value);
  }

  jumpButton?.addEventListener('click', jumpToInputValue);
  jumpInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToInputValue();
    }
  });

  backButton?.addEventListener('click', () => {
    if (lastKnownOwnedValue !== null) scrollToValue(lastKnownOwnedValue);
  });

  render(initialRegulation);
}

function readEmbeddedJson<T>(elementId: string): T | null {
  const el = document.getElementById(elementId);
  if (!el || !el.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

async function loadMasterData(): Promise<MasterData> {
  const [pokemonAutocomplete, pokemonDetail, megaStones, itemAutocomplete, speedModifiers] = await Promise.all([
    fetch('/master-data/autocomplete/pokemon.json').then((r) => r.json() as Promise<PokemonAutocompleteEntry[]>),
    fetch('/master-data/detail/pokemon.json').then((r) => r.json() as Promise<PokemonDetailEntry[]>),
    fetch('/master-data/autocomplete/mega-stones.json').then((r) => r.json() as Promise<MegaStoneEntry[]>),
    fetch('/master-data/autocomplete/items.json').then((r) => r.json() as Promise<ItemAutocompleteEntry[]>),
    fetch('/master-data/detail/speed-modifiers.json').then((r) => r.json() as Promise<SpeedModifiersData>),
  ]);
  return { pokemonAutocomplete, pokemonDetail, megaStones, itemAutocomplete, speedModifiers };
}

// U-2/R-4: 「こだわりスカーフ」という名前をハードコードせず、items内で kind==='multiplier' の
// エントリを機械的に見つける(speed-chart.ts冒頭コメントの「アプリ側にポケモン名・技名・
// 特性名をハードコードしない」方針を持ち物名にも適用したもの)。
function findScarfItemEntry(
  items: Record<string, SpeedModifierEntry>,
): { name: string; modifier: SpeedModifierMultiplier } | null {
  for (const [name, modifier] of Object.entries(items)) {
    if (modifier.kind === 'multiplier') return { name, modifier };
  }
  return null;
}

function buildDashCell(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'speed-chart-owned';
  const span = document.createElement('span');
  span.className = 'speed-chart-owned-dash';
  span.textContent = '−';
  wrap.appendChild(span);
  return wrap;
}

// R-13: 「実数値行の中で振り方+種族値ラベル+補正ラベルのグループに分ける」(PNGの構造)。
// 同じ行(=同じ実数値)の中で spread + modifier の組み合わせが同じエントリを1グループにまとめる。
function buildGroupsElement(
  entries: SpeedChartEntry[],
  formsByName: Map<string, SpeedChartForm>,
  imageIdByName: Map<string, number>,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'speed-chart-groups';

  const groups = new Map<string, { label: string; formNames: string[] }>();
  for (const entry of entries) {
    const key = `${entry.spread}|${entry.modifier ? `${entry.modifier.category}:${entry.modifier.name}` : 'none'}`;
    let group = groups.get(key);
    if (!group) {
      group = { label: buildGroupLabel(entry, formsByName), formNames: [] };
      groups.set(key, group);
    }
    group.formNames.push(entry.formName);
  }

  for (const group of groups.values()) {
    const groupEl = document.createElement('div');
    groupEl.className = 'speed-chart-group';

    const heading = document.createElement('div');
    heading.className = 'speed-chart-group-heading';
    heading.textContent = group.label;
    groupEl.appendChild(heading);

    const chips = document.createElement('div');
    chips.className = 'speed-chart-chips';
    for (const formName of group.formNames) {
      chips.appendChild(buildChip(formName, imageIdByName));
    }
    groupEl.appendChild(chips);

    container.appendChild(groupEl);
  }

  return container;
}

function buildGroupLabel(entry: SpeedChartEntry, formsByName: Map<string, SpeedChartForm>): string {
  const baseSpeed = formsByName.get(entry.formName)?.baseSpeed ?? '?';
  const spreadLabel = SPEED_SPREADS[entry.spread].label;
  let label = `${spreadLabel} ${baseSpeed}族`;
  if (entry.modifier) label += ` ${formatModifierLabel(entry.modifier)}`;
  return label;
}

// 参考サイトの語彙(120族 2倍 / 110族 S+2 / 123族 こだわりスカーフ)に合わせる。
// 持ち物は名前だけ、特性・技は倍率/ランク量+名前を表示する(P1確定仕様の表と同じ書式)。
function formatModifierLabel(modifier: EffectiveSpeedModifier): string {
  if (modifier.category === 'items') return modifier.name;
  const magnitude =
    modifier.modifier.kind === 'rank'
      ? `S+${modifier.modifier.stages}`
      : `${formatRatio(modifier.modifier.numerator / modifier.modifier.denominator)}倍`;
  return `${magnitude} ${modifier.name}`;
}

function formatRatio(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildChip(formName: string, imageIdByName: Map<string, number>): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'speed-chart-chip';

  const imageId = imageIdByName.get(formName);
  if (imageId) {
    const img = document.createElement('img');
    img.className = 'sprite-icon speed-chart-chip-icon';
    img.src = spriteUrl(imageId);
    img.alt = '';
    img.loading = 'lazy';
    chip.appendChild(img);
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'speed-chart-chip-name';
  nameEl.textContent = formName;
  chip.appendChild(nameEl);

  return chip;
}
