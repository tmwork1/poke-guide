// src/lib/speed-chart.ts(すばやさ早見表の純粋関数群)の回帰テスト。
// docs/plan/pages/speed-chart.md の設計レビュー R-2/R-3/R-4/R-14、P3追補 U-1/U-2 を参照。
//
// public/master-data/ 配下の生成物(npm run build:master-data の出力)を実際に読み込んで
// 突き合わせるテストは tests/pokemon-master-data.test.ts と同じ方針(ビルド済み成果物の検証の
// ため、このテストはビルドスクリプト実行後にのみ意味を持つ)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calcOtherStat } from '../src/lib/stats.ts';
import {
  applySpeedMultiplier,
  applySpeedRank,
  applySpeedModifier,
  buildAppliedEvs,
  buildSpeedChartPopulation,
  buildSpeedChartRows,
  enumerateReachableSpeedValues,
  filterRowsByReachableValues,
  findUnknownDisabledModifierNames,
  getEffectiveSpeedModifiers,
  getNatureSpeedEffect,
  isAdoptedByRate,
  isAdoptionRateFilterActive,
  limitRowChipsByWidth,
  pickNatureNameForSpeedEffect,
  selectMinimalCostSpeedOption,
  sortFormNamesByUsage,
  SPEED_SPREADS,
  type AdoptionRateConfig,
  type AdoptionRateData,
  type EffectiveSpeedModifier,
  type SpeedChartConfig,
  type SpeedChartForm,
  type SpeedChartRow,
  type SpeedModifiersData,
  type SpeedModifierMultiplier,
  type SpeedModifierRank,
} from '../src/lib/speed-chart.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const masterDataDir = path.join(__dirname, '..', 'public', 'master-data');
const configDir = path.join(__dirname, '..', 'src', 'config');

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(path.join(...parts), 'utf-8')) as T;
}

// ------------------------------------------------------------------------------------------
// 実データ(public/master-data/・src/config/speed-chart.json)の読み込み。
// ------------------------------------------------------------------------------------------
const realPokemonAutocomplete = readJson<Array<{ name: string; regulations: string[] }>>(
  masterDataDir,
  'autocomplete',
  'pokemon.json',
);
const realPokemonDetail = readJson<Array<{ name: string; baseStats: number[]; abilities: string[]; learnset: string[] }>>(
  masterDataDir,
  'detail',
  'pokemon.json',
);
const realMegaStones = readJson<Array<{ species: string; item: string }>>(
  masterDataDir,
  'autocomplete',
  'mega-stones.json',
);
const realItemAutocomplete = readJson<Array<{ name: string; regulations: string[] }>>(
  masterDataDir,
  'autocomplete',
  'items.json',
);
const realSpeedModifiers = readJson<SpeedModifiersData>(masterDataDir, 'detail', 'speed-modifiers.json');
const realSpeedChartConfig = readJson<SpeedChartConfig>(configDir, 'speed-chart.json');

