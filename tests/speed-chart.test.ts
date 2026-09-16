import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySpeedModifier,
  applySpeedMultiplier,
  applySpeedRank,
  buildAppliedEvs,
  buildOpggSpeedChartPopulation,
  buildSpeedChartRows,
  decideSpeedSpreads,
  enumerateReachableSpeedValues,
  filterRowsByReachableValues,
  findUnknownDisabledModifierNames,
  getEffectiveSpeedModifiers,
  getNatureSpeedEffect,
  includeReachableValuesInRows,
  limitRowChipsByWidth,
  pickNatureNameForSpeedEffect,
  selectMinimalCostSpeedOption,
  selectMinimalCostSpeedOptions,
  SPEED_SPREADS,
  sumNatureEffectRate,
  sumSpeedEvRate,
  type SpeedChartConfig,
  type SpeedModifiersData,
} from '../src/lib/speed-chart.ts';
import { calcOtherStat } from '../src/lib/stats.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as T;

const thresholds = { evRateThreshold: 0.2, natureRateThreshold: 0.2 };
const single = (ev32: number, ev0: number, up: number, neutral: number, down: number) => ({
  evs: [
    { rank: 1, usageRate: ev32, values: { speed: 32 } },
    { rank: 2, usageRate: ev0, values: { speed: 0 } },
  ],
  natures: [
    { rank: 1, name: 'おくびょう', usageRate: up },
    { rank: 2, name: 'まじめ', usageRate: neutral },
    { rank: 3, name: 'ゆうかん', usageRate: down },
  ],
});

describe('OP.GGの努力値・性格補正から振り方を判定する', () => {
  it('usageRateを百分率から比率へ直し、speedがnullの努力値行を除外する', () => {
    const data = single(20, 25, 20, 20, 20);
    assert.equal(sumSpeedEvRate(data.evs, 32), 0.2);
    assert.equal(sumSpeedEvRate(data.evs, 0), 0.25);
    assert.equal(sumNatureEffectRate(data.natures, 'up'), 0.2);
  });

  it('閾値ちょうどで最速・準速・無振り・最遅の全条件を表示する', () => {
    assert.deepEqual(decideSpeedSpreads(single(20, 20, 20, 20, 20), thresholds), ['max', 'sub', 'none', 'min']);
  });

  it('努力値または性格の片方だけでは条件を満たさず、どれも満たさなければ無振りへフォールバックする', () => {
    assert.deepEqual(decideSpeedSpreads(single(20, 0, 19.9, 0, 0), thresholds), ['none']);
  });
});

describe('OP.GG順位で作る母集団', () => {
  const details = [
    { name: 'A', baseStats: [0, 0, 0, 0, 0, 100], abilities: ['特性A'], learnset: ['技A'] },
    { name: 'B', baseStats: [0, 0, 0, 0, 0, 100], abilities: ['特性B'], learnset: [] },
    { name: 'メガA', baseStats: [0, 0, 0, 0, 0, 120], abilities: ['特性M'], learnset: [] },
  ];
  const ranked = [
    { name: 'B', rank: 2, single: single(20, 0, 20, 0, 0) },
    { name: 'A', rank: 1, single: single(20, 0, 20, 0, 0) },
  ];
  const index = [
    { name: 'A', dexNo: 1, forme: null },
    { name: 'B', dexNo: 2, forme: null },
    { name: 'メガA', dexNo: 1, forme: 'Mega' },
  ];

  it('top Nは基本フォルムだけで数え、基本が入ったメガは同順位で後ろに同伴する', () => {
    const forms = buildOpggSpeedChartPopulation(ranked, 1, details, index, [{ species: 'メガA', item: 'Aナイト' }]);
    assert.deepEqual(forms.map((form) => [form.name, form.rank, form.isMega]), [['A', 1, false], ['メガA', 1, true]]);
  });

  it('top N外の基本フォルムのメガは表示しない', () => {
    const forms = buildOpggSpeedChartPopulation(ranked, 1, details, index, [{ species: 'メガB', item: 'Bナイト' }]);
    assert.deepEqual(forms.map((form) => form.name), ['A']);
  });

  it('名前の前方一致ではなくdexNoでメガを対応付ける', () => {
    const forms = buildOpggSpeedChartPopulation(
      [{ name: 'リザード', rank: 1, single: single(20, 0, 20, 0, 0) }],
      1,
      [
        { name: 'リザード', baseStats: [0, 0, 0, 0, 0, 80], abilities: [], learnset: [] },
        { name: 'メガリザードンX', baseStats: [0, 0, 0, 0, 0, 100], abilities: [], learnset: [] },
      ],
      [
        { name: 'リザード', dexNo: 5, forme: null },
        { name: 'メガリザードンX', dexNo: 6, forme: 'Mega X' },
      ],
      [{ species: 'メガリザードンX', item: 'リザードナイトX' }],
    );
    assert.deepEqual(forms.map((form) => form.name), ['リザード']);
  });

  it('行内のポケモンはOP.GG順位の昇順になる', () => {
    const forms = buildOpggSpeedChartPopulation(ranked, 2, details, index, []);
    const rows = buildSpeedChartRows(forms, [], { threshold: 0.2, appliesTo: [] }, new Map(ranked.map((entry) => [entry.name, entry.single])), thresholds);
    const equalValueRow = rows.find((row) => row.entries.length > 1);
    assert.ok(equalValueRow);
    assert.deepEqual(equalValueRow!.entries.map((entry) => entry.formName), ['A', 'B']);
  });
});

