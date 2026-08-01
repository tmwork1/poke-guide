// すばやさ早見表(/speed-chart)専用の純粋関数群。
// src/lib/stats.ts 冒頭のコメントにある制約と同じく、DOM・ブラウザAPI・Node APIに一切
// 依存しないこと(SSR(src/pages/speed-chart/index.astro)とブラウザ側スクリプト
// (src/lib/speed-chart/chart-table.ts・owned-panel.ts)の両方からimportされるため)。
//
// 【仕様の出典】 docs/plan/pages/speed-chart.md
// 「設計レビュー(2026-08-01)」R-2/R-3/R-4/R-14、「P3追補: ユーザー追加要件」U-1/U-2、
// 「確定した設計(P4への入力)」を参照。実数値の計算式そのものは再実装せず
// src/lib/stats.ts の calcOtherStat をそのまま使う。
//
// 【この画面のマスターデータ】
//   - public/master-data/detail/speed-modifiers.json … jpokeから機械抽出した補正の全件
//     (scripts/build-master-data/extract_autocomplete.py の build_speed_modifiers が生成)
//   - src/config/speed-chart.json … 上の全件に対する採否(手動)。抽出(自動)と分離されている(U-1)
//   - public/master-data/autocomplete/pokemon.json … 各要素の regulations でレギュレーション別に絞る
//   - public/master-data/detail/pokemon.json … 種族値・特性・技(learnset)
//   - public/master-data/autocomplete/mega-stones.json … メガ種族の母集団を組み立てるのに使う
//   - public/master-data/autocomplete/items.json … メガストーンの regulations 判定に使う
//
// これらのJSONを実際に読み込む(静的import/fetch)のは呼び出し側(index.astro/chart-table.ts/
// owned-panel.ts)の責務。このファイルはデータを引数で受け取るだけの純粋関数のみを提供する。

import { calcOtherStat, NATURE_STAT_MODIFIERS } from './stats.ts';

// ============================================================================
// 型: マスターデータ(呼び出し側が読み込んで渡す。フィールドは実際に使うものだけ)
// ============================================================================

/** public/master-data/autocomplete/pokemon.json の要素のうち、この画面が使うフィールド。 */
export interface SpeedChartPokemonMasterEntry {
  name: string;
  regulations: string[];
}

/** public/master-data/detail/pokemon.json の要素のうち、この画面が使うフィールド。 */
export interface SpeedChartPokemonDetailEntry {
  name: string;
  /** [HP, 攻撃, 防御, 特攻, 特防, 素早さ] の順(index5がすばやさ種族値)。 */
  baseStats: number[];
  abilities: string[];
  learnset: string[];
}

/** public/master-data/autocomplete/mega-stones.json の要素。 */
export interface SpeedChartMegaStoneEntry {
  species: string;
  item: string;
}

/** public/master-data/autocomplete/items.json の要素のうち、この画面が使うフィールド。 */
export interface SpeedChartItemMasterEntry {
  name: string;
  regulations: string[];
}

// ============================================================================
// 型: すばやさ補正(speed-modifiers.json + speed-chart.json)
// ============================================================================

export interface SpeedModifierMultiplier {
  kind: 'multiplier';
  numerator: number;
  denominator: number;
}

export interface SpeedModifierRank {
  kind: 'rank';
  stages: number;
}

export type SpeedModifierEntry = SpeedModifierMultiplier | SpeedModifierRank;

export type SpeedModifierCategory = 'items' | 'abilities' | 'moves';

/** public/master-data/detail/speed-modifiers.json の全体形。 */
export interface SpeedModifiersData {
  items: Record<string, SpeedModifierEntry>;
  abilities: Record<string, SpeedModifierEntry>;
  moves: Record<string, SpeedModifierEntry>;
}

export interface AdoptionRateConfig {
  enabled: boolean;
  threshold: number;
  minSampleSize: number;
  appliesTo: SpeedModifierCategory[];
}

/** src/config/speed-chart.json の形(`_readme` は無視してよい説明用キー)。 */
export interface SpeedChartConfig {
  adoptionRate: AdoptionRateConfig;
  disabled: {
    abilities: string[];
    moves: string[];
    items: string[];
  };
}

export interface EffectiveSpeedModifier {
  category: SpeedModifierCategory;
  name: string;
  modifier: SpeedModifierEntry;
}