// ------------------------------------------------------------------------------------------
// 実数値の突き合わせ(受け入れ基準4/5/6、requirement 5「最低5件」)
// ------------------------------------------------------------------------------------------
describe('buildSpeedChartPopulation / calcOtherStatとの実数値の突き合わせ', () => {
  const population = buildSpeedChartPopulation(
    'M-B',
    realPokemonAutocomplete,
    realPokemonDetail,
    realMegaStones,
    realItemAutocomplete,
  );

  it('M-Bの母集団が5件以上ある(前提)', () => {
    assert.ok(population.length >= 5, `population.length=${population.length}`);
  });

  // vendor/jpoke v0.2.0時点の実測: M-B population = 通常種族235 + メガ種族73 = 308フォルム。
  // (P1の見積り311は実装時に無効化された。R-3のパラドックス除外・R-4のメガ絞り込みで
  // 実際の値が変わるため、P4=このエージェントが実測した値を正とする。)
  it('M-Bの母集団は308フォルム(通常235+メガ73。vendor/jpoke v0.2.0時点の実測値)', () => {
    const normalCount = population.filter((f) => !f.isMega).length;
    const megaCount = population.filter((f) => f.isMega).length;
    assert.equal(normalCount, 235);
    assert.equal(megaCount, 73);
    assert.equal(population.length, 308);
  });

  it('M-Aの母集団は270フォルム(通常213+メガ57。vendor/jpoke v0.2.0時点の実測値)', () => {
    const popA = buildSpeedChartPopulation(
      'M-A',
      realPokemonAutocomplete,
      realPokemonDetail,
      realMegaStones,
      realItemAutocomplete,
    );
    const normalCount = popA.filter((f) => !f.isMega).length;
    const megaCount = popA.filter((f) => f.isMega).length;
    assert.equal(normalCount, 213);
    assert.equal(megaCount, 57);
    assert.equal(popA.length, 270);
  });

  it('母集団に重複したフォルム名が無い', () => {
    const names = population.map((f) => f.name);
    assert.equal(new Set(names).size, names.length);
  });

  // 最低5件、無振り(EV0/補正なし)・最速(EV32/1.1倍)の両方でcalcOtherStatと突き合わせる。
  const sampleNames = ['ピカチュウ', 'カイリュー', 'ミミッキュ', 'ドラパルト', 'ガブリアス'];
  for (const name of sampleNames) {
    it(`${name}: 無振りの実数値がcalcOtherStat(50, base, 31, 0, 1.0)と一致する`, () => {
      const form = population.find((f) => f.name === name);
      assert.ok(form, `${name} がM-Bの母集団に見つかりません`);
      const expected = calcOtherStat(50, form!.baseSpeed, 31, 0, 1.0);
      const actual = calcOtherStat(50, form!.baseSpeed, 31, SPEED_SPREADS.none.evSpe, SPEED_SPREADS.none.natureModifier);
      assert.equal(actual, expected);
    });

    it(`${name}: 最速の実数値がcalcOtherStat(50, base, 31, 32, 1.1)と一致する`, () => {
      const form = population.find((f) => f.name === name);
      assert.ok(form);
      const expected = calcOtherStat(50, form!.baseSpeed, 31, 32, 1.1);
      const actual = calcOtherStat(50, form!.baseSpeed, 31, SPEED_SPREADS.max.evSpe, SPEED_SPREADS.max.natureModifier);
      assert.equal(actual, expected);
    });
  }

  it('全フォルムの無振り実数値がcalcOtherStatと1件も不一致にならない(受け入れ基準4相当の全件版)', () => {
    for (const form of population) {
      const expected = calcOtherStat(50, form.baseSpeed, 31, 0, 1.0);
      const actual = calcOtherStat(50, form.baseSpeed, 31, SPEED_SPREADS.none.evSpe, SPEED_SPREADS.none.natureModifier);
      assert.equal(actual, expected, `${form.name} の無振り実数値が不一致`);
    }
  });

  it('最遅はEV0・下降補正0.9で算出される', () => {
    const form = population.find((candidate) => candidate.name === 'ピカチュウ');
    assert.ok(form);
    const expected = calcOtherStat(50, form.baseSpeed, 31, 0, 0.9);
    const actual = calcOtherStat(50, form.baseSpeed, 31, SPEED_SPREADS.min.evSpe, SPEED_SPREADS.min.natureModifier);
    assert.equal(actual, expected);
  });
});

// ------------------------------------------------------------------------------------------
// 補正の適用(倍率・ランク)
// ------------------------------------------------------------------------------------------
describe('applySpeedMultiplier / applySpeedRank', () => {
  it('こだわりスカーフ相当(6144/4096)は floor(素の値 * 6144 / 4096) になる', () => {
    // 素の値100の場合: 100*6144/4096 = 150.0 (割り切れる例)
    assert.equal(applySpeedMultiplier(100, 6144, 4096), 150);
    // 割り切れない例(切り捨てが効いているかの確認)。
    assert.equal(applySpeedMultiplier(101, 6144, 4096), Math.floor((101 * 6144) / 4096));
    assert.equal(applySpeedMultiplier(101, 6144, 4096), 151);
  });

  it('2倍の特性(かるわざ等)は floor(素の値 * 2) になる', () => {
    assert.equal(applySpeedMultiplier(123, 2, 1), 246);
  });

  it('S+2(からをやぶる・ロックカット等)は floor(素の値 * 2) になる', () => {
    assert.equal(applySpeedRank(100, 2), 200);
    assert.equal(applySpeedRank(101, 2), 202);
  });

  it('S+1(かそく等)は floor(素の値 * 1.5) になる', () => {
    assert.equal(applySpeedRank(100, 1), 150);
    // 端数切り捨ての確認(101*1.5=151.5 -> 151)。
    assert.equal(applySpeedRank(101, 1), 151);
  });

  it('S+6(じょうききかん)は floor(素の値 * 4) になる', () => {
    assert.equal(applySpeedRank(100, 6), 400);
  });

  it('applySpeedModifierはkindに応じてmultiplier/rankを正しくディスパッチする', () => {
    const multiplier: SpeedModifierMultiplier = { kind: 'multiplier', numerator: 6144, denominator: 4096 };
    const rank: SpeedModifierRank = { kind: 'rank', stages: 2 };
    assert.equal(applySpeedModifier(100, multiplier), 150);
    assert.equal(applySpeedModifier(100, rank), 200);
  });

  it('実データのこだわりスカーフの倍率は6144/4096である(speed-modifiers.jsonとの突き合わせ)', () => {
    const scarf = realSpeedModifiers.items['こだわりスカーフ'];
    assert.ok(scarf, 'こだわりスカーフ が speed-modifiers.json の items に見つかりません');
    assert.equal(scarf.kind, 'multiplier');
    if (scarf.kind === 'multiplier') {
      assert.equal(scarf.numerator, 6144);
      assert.equal(scarf.denominator, 4096);
    }
  });
});