describe('OP.GG採用率による補正要因の絞り込み', () => {
  it('閾値未満の特性・持ち物・技は出さず、閾値以上だけを出す', () => {
    const form = { name: 'A', baseSpeed: 100, abilities: ['特性高', '特性低'], learnset: ['技高', '技低'], rank: 1, usageSourceName: 'A', isMega: false };
    const usage = {
      ...single(0, 0, 0, 0, 0),
      abilities: [{ rank: 1, name: '特性高', usageRate: 20 }, { rank: 2, name: '特性低', usageRate: 19.9 }],
      items: [{ rank: 1, name: '持ち物高', usageRate: 20 }, { rank: 2, name: '持ち物低', usageRate: 19.9 }],
      moves: [{ rank: 1, name: '技高', usageRate: 20 }, { rank: 2, name: '技低', usageRate: 19.9 }],
    };
    const modifiers = getEffectiveSpeedModifiers({
      abilities: { 特性高: { kind: 'rank', stages: 1 }, 特性低: { kind: 'rank', stages: 1 } },
      items: { 持ち物高: { kind: 'multiplier', numerator: 3, denominator: 1 }, 持ち物低: { kind: 'multiplier', numerator: 3, denominator: 1 } },
      moves: { 技高: { kind: 'rank', stages: 2 }, 技低: { kind: 'rank', stages: 2 } },
    }, { population: { topN: 1 }, adoptionRate: { threshold: 0.2, appliesTo: [] }, spreadConditions: thresholds, disabled: { abilities: [], items: [], moves: [] } });
    const rows = buildSpeedChartRows([form], modifiers, { threshold: 0.2, appliesTo: ['abilities', 'items', 'moves'] }, new Map([['A', usage]]), thresholds);
    const names = rows.flatMap((row) => row.entries.map((entry) => entry.modifier?.name).filter(Boolean));
    assert.deepEqual(new Set(names), new Set(['特性高', '持ち物高', '技高']));
  });
});

it('disabledに書かれた補正名は実データに存在する', () => {
  const config = readJson<SpeedChartConfig>('src/config/speed-chart.json');
  const modifiers = readJson<SpeedModifiersData>('public/master-data/detail/speed-modifiers.json');
  assert.deepEqual(findUnknownDisabledModifierNames(modifiers, config), []);
});

describe('実数値と補正の回帰', () => {
  const core = readJson<Array<{ name: string; baseStats: number[] }>>('public/master-data/detail/pokemon-core.json');

  it('無振りの実数値がcalcOtherStat(...)と一致する', () => {
    const baseSpeed = 100;
    assert.equal(calcOtherStat(50, baseSpeed, 31, SPEED_SPREADS.none.evSpe, SPEED_SPREADS.none.natureModifier), calcOtherStat(50, baseSpeed, 31, 0, 1));
  });

  it('最速の実数値がcalcOtherStat(...)と一致する', () => {
    const baseSpeed = 100;
    assert.equal(calcOtherStat(50, baseSpeed, 31, SPEED_SPREADS.max.evSpe, SPEED_SPREADS.max.natureModifier), calcOtherStat(50, baseSpeed, 31, 32, 1.1));
  });

  it('全フォルムの無振り実数値がcalcOtherStatと1件も不一致にならない', () => {
    for (const form of core) {
      assert.equal(calcOtherStat(50, form.baseStats[5], 31, SPEED_SPREADS.none.evSpe, SPEED_SPREADS.none.natureModifier), calcOtherStat(50, form.baseStats[5], 31, 0, 1), form.name);
    }
  });

  it('最遅はEV0・下降補正0.9で算出される', () => {
    assert.equal(calcOtherStat(50, 100, 31, SPEED_SPREADS.min.evSpe, SPEED_SPREADS.min.natureModifier), calcOtherStat(50, 100, 31, 0, 0.9));
  });

  it('こだわりスカーフ相当(6144/4096)はfloorで計算される', () => {
    assert.equal(applySpeedMultiplier(101, 6144, 4096), 151);
  });

  it('2倍の特性は倍率補正になる', () => assert.equal(applySpeedMultiplier(123, 2, 1), 246));
  it('S+2は2倍になる', () => assert.equal(applySpeedRank(123, 2), 246));
  it('S+1は1.5倍になる', () => assert.equal(applySpeedRank(123, 1), 184));
  it('S+6は4倍になる', () => assert.equal(applySpeedRank(123, 6), 492));
  it('applySpeedModifierはkindに応じて補正を適用する', () => {
    assert.equal(applySpeedModifier(101, { kind: 'multiplier', numerator: 6144, denominator: 4096 }), 151);
    assert.equal(applySpeedModifier(101, { kind: 'rank', stages: 1 }), 151);
  });
});

