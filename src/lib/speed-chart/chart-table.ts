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
  type SpeedSpreadKind,
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
  // 要件5(2026-08-01第4弾): すばやさ上昇要因(ランク補正・道具・特性等の補正情報)の表示ON/OFF。
  // hasOwnedPanelに関係なく常に存在する(ChartTable.astro側も無条件レンダリング)。
  const boostFactorsToggle = document.getElementById('speed-chart-boost-factors-toggle') as HTMLInputElement | null;

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

  // 2026-08-01追補: 「同じ実数値のなかで族ごとに行を分ける」ため、1実数値に対して族ブロックの
  // 数だけ物理行(.speed-chart-row)が存在しうる。ハイライト・スクロールは実数値単位で
  // 行いたいので、値ごとに複数要素を保持する(renderRows参照)。
  const rowElements = new Map<number, HTMLElement[]>();
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
  // 要件5: 既定でOFF(すばやさ上昇要因は非表示)。boostFactorsToggleにchecked属性を
  // 付けていない(ChartTable.astro側)ため、初期値はDOMのcheckedプロパティからも導ける。
  let showBoostFactors = boostFactorsToggle?.checked ?? false;
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
      // 族(baseSpeed)ごとのブロックに分け、ブロックごとに独立した物理行を作る
      // (2026-08-01追補: 「同じ実数値のなかで族ごとに行を分ける」)。
      const blocks = groupEntriesIntoBlocks(row.entries, baseSpeedByName, usageCounts, showBoostFactors);
      const elementsForValue: HTMLElement[] = [];

      blocks.forEach((block, blockIndex) => {
        const isLastBlock = blockIndex === blocks.length - 1;
        const rowEl = document.createElement('div');
        rowEl.className = 'speed-chart-row';
        // 同じ実数値グループ内の行同士は境界線を軽くし(is-value-group-end無し)、
        // グループの最後の行にだけ通常の境界線を付ける(値ごとの区切りを分かりやすくする)。
        if (isLastBlock) rowEl.classList.add('speed-chart-row-value-end');
        rowEl.dataset.value = String(row.value);

        const valueCell = document.createElement('div');
        valueCell.className = 'speed-chart-value-cell tnum';
        // 実数値はグループの先頭行だけに出す(2行目以降は同じ実数値であることが行の並びで
        // 分かるため空欄のままにし、値の重複表示を避ける)。
        if (blockIndex === 0) valueCell.textContent = String(row.value);
        rowEl.appendChild(valueCell);

        const groupCell = document.createElement('div');
        groupCell.className = 'speed-chart-group-cell';
        groupCell.appendChild(
          buildBlockContent(block, imageIdByName, usageCounts, baseSpeedByName, chipWidthByName, chipLayoutMetrics),
        );
        rowEl.appendChild(groupCell);

        const ownedCell = document.createElement('div');
        ownedCell.className = 'speed-chart-owned-cell';
        // 「この個体」列も実数値ごとに1つの内容なので、グループの先頭行だけに出す。
        if (blockIndex === 0) {
          if (ownedController) {
            ownedCell.appendChild(ownedController.renderCell(row.value));
          } else {
            ownedCell.appendChild(buildDashCell());
          }
        }
        rowEl.appendChild(ownedCell);

        fragment.appendChild(rowEl);
        elementsForValue.push(rowEl);
      });

      rowElements.set(row.value, elementsForValue);
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
      rowElements.get(currentHighlightValue)?.forEach((el) => el.classList.remove('is-current-row'));
    }
    currentHighlightValue = value;
    // 同じ実数値の族ブロックが複数行に分かれていても、その値の全行をまとめてハイライトする。
    rowElements.get(value)?.forEach((el) => el.classList.add('is-current-row'));
  }

  function scrollToValue(value: number): void {
    const el = findNearestRowElement(value);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function findNearestRowElement(targetValue: number): HTMLElement | null {
    // スクロール先は「その値の先頭行」で十分(先頭行=グループの一番上)。
    if (rowElements.has(targetValue)) return rowElements.get(targetValue)?.[0] ?? null;
    // R-8: 「その値以上で最も近い行」まで昇順に探す。
    const values = Array.from(rowElements.keys()).sort((a, b) => a - b);
    for (const v of values) {
      if (v >= targetValue) return rowElements.get(v)?.[0] ?? null;
    }
    // targetValueが全行より大きい場合は最大値(実数値降順の先頭行)へ。
    return values.length > 0 ? (rowElements.get(values[values.length - 1])?.[0] ?? null) : null;
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

  // 要件5: すばやさ上昇要因トグル。表示される「行の集合」自体は変えず(showReachableOnlyとは
  // 独立)、各行の中身(補正ありグループの表示/非表示)だけを切り替えるため、renderVisibleRows()
  // ではなくrenderRows()を直接呼ぶだけで十分だが、reachableOnly側のフィルタも常に反映したい
  // ため既存のrenderVisibleRows()をそのまま再利用する(挙動は変えない)。
  boostFactorsToggle?.addEventListener('change', () => {
    showBoostFactors = boostFactorsToggle.checked;
    renderVisibleRows();
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

// 追加改修(2026-08-01第3弾)要件1: 「補正量とその原因は行をわける」。以前は
// 「振り方+種族値+補正量+補正の原因」を1本のラベル文字列にまとめていた(例:
// "最速 120族 2倍 かるわざ")が、これを3段に分ける:
//   1段目 .speed-chart-amounts-row … 振り方バッジ(色分け)+ 補正量(x1.5/x2等。
//     第4弾要件4でS+n表記を廃止し倍率表記に統一。formatModifierMagnitude参照)
//   2段目 .speed-chart-origins-row … 補正の原因(特性名/わざ名/持ち物名)。補正なしの
//     グループ(素の実数値)は原因を持たないため、そのグループ分は出力しない
//     (行の高さはCSS側のmin-heightで確保するため、原因が1件も無い行でも段自体は消えない)。
//   3段目 .speed-chart-chips-row … ポケモンのアイコン+名前チップ(要件・仕様は変更なし)。
// 1段目と2段目の対応は、以前と同じく「同じグループ順に並べる」ことで表す(厳密な位置揃えは
// しない。docs/plan/pages/speed-chart.md 追加改修(2026-08-01第2弾)要件3の仮定を踏襲)。
//
// 【2026-08-01追補】 「族」(baseSpeed。すばやさ種族値)は以前は同じ実数値行の中で
// ブロック分けして横並び表示していたが、これを「族ごとに独立した物理行」へ変更した
// (ユーザー指示: 「同じ実数値のなかで、族ごとに行を分ける(単一行構成を廃止)」)。
// そのため以下の2関数に分割する:
//   - groupEntriesIntoBlocks: 1実数値ぶんのentriesを「族(baseSpeed)ごとのRowBlock」に
//     まとめる(以前buildRowContent内で行っていたグルーピング・使用率順並び替え・
//     showBoostFactorsフィルタをそのまま踏襲。呼び出し側=renderRowsがブロックごとに
//     物理行を作る)。
//   - buildBlockContent: 1つのRowBlock(=1つの物理行)の中身(3段)を作る。同じ行の中に
//     複数のbaseSpeedが混在することは無くなったため、ブロック間の縦棒区切り
//     (.speed-chart-group-divider)や.speed-chart-blockラッパー・チップ2行クランプは
//     不要になった(行そのものが区切りになるため)。チップの足切りは行全体の幅
//     (chipLayoutMetrics.containerWidth)をそのまま使う(ブロック分割前の設計に戻る)。
interface RowGroup {
  spreadKind: SpeedSpreadKind;
  baseSpeed: number;
  modifier: EffectiveSpeedModifier | null;
  formNames: string[];
}

/** 「族」(baseSpeed)ごとのブロック。1ブロック=1物理行(renderRows参照)。 */
interface RowBlock {
  baseSpeed: number;
  groups: RowGroup[];
}

function groupEntriesIntoBlocks(
  entries: SpeedChartEntry[],
  baseSpeedByName: Map<string, number>,
  usageCounts: SpeciesUsageCounts | undefined,
  // 要件5(第4弾、2026-08-02修正): OFF(既定)のときは補正ありグループ(modifier !== null)を
  // 折りたたむ。その行の全グループが補正ありの場合(素の実数値では到達しない行)は、
  // このブロック自体が空(=空配列)になり、呼び出し側で行そのものが描画されなくなる
  // (フォールバックしない。理由は下のコメント参照)。
  showBoostFactors: boolean,
): RowBlock[] {
  const groups = new Map<string, RowGroup>();
  for (const entry of entries) {
    const key = `${entry.spread}|${entry.modifier ? `${entry.modifier.category}:${entry.modifier.name}` : 'none'}`;
    let group = groups.get(key);
    if (!group) {
      // baseSpeedは(既存の挙動どおり)このグループを最初に作ったentryの種族値を代表値として使う。
      group = {
        spreadKind: entry.spread,
        baseSpeed: baseSpeedByName.get(entry.formName) ?? 0,
        modifier: entry.modifier,
        formNames: [],
      };
      groups.set(key, group);
    }
    group.formNames.push(entry.formName);
  }

  // 要件1(2026-08-01第2弾): グループ内を使用率降順(→すばやさ種族値降順→種族名昇順)に並べる。
  const orderedGroups = Array.from(groups.values(), (group) => ({
    ...group,
    formNames: sortFormNamesByUsage(group.formNames, usageCounts, baseSpeedByName),
  }));

  // 要件5(2026-08-02実機確認で修正): showBoostFactors=falseのときは補正あり
  // (modifier !== null)グループを折りたたむ。以前はここで「フィルタの結果が空になる場合は
  // 元のorderedGroupsへフォールバックする」安全策を取っていたが、この安全策自体が
  // 「補正なしのグループが1つも無い実数値行(=素の実数値では絶対に到達しない値)」では
  // トグルをOFFにしても常にON相当の全件表示に戻ってしまい、「トグルが効いていない」という
  // ユーザー報告の直接の原因になっていた。素の実数値では到達しない行をOFF時に隠さず見せる
  // ことは「上昇要因の表示/非表示」ではなく「存在しないはずの値を見せる」ことになり、
  // むしろ誤解を招くため、フォールバックはやめてfilteredGroupsをそのまま使う(空なら
  // このブロックからは何も描画されない=呼び出し側で行自体が現れなくなる)。
  const filteredGroups = showBoostFactors ? orderedGroups : orderedGroups.filter((group) => group.modifier === null);

  // filteredGroupsをbaseSpeedごとのブロックにまとめ、baseSpeed降順に並べる
  // (ブロック内のグループ順は元のfilteredGroupsの出現順を維持する)。
  const blocksByBaseSpeed = new Map<number, RowGroup[]>();
  for (const group of filteredGroups) {
    const bucket = blocksByBaseSpeed.get(group.baseSpeed);
    if (bucket) bucket.push(group);
    else blocksByBaseSpeed.set(group.baseSpeed, [group]);
  }
  return Array.from(blocksByBaseSpeed.entries())
    .map(([baseSpeed, groupsInBlock]) => ({ baseSpeed, groups: groupsInBlock }))
    .sort((a, b) => b.baseSpeed - a.baseSpeed);
}

// UI改修(2026-08-02) 要件5b: 「要因は/で連結表示せず、各ポケモンの下に中央寄せで配置する」
// 指示、および「実数値356では、110族 最速 x2 最速 x2のように1行目の情報が重複して表示されて
// いる」という実例への対応。以前は1ブロック(=1族)につき「全グループのバッジ+倍率を' '区切りで
// 横並び」「全グループの原因を' / '区切りで連結」「全グループのチップをまとめて1行」という
// 3段構成で、グループ(振り方+補正の組)単位の対応関係が見た目から失われていた
// (同じ x2 倍率でも原因(グループ)が別なら別々に表示すべきなのに、連結表示のせいで
// 「x2 x2」のように重複して見えた)。
// これを、グループごとに独立した「枠のないカード」(.speed-chart-group)にする: バッジ+倍率
// (.speed-chart-group-meta)→原因(あれば。.speed-chart-group-origin)→そのグループの
// ポケモンチップ(.speed-chart-chips-row、既存クラスを流用)を縦に積み、中央寄せにする。
// 族ラベル(◯◯族)は仕様どおりブロック全体で1つだけ(.speed-chart-base-speed-label、
// 既存クラスのまま先頭に残す)。
// 参考: docs/ui_proposal/すばやさライン早見表 シーズンM-2(シングルバトル)｜バトルデータベース
// チャンピオンズ.html の speed-table__header 周辺(各ポケモンをカード状に見せる構造)。
function buildBlockContent(
  block: RowBlock,
  imageIdByName: Map<string, number>,
  usageCounts: SpeciesUsageCounts | undefined,
  baseSpeedByName: Map<string, number>,
  chipWidthByName: Map<string, number>,
  chipLayoutMetrics: ChipLayoutMetrics | null,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'speed-chart-row-content';

  // 族(baseSpeed)ラベルを1つだけ出す(ブロック全体で1つ、現状維持)。
  const baseSpeedLabel = document.createElement('span');
  baseSpeedLabel.className = 'speed-chart-base-speed-label';
  baseSpeedLabel.textContent = `${block.baseSpeed}族`;
  container.appendChild(baseSpeedLabel);

  // グループ(振り方+補正の組)ごとに独立したカードを縦に積む。
  const groupsWrap = document.createElement('div');
  groupsWrap.className = 'speed-chart-groups';

  block.groups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'speed-chart-group';

    // バッジ+倍率(このグループのポケモンチップの直上に中央寄せ)。
    const metaRow = document.createElement('div');
    metaRow.className = 'speed-chart-group-meta';
    metaRow.appendChild(buildSpreadBadge(group.spreadKind));
    if (group.modifier) {
      metaRow.appendChild(document.createTextNode(` ${formatModifierMagnitude(group.modifier.modifier)}`));
    }
    groupEl.appendChild(metaRow);

    // 原因(特性名/わざ名/持ち物名)。補正なしグループ(素の実数値)には原因が無いため出さない。
    if (group.modifier) {
      const originEl = document.createElement('div');
      originEl.className = 'speed-chart-group-origin';
      originEl.textContent = group.modifier.name;
      groupEl.appendChild(originEl);
    }

    // このグループのポケモンチップ。グループごとに独立した行になったため、行全体の幅
    // (chipLayoutMetrics.containerWidth)をそのグループ単独で使える(以前のように他グループと
    // 幅を分け合う必要はない。groupsWrapがflex-direction: columnで縦に積むため)。
    const chipsRow = document.createElement('div');
    chipsRow.className = 'speed-chart-chips-row';
    const { kept, droppedCount } = chipLayoutMetrics
      ? limitRowChipsByWidth(
          group.formNames,
          usageCounts,
          baseSpeedByName,
          chipWidthByName,
          chipLayoutMetrics.gapWidth,
          chipLayoutMetrics.containerWidth,
          chipLayoutMetrics.overflowBadgeWidth,
        )
      : { kept: group.formNames, droppedCount: 0 };
    const keptSet = new Set(kept);
    for (const formName of group.formNames) {
      if (!keptSet.has(formName)) continue;
      chipsRow.appendChild(buildChip(formName, imageIdByName));
    }
    // 足切りが起きたグループには必ず可視で件数を示す(黙って切ると「そのポケモンは居ない」と
    // 誤読されるため。stack.mdの「no silent caps」と同趣旨)。
    if (droppedCount > 0) {
      const overflow = document.createElement('span');
      overflow.className = 'speed-chart-chip-overflow';
      overflow.textContent = `+${droppedCount}件`;
      chipsRow.appendChild(overflow);
    }
    groupEl.appendChild(chipsRow);

    groupsWrap.appendChild(groupEl);
  });

  container.appendChild(groupsWrap);
  return container;
}

// 要件2: 振り方(最速/準速/無振り)を色分けするバッジ。既存の配色トークン(primary/success/risky)
// の範囲で3種を作る(新色は作らない)。dangerは他画面でエラー表現に使われているため避け、
// riskyを「無振り(=すばやさに何も投資していない)」に割り当てる。
function buildSpreadBadge(spreadKind: SpeedSpreadKind): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'speed-chart-spread-badge';
  badge.dataset.spread = spreadKind;
  badge.textContent = SPEED_SPREADS[spreadKind].label;
  return badge;
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

// 追加改修(2026-08-01第3弾)要件1: 補正量(S+1/2倍等)と原因(特性名・わざ名・持ち物名)を
// 別の段に分けるため、以前は1本の文字列(例: "2倍 かるわざ")にまとめていたのを2つの関数に
// 分割する。以前は持ち物だけ名前のみ表示(倍率を省略)していたが、段を分けた今は
// 「[最速] 120族 x1.5」/「こだわりスカーフ」のように持ち物にも倍率を表示したほうが
// amounts-row(1段目)が特性・わざの行と同じ書式で揃うため、持ち物の特例は廃止する。
//
// 第4弾要件4(2026-08-01): 「S+n」(ランク表記)と「1.5倍」(和風の倍率表記)が混在していたのを
// 「xN」に統一する。ランク補正はfloor(値*(2+stages)/2)で適用される(speed-chart.tsの
// applySpeedRank)ため、表示上の倍率も同じ式(2+stages)/2から求める(例: S+1→x1.5、S+2→x2、
// S+6→x4)。
function formatModifierMagnitude(modifier: SpeedModifierEntry): string {
  const ratio = modifier.kind === 'rank' ? (2 + modifier.stages) / 2 : modifier.numerator / modifier.denominator;
  return `x${formatRatio(ratio)}`;
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