// ------------------------------------------------------------------------------------------
// speed-modifiers.json の抽出結果そのものの検証(R-2/R-3/R-14)
// ------------------------------------------------------------------------------------------
describe('public/master-data/detail/speed-modifiers.json(機械抽出結果の回帰テスト)', () => {
  it('こだいかっせい・クォークチャージが特性の補正に含まれない(R-3)', () => {
    assert.equal('こだいかっせい' in realSpeedModifiers.abilities, false);
    assert.equal('クォークチャージ' in realSpeedModifiers.abilities, false);
  });

  it('でんきエンジン(位置引数ではなくキーワード引数stats={"spe":1}経由)が抽出されている(R-2の取りこぼし対策)', () => {
    assert.ok('でんきエンジン' in realSpeedModifiers.abilities);
  });

  it('かそく・くだけるよろい(位置引数{"spe": +n}経由)が抽出されている(R-2の取りこぼし対策)', () => {
    assert.ok('かそく' in realSpeedModifiers.abilities);
    assert.ok('くだけるよろい' in realSpeedModifiers.abilities);
  });

  it('こうそくスピンが技のランク上昇に含まれる(P1で取りこぼしていた技)', () => {
    assert.ok('こうそくスピン' in realSpeedModifiers.moves);
  });

  it('倍率特性が下限6件以上、ランク上昇技が下限15件以上ある(P2 R-14の下限)', () => {
    const multiplierAbilityCount = Object.values(realSpeedModifiers.abilities).filter((m) => m.kind === 'multiplier').length;
    const rankMoveCount = Object.keys(realSpeedModifiers.moves).length;
    assert.ok(multiplierAbilityCount >= 6, `multiplierAbilityCount=${multiplierAbilityCount}`);
    assert.ok(rankMoveCount >= 15, `rankMoveCount=${rankMoveCount}`);
  });

  it('あやしいかぜ・ぎんいろのかぜ・げんしのちから(確率発動)が技の補正に含まれない', () => {
    assert.equal('あやしいかぜ' in realSpeedModifiers.moves, false);
    assert.equal('ぎんいろのかぜ' in realSpeedModifiers.moves, false);
    assert.equal('げんしのちから' in realSpeedModifiers.moves, false);
  });

  it('くろいてっきゅう・スロースタート(下降補正)が特性・持ち物の補正に含まれない', () => {
    assert.equal('くろいてっきゅう' in realSpeedModifiers.items, false);
    assert.equal('スロースタート' in realSpeedModifiers.abilities, false);
  });
});

// ------------------------------------------------------------------------------------------
// U-1: 採否のマージ・disabledの存在チェック
// ------------------------------------------------------------------------------------------
describe('getEffectiveSpeedModifiers(U-1: 抽出と採否のマージ)', () => {
  const fixtureModifiers: SpeedModifiersData = {
    items: { アイテムA: { kind: 'multiplier', numerator: 2, denominator: 1 } },
    abilities: {
      特性A: { kind: 'rank', stages: 1 },
      特性B: { kind: 'multiplier', numerator: 2, denominator: 1 },
    },
    moves: { 技A: { kind: 'rank', stages: 2 } },
  };

  it('disabledに載っていないものは全て有効になる(既定でON)', () => {
    const config: SpeedChartConfig = {
      adoptionRate: { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] },
      disabled: { abilities: [], moves: [], items: [] },
    };
    const effective = getEffectiveSpeedModifiers(fixtureModifiers, config);
    assert.equal(effective.length, 4);
  });

  it('disabledに載っているものは有効な補正一覧から除外される', () => {
    const config: SpeedChartConfig = {
      adoptionRate: { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] },
      disabled: { abilities: ['特性A'], moves: [], items: [] },
    };
    const effective = getEffectiveSpeedModifiers(fixtureModifiers, config);
    assert.equal(effective.some((m) => m.name === '特性A'), false);
    assert.equal(effective.length, 3);
  });

  it('findUnknownDisabledModifierNames: disabledに実在しない名前があれば列挙する(打ち間違い検知)', () => {
    const config: SpeedChartConfig = {
      adoptionRate: { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] },
      disabled: { abilities: ['存在しない特性'], moves: [], items: [] },
    };
    const unknown = findUnknownDisabledModifierNames(fixtureModifiers, config);
    assert.deepEqual(unknown, ['abilities.存在しない特性']);
  });

  it('findUnknownDisabledModifierNames: 全て実在するdisabledなら空配列', () => {
    const config: SpeedChartConfig = {
      adoptionRate: { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] },
      disabled: { abilities: ['特性A'], moves: ['技A'], items: ['アイテムA'] },
    };
    assert.deepEqual(findUnknownDisabledModifierNames(fixtureModifiers, config), []);
  });

  // 受け入れ基準30 / U-1: src/config/speed-chart.json の disabled に書かれた名前が
  // public/master-data/detail/speed-modifiers.json に実在しない場合、このテストが失敗する。
  // 打ち間違い・jpoke側の改名によるサイレントな無効化解除を検知する回帰テスト。
  it('実データ: src/config/speed-chart.json の disabled は全て speed-modifiers.json に実在する', () => {
    const unknown = findUnknownDisabledModifierNames(realSpeedModifiers, realSpeedChartConfig);
    assert.deepEqual(unknown, [], `disabledに存在しない名前があります: ${unknown.join(', ')}`);
  });
});