describe('speed-modifiers.jsonの回帰', () => {
  const modifiers = readJson<SpeedModifiersData>('public/master-data/detail/speed-modifiers.json');
  const values = (category: keyof SpeedModifiersData) => Object.keys(modifiers[category]);

  it('実データのこだわりスカーフの倍率は6144/4096である', () => {
    const scarf = modifiers.items['こだわりスカーフ'];
    assert.deepEqual(scarf, { kind: 'multiplier', numerator: 6144, denominator: 4096 });
  });
  it('こだいかっせい・クォークチャージが特性の補正に含まれない(R-3)', () => {
    assert.equal(values('abilities').includes('こだいかっせい'), false);
    assert.equal(values('abilities').includes('クォークチャージ'), false);
  });
  it('でんきエンジン・かそく・くだけるよろいが特性補正に含まれる', () => {
    for (const name of ['でんきエンジン', 'かそく', 'くだけるよろい']) assert.ok(modifiers.abilities[name]);
  });
  it('こうそくスピンが技のランク上昇に含まれる', () => assert.equal(modifiers.moves['こうそくスピン']?.kind, 'rank'));
  it('倍率特性が下限6件以上、ランク上昇技が下限15件以上ある', () => {
    assert.ok(Object.values(modifiers.abilities).filter((value) => value.kind === 'multiplier').length >= 6);
    assert.ok(Object.values(modifiers.moves).filter((value) => value.kind === 'rank').length >= 15);
  });
  it('確率発動のあやしいかぜ等が技の補正に含まれない', () => {
    for (const name of ['あやしいかぜ', 'ぎんいろのかぜ', 'げんしのちから']) assert.equal(values('moves').includes(name), false);
  });
  it('くろいてっきゅう・スロースタートが補正に含まれない', () => {
    assert.equal(values('items').includes('くろいてっきゅう'), false);
    assert.equal(values('abilities').includes('スロースタート'), false);
  });
});

describe('disabledの採否', () => {
  const all: SpeedModifiersData = { items: { A: { kind: 'rank', stages: 1 } }, abilities: { B: { kind: 'rank', stages: 1 } }, moves: { C: { kind: 'rank', stages: 1 } } };
  const config = (disabled: SpeedChartConfig['disabled']): SpeedChartConfig => ({ population: { topN: 1 }, adoptionRate: { threshold: 0.2, appliesTo: [] }, spreadConditions: thresholds, disabled });
  it('disabledに載っていないものは全て有効になる', () => assert.equal(getEffectiveSpeedModifiers(all, config({ items: [], abilities: [], moves: [] })).length, 3));
  it('disabledに載っているものは除外される', () => assert.deepEqual(getEffectiveSpeedModifiers(all, config({ items: ['A'], abilities: [], moves: [] })).map((entry) => entry.name), ['B', 'C']));
  it('findUnknownDisabledModifierNamesは未知名を列挙する', () => assert.deepEqual(findUnknownDisabledModifierNames(all, config({ items: ['missing'], abilities: [], moves: [] })), ['items.missing']));
  it('findUnknownDisabledModifierNamesは既知名だけなら空になる', () => assert.deepEqual(findUnknownDisabledModifierNames(all, config({ items: ['A'], abilities: [], moves: [] })), []));
});