/**
 * speed-modifiers.json(全件・自動生成)と speed-chart.json(採否・手動設定)をマージし、
 * 「有効な補正の一覧」を返す(U-1)。disabled に載っていないものは全てON。
 */
export function getEffectiveSpeedModifiers(
  allModifiers: SpeedModifiersData,
  config: SpeedChartConfig,
): EffectiveSpeedModifier[] {
  const categories: SpeedModifierCategory[] = ['items', 'abilities', 'moves'];
  const result: EffectiveSpeedModifier[] = [];
  for (const category of categories) {
    const disabledNames = new Set(config.disabled[category] ?? []);
    for (const [name, modifier] of Object.entries(allModifiers[category])) {
      if (disabledNames.has(name)) continue;
      result.push({ category, name, modifier });
    }
  }
  return result;
}

/**
 * speed-chart.json の disabled に書かれた名前のうち、speed-modifiers.json に実在しないものを
 * 列挙する(U-1: 「打ち間違いと、jpoke側の改名によるサイレントな無効化解除を検知する」)。
 * 空配列 = 全て実在(正常)。tests/speed-chart.test.ts がこの関数を使い、
 * 実際の src/config/speed-chart.json と public/master-data/detail/speed-modifiers.json を
 * 突き合わせてテストを失敗させる(受け入れ基準30)。
 */
export function findUnknownDisabledModifierNames(
  allModifiers: SpeedModifiersData,
  config: SpeedChartConfig,
): string[] {
  const categories: SpeedModifierCategory[] = ['items', 'abilities', 'moves'];
  const unknown: string[] = [];
  for (const category of categories) {
    for (const name of config.disabled[category] ?? []) {
      if (!(name in allModifiers[category])) {
        unknown.push(`${category}.${name}`);
      }
    }
  }
  return unknown;
}

// ============================================================================
// 母集団: そのレギュレーションで使える全フォルム(通常種族 + メガ種族)
// ============================================================================

export interface SpeedChartForm {
  name: string;
  baseSpeed: number;
  abilities: string[];
  learnset: string[];
  /** メガシンカ種族かどうか(R-4: メガにはこだわりスカーフを付けない判定に使う)。 */
  isMega: boolean;
}

/**
 * 指定レギュレーションで使える全フォルム(通常種族 + メガ種族)の母集団を組み立てる。
 *
 * - 通常種族: pokemonAutocomplete の各要素の regulations にレギュレーションが含まれるもの
 *   (jpoke の regulation/pokemon.csv 由来。メガ・原始回帰フォルムはここに含まれない)。
 * - メガ種族: megaStones の各要素(species/item)のうち、対応する item の regulations に
 *   レギュレーションが含まれるもの(jpoke の regulation/item.csv 由来。メガ種族自体は
 *   pokemon.csv に行を持たないため、この経路でしか母集団に入らない)。
 *
 * pokemonDetail に対応するエントリが無い名前(データ欠損)は無視する(壊れた行を作らない)。
 */
export function buildSpeedChartPopulation(
  regulation: string,
  pokemonAutocomplete: SpeedChartPokemonMasterEntry[],
  pokemonDetail: SpeedChartPokemonDetailEntry[],
  megaStones: SpeedChartMegaStoneEntry[],
  itemAutocomplete: SpeedChartItemMasterEntry[],
): SpeedChartForm[] {
  const detailByName = new Map(pokemonDetail.map((entry) => [entry.name, entry]));
  const itemRegulationsByName = new Map(itemAutocomplete.map((entry) => [entry.name, entry.regulations]));
  const forms: SpeedChartForm[] = [];

  for (const entry of pokemonAutocomplete) {
    if (!entry.regulations.includes(regulation)) continue;
    const detail = detailByName.get(entry.name);
    if (!detail) continue;
    forms.push({
      name: entry.name,
      baseSpeed: detail.baseStats[5],
      abilities: detail.abilities,
      learnset: detail.learnset,
      isMega: false,
    });
  }

  for (const mega of megaStones) {
    const itemRegulations = itemRegulationsByName.get(mega.item);
    if (!itemRegulations || !itemRegulations.includes(regulation)) continue;
    const detail = detailByName.get(mega.species);
    if (!detail) continue;
    forms.push({
      name: mega.species,
      baseSpeed: detail.baseStats[5],
      abilities: detail.abilities,
      learnset: detail.learnset,
      isMega: true,
    });
  }

  return forms;
}