// ------------------------------------------------------------------------------------------
// U-2: 採用率フィルタの境界値
// ------------------------------------------------------------------------------------------
describe('isAdoptedByRate(U-2: 採用率フィルタ)', () => {
  const config: AdoptionRateConfig = { enabled: true, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] };
  const data: AdoptionRateData = {
    ドラパルト: { items: { sampleSize: 20, options: { こだわりスカーフ: 0.1 } } },
    カイリュー: { items: { sampleSize: 20, options: { こだわりスカーフ: 0.05 } } },
    ハバタクカミ: { items: { sampleSize: 3, options: { こだわりスカーフ: 0.5 } } },
  };

  it('採用率がthresholdちょうどのときは採用する(境界値。 >= threshold)', () => {
    assert.equal(isAdoptedByRate('items', 'こだわりスカーフ', 'ドラパルト', config, data), true);
  });

  it('採用率がthreshold未満のときは採用しない', () => {
    assert.equal(isAdoptedByRate('items', 'こだわりスカーフ', 'カイリュー', config, data), false);
  });

  it('sampleSizeがminSampleSize未満のときは採用率に関わらず採用しない(k-匿名性)', () => {
    assert.equal(isAdoptedByRate('items', 'こだわりスカーフ', 'ハバタクカミ', config, data), false);
  });

  it('その種族のデータが無いときは採用しない', () => {
    assert.equal(isAdoptedByRate('items', 'こだわりスカーフ', 'データなし種族', config, data), false);
  });

  it('adoptionRate.enabled=falseのときは常に採用する(P1の挙動に戻る)', () => {
    const disabledConfig: AdoptionRateConfig = { ...config, enabled: false };
    assert.equal(isAdoptedByRate('items', 'こだわりスカーフ', 'データなし種族', disabledConfig, data), true);
    assert.equal(isAdoptionRateFilterActive('items', disabledConfig), false);
  });

  it('特性(abilities)には採用率データの型自体が無いため、誤ってappliesToに含めても安全側(出さない)に倒れる(U-2)', () => {
    // 本番経路(isModifierApplicableToForm)では abilities は isAdoptedByRate を一切呼ばず
    // form.abilities.includes(...) のみで判定する(採用率フィルタは常にバイパスされる)。
    // このテストは「万一 appliesTo に 'abilities' を書いてしまっても、AdoptionRateData が
    // items/moves の2種類しかバケットを持たないため安全側(false=出さない)に倒れる」ことの確認。
    const abilitiesConfig: AdoptionRateConfig = { ...config, appliesTo: ['items', 'moves', 'abilities'] };
    assert.equal(isAdoptedByRate('abilities', '特性A', 'データなし種族', abilitiesConfig, data), false);
  });

  it('appliesToにカテゴリが含まれないときはフィルタが効かない', () => {
    const itemsOnlyConfig: AdoptionRateConfig = { ...config, appliesTo: ['items'] };
    assert.equal(isAdoptedByRate('moves', 'りゅうのまい', 'データなし種族', itemsOnlyConfig, data), true);
  });

  // 2026-08-01: くさわけ・こうそくいどうの手動除外(disabled.moves)を廃止し、技も
  // 採用率フィルタ(appliesTo に 'moves')で制御する方針に変更した。moves カテゴリでも
  // items と同じ境界値判定(閾値・k-匿名性)が効くことを直接確認する。
  const moveData: AdoptionRateData = {
    メガメガニウム: { moves: { sampleSize: 25, options: { くさわけ: 0.2 } } },
    ライチュウ: { moves: { sampleSize: 20, options: { くさわけ: 0.05 } } },
  };

  it('moves: 採用率がthreshold以上なら採用する', () => {
    assert.equal(isAdoptedByRate('moves', 'くさわけ', 'メガメガニウム', config, moveData), true);
  });

  it('moves: 採用率がthreshold未満なら採用しない', () => {
    assert.equal(isAdoptedByRate('moves', 'くさわけ', 'ライチュウ', config, moveData), false);
  });
});