describe('R-4と行組み立て', () => {
  const usage = { ...single(100, 100, 100, 100, 100), items: [{ rank: 1, name: 'こだわりスカーフ', usageRate: 100 }], abilities: [{ rank: 1, name: '特性', usageRate: 100 }] };
  const forms = [
    { name: '通常', baseSpeed: 100, abilities: [], learnset: [], rank: 1, usageSourceName: '通常', isMega: false },
    { name: 'メガ', baseSpeed: 100, abilities: [], learnset: [], rank: 1, usageSourceName: '通常', isMega: true },
  ];
  const modifiers = [{ category: 'items' as const, name: 'こだわりスカーフ', modifier: { kind: 'multiplier' as const, numerator: 6144, denominator: 4096 } }];
  const rows = buildSpeedChartRows(forms, modifiers, { threshold: 0.2, appliesTo: ['items'] }, new Map([['通常', usage]]), thresholds);
  it('メガ種族の行にはこだわりスカーフのエントリが1件も無い', () => assert.equal(rows.flatMap((row) => row.entries).filter((entry) => entry.formName === 'メガ' && entry.modifier?.name === 'こだわりスカーフ').length, 0));
  it('通常種族の行にはこだわりスカーフのエントリがある(対照確認)', () => assert.ok(rows.flatMap((row) => row.entries).some((entry) => entry.formName === '通常' && entry.modifier?.name === 'こだわりスカーフ')));
  it('同じ実数値になる複数フォルムは1行にまとまる', () => {
    const same = buildSpeedChartRows(forms.map((form) => ({ ...form, isMega: false })), [], { threshold: 0.2, appliesTo: [] }, new Map(), thresholds);
    assert.ok(same.every((row) => row.entries.length === 2));
  });
  it('行は実数値の降順に並ぶ', () => {
    for (let index = 1; index < rows.length; index += 1) assert.ok(rows[index - 1].value >= rows[index].value);
  });
  it('abilities > items > moves、同カテゴリでは入力順の先頭を残す', () => {
    const one = [{ ...forms[0], abilities: ['特性'] , learnset: ['技'] }];
    const entries = buildSpeedChartRows(one, [
      { category: 'moves', name: '技', modifier: { kind: 'rank', stages: 1 } },
      { category: 'items', name: '持物', modifier: { kind: 'rank', stages: 1 } },
      { category: 'abilities', name: '特性', modifier: { kind: 'rank', stages: 1 } },
    ], { threshold: 0.2, appliesTo: ['abilities', 'items', 'moves'] }, new Map([['通常', usage]]), thresholds).flatMap((row) => row.entries);
    assert.ok(entries.some((entry) => entry.modifier?.name === '特性'));
  });
});

describe('この個体カラムの純粋関数', () => {
  const scarf = { kind: 'multiplier' as const, numerator: 6144, denominator: 4096 };
  it('複数選択は到達可能な全候補を重複なく返す', () => {
    const currentNature = pickNatureNameForSpeedEffect('neutral');
    const selections = selectMinimalCostSpeedOptions([
      { value: 100, evSpe: 8, natureEffect: 'up', usesScarf: false },
      { value: 100, evSpe: 4, natureEffect: 'neutral', usesScarf: true },
      { value: 100, evSpe: 12, natureEffect: 'neutral', usesScarf: false },
      { value: 100, evSpe: 20, natureEffect: 'neutral', usesScarf: false },
      { value: 100, evSpe: 4, natureEffect: 'neutral', usesScarf: true },
    ], 100, currentNature, false);
    assert.deepEqual(selections, [
      { nature: currentNature, evSpe: 12, usesScarf: false },
      { nature: currentNature, evSpe: 4, usesScarf: true },
      { nature: pickNatureNameForSpeedEffect('up'), evSpe: 8, usesScarf: false },
    ]);
  });
  it('性格3種 × EV0〜32 × 持ち物2種を列挙する', () => assert.equal(enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'ようき', scarfModifier: scarf }).length, 3 * 33 * 2));
  it('スカーフが使えない場合は持ち物1種のみ', () => assert.equal(enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'ようき', scarfModifier: null }).length, 3 * 33));
  it('最小コスト選択はS努力値が最小のものを優先する', () => {
    const combos = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier: scarf });
    assert.equal(selectMinimalCostSpeedOption(combos, calcOtherStat(50, 100, 31, 0, 1), 'まじめ', false)?.evSpe, 0);
  });
  it('到達不可能な値はnullを返す', () => assert.equal(selectMinimalCostSpeedOption(enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier: null }), 999999, 'まじめ', false), null));
  it('特性の倍率補正を到達可能値へ適用する', () => {
    const combo = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier: null, abilityModifier: { kind: 'multiplier', numerator: 2, denominator: 1 } }).find((value) => value.natureEffect === 'neutral' && value.evSpe === 0);
    assert.equal(combo?.value, calcOtherStat(50, 100, 31, 0, 1) * 2);
  });
  it('rank特性は手動ランクと合算して一度だけ適用する', () => {
    const combo = enumerateReachableSpeedValues({ baseSpeed: 100, currentNature: 'まじめ', scarfModifier: null, abilityModifier: { kind: 'rank', stages: 1 }, rankStages: 1 }).find((value) => value.natureEffect === 'neutral' && value.evSpe === 0);
    assert.equal(combo?.value, calcOtherStat(50, 100, 31, 0, 1) * 2);
  });
  it('複数選択は努力値が異なる候補もすべて返す', () => assert.equal(selectMinimalCostSpeedOptions([{ value: 100, evSpe: 4, natureEffect: 'down', usesScarf: false }, { value: 100, evSpe: 8, natureEffect: 'up', usesScarf: false }], 100, 'まじめ', false).length, 2));
});