// ============================================================================
// 実数値の算出・補正の適用
// ============================================================================

export type SpeedSpreadKind = 'max' | 'sub' | 'none';

export interface SpeedSpreadDef {
  label: string;
  evSpe: number;
  natureModifier: number;
}

/** 振り方(3種)の定義。P1確定仕様のラベル・努力値・性格補正。 */
export const SPEED_SPREADS: Record<SpeedSpreadKind, SpeedSpreadDef> = {
  max: { label: '最速', evSpe: 32, natureModifier: 1.1 },
  sub: { label: '準速', evSpe: 32, natureModifier: 1.0 },
  none: { label: '無振り', evSpe: 0, natureModifier: 1.0 },
};

/** 倍率補正の適用: floor(値 * numerator / denominator)。 */
export function applySpeedMultiplier(value: number, numerator: number, denominator: number): number {
  return Math.floor((value * numerator) / denominator);
}

/** ランク補正の適用: floor(値 * (2 + stages) / 2)。 */
export function applySpeedRank(value: number, stages: number): number {
  return Math.floor((value * (2 + stages)) / 2);
}

/** kind に応じて倍率/ランクいずれかの補正を適用する薄いディスパッチャ。 */
export function applySpeedModifier(value: number, modifier: SpeedModifierEntry): number {
  return modifier.kind === 'multiplier'
    ? applySpeedMultiplier(value, modifier.numerator, modifier.denominator)
    : applySpeedRank(value, modifier.stages);
}

// ============================================================================
// U-2: 採用率フィルタ(持ち物・技のみ。特性は対象外)
// ============================================================================

export interface AdoptionRateBucket {
  sampleSize: number;
  /** 名前(持ち物名/技名) -> 採用率(0〜1)。 */
  options: Record<string, number>;
}

/**
 * 種族名 -> カテゴリ("items"|"moves") -> 採用率バケット。
 * suggestions テーブル(kind='popular_item'|'popular_move', subject_key='<種族名>|<レギュレーション>')
 * の payload をこの形に畳んだもの(畳む処理自体はSSR側=index.astroの責務。U-2参照)。
 */
export type AdoptionRateData = Record<string, Partial<Record<'items' | 'moves', AdoptionRateBucket>>>;

/** そのカテゴリに採用率フィルタが効くかどうか(enabled かつ appliesTo に含まれる)。 */
export function isAdoptionRateFilterActive(
  category: SpeedModifierCategory,
  config: AdoptionRateConfig,
): boolean {
  return config.enabled && config.appliesTo.includes(category);
}

/**
 * 指定の(カテゴリ, 名前, 種族)が採用率フィルタを通るかどうかを判定する(U-2判定ルール表)。
 *
 * - フィルタが効かないカテゴリ(既定の appliesTo=["items","moves"] では abilities。
 *   または enabled=false)は常に通す。
 * - 種族の集計データが無い(k-匿名性の閾値未満・実績なし)場合は出さない。
 * - sampleSize が minSampleSize 未満なら出さない。
 * - 採用率が threshold 以上なら出す、未満なら出さない。
 *
 * 注意: AdoptionRateData は items/moves の2種類しかバケットの型を持たない(U-2: 特性の
 * 採用率データはsuggestionsテーブルに存在しないため)。abilities は本番経路
 * (isModifierApplicableToForm)では常にこの関数を呼ばず form.abilities.includes(...) のみで
 * 判定するが、万一 appliesTo に 'abilities' を書いてこの関数を直接呼んだ場合は
 * バケットが常に見つからず false(出さない)側に倒れる(「常に通す」ではない安全側フォールバック)。
 */
export function isAdoptedByRate(
  category: SpeedModifierCategory,
  name: string,
  speciesName: string,
  config: AdoptionRateConfig,
  data: AdoptionRateData | undefined,
): boolean {
  if (!isAdoptionRateFilterActive(category, config)) return true;
  // items/moves 以外(=abilities)はそもそもバケットの型に無いが、念のため安全に弾く。
  const bucket = category === 'items' || category === 'moves' ? data?.[speciesName]?.[category] : undefined;
  if (!bucket) return false;
  if (bucket.sampleSize < config.minSampleSize) return false;
  const ratio = bucket.options[name];
  if (ratio === undefined) return false;
  return ratio >= config.threshold;
}

// ============================================================================
// 早見表の行の組み立て
// ============================================================================