// ------------------------------------------------------------------------------------------
// R-4: メガ種族にはこだわりスカーフを付けない
// ------------------------------------------------------------------------------------------
describe('buildSpeedChartRows: R-4 メガ種族にこだわりスカーフを付けない', () => {
  const population: SpeedChartForm[] = [
    { name: 'メガテスト', baseSpeed: 100, abilities: [], learnset: [], isMega: true },
    { name: '通常テスト', baseSpeed: 100, abilities: [], learnset: [], isMega: false },
  ];
  const effectiveModifiers: EffectiveSpeedModifier[] = [
    { category: 'items', name: 'こだわりスカーフ', modifier: { kind: 'multiplier', numerator: 6144, denominator: 4096 } },
  ];
  const adoptionConfig: AdoptionRateConfig = { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] };

  it('メガ種族の行にはこだわりスカーフのエントリが1件も無い', () => {
    const rows = buildSpeedChartRows(population, effectiveModifiers, adoptionConfig);
    const megaScarfEntries = rows
      .flatMap((row) => row.entries)
      .filter((entry) => entry.formName === 'メガテスト' && entry.modifier?.name === 'こだわりスカーフ');
    assert.equal(megaScarfEntries.length, 0);
  });

  it('通常種族の行にはこだわりスカーフのエントリがある(対照確認)', () => {
    const rows = buildSpeedChartRows(population, effectiveModifiers, adoptionConfig);
    const normalScarfEntries = rows
      .flatMap((row) => row.entries)
      .filter((entry) => entry.formName === '通常テスト' && entry.modifier?.name === 'こだわりスカーフ');
    assert.equal(normalScarfEntries.length, 4, '振り方4種それぞれにスカーフ行があるべき');
  });

  it('実データ: M-Bのメガ種族はどれもこだわりスカーフの行を持たない', () => {
    const realPopulation = buildSpeedChartPopulation(
      'M-B',
      realPokemonAutocomplete,
      realPokemonDetail,
      realMegaStones,
      realItemAutocomplete,
    );
    const megaNames = new Set(realPopulation.filter((f) => f.isMega).map((f) => f.name));
    assert.ok(megaNames.size > 0, '実データにメガ種族が1件も無い(前提が崩れている)');

    const config = getEffectiveSpeedModifiers(realSpeedModifiers, realSpeedChartConfig);
    const disabledAdoption: AdoptionRateConfig = { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] };
    const rows = buildSpeedChartRows(realPopulation, config, disabledAdoption);
    const megaItemEntries = rows
      .flatMap((row) => row.entries)
      .filter((entry) => entry.modifier?.category === 'items' && megaNames.has(entry.formName));
    assert.equal(megaItemEntries.length, 0);
  });
});

// ------------------------------------------------------------------------------------------
// 2026-08-01: くさわけ・こうそくいどうの手動除外を廃止し、技も採用率フィルタで
// 制御する方針に変更したことの回帰テスト(要件4: 採用率フィルタが技にも効くことの検証)。
// ------------------------------------------------------------------------------------------
describe('buildSpeedChartRows: 採用率フィルタが技(moves)にも効く(手動除外disabledの代替)', () => {
  const population: SpeedChartForm[] = [
    { name: 'メガメガニウム', baseSpeed: 100, abilities: [], learnset: ['くさわけ'], isMega: true },
    { name: 'ライチュウ', baseSpeed: 100, abilities: [], learnset: ['くさわけ'], isMega: false },
  ];
  const effectiveModifiers: EffectiveSpeedModifier[] = [
    { category: 'moves', name: 'くさわけ', modifier: { kind: 'rank', stages: 2 } },
  ];
  // appliesTo に 'moves' を含めた実運用の設定(src/config/speed-chart.jsonの現行値と同じ形)。
  const adoptionConfig: AdoptionRateConfig = { enabled: true, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] };
  const adoptionData: AdoptionRateData = {
    // メガメガニウムは実際に採用率20%(閾値10%以上) → 行に出る。
    メガメガニウム: { moves: { sampleSize: 25, options: { くさわけ: 0.2 } } },
    // ライチュウは採用率5%(閾値未満) → 行から除外される。
    ライチュウ: { moves: { sampleSize: 20, options: { くさわけ: 0.05 } } },
  };

  it('採用率が閾値以上の種族(メガメガニウム)にはくさわけの補正行が出る', () => {
    const rows = buildSpeedChartRows(population, effectiveModifiers, adoptionConfig, adoptionData);
    const entries = rows.flatMap((row) => row.entries).filter((e) => e.formName === 'メガメガニウム' && e.modifier?.name === 'くさわけ');
    assert.equal(entries.length, 4, '振り方4種それぞれにくさわけ行があるべき');
  });

  it('採用率が閾値未満の種族(ライチュウ)にはくさわけの補正行が出ない', () => {
    const rows = buildSpeedChartRows(population, effectiveModifiers, adoptionConfig, adoptionData);
    const entries = rows.flatMap((row) => row.entries).filter((e) => e.formName === 'ライチュウ' && e.modifier?.name === 'くさわけ');
    assert.equal(entries.length, 0);
  });

  it('実データ: src/config/speed-chart.json は disabled.moves を空にし、appliesTo にmovesを含む(手動除外から採用率フィルタへの移行)', () => {
    assert.deepEqual(realSpeedChartConfig.disabled.moves, []);
    assert.ok(realSpeedChartConfig.adoptionRate.appliesTo.includes('moves'));
    assert.ok(realSpeedChartConfig.adoptionRate.appliesTo.includes('items'));
  });
});