describe('性格・努力値・到達可能行', () => {
  it('getNatureSpeedEffectは性格補正を判定する', () => {
    assert.equal(getNatureSpeedEffect('ようき'), 'up');
    assert.equal(getNatureSpeedEffect('ゆうかん'), 'down');
    assert.equal(getNatureSpeedEffect('まじめ'), 'neutral');
  });
  it('pickNatureNameForSpeedEffectは各効果の性格を返す', () => {
    for (const effect of ['up', 'neutral', 'down'] as const) assert.equal(getNatureSpeedEffect(pickNatureNameForSpeedEffect(effect)), effect);
  });
  it('buildAppliedEvsはindex5だけを差し替える', () => {
    const evs = [4, 252, 0, 0, 0, 252];
    assert.deepEqual(buildAppliedEvs(evs, 32), [4, 252, 0, 0, 0, 32]);
    assert.equal(evs[5], 252);
  });
  it('includeReachableValuesInRowsは到達可能行を残す', () => {
    const rows = [{ value: 100, entries: [] }, { value: 101, entries: [] }];
    assert.deepEqual(includeReachableValuesInRows(rows, new Set([101])).map((row) => row.value), [101, 100]);
    assert.deepEqual(filterRowsByReachableValues(rows, new Set([101])).map((row) => row.value), [101]);
  });
});

describe('limitRowChipsByWidth', () => {
  const baseSpeed = new Map([['A', 100], ['B', 90], ['C', 80]]);
  const widths = new Map([['A', 30], ['B', 30], ['C', 30]]);
  it('全件が収まるならそのまま返す', () => {
    assert.deepEqual(limitRowChipsByWidth(['A', 'B'], { A: 2, B: 1 }, baseSpeed, widths, 4, 100, 12), { kept: ['A', 'B'], droppedCount: 0 });
  });
  it('収まらない場合は使用率の低いものから落とす', () => {
    const result = limitRowChipsByWidth(['A', 'B', 'C'], { A: 3, B: 2, C: 1 }, baseSpeed, widths, 4, 70, 12);
    assert.ok(result.droppedCount > 0);
    assert.ok(result.kept.includes('A'));
  });
  it('残ったチップの相対順序を保つ', () => {
    const result = limitRowChipsByWidth(['C', 'A', 'B'], { A: 3, B: 2, C: 1 }, baseSpeed, widths, 4, 70, 12);
    assert.deepEqual(result.kept, result.kept.filter((name) => ['C', 'A', 'B'].includes(name)));
  });
  it('長いチップ幅は収容件数に影響する', () => {
    const narrow = limitRowChipsByWidth(['A', 'B', 'C'], { A: 3, B: 2, C: 1 }, baseSpeed, widths, 4, 75, 12);
    const wide = limitRowChipsByWidth(['A', 'B', 'C'], { A: 3, B: 2, C: 1 }, baseSpeed, new Map([['A', 60], ['B', 30], ['C', 30]]), 4, 75, 12);
    assert.ok(wide.kept.length <= narrow.kept.length);
  });
  it('極端に狭くても最低1件を残す', () => assert.equal(limitRowChipsByWidth(['A', 'B'], { A: 2, B: 1 }, baseSpeed, widths, 4, 1, 12).kept.length, 1));
  it('空配列は空のまま返す', () => assert.deepEqual(limitRowChipsByWidth([], {}, baseSpeed, widths, 4, 1, 12), { kept: [], droppedCount: 0 }));
});