export interface SpeedChartEntry {
  formName: string;
  isMega: boolean;
  spread: SpeedSpreadKind;
  /** null = 補正なし(素の実数値)。素の行は採用率フィルタの対象外(常に出す)。 */
  modifier: EffectiveSpeedModifier | null;
  value: number;
}

export interface SpeedChartRow {
  value: number;
  entries: SpeedChartEntry[];
}

function isModifierApplicableToForm(
  modifier: EffectiveSpeedModifier,
  form: SpeedChartForm,
  adoptionConfig: AdoptionRateConfig,
  adoptionData: AdoptionRateData | undefined,
): boolean {
  if (modifier.category === 'items') {
    // R-4: メガシンカ種族は持ち物がメガストーンに固定されるため、他の持ち物補正
    // (こだわりスカーフ等)を同時に持てない。
    if (form.isMega) return false;
    return isAdoptedByRate('items', modifier.name, form.name, adoptionConfig, adoptionData);
  }
  if (modifier.category === 'abilities') {
    // 特性は「持てるフォルムにだけ付ける」が必要十分条件(採用率フィルタは掛からない。U-2)。
    return form.abilities.includes(modifier.name);
  }
  // moves: 「持てるフォルムにだけ付ける」は必要条件に格下げ(U-1/U-2)。採用率も満たす必要がある。
  if (!form.learnset.includes(modifier.name)) return false;
  return isAdoptedByRate('moves', modifier.name, form.name, adoptionConfig, adoptionData);
}

/**
 * 早見表の行を組み立てる。population の各フォルム × 振り方(3種) × (補正なし + 適用可能な
 * 各補正)で実数値を算出し、同じ実数値のエントリを1行にまとめて実数値の降順に並べる。
 *
 * adoptionConfig/adoptionData を渡さない場合は「採用率フィルタなし」として扱いたい呼び出し側は
 * adoptionConfig.enabled=false を渡すこと(このファイル側では既定値を持たない。設定の所在は
 * 呼び出し側=src/config/speed-chart.json に一元化する)。
 */
export function buildSpeedChartRows(
  population: SpeedChartForm[],
  effectiveModifiers: EffectiveSpeedModifier[],
  adoptionConfig: AdoptionRateConfig,
  adoptionData?: AdoptionRateData,
): SpeedChartRow[] {
  const entries: SpeedChartEntry[] = [];
  const spreadKinds: SpeedSpreadKind[] = ['max', 'sub', 'none'];

  for (const form of population) {
    for (const spreadKind of spreadKinds) {
      const spread = SPEED_SPREADS[spreadKind];
      const baseValue = calcOtherStat(50, form.baseSpeed, 31, spread.evSpe, spread.natureModifier);
      entries.push({ formName: form.name, isMega: form.isMega, spread: spreadKind, modifier: null, value: baseValue });

      for (const modifier of effectiveModifiers) {
        if (!isModifierApplicableToForm(modifier, form, adoptionConfig, adoptionData)) continue;
        const value = applySpeedModifier(baseValue, modifier.modifier);
        entries.push({ formName: form.name, isMega: form.isMega, spread: spreadKind, modifier, value });
      }
    }
  }

  const rowsByValue = new Map<number, SpeedChartEntry[]>();
  for (const entry of entries) {
    const existing = rowsByValue.get(entry.value);
    if (existing) {
      existing.push(entry);
    } else {
      rowsByValue.set(entry.value, [entry]);
    }
  }

  return Array.from(rowsByValue.entries())
    .map(([value, rowEntries]) => ({ value, entries: rowEntries }))
    .sort((a, b) => b.value - a.value);
}

// ============================================================================
// B. 「この個体」カラム: 到達可能なすばやさ実数値の列挙・最小コスト選択
// ============================================================================

export type NatureSpeedEffect = 'up' | 'neutral' | 'down';

const NATURE_SPEED_EFFECT_MODIFIER: Record<NatureSpeedEffect, number> = {
  up: 1.1,
  neutral: 1.0,
  down: 0.9,
};

/**
 * 性格名からすばやさへの効果(上昇/無補正/下降)を求める。
 * 出典: src/lib/stats.ts の NATURE_STAT_MODIFIERS(vendor/jpoke/src/jpoke/data/nature.py と同期)。
 * 未知の性格名(nullを含む)は無補正として扱う(安全側のフォールバック)。
 */