// ------------------------------------------------------------------------------------------
// 早見表の行の組み立て(降順ソート・同値のまとめ)
// ------------------------------------------------------------------------------------------
describe('buildSpeedChartRows: 行の組み立て', () => {
  const population: SpeedChartForm[] = [
    { name: 'フォルムA', baseSpeed: 100, abilities: [], learnset: [], isMega: false },
    { name: 'フォルムB', baseSpeed: 100, abilities: [], learnset: [], isMega: false },
  ];
  const adoptionConfig: AdoptionRateConfig = { enabled: false, threshold: 0.1, minSampleSize: 5, appliesTo: ['items', 'moves'] };

  it('同じ実数値になる複数フォルムは1行にまとまる', () => {
    const rows = buildSpeedChartRows(population, [], adoptionConfig);
    // 同じ種族値・同じ振り方なら同じ実数値になるはずなので、行数は振り方の種類数(4)のまま。
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.entries.length, 2, '同値の2フォルムが同じ行にまとまっているべき');
    }
  });

  it('行は実数値の降順に並ぶ', () => {
    const rows = buildSpeedChartRows(population, [], adoptionConfig);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].value >= rows[i].value, '実数値が降順になっていない');
    }
  });
});

// ------------------------------------------------------------------------------------------
// B. 「この個体」カラム: 到達可能値の列挙・最小コスト選択
// ------------------------------------------------------------------------------------------
describe('enumerateReachableSpeedValues / selectMinimalCostSpeedOption', () => {
  const scarfModifier: SpeedModifierMultiplier = { kind: 'multiplier', numerator: 6144, denominator: 4096 };

  it('性格3種 × EV0〜32(33段) × 持ち物2種(スカーフ有効時)の直積を列挙する', () => {
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'ようき', scarfModifier });
    assert.equal(combos.length, 3 * 33 * 2);
  });

  it('スカーフが使えない場合(scarfModifier=null)は持ち物1種のみ', () => {
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'ようき', scarfModifier: null });
    assert.equal(combos.length, 3 * 33 * 1);
    assert.equal(combos.every((c) => c.usesScarf === false), true);
  });

  it('最小コスト選択: S努力値が最小のものを優先する', () => {
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier });
    // baseSpeed=100, neutral(1.0), EV0 -> calcOtherStat(50,100,31,0,1.0)
    const target = calcOtherStat(50, 100, 31, 0, 1.0);
    const selection = selectMinimalCostSpeedOption(combos, target, 'まじめ', false);
    assert.ok(selection);
    assert.equal(selection!.evSpe, 0);
  });

  it('最小コスト選択: 同じEVの中では現在の性格効果と同じものを優先する', () => {
    // ゆうかん(spe down)の個体で、down効果のまま到達できる値を目標にする。
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'ゆうかん', scarfModifier: null });
    const target = calcOtherStat(50, 100, 31, 4, 0.9); // down効果・EV4で到達する値
    const selection = selectMinimalCostSpeedOption(combos, target, 'ゆうかん', false);
    assert.ok(selection);
    assert.equal(selection!.nature, 'ゆうかん', '現在の性格のまま(効果が一致)なら性格を変えない');
  });

  it('最小コスト選択: 効果を変える必要がある場合はpickNatureNameForSpeedEffectの代表性格になる', () => {
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier: null });
    // neutral(まじめ)の個体で、up効果でしか到達できない値を目標にする。
    const upOnlyTarget = calcOtherStat(50, 100, 31, 0, 1.1);
    const neutralAtSameEv = calcOtherStat(50, 100, 31, 0, 1.0);
    assert.notEqual(upOnlyTarget, neutralAtSameEv, 'テスト前提が成立していない(up/neutralが同値)');
    const selection = selectMinimalCostSpeedOption(combos, upOnlyTarget, 'まじめ', false);
    assert.ok(selection);
    assert.equal(selection!.nature, pickNatureNameForSpeedEffect('up'));
  });

  it('最小コスト選択: EV・性格が同点のときは持ち物が現在値と同じものを優先する', () => {
    // scarfModifierが1.5倍でbaseSpeedによっては同じ値になり得ないため、素朴に
    // usesScarf=falseの候補が存在する場合にそれが選ばれることを、
    // 「現在スカーフを持っていない」個体で確認する。
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier });
    const target = calcOtherStat(50, 100, 31, 10, 1.0);
    const selection = selectMinimalCostSpeedOption(combos, target, 'まじめ', false);
    assert.ok(selection);
    assert.equal(selection!.usesScarf, false);
  });

  it('到達不可能な値はnullを返す', () => {
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier: null });
    const selection = selectMinimalCostSpeedOption(combos, 999999, 'まじめ', false);
    assert.equal(selection, null);
  });
});

