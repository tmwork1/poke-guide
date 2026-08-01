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
  filterRowsByReachableValues,
  getEffectiveSpeedModifiers,
  limitRowChipsByWidth,
  sortFormNamesByUsage,
  SPEED_SPREADS,
  type AdoptionRateData,
  type EffectiveSpeedModifier,
  type SpeciesUsageCounts,
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
  OWNED_REACHABLE_VALUES_EVENT,
  type OwnedCurrentValueEventDetail,
  type OwnedPanelController,
  type OwnedReachableValuesEventDetail,
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
  // 追加改修(2026-08-01第2弾)要件1: レギュレーション別の種族使用率(ranked_team_members由来。
  // index.astroが1レギュレーションずつではなく全レギュレーション分まとめて埋め込むため、
  // レギュレーション切替時に追加のfetchなしで再計算できる(adoptionByRegulationと同じ設計)。
  const usageByRegulation = readEmbeddedJson<Record<string, SpeciesUsageCounts>>('speed-chart-usage-data') ?? {};
  const ownedRecord = hasOwnedPanel ? readEmbeddedJson<OwnedPokemonRecord>('speed-chart-owned-record') : null;

  const statusEl = document.getElementById('speed-chart-status');
  const tableEl = document.getElementById('speed-chart-rows');
  const bodyEl = document.getElementById('speed-chart-rows-body');
  const regSelect = document.getElementById('speed-chart-regulation-select') as HTMLSelectElement | null;
  const jumpInput = document.getElementById('speed-chart-jump-input') as HTMLInputElement | null;
  const jumpButton = document.getElementById('speed-chart-jump-button');
  const backButton = document.getElementById('speed-chart-back-to-current');
  // 要件4: ?owned=があるときだけ存在するトグル(ChartTable.astro側もhasOwnedPanelで条件付け済み)。
  const reachableOnlyToggle = document.getElementById('speed-chart-reachable-only-toggle') as HTMLInputElement | null;

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
  // 追加改修(2026-08-01第2弾)要件4の状態。
  let currentRows: SpeedChartRow[] = [];
  // R-12更新: 「個体が到達可能な実数値の集合」はowned-panel.tsが所有する。ここではCustomEvent
  // 経由で受け取った値をキャッシュするだけ(クロージャ共有はしない)。
  let lastKnownReachableValues: Set<number> | null = null;
  // 既定でON(とりうるすばやさのみ)。?owned=が無いときはトグル自体が無くこの値は使われない。
  let showReachableOnly = true;
  // 要件3の不具合修正(2026-08-01): 「行ごとの実際の合計幅」で足切りするための実測キャッシュ。
  // フォルム名 -> チップ1個の実測幅(px)。チップ幅は名前とアイコンだけで決まるため、
  // フォルム名をキーに1回だけ測ればよい(レギュレーションを跨いでも再利用する。
  // ensureChipMetrics参照)。
  const chipWidthByName = new Map<string, number>();
  // グループセル幅・チップ間gap・「+N件」バッジ幅は行によらず一定(固定グリッド列幅のため)
  // なので初回のみ実測してキャッシュする。
  let chipLayoutMetrics: ChipLayoutMetrics | null = null;

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
    currentRows = buildSpeedChartRows(population, effectiveModifiers, config!.adoptionRate, adoptionData);

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

    renderVisibleRows();

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

  // 要件4: 現在のトグル状態(showReachableOnly)とlastKnownReachableValuesに基づき、
  // currentRowsを絞り込んでから描画する。レギュレーション切替・トグル切替の両方から呼ばれる。
  function renderVisibleRows(): void {
    const rows =
      hasOwnedPanel && showReachableOnly && lastKnownReachableValues
        ? filterRowsByReachableValues(currentRows, lastKnownReachableValues)
        : currentRows;
    renderRows(rows);
  }

  function renderRows(rows: SpeedChartRow[]): void {
    rowElements.clear();
    bodyEl!.replaceChildren();
    const fragment = document.createDocumentFragment();

    // 要件3の不具合修正: このレギュレーションの母集団のうち未計測のフォルムだけを一括計測する
    // (計測フェーズと描画フェーズを分離。レイアウトスラッシング回避)。
    chipLayoutMetrics = ensureChipMetrics(bodyEl!, tableEl!, formsByName.keys(), imageIdByName, chipWidthByName, chipLayoutMetrics);
    const usageCounts = usageByRegulation[currentRegulation];
    const baseSpeedByName = new Map<string, number>();
    for (const [name, form] of formsByName) baseSpeedByName.set(name, form.baseSpeed);

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
      groupCell.appendChild(
        buildRowContent(row.entries, baseSpeedByName, imageIdByName, usageCounts, chipWidthByName, chipLayoutMetrics),
      );
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

  // 追加改修(2026-08-01第2弾)要件4・R-12更新: 「個体が到達可能な実数値の集合」は
  // owned-panel.tsが所有し、CustomEventで一方向に通知する。ここでは値をキャッシュして
  // renderVisibleRows()の絞り込みに使うだけ(owned-panel.ts側の内部変数は直接参照しない)。
  // render()の中でinitOwnedPanel()が呼ばれた時点でこのリスナーが同期的に発火するよう、
  // render(initialRegulation)より前にここで登録しておく。
  document.addEventListener(OWNED_REACHABLE_VALUES_EVENT, (event) => {
    const detail = (event as CustomEvent<OwnedReachableValuesEventDetail>).detail;
    lastKnownReachableValues = new Set(detail.values);
  });

  reachableOnlyToggle?.addEventListener('change', () => {
    showReachableOnly = reachableOnlyToggle.checked;
    renderVisibleRows();
    // トグル操作でも← 現在マーカーの位置は変わらないため、直前のハイライト値を再適用する。
    if (ownedController) applyHighlight(ownedController.getCurrentValue());
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

// 追加改修(2026-08-01第2弾)要件3: 「すばやさ数値ごとに1段(文字とアイコンは別段のまま)に
// まとめる」。以前は「振り方+補正」のグループごとに見出し+アイコン行を積んでいた
// (グループ数が多い行で最大10段超・高さ100〜400px超のばらつき)。ラベル群を1段目
// (.speed-chart-labels-row)、チップ群を2段目(.speed-chart-chips-row)にまとめ、
// 両者の対応は「同じグループ順に並べる」ことで表す(R-13の「振り方+種族値ラベル+補正ラベルの
// グループに分ける」という構造自体は維持し、レイアウトだけを2段に変える)。
function buildRowContent(
  entries: SpeedChartEntry[],
  baseSpeedByName: Map<string, number>,
  imageIdByName: Map<string, number>,
  usageCounts: SpeciesUsageCounts | undefined,
  chipWidthByName: Map<string, number>,
  chipLayoutMetrics: ChipLayoutMetrics | null,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'speed-chart-row-content';

  const groups = new Map<string, { label: string; formNames: string[] }>();
  for (const entry of entries) {
    const key = `${entry.spread}|${entry.modifier ? `${entry.modifier.category}:${entry.modifier.name}` : 'none'}`;
    let group = groups.get(key);
    if (!group) {
      group = { label: buildGroupLabel(entry, baseSpeedByName), formNames: [] };
      groups.set(key, group);
    }
    group.formNames.push(entry.formName);
  }

  // 要件1: グループ内を使用率降順(→すばやさ種族値降順→種族名昇順)に並べる。
  const orderedGroups = Array.from(groups.values(), (group) => ({
    label: group.label,
    formNames: sortFormNamesByUsage(group.formNames, usageCounts, baseSpeedByName),
  }));

  // 要件3の不具合修正: 行全体のチップの実際の合計幅を実測キャッシュから求めて足切りする
  // (グループの境界をまたいで使用率の最下位から落とす。グループ順・グループ内の並びは
  // 維持したまま除外するだけ)。計測がまだ済んでいない(異常系)場合は足切りをかけない
  // 安全側にフォールバックする。
  const allFormNamesInOrder = orderedGroups.flatMap((group) => group.formNames);
  const { kept, droppedCount } = chipLayoutMetrics
    ? limitRowChipsByWidth(
        allFormNamesInOrder,
        usageCounts,
        baseSpeedByName,
        chipWidthByName,
        chipLayoutMetrics.gapWidth,
        chipLayoutMetrics.containerWidth,
        chipLayoutMetrics.overflowBadgeWidth,
      )
    : { kept: allFormNamesInOrder, droppedCount: 0 };
  const keptSet = new Set(kept);

  const labelsRow = document.createElement('div');
  labelsRow.className = 'speed-chart-labels-row';
  orderedGroups.forEach((group, index) => {
    if (index > 0) labelsRow.appendChild(document.createTextNode(' / '));
    const span = document.createElement('span');
    span.className = 'speed-chart-label-group';
    span.textContent = group.label;
    labelsRow.appendChild(span);
  });

  const chipsRow = document.createElement('div');
  chipsRow.className = 'speed-chart-chips-row';
  for (const group of orderedGroups) {
    for (const formName of group.formNames) {
      if (!keptSet.has(formName)) continue;
      chipsRow.appendChild(buildChip(formName, imageIdByName));
    }
  }
  // 足切りが起きた行には必ず可視で件数を示す(黙って切ると「そのポケモンは居ない」と
  // 誤読されるため。stack.mdの「no silent caps」と同趣旨)。
  if (droppedCount > 0) {
    const overflow = document.createElement('span');
    overflow.className = 'speed-chart-chip-overflow';
    overflow.textContent = `+${droppedCount}件`;
    chipsRow.appendChild(overflow);
  }

  container.append(labelsRow, chipsRow);
  return container;
}

function buildGroupLabel(entry: SpeedChartEntry, baseSpeedByName: Map<string, number>): string {
  const baseSpeed = baseSpeedByName.get(entry.formName) ?? '?';
  const spreadLabel = SPEED_SPREADS[entry.spread].label;
  let label = `${spreadLabel} ${baseSpeed}族`;
  if (entry.modifier) label += ` ${formatModifierLabel(entry.modifier)}`;
  return label;
}

/** グループセル幅・チップ間gap・「+N件」バッジ幅(行によらず一定。固定グリッド列幅のため)。 */
interface ChipLayoutMetrics {
  containerWidth: number;
  gapWidth: number;
  overflowBadgeWidth: number;
}

// 要件3の不具合修正(2026-08-01): 「行ごとの実際の合計幅」で足切りするため、チップ幅を
// フォルム名ごとに実測してキャッシュする(名前が同じならアイコン・幅も同じなので、
// 1回測れば以後のレギュレーション切替でも使い回せる)。
//
// ⚠ getBoundingClientRect()を1行ずつ呼ぶとレイアウトスラッシングになるため、
// 「未計測のフォルムを一括でDOMに書き込む(書き込みフェーズ)→まとめて一度に読み取る
// (読み取りフェーズ)」の2フェーズに分離する(このループの中では書き込みと読み取りを
// 混在させない)。
//
// containerWidth/gapWidth/overflowBadgeWidthは初回呼び出し時のみ実測し(existingがnullの
// 場合)、以後は引数で受け取った既存値をそのまま返す(グリッド列幅は行によらず一定のため
// 再測定は不要)。
function ensureChipMetrics(
  bodyEl: HTMLElement,
  tableEl: HTMLElement,
  formNames: Iterable<string>,
  imageIdByName: Map<string, number>,
  chipWidthByName: Map<string, number>,
  existing: ChipLayoutMetrics | null,
): ChipLayoutMetrics | null {
  const missing = [...formNames].filter((name) => !chipWidthByName.has(name));
  if (missing.length === 0 && existing !== null) return existing;

  const wasHidden = tableEl.hidden;
  tableEl.hidden = false; // 非表示中はgetBoundingClientRectが0になるため一時的に表示する

  // ⚠ position:absoluteにすると、この時点でのcontainingBlock(このページに他の
  // position指定祖先が無ければ初期containing block)に対するshrink-to-fit幅で
  // グリッドの列幅が決まってしまい、.speed-chart-group-cell(minmax(0,1fr)の可変列)の
  // 実測幅が実際の行(bodyEl幅いっぱいに広がる通常フローの行)とズレる(実測して確認済み:
  // absoluteだと0、通常フローだと実際の行と同じ748px)。そのためabsoluteにはせず、
  // 通常フロー内に挿入する(bodyElは呼び出し時点で空 = replaceChildren直後なので、
  // 同期的に追加→削除する間に他の内容へ影響しない)。
  const probeRow = document.createElement('div');
  probeRow.className = 'speed-chart-row';
  probeRow.style.visibility = 'hidden';
  probeRow.style.pointerEvents = 'none';

  const valueCell = document.createElement('div');
  valueCell.className = 'speed-chart-value-cell';
  const groupCell = document.createElement('div');
  groupCell.className = 'speed-chart-group-cell';
  const chipsRow = document.createElement('div');
  chipsRow.className = 'speed-chart-chips-row';
  groupCell.appendChild(chipsRow);
  const ownedCell = document.createElement('div');
  ownedCell.className = 'speed-chart-owned-cell';
  probeRow.append(valueCell, groupCell, ownedCell);
  bodyEl.appendChild(probeRow);

  // 書き込みフェーズ: 未計測分のチップを一括で作る(ここではgetBoundingClientRectを呼ばない)。
  const chipByName = new Map<string, HTMLElement>();
  for (const name of missing) {
    const chip = buildChip(name, imageIdByName);
    chipsRow.appendChild(chip);
    chipByName.set(name, chip);
  }
  // レギュレーションあたりの母集団は最大308件(M-Bで実測)。「+N件」は3桁あれば十分な余裕。
  let overflowProbe: HTMLElement | null = null;
  if (existing === null) {
    overflowProbe = document.createElement('span');
    overflowProbe.className = 'speed-chart-chip-overflow';
    overflowProbe.textContent = '+999件';
    chipsRow.appendChild(overflowProbe);
  }

  // 読み取りフェーズ: ここで初めてまとめてgetBoundingClientRectを呼ぶ。
  for (const [name, chip] of chipByName) {
    chipWidthByName.set(name, chip.getBoundingClientRect().width);
  }
  let metrics = existing;
  if (metrics === null) {
    const containerWidth = groupCell.getBoundingClientRect().width;
    const gap = Number.parseFloat(getComputedStyle(chipsRow).columnGap || getComputedStyle(chipsRow).gap || '0') || 0;
    const overflowBadgeWidth = overflowProbe!.getBoundingClientRect().width;
    metrics = { containerWidth, gapWidth: gap, overflowBadgeWidth };
  }

  bodyEl.removeChild(probeRow);
  tableEl.hidden = wasHidden;

  return metrics;
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