export function getNatureSpeedEffect(natureName: string | null | undefined): NatureSpeedEffect {
  const modifier = natureName ? NATURE_STAT_MODIFIERS[natureName] : undefined;
  if (!modifier) return 'neutral';
  if (modifier.up === 'spe') return 'up';
  if (modifier.down === 'spe') return 'down';
  return 'neutral';
}

/**
 * すばやさへの効果(up/neutral/down)を代表する性格名を1つ選ぶ。
 * NATURE_STAT_MODIFIERS の定義順で最初に見つかったものを使う(決定的な選択にするため)。
 * up→おくびょう、down→ゆうかん、neutral→まじめ、が選ばれる(NATURE_STAT_MODIFIERSの定義順で
 * 各効果に最初に現れる性格名。vendor/jpoke v0.2.0時点のNATURE_STAT_MODIFIERS定義順で実測)。
 * 現在の性格がすでに求める効果と一致する場合はこの関数を使わず現在の性格名をそのまま使う
 * (selectMinimalCostSpeedOption 参照。「性格を変えない」を優先するため)。
 */
export function pickNatureNameForSpeedEffect(effect: NatureSpeedEffect): string {
  for (const [name, modifier] of Object.entries(NATURE_STAT_MODIFIERS)) {
    const natureEffect: NatureSpeedEffect = modifier.up === 'spe' ? 'up' : modifier.down === 'spe' ? 'down' : 'neutral';
    if (natureEffect === effect) return name;
  }
  // NATURE_STAT_MODIFIERSに'neutral'に該当する性格(まじめ等)が必ず存在するため実際には
  // 到達しない。型を満たすためのフォールバック。
  return 'まじめ';
}

const OWNED_EV_SPE_MIN = 0;
const OWNED_EV_SPE_MAX = 32;

export interface OwnedSpeedContext {
  baseSpeed: number;
  /** 現在の個体の性格名(null=未設定。無補正として扱う)。 */
  currentNature: string | null;
  /**
   * こだわりスカーフの倍率補正(speed-modifiers.json の "こだわりスカーフ" エントリ)。
   * メガ種族(R-4)、またはそのレギュレーションでスカーフが使えない場合は null にする
   * (呼び出し側が判定して渡す。このファイル側では「こだわりスカーフ」という名前を
   * ハードコードせず、数値(倍率)だけを受け取る)。
   */
  scarfModifier: SpeedModifierMultiplier | null;
}

export interface ReachableSpeedCombo {
  value: number;
  evSpe: number;
  natureEffect: NatureSpeedEffect;
  usesScarf: boolean;
}

/**
 * その個体で実現可能なすばやさ実数値を列挙する(性格3種 × S努力値0〜32 × 持ち物2種の直積。
 * 特性・技によるランク上昇は含めない。R-4によりメガ種族/スカーフ不可の場合は持ち物1種のみ)。
 */
export function enumerateReachableSpeedValues(ctx: OwnedSpeedContext): ReachableSpeedCombo[] {
  const effects: NatureSpeedEffect[] = ['up', 'neutral', 'down'];
  const itemOptions: boolean[] = ctx.scarfModifier ? [false, true] : [false];
  const combos: ReachableSpeedCombo[] = [];

  for (const effect of effects) {
    for (let evSpe = OWNED_EV_SPE_MIN; evSpe <= OWNED_EV_SPE_MAX; evSpe++) {
      const baseValue = calcOtherStat(50, ctx.baseSpeed, 31, evSpe, NATURE_SPEED_EFFECT_MODIFIER[effect]);
      for (const usesScarf of itemOptions) {
        const value = usesScarf && ctx.scarfModifier
          ? applySpeedMultiplier(baseValue, ctx.scarfModifier.numerator, ctx.scarfModifier.denominator)
          : baseValue;
        combos.push({ value, evSpe, natureEffect: effect, usesScarf });
      }
    }
  }

  return combos;
}

export interface SpeedTargetSelection {
  evSpe: number;
  nature: string;
  usesScarf: boolean;
}

/**
 * 目標のすばやさ実数値に対し、「最小コストの組み合わせ」を1つ選ぶ。
 * 優先順位(P1確定仕様): S努力値が最小 → 性格補正が現在値と同じ → 持ち物が現在値と同じ。
 * 該当する組み合わせが無ければ null(到達不可。R-7の「−」表示に対応)。
 */