describe('getNatureSpeedEffect / pickNatureNameForSpeedEffect', () => {
  it('おくびょう・せっかち・ようき・むじゃきはup', () => {
    for (const name of ['おくびょう', 'せっかち', 'ようき', 'むじゃき']) {
      assert.equal(getNatureSpeedEffect(name), 'up', name);
    }
  });

  it('ゆうかん・のんき・れいせい・なまいきはdown', () => {
    for (const name of ['ゆうかん', 'のんき', 'れいせい', 'なまいき']) {
      assert.equal(getNatureSpeedEffect(name), 'down', name);
    }
  });

  it('まじめ・いじっぱり等はneutral', () => {
    assert.equal(getNatureSpeedEffect('まじめ'), 'neutral');
    assert.equal(getNatureSpeedEffect('いじっぱり'), 'neutral');
  });

  it('null/未知の性格名はneutralとして扱う(安全側)', () => {
    assert.equal(getNatureSpeedEffect(null), 'neutral');
    assert.equal(getNatureSpeedEffect('存在しない性格'), 'neutral');
  });

  it('pickNatureNameForSpeedEffectは各効果について有効な性格名を返す', () => {
    assert.equal(getNatureSpeedEffect(pickNatureNameForSpeedEffect('up')), 'up');
    assert.equal(getNatureSpeedEffect(pickNatureNameForSpeedEffect('down')), 'down');
    assert.equal(getNatureSpeedEffect(pickNatureNameForSpeedEffect('neutral')), 'neutral');
  });
});

describe('buildAppliedEvs', () => {
  it('index5(すばやさ)だけを差し替え、他は変えない', () => {
    const current = [4, 252, 0, 0, 0, 252];
    const next = buildAppliedEvs(current, 32);
    assert.deepEqual(next, [4, 252, 0, 0, 0, 32]);
    assert.deepEqual(current, [4, 252, 0, 0, 0, 252], '元の配列を変更してはいけない');
  });
});

// ------------------------------------------------------------------------------------------
// 追加改修(2026-08-01 ユーザー指示・第2弾)要件1: sortFormNamesByUsage
// ------------------------------------------------------------------------------------------
describe('sortFormNamesByUsage(要件1: 使用率降順→すばやさ種族値降順→種族名昇順)', () => {
  const baseSpeedByName = new Map<string, number>([
    ['ガブリアス', 102],
    ['ブリジュラス', 98],
    ['ミミッキュ', 96],
    ['カバルドン', 55],
    ['アシレーヌ', 62],
  ]);

  it('使用率(延べ数)の降順に並ぶ', () => {
    const usage = { ガブリアス: 114, ブリジュラス: 92, ミミッキュ: 83 };
    const sorted = sortFormNamesByUsage(['ミミッキュ', 'ガブリアス', 'ブリジュラス'], usage, baseSpeedByName);
    assert.deepEqual(sorted, ['ガブリアス', 'ブリジュラス', 'ミミッキュ']);
  });

  it('使用率が同じ(または両方未使用)ときはすばやさ種族値の降順になる', () => {
    // カバルドン・アシレーヌはusageデータに含まれない(=0扱い)。種族値はアシレーヌ(62)>カバルドン(55)。
    const usage = { ガブリアス: 100 };
    const sorted = sortFormNamesByUsage(['カバルドン', 'アシレーヌ'], usage, baseSpeedByName);
    assert.deepEqual(sorted, ['アシレーヌ', 'カバルドン']);
  });

  it('使用率・すばやさ種族値の両方が同じときは種族名の昇順になる', () => {
    const speedByName = new Map<string, number>([
      ['ピカチュウ', 90],
      ['カイリュー', 90],
    ]);
    const sorted = sortFormNamesByUsage(['カイリュー', 'ピカチュウ'], undefined, speedByName);
    assert.deepEqual(sorted, ['カイリュー', 'ピカチュウ'], '「カ」<「ピ」の辞書順');
  });

  it('usageCountsがundefinedのときは全て使用率0として扱われ、すばやさ種族値降順になる', () => {
    const sorted = sortFormNamesByUsage(['カバルドン', 'ガブリアス', 'ミミッキュ'], undefined, baseSpeedByName);
    assert.deepEqual(sorted, ['ガブリアス', 'ミミッキュ', 'カバルドン']);
  });

  it('元の配列を変更しない', () => {
    const original = ['カバルドン', 'ガブリアス'];
    sortFormNamesByUsage(original, { ガブリアス: 10 }, baseSpeedByName);
    assert.deepEqual(original, ['カバルドン', 'ガブリアス']);
  });
});

