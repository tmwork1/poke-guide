// すばやさ早見表(/speed-chart)の早見表本体(ChartTable.astro)のブラウザ側ロジック。
//
// 責務:
//   - マスターデータの取得(public/master-data/ 配下をブラウザから fetch する。既存の
//     pokemon-master-data.ts 等と同じ「クライアント側で1回fetchする」流儀に揃える)
//   - レギュレーション切替(R-12: 「現在のレギュレーション」はこのモジュールが所有する)
//   - 行の描画(R-13: 表と右カラムを分けず横一列にする。列構成は
//     「実数値/族・配分・倍率/ポケモン・補正要因/(調整。?owned=連携時のみ)」の3〜4列。
//     「調整」列の中身はowned-panel.tsに委譲する。このファイル自身はセルの中身を知らない)
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
  includeReachableValuesInRows,
  getEffectiveSpeedModifiers,
  sortFormNamesByUsage,
  SPEED_SPREADS,
  type AdoptionRateData,
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
import { championSpriteUrl, officialArtworkUrl } from '../pokemon-master-data';
import { kanaIncludes } from '../kana';
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
const ALL_REGULATIONS_VALUE = 'all';
// 全規制表示でも性格率を加重平均する。
const ADOPTION_CATEGORIES = ['items', 'moves', 'natures'] as const;

function getKnownRegulations(regSelect: HTMLSelectElement | null): string[] {
  if (!regSelect) return [];
  return Array.from(regSelect.options, (option) => option.value).filter((value) => value !== ALL_REGULATIONS_VALUE);
}

function mergeAdoptionRateData(
  adoptionByRegulation: Record<string, AdoptionRateData>,
  regulations: string[],
): AdoptionRateData {
  const merged: AdoptionRateData = {};
  const speciesNames = new Set<string>();
  for (const regulation of regulations) {
    for (const speciesName of Object.keys(adoptionByRegulation[regulation] ?? {})) {
      speciesNames.add(speciesName);
    }
  }

  for (const speciesName of speciesNames) {
    const mergedCategories: AdoptionRateData[string] = {};
    for (const category of ADOPTION_CATEGORIES) {
      let hasBucket = false;
      let sampleSize = 0;
      const weightedRatios = new Map<string, number>();
      for (const regulation of regulations) {
        const bucket = adoptionByRegulation[regulation]?.[speciesName]?.[category];
        if (!bucket) continue;
        hasBucket = true;
        sampleSize += bucket.sampleSize;
        for (const [option, ratio] of Object.entries(bucket.options)) {
          weightedRatios.set(option, (weightedRatios.get(option) ?? 0) + ratio * bucket.sampleSize);
        }
      }
      if (!hasBucket) continue;

      const options: Record<string, number> = {};
      if (sampleSize > 0) {
        for (const [option, weightedRatio] of weightedRatios) {
          options[option] = weightedRatio / sampleSize;
        }
      }
      mergedCategories[category] = { sampleSize, options };
    }
    if (Object.keys(mergedCategories).length > 0) merged[speciesName] = mergedCategories;
  }
  return merged;
}

// 種族使用率の横断スコープ(migrations/021 の combined_species_usage が返す regulation = '')。
// index.astro はこのキーで横断集計を埋め込む。
const CROSS_REGULATION_KEY = '';

// レギュレーション選択が「すべて」のときの使用数。横断スコープが埋め込まれていればそれを使う。
// レギュレーション別の単純合計では、レギュレーションが未設定の登録個体とシーズン対応が
// 未登録のランキングチーム(どちらも 013/014 の規則で横断スコープにしか入らない)が
// 落ちてしまうため。集計が取れなかったときだけ従来どおり合計へ退く。
function mergeSpeciesUsageCounts(
  usageByRegulation: Record<string, SpeciesUsageCounts>,
  regulations: string[],
): SpeciesUsageCounts {
  const crossScope = usageByRegulation[CROSS_REGULATION_KEY];
  if (crossScope && Object.keys(crossScope).length > 0) return crossScope;
  const merged: SpeciesUsageCounts = {};
  for (const regulation of regulations) {
    for (const [speciesName, count] of Object.entries(usageByRegulation[regulation] ?? {})) {
      merged[speciesName] = (merged[speciesName] ?? 0) + count;
    }
  }
  return merged;
}