export function selectMinimalCostSpeedOption(
  combos: ReachableSpeedCombo[],
  targetValue: number,
  currentNature: string | null,
  currentUsesScarf: boolean,
): SpeedTargetSelection | null {
  const currentEffect = getNatureSpeedEffect(currentNature);
  const matches = combos.filter((combo) => combo.value === targetValue);
  if (matches.length === 0) return null;

  const sorted = [...matches].sort((a, b) => {
    if (a.evSpe !== b.evSpe) return a.evSpe - b.evSpe;
    const aNatureSame = a.natureEffect === currentEffect ? 0 : 1;
    const bNatureSame = b.natureEffect === currentEffect ? 0 : 1;
    if (aNatureSame !== bNatureSame) return aNatureSame - bNatureSame;
    const aItemSame = a.usesScarf === currentUsesScarf ? 0 : 1;
    const bItemSame = b.usesScarf === currentUsesScarf ? 0 : 1;
    return aItemSame - bItemSame;
  });

  const best = sorted[0];
  const nature = best.natureEffect === currentEffect && currentNature ? currentNature : pickNatureNameForSpeedEffect(best.natureEffect);
  return { evSpe: best.evSpe, nature, usesScarf: best.usesScarf };
}

/**
 * 現在の努力値配列([HP, 攻撃, 防御, 特攻, 特防, 素早さ])のうち、すばやさ(index5)だけを
 * 差し替えた新しい配列を作る(R-1: 全項目上書きAPIへ渡すペイロードは他の努力値を変えない)。
 * 元の配列は変更しない(コピーを返す)。
 */
export function buildAppliedEvs(currentEvs: number[], evSpe: number): number[] {
  const next = [...currentEvs];
  next[5] = evSpe;
  return next;
}

// ============================================================================
// 追加改修(2026-08-01 ユーザー指示・第2弾)
// 要件1: ポケモンを使用率順に並べる / 要件3: 使用率で足切り / 要件4: 到達可能値でのフィルタ
// 出典: docs/plan/pages/speed-chart.md「追加改修(2026-08-01 ユーザー指示・第2弾)」。
// ============================================================================

/**
 * 種族(フォルム)名 -> レギュレーション別の延べ使用数(ranked_team_membersでの出現数)。
 * suggestions(持ち物・技の種族"内"採用率)とは別の指標。使用実績が無いフォルムはキー自体が
 * 存在しない(=使用率0として扱う。要件1)。呼び出し側(index.astro)がSSRで集計して渡す。
 */
export type SpeciesUsageCounts = Record<string, number>;

/**
 * 要件1/3で共有する比較関数: 使用率(延べ数)降順 → すばやさ種族値降順 → 種族名昇順。
 * 使用率0のフォルムが名前順で固まるのを避けるため種族値を第2キーにする(要件1確定仕様)。
 */
function compareByUsageThenBaseSpeedThenName(
  a: string,
  b: string,
  usageCounts: SpeciesUsageCounts | undefined,
  baseSpeedByName: Map<string, number>,
): number {
  const usageA = usageCounts?.[a] ?? 0;
  const usageB = usageCounts?.[b] ?? 0;
  if (usageA !== usageB) return usageB - usageA;
  const baseSpeedA = baseSpeedByName.get(a) ?? 0;
  const baseSpeedB = baseSpeedByName.get(b) ?? 0;
  if (baseSpeedA !== baseSpeedB) return baseSpeedB - baseSpeedA;
  return a.localeCompare(b, 'ja');
}

/**
 * 要件1: 「ポケモンは使用率順に並べる」。1グループ内のフォルム名配列を、使用率降順→
 * すばやさ種族値降順→種族名昇順で並び替える(行そのものの並び=実数値の降順は変えない。
 * 適用範囲はあくまで行内のチップの並びだけ)。
 */
export function sortFormNamesByUsage(
  formNames: string[],
  usageCounts: SpeciesUsageCounts | undefined,
  baseSpeedByName: Map<string, number>,
): string[] {
  return [...formNames].sort((a, b) => compareByUsageThenBaseSpeedThenName(a, b, usageCounts, baseSpeedByName));
}

export interface RowChipLimitResult {
  /** 残すフォルム名(orderedFormNamesの元の順序=グループ順+グループ内使用率順を維持)。 */
  kept: string[];
  /** 落とした件数(0 = 足切りなし)。 */
  droppedCount: number;
}