// ------------------------------------------------------------------------------------------
// 要件3の不具合修正(2026-08-01): limitRowChipsByWidth
// 「サンプル1個の幅から算出した全行共通の固定件数」で足切りしていたのが不具合の原因
// (名前の長いフォルムを含む行で実際の合計幅がコンテナ幅を超えて折り返していた)。
// 「行ごとの実際の合計幅」で足切りする新しい実装のテスト。
// ------------------------------------------------------------------------------------------
describe('limitRowChipsByWidth(要件3不具合修正: 実際の合計幅で足切り)', () => {
  const baseSpeedByName = new Map<string, number>([
    ['A', 100],
    ['B', 100],
    ['C', 100],
    ['D', 100],
    ['E', 100],
  ]);
  const usage = { A: 50, B: 40, C: 30, D: 20, E: 10 };
  const uniformWidths = new Map<string, number>([
    ['A', 10],
    ['B', 10],
    ['C', 10],
    ['D', 10],
    ['E', 10],
  ]);

  it('全件の合計幅(gap込み)がcontainerWidthに収まるならそのまま返し、droppedCountは0', () => {
    // A+B+gap1本 = 10+10+2 = 22 = containerWidth ぴったり収まる。
    const result = limitRowChipsByWidth(['A', 'B'], usage, baseSpeedByName, uniformWidths, 2, 22, 5);
    assert.deepEqual(result.kept, ['A', 'B']);
    assert.equal(result.droppedCount, 0);
  });

  it('収まらない場合は使用率の最下位から落とし、+N件バッジの幅も予算に含める', () => {
    // 5件(各幅10、gap2)の合計は58。containerWidth=41、badge幅5+区切りgap2を引いた
    // 予算34に対し、使用率上位から入るだけ入れると A,B,C(=10+2+10+2+10=34)まで収まり、
    // Dを足すと34+2+10=46で溢れる。
    const result = limitRowChipsByWidth(['A', 'B', 'C', 'D', 'E'], usage, baseSpeedByName, uniformWidths, 2, 41, 5);
    assert.deepEqual(result.kept, ['A', 'B', 'C'], '使用率上位3件(A,B,C)が残るべき');
    assert.equal(result.droppedCount, 2);
  });

  it('落とされた後も残ったものの相対順序(グループ順)は維持される', () => {
    // 入力順はグループ順(使用率順とは無関係)。使用率上位のB,C,Dが残り、
    // 元の並び順(B,C,D)を保ったまま使用率下位のA,Eだけ除外される。
    const usageReordered = { A: 5, B: 40, C: 30, D: 20, E: 1 };
    const result = limitRowChipsByWidth(['B', 'A', 'C', 'E', 'D'], usageReordered, baseSpeedByName, uniformWidths, 2, 41, 5);
    assert.deepEqual(result.kept, ['B', 'C', 'D'], '元の並び順(B,C,D)を保ったまま使用率下位のA,Eだけ除外');
    assert.equal(result.droppedCount, 2);
  });

  it('名前が長く実測幅が大きいフォルムが上位にあると、残せる件数がその分減る(不具合の再現と修正の確認)', () => {
    // Aだけ幅30(名前の長いフォルムを模す)、他は10。containerWidth=41なので予算は34。
    // Aだけで30を消費するため、Bを足すと30+2+10=42で溢れ、Aの1件しか残せない
    // (固定件数方式ならサンプルの幅次第でB,C等も残ってしまい、実際には折り返していた)。
    const widths = new Map(uniformWidths);
    widths.set('A', 30);
    const result = limitRowChipsByWidth(['A', 'B', 'C', 'D', 'E'], usage, baseSpeedByName, widths, 2, 41, 5);
    assert.deepEqual(result.kept, ['A'], '幅の大きいAだけで予算を使い切るため1件しか残せない');
    assert.equal(result.droppedCount, 4);
  });

  it('1件も収まらない極端な場合でも安全側として最低1件は残す', () => {
    const result = limitRowChipsByWidth(['A', 'B'], usage, baseSpeedByName, uniformWidths, 2, 3, 5);
    assert.deepEqual(result.kept, ['A'], '使用率トップのAだけは残す(安全側フォールバック)');
    assert.equal(result.droppedCount, 1);
  });

  it('空配列を渡すとdroppedCount 0の空配列を返す', () => {
    const result = limitRowChipsByWidth([], usage, baseSpeedByName, uniformWidths, 2, 41, 5);
    assert.deepEqual(result.kept, []);
    assert.equal(result.droppedCount, 0);
  });
});

// ------------------------------------------------------------------------------------------
// 追加改修(2026-08-01 ユーザー指示・第2弾)要件4: filterRowsByReachableValues
// ------------------------------------------------------------------------------------------
describe('filterRowsByReachableValues(要件4: 到達可能な実数値の行だけを残す)', () => {
  const rows: SpeedChartRow[] = [
    { value: 150, entries: [] },
    { value: 140, entries: [] },
    { value: 130, entries: [] },
  ];

  it('reachableValuesに含まれる行だけが残る', () => {
    const filtered = filterRowsByReachableValues(rows, new Set([150, 130]));
    assert.deepEqual(
      filtered.map((r) => r.value),
      [150, 130],
    );
  });

  it('reachableValuesが空なら全行が除外される', () => {
    const filtered = filterRowsByReachableValues(rows, new Set());
    assert.equal(filtered.length, 0);
  });

  it('rowsの並び順(実数値の降順)は変えない', () => {
    const filtered = filterRowsByReachableValues(rows, new Set([150, 140, 130]));
    assert.deepEqual(
      filtered.map((r) => r.value),
      [150, 140, 130],
    );
  });
});