// 上と対になる分母(チーム相当数)。横断スコープが無いときだけ合計へ退く。
function resolveTotalTeamCount(
  teamCountByRegulation: Record<string, number>,
  regulations: string[],
): number {
  const crossScope = teamCountByRegulation[CROSS_REGULATION_KEY];
  if (crossScope) return crossScope;
  return regulations.reduce((total, regulation) => total + (teamCountByRegulation[regulation] ?? 0), 0);
}

/** hiddenEntries.rules の1件。「指定された項目がすべて一致するエントリを消す」の意味。 */
interface HiddenEntryRule {
  /** 省略時は振り方を問わない。src/lib/speed-chart.ts の SPEED_SPREADS のキー。 */
  spread?: SpeedSpreadKind;
  /** true=上昇要因あり / false=補正なし(素の実数値)。省略時は問わない。 */
  hasModifier?: boolean;
  /** 表示には使わない。なぜ消すかのメモ。 */
  reason?: string;
}
type SpeedChartPageConfig = SpeedChartConfig & {
  speciesAdoptionRate?: {
    enabled: boolean;
    threshold: number;
    minSampleSize: number;
  };
  hiddenEntries?: { rules?: HiddenEntryRule[] };
  hiddenPokemon?: { names?: string[] };
};

export async function initSpeedChartPage(): Promise<void> {
  const root = document.querySelector<HTMLElement>(ROOT_SELECTOR);
  if (!root) return;

  const initialRegulation = root.dataset.regulation ?? '';
  const ownedId = root.dataset.ownedId || null;
  const hasOwnedPanel = root.dataset.hasOwnedPanel === 'true';

  const config = readEmbeddedJson<SpeedChartPageConfig>('speed-chart-config');
  const adoptionByRegulation = readEmbeddedJson<Record<string, AdoptionRateData>>('speed-chart-adoption-data') ?? {};
  const usageByRegulation = readEmbeddedJson<Record<string, SpeciesUsageCounts>>('speed-chart-usage-data') ?? {};
  const teamCountByRegulation =
    readEmbeddedJson<Record<string, number>>('speed-chart-team-count-data') ?? {};
  const ownedRecord = hasOwnedPanel ? readEmbeddedJson<OwnedPokemonRecord>('speed-chart-owned-record') : null;

  const statusEl = document.getElementById('speed-chart-status');
  const tableEl = document.getElementById('speed-chart-rows');
  const bodyEl = document.getElementById('speed-chart-rows-body');
  const regSelect = document.getElementById('speed-chart-regulation-select') as HTMLSelectElement | null;
  const knownRegulations = getKnownRegulations(regSelect);
  const jumpInput = document.getElementById('speed-chart-jump-input') as HTMLInputElement | null;
  const backButton = document.getElementById('speed-chart-owned-jump-button');
  // 要件4: ?owned=があるときだけ存在するトグル(ChartTable.astro側もhasOwnedPanelで条件付け済み)。
  const reachableOnlyToggle = document.getElementById('speed-chart-reachable-only-toggle') as HTMLInputElement | null;
  const minimapEl = document.getElementById('speed-chart-minimap');
  const minimapTrack = minimapEl?.querySelector<HTMLElement>('.speed-chart-minimap-track') ?? null;
  const minimapViewport = minimapEl?.querySelector<HTMLElement>('.speed-chart-minimap-viewport') ?? null;

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
  const pokemonDetailByName = new Map(masterData.pokemonDetail.map((p) => [p.name, p]));

  // 1実数値に対して、その値を作るグループ(振り方+補正の組)の数だけ物理行(.speed-chart-row)が
  // 存在しうる。ハイライト・スクロールは実数値単位で行いたいので、値ごとに複数要素を保持する
  // (renderRows参照)。
  const rowElements = new Map<number, HTMLElement[]>();
  const formsByName = new Map<string, SpeedChartForm>();
  let ownedController: OwnedPanelController | null = null;
  let currentRegulation = initialRegulation;
  let currentHighlightValue: number | null = null;
  let lastKnownOwnedValue: number | null = null;
  let hasScrolledInitially = false;
  let currentRows: SpeedChartRow[] = [];
  // R-12更新: 「個体が到達可能な実数値の集合」はowned-panel.tsが所有する。ここではCustomEvent
  // 経由で受け取った値をキャッシュするだけ(クロージャ共有はしない)。
  let lastKnownReachableValues: Set<number> | null = null;
  let minimapFrame: number | null = null;

  function getDocumentHeight(): number {
    return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  }

  function updateMinimapViewport(): void {
    minimapFrame = null;
    if (!minimapTrack || !minimapViewport || minimapTrack.clientHeight <= 0) return;
    const documentHeight = getDocumentHeight();
    const viewportHeight = window.innerHeight;
    minimapViewport.style.top = `${(window.scrollY / documentHeight) * 100}%`;
    minimapViewport.style.height = `${Math.min(1, viewportHeight / documentHeight) * 100}%`;
  }

  function scheduleMinimapViewportUpdate(): void {
    if (minimapFrame !== null) return;
    minimapFrame = window.requestAnimationFrame(updateMinimapViewport);
  }

  function rebuildMinimapMarkers(): void {
    if (!minimapTrack || !minimapViewport) return;
    minimapTrack.querySelectorAll('.speed-chart-minimap-marker').forEach((marker) => marker.remove());
    const documentHeight = getDocumentHeight();
    const fragment = document.createDocumentFragment();
    bodyEl!.querySelectorAll<HTMLElement>('.speed-chart-row-value-end').forEach((row) => {
      const marker = document.createElement('span');
      marker.className = 'speed-chart-minimap-marker';
      const boundaryY = row.getBoundingClientRect().bottom + window.scrollY;
      marker.style.top = `${Math.min(1, boundaryY / documentHeight) * 100}%`;
      fragment.appendChild(marker);
    });
    minimapTrack.insertBefore(fragment, minimapViewport);
    scheduleMinimapViewportUpdate();
  }

  function scrollFromMinimapTrackY(clientY: number): void {
    if (!minimapTrack) return;
    const rect = minimapTrack.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const maxScroll = Math.max(0, getDocumentHeight() - window.innerHeight);
    window.scrollTo({ top: ratio * maxScroll, behavior: 'auto' });
  }

  minimapTrack?.addEventListener('click', (event) => scrollFromMinimapTrackY(event.clientY));
  minimapViewport?.addEventListener('click', (event) => event.stopPropagation());
  minimapViewport?.addEventListener('mousedown', (downEvent) => {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    if (!minimapTrack || !minimapViewport || !minimapEl) return;
    const startY = downEvent.clientY;
    const startTop = minimapViewport.offsetTop;
    minimapEl.classList.add('is-dragging');

    function onMove(moveEvent: MouseEvent): void {
      const maxTrackTop = Math.max(0, minimapTrack!.clientHeight - minimapViewport!.offsetHeight);
      const nextTop = Math.max(0, Math.min(maxTrackTop, startTop + moveEvent.clientY - startY));
      const ratio = maxTrackTop > 0 ? nextTop / maxTrackTop : 0;
      const maxScroll = Math.max(0, getDocumentHeight() - window.innerHeight);
      window.scrollTo({ top: ratio * maxScroll, behavior: 'auto' });
    }

    function onUp(): void {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      minimapEl!.classList.remove('is-dragging');
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  window.addEventListener('scroll', scheduleMinimapViewportUpdate, { passive: true });
  window.addEventListener('resize', rebuildMinimapMarkers);

  function render(regulation: string): void {
    currentRegulation = regulation;
    let population =
      regulation === ALL_REGULATIONS_VALUE
        ? Array.from(
            knownRegulations.reduce((formsByName, knownRegulation) => {
              for (const form of buildSpeedChartPopulation(
                knownRegulation,
                masterData.pokemonAutocomplete,
                masterData.pokemonDetail,
                masterData.megaStones,
                masterData.itemAutocomplete,
              )) {
                if (!formsByName.has(form.name)) formsByName.set(form.name, form);
              }
              return formsByName;
            }, new Map<string, SpeedChartForm>()).values(),
          )
        : buildSpeedChartPopulation(
            regulation,
            masterData.pokemonAutocomplete,
            masterData.pokemonDetail,
            masterData.megaStones,
            masterData.itemAutocomplete,
          );
    const speciesUsage =
      regulation === ALL_REGULATIONS_VALUE
        ? mergeSpeciesUsageCounts(usageByRegulation, knownRegulations)
        : usageByRegulation[regulation] ?? {};
    const teamCount =
      regulation === ALL_REGULATIONS_VALUE
        ? resolveTotalTeamCount(teamCountByRegulation, knownRegulations)
        : teamCountByRegulation[regulation] ?? 0;
    const speciesAdoptionRate = config!.speciesAdoptionRate;
    if (speciesAdoptionRate?.enabled && teamCount >= speciesAdoptionRate.minSampleSize) {
      population = population.filter(
        (form) => (speciesUsage[form.name] ?? 0) / teamCount >= speciesAdoptionRate.threshold,
      );
    }
    formsByName.clear();
    for (const form of population) formsByName.set(form.name, form);

    const adoptionData =
      regulation === ALL_REGULATIONS_VALUE
        ? mergeAdoptionRateData(adoptionByRegulation, knownRegulations)
        : adoptionByRegulation[regulation];
    currentRows = filterRowsByHiddenPokemon(
      filterRowsByHiddenEntries(
        buildSpeedChartRows(population, effectiveModifiers, config!.adoptionRate, adoptionData, config!.minSpreadAdoptionRate),
        config!.hiddenEntries?.rules ?? [],
      ),
      config!.hiddenPokemon?.names ?? [],
    );

    ownedController = null;
    if (hasOwnedPanel && ownedRecord) {
      const ownedName = ownedRecord.species_name;
      const ownedDetail = pokemonDetailByName.get(ownedName);
      // 「この個体」の調整は、早見表へ表示するレギュレーション所属や使用率とは無関係に行う。
      // formsByName は speciesAdoptionRate の足切り後の母集団なので、そこに無い場合だけ全件の
      // 詳細マスターから補う。これにより早見表の行には出ない種族でも調整パネルは出るが、この
      // 非対称は意図的であり、buildSpeedChartRows に渡す早見表自体の母集団は今回変更しない。
      const ownedForm =
        formsByName.get(ownedName) ??
        (ownedDetail
          ? {
              name: ownedName,
              baseSpeed: ownedDetail.baseStats[5],
              abilities: ownedDetail.abilities,
              learnset: ownedDetail.learnset,
              isMega: masterData.megaStones.some((mega) => mega.species === ownedName),
            }
          : null);
      if (ownedForm) {
        // 調整候補はレギュレーション非依存。ただしメガシンカ個体がスカーフを持てない制約は残す。
        const scarfUsable = !ownedForm.isMega && !!scarfEntry;
        ownedController = initOwnedPanel({
          ownedRecord,
          baseSpeed: ownedForm.baseSpeed,
          scarfModifier: scarfUsable ? scarfEntry!.modifier : null,
          scarfItemName: scarfUsable ? scarfEntry!.name : null,
          abilityModifier: ownedRecord.ability_name
            ? masterData.speedModifiers.abilities[ownedRecord.ability_name] ?? null
            : null,
          spriteImageId: imageIdByName.get(ownedName) ?? null,
        });
      }
    }
    // pokemonDetailにも種族が無いと、上でownedControllerがnullのままになる。この場合
    // owned-panel.ts側のupdateSummary()が一度も呼ばれず#speed-chart-owned-summaryが
    // 空箱のまま残ってしまう(「データ破損に見える空箱」を防ぐpitfalls.mdの方針)ため、
    // controllerの有無に応じてサマリ本体/注記のhiddenを出し分ける。render()はレギュレーション
    // 切替のたびに呼ばれるので、切替で母集団に入った/出たケースもここで毎回再評価される。
    applyOwnedPanelAvailability(ownedController !== null);

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
    } else if (!hasScrolledInitially) {
      // 調整対象が無い通常表示（または対象が現レギュレーションに存在しない初期表示）は、
      // 長い表の中央付近である実数値200を初回だけ表示する。
      hasScrolledInitially = true;
      scrollToValue(200);
    }
  }

  // レギュレーション切替・トグル切替の両方から呼ばれる。
  function renderVisibleRows(): void {
    // すばやさ調整では候補を絞り込まず、常に全実数値を表示する。
    const rows = lastKnownReachableValues
      ? includeReachableValuesInRows(currentRows, lastKnownReachableValues)
      : currentRows;
    renderRows(rows);
  }

  function renderRows(rows: SpeedChartRow[]): void {
    rowElements.clear();
    bodyEl!.replaceChildren();
    const fragment = document.createDocumentFragment();
    const baseSpeedByName = new Map<string, number>();
    for (const [name, form] of formsByName) baseSpeedByName.set(name, form.baseSpeed);

    const usageCounts =
      currentRegulation === ALL_REGULATIONS_VALUE
        ? mergeSpeciesUsageCounts(usageByRegulation, knownRegulations)
        : usageByRegulation[currentRegulation];

    for (const row of rows) {
      if (row.entries.length === 0) {
        const rowEl = document.createElement('div');
        rowEl.className = 'speed-chart-row speed-chart-row-owned-only speed-chart-row-single-group speed-chart-row-value-end';
        rowEl.dataset.value = String(row.value);

        const valueCell = document.createElement('div');
        valueCell.className = 'speed-chart-value-cell tnum';
        valueCell.textContent = String(row.value);
        rowEl.appendChild(valueCell);

        if (hasOwnedPanel) {
          const ownedCell = document.createElement('div');
          ownedCell.className = 'speed-chart-owned-cell';
          ownedCell.appendChild(ownedController ? ownedController.renderCell(row.value) : buildDashCell());
          rowEl.appendChild(ownedCell);
        }

        fragment.appendChild(rowEl);
        rowElements.set(row.value, [rowEl]);
        continue;
      }

      // 実数値1件ぶんのentriesを「振り方+補正」のグループへ分け、族(baseSpeed)降順の
      // フラットな配列として、グループごとに独立した物理行を作る(要件2)。
      const groups = groupEntriesIntoRowGroups(row.entries, baseSpeedByName, usageCounts);
      const elementsForValue: HTMLElement[] = [];

      groups.forEach((group, groupIndex) => {
        const isLastGroup = groupIndex === groups.length - 1;
        const rowEl = document.createElement('div');
        rowEl.className = 'speed-chart-row';
        // 1段だけの実数値グループは、補正要因があっても先頭2列を垂直中央に置く。
        if (groups.length === 1) rowEl.classList.add('speed-chart-row-single-group');
        // 同じ実数値内の行同士は境界線を軽くし(is-value-group-end無し)、
        // 実数値の最後の行にだけ通常の境界線を付ける(値ごとの区切りを分かりやすくする)。
        if (isLastGroup) rowEl.classList.add('speed-chart-row-value-end');
        rowEl.dataset.value = String(row.value);

        const valueCell = document.createElement('div');
        valueCell.className = 'speed-chart-value-cell tnum';
        // 実数値はその値の先頭行だけに出す(2行目以降は同じ実数値であることが行の並びで
        // 分かるため空欄のままにし、値の重複表示を避ける)。
        if (groupIndex === 0) valueCell.textContent = String(row.value);
        rowEl.appendChild(valueCell);

        rowEl.appendChild(buildMetaCell(group));
        rowEl.appendChild(buildChipsCell(group, imageIdByName));

        // 要件: 4列目(調整)は?owned=連携時だけ存在する(ChartTable.astro側もdata-has-owned-panel
        // で列数を切り替えている)。列数がズレないよう、無いときはセル自体を作らない。
        if (hasOwnedPanel) {
          const ownedCell = document.createElement('div');
          ownedCell.className = 'speed-chart-owned-cell';
          // 「この個体」列も実数値ごとに1つの内容なので、その値の先頭行だけに出す。
          if (groupIndex === 0) {
            if (ownedController) {
              ownedCell.appendChild(ownedController.renderCell(row.value));
            } else {
              ownedCell.appendChild(buildDashCell());
            }
          }
          rowEl.appendChild(ownedCell);
        }

        fragment.appendChild(rowEl);
        elementsForValue.push(rowEl);
      });

      rowElements.set(row.value, elementsForValue);
    }

    bodyEl!.appendChild(fragment);
    statusEl!.hidden = true;
    tableEl!.hidden = false;
    rebuildMinimapMarkers();

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
    // 同じ実数値のグループが複数行に分かれていても、その値の全行をまとめてハイライトする。
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
    if (detail.navigate) renderVisibleRows();
    applyHighlight(detail.value);
    if (detail.navigate) scrollToValue(detail.value);
  });

  document.addEventListener(OWNED_REACHABLE_VALUES_EVENT, (event) => {
    const detail = (event as CustomEvent<OwnedReachableValuesEventDetail>).detail;
    lastKnownReachableValues = new Set(detail.values);
    renderVisibleRows();
  });

  reachableOnlyToggle?.addEventListener('change', () => {
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

  // UI改修: 実数値専用だった検索欄を「ポケモン・すばやさ実数値」の汎用検索にする。
  // 全角数字だけの入力は半角に正規化した上で従来どおり実数値ジャンプとして扱い、
  // それ以外(ポケモン名を含む文字列)は現在のレギュレーションの行から種族名一致を探す。
  function normalizeFullWidthDigits(input: string): string {
    return input.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  function jumpToInputValue(): void {
    if (!jumpInput) return;
    const raw = jumpInput.value.trim();
    if (!raw) return;
    const normalized = normalizeFullWidthDigits(raw);
    if (/^[0-9]+$/.test(normalized)) {
      scrollToValue(Number.parseInt(normalized, 10));
      return;
    }
    const matchedRow = currentRows.find((row) =>
      row.entries.some((entry) => kanaIncludes(entry.formName, raw)),
    );
    if (matchedRow) scrollToValue(matchedRow.value);
  }

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

function applyOwnedPanelAvailability(available: boolean): void {
  const summaryEl = document.getElementById('speed-chart-owned-summary');
  if (summaryEl) summaryEl.hidden = !available;
  const unavailableEl = document.getElementById('speed-chart-owned-unavailable');
  if (unavailableEl) unavailableEl.hidden = available;
}

function filterRowsByHiddenEntries(rows: SpeedChartRow[], rules: HiddenEntryRule[]): SpeedChartRow[] {
  if (rules.length === 0) return rows;
  const result: SpeedChartRow[] = [];
  for (const row of rows) {
    const entries = row.entries.filter((entry) => !rules.some((rule) => matchesHiddenEntryRule(entry, rule)));
    if (entries.length === 0) continue;
    result.push({ value: row.value, entries });
  }
  return result;
}

/** ルールの各項目(spread/hasModifier)は「省略時は問わない」。全項目が一致すれば真。 */
function matchesHiddenEntryRule(entry: SpeedChartEntry, rule: HiddenEntryRule): boolean {
  if (rule.spread !== undefined && entry.spread !== rule.spread) return false;
  if (rule.hasModifier !== undefined && (entry.modifier !== null) !== rule.hasModifier) return false;
  return true;
}

function filterRowsByHiddenPokemon(rows: SpeedChartRow[], hiddenNames: string[]): SpeedChartRow[] {
  if (hiddenNames.length === 0) return rows;
  const hiddenNameSet = new Set(hiddenNames);
  const result: SpeedChartRow[] = [];
  for (const row of rows) {
    const entries = row.entries.filter((entry) => !hiddenNameSet.has(entry.formName));
    if (entries.length === 0) continue;
    result.push({ value: row.value, entries });
  }
  return result;
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

/** 3列目に描くチップ1個ぶん(ポケモン+その補正要因の組)。 */
interface RowGroupEntry {
  formName: string;
  /** null = 補正なし(素の実数値)。特性名/わざ名/持ち物名。 */
  originName: string | null;
}

interface RowGroup {
  spreadKind: SpeedSpreadKind;
  baseSpeed: number;
  /** 倍率表記(例 "x2")。補正なしグループはnull(2列目に倍率を出さない)。 */
  magnitudeLabel: string | null;
  entries: RowGroupEntry[];
}

function groupEntriesIntoRowGroups(
  entries: SpeedChartEntry[],
  baseSpeedByName: Map<string, number>,
  usageCounts: SpeciesUsageCounts | undefined,
): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const entry of entries) {
    const baseSpeed = baseSpeedByName.get(entry.formName) ?? 0;
    const magnitudeLabel = entry.modifier ? formatModifierMagnitude(entry.modifier.modifier) : null;
    const key = `${entry.spread}|${baseSpeed}|${magnitudeLabel ?? 'none'}`;
    let group = groups.get(key);
    if (!group) {
      group = { spreadKind: entry.spread, baseSpeed, magnitudeLabel, entries: [] };
      groups.set(key, group);
    }
    const originName = entry.modifier?.name ?? null;
    const existingEntry = group.entries.find((groupEntry) => groupEntry.formName === entry.formName);
    if (!existingEntry) {
      group.entries.push({ formName: entry.formName, originName });
    } else if (
      existingEntry.originName &&
      originName &&
      !existingEntry.originName.split('/').includes(originName)
    ) {
      existingEntry.originName = `${existingEntry.originName}/${originName}`;
    }
  }

  const orderedGroups = Array.from(groups.values(), (group) => {
    const uniqueFormNames = Array.from(new Set(group.entries.map((e) => e.formName)));
    const rankByName = new Map(
      sortFormNamesByUsage(uniqueFormNames, usageCounts, baseSpeedByName).map((name, index) => [name, index]),
    );
    const sortedEntries = [...group.entries].sort(
      (a, b) => (rankByName.get(a.formName) ?? 0) - (rankByName.get(b.formName) ?? 0),
    );
    return { ...group, entries: sortedEntries };
  });

  // 族(baseSpeed)降順に並べる。同じ族内は元の出現順(entriesの出現順=Mapの挿入順)を
  // 維持したいので、安定ソートに依存する(Array#sortはES2019以降で安定性が仕様上保証されている)。
  return orderedGroups.sort((a, b) => b.baseSpeed - a.baseSpeed);
}

/** 2列目(族・配分バッジ・倍率)を作る。 */
function buildMetaCell(group: RowGroup): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'speed-chart-meta-cell';

  const baseSpeedLabel = document.createElement('span');
  baseSpeedLabel.className = 'speed-chart-base-speed-label';
  baseSpeedLabel.textContent = `${group.baseSpeed}族`;
  cell.appendChild(baseSpeedLabel);

  cell.appendChild(buildSpreadBadge(group.spreadKind));

  if (group.magnitudeLabel) {
    const magnitude = document.createElement('span');
    magnitude.className = 'speed-chart-magnitude-badge';
    magnitude.textContent = group.magnitudeLabel;
    cell.appendChild(magnitude);
  }

  return cell;
}

// チップは常に全件表示する(幅で足切りして「+N件」バッジを出す旧仕様は廃止済み)。
// 収まらない場合は表示領域側で折り返す(speed-chart-table.cssのflex-wrap)。
function buildChipsCell(group: RowGroup, imageIdByName: Map<string, number>): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'speed-chart-chips-cell';

  const chipsRow = document.createElement('div');
  chipsRow.className = 'speed-chart-chips-row';

  for (const entry of group.entries) {
    chipsRow.appendChild(buildChipUnit(entry, imageIdByName));
  }
  cell.appendChild(chipsRow);

  return cell;
}

/** チップ+補正要因ラベルを縦積みにした1ユニットを作る(要因はエントリごとに表示)。 */
function buildChipUnit(entry: RowGroupEntry, imageIdByName: Map<string, number>): HTMLElement {
  const unit = document.createElement('div');
  unit.className = 'speed-chart-chip-unit';
  unit.appendChild(buildChip(entry.formName, imageIdByName));

  if (entry.originName) {
    const originEl = document.createElement('span');
    originEl.className = 'speed-chart-chip-origin';
    originEl.textContent = entry.originName;
    unit.appendChild(originEl);
  }

  return unit;
}

// 振り方(最速/準速/無振り/最遅)を既存トークンの濃淡で示すバッジ。
// 最遅も新色を増やさず、無振りとの差は既存のborderトークンで示す。
function buildSpreadBadge(spreadKind: SpeedSpreadKind): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'speed-chart-spread-badge';
  badge.dataset.spread = spreadKind;
  badge.textContent = SPEED_SPREADS[spreadKind].label;
  return badge;
}

function formatModifierMagnitude(modifier: SpeedModifierEntry): string {
  const ratio = modifier.kind === 'rank' ? (2 + modifier.stages) / 2 : modifier.numerator / modifier.denominator;
  return `×${formatRatio(ratio)}`;
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
    img.src = championSpriteUrl(imageId);
    img.onerror = () => {
      img.onerror = null;
      img.src = officialArtworkUrl(imageId);
    };
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