/**
 * 要件3の不具合修正(2026-08-01): 「入りきらない場合は使用率で足切りする」を、固定件数
 * ではなく行ごとの実際のチップ合計幅で判定する。
 *
 * 【直した不具合】 以前は measureChipCapacity がサンプル1個(母集団の最初の1件)のチップ幅から
 * 「全行共通の固定件数」を算出していた。チップ幅はポケモン名の長さで大きく変わる
 * (例:「プテラ」 vs 「ニャオニクス(オス)」)ため、名前の長いフォルムを含む行では
 * 固定件数のままだと実際の合計幅がコンテナ幅を超えて折り返していた(94行が2〜5行に折り返し、
 * 一方で+N件の表示はわずか6行だった=足切りがほとんど発動していなかった)。
 *
 * 【アルゴリズム】 chipWidthByName・gapWidth・containerWidth・overflowBadgeWidth は
 * すべて呼び出し側(chart-table.ts)が事前に(描画とは別フェーズで)実測してキャッシュした値を
 * 渡す(この関数自身はDOM測定を一切行わない純粋関数)。
 *   1. 全フォルムを使用率降順(→種族値降順→名前昇順)でランク付けする。
 *   2. 全件の合計幅(gap込み・バッジ抜き)がcontainerWidthに収まるならそのまま全件残す。
 *   3. 収まらない場合は「バッジは必ず出る」ことが確定するので、バッジとその左gapの分を
 *      containerWidthから引いた予算(budget)に対し、使用率上位から順に1件ずつ
 *      (自身の幅+区切りgap)を加算していき、budgetを超えた時点で打ち切る
 *      (合計幅は並べる順序によらず一定なので、「使用率上位から入るだけ入れる」で
 *      「入りきる最大件数」が求まる)。
 * 1件も収まらない極端なケースでも安全側として最低1件は残す。
 */
export function limitRowChipsByWidth(
  orderedFormNames: string[],
  usageCounts: SpeciesUsageCounts | undefined,
  baseSpeedByName: Map<string, number>,
  chipWidthByName: ReadonlyMap<string, number>,
  gapWidth: number,
  containerWidth: number,
  overflowBadgeWidth: number,
): RowChipLimitResult {
  if (orderedFormNames.length === 0) return { kept: [], droppedCount: 0 };

  const ranked = [...orderedFormNames].sort((a, b) =>
    compareByUsageThenBaseSpeedThenName(a, b, usageCounts, baseSpeedByName),
  );
  const widthOf = (name: string): number => chipWidthByName.get(name) ?? 0;

  const totalWidthAll = ranked.reduce(
    (sum, name, index) => sum + widthOf(name) + (index === 0 ? 0 : gapWidth),
    0,
  );
  if (totalWidthAll <= containerWidth) {
    return { kept: [...orderedFormNames], droppedCount: 0 };
  }

  // ここに来た時点で「+N件」バッジは必ず表示される。バッジ自身の幅+区切りgapを
  // 先に予算から引いておく(バッジを足したせいで溢れることを防ぐ。要件3注意書き)。
  const budget = containerWidth - gapWidth - overflowBadgeWidth;
  let widthSoFar = 0;
  let keepCount = 0;
  for (let i = 0; i < ranked.length; i++) {
    const additionalGap = i === 0 ? 0 : gapWidth;
    const widthWithThis = widthSoFar + additionalGap + widthOf(ranked[i]);
    if (widthWithThis > budget) break;
    widthSoFar = widthWithThis;
    keepCount = i + 1;
  }
  keepCount = Math.max(1, keepCount);

  const keepSet = new Set(ranked.slice(0, keepCount));
  const kept = orderedFormNames.filter((name) => keepSet.has(name));
  return { kept, droppedCount: orderedFormNames.length - kept.length };
}

/**
 * 要件4: 「個体編集画面から遷移した場合、とりうるすばやさ以外をデフォルトで非表示にする」。
 * reachableValues は enumerateReachableSpeedValues(...).map(c => c.value) から作った
 * Set を渡す(個体の現在値も combos の直積に必ず含まれるため、← 現在の行も自動的に残る)。
 */
export function filterRowsByReachableValues(
  rows: SpeedChartRow[],
  reachableValues: ReadonlySet<number>,
): SpeedChartRow[] {
  return rows.filter((row) => reachableValues.has(row.value));
}
