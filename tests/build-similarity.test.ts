import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateBuildSimilarity,
  calculateTeamSimilarity,
  type BuildSimilaritySource,
  type BuildSimilarityTarget,
  type TeamSimilaritySource,
  type TeamSimilarityTarget,
} from '../src/lib/build-similarity.ts';

describe('calculateBuildSimilarity', () => {
  it('特性・アイテム・技がすべて一致すると3点になる', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: 'しんりょく', item_name: 'きせきのタネ', move_names: ['技1', '技2', '技3', '技4'] },
      { ability: 'しんりょく', itemName: 'きせきのタネ', moveNames: ['技1', '技2', '技3', '技4'] },
    ), 3);
  });

  it('何も一致しないと0点になる', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: '特性A', item_name: 'アイテムA', move_names: ['技1', '技2', '技3', '技4'] },
      { ability: '特性B', itemName: 'アイテムB', moveNames: ['技5', '技6', '技7', '技8'] },
    ), 0);
  });

  it('技が2/4だけ一致すると0.5点になる', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: '特性A', item_name: 'アイテムA', move_names: ['技1', '技2', '技3', '技4'] },
      { ability: '特性B', itemName: 'アイテムB', moveNames: ['技1', '技2', '技5', '技6'] },
    ), 0.5);
  });

  it('一方の特性またはアイテムが空文字列やnullなら一致とみなさない', () => {
    const source: BuildSimilaritySource = { ability_name: '', item_name: null, move_names: [] };
    const target: BuildSimilarityTarget = { ability: '', itemName: null, moveNames: [] };
    assert.equal(calculateBuildSimilarity(source, target), 0);
    assert.equal(calculateBuildSimilarity(
      { ability_name: '特性A', item_name: 'アイテムA', move_names: [] },
      { ability: null, itemName: '', moveNames: [] },
    ), 0);
  });

  it('target.moveNamesが空配列でも技スコアは0になる', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: '特性A', item_name: 'アイテムA', move_names: ['技1'] },
      { ability: '特性B', itemName: 'アイテムB', moveNames: [] },
    ), 0);
  });
});

describe('calculateTeamSimilarity', () => {
  const makeSource = (index: number): TeamSimilaritySource => ({
    species_name: `種族${index}`,
    ability_name: `特性${index}`,
    item_name: `アイテム${index}`,
    move_names: [`技${index}-1`, `技${index}-2`, `技${index}-3`, `技${index}-4`],
  });
  const makeTarget = (index: number): TeamSimilarityTarget => ({
    speciesName: `種族${index}`,
    speciesKey: `種族${index}`,
    ability: `特性${index}`,
    itemName: `アイテム${index}`,
    moveNames: [`技${index}-1`, `技${index}-2`, `技${index}-3`, `技${index}-4`],
  });

  it('6体すべての種族・特性・アイテム・技が一致すると24点になる', () => {
    assert.equal(
      calculateTeamSimilarity([1, 2, 3, 4, 5, 6].map(makeSource), [1, 2, 3, 4, 5, 6].map(makeTarget)),
      24,
    );
  });

  it('3体だけが完全一致し、残り3体の種族がなければ12点になる', () => {
    assert.equal(
      calculateTeamSimilarity([1, 2, 3, 4, 5, 6].map(makeSource), [1, 2, 3].map(makeTarget)),
      12,
    );
  });

  it('種族の一致がなければ0点になる', () => {
    assert.equal(calculateTeamSimilarity([1, 2, 3].map(makeSource), [4, 5, 6].map(makeTarget)), 0);
  });

  it('種族だけ一致するペアが1組なら1点になる', () => {
    assert.equal(calculateTeamSimilarity(
      [makeSource(1)],
      [{ speciesName: '種族1', speciesKey: '種族1', ability: '別の特性', itemName: '別のアイテム', moveNames: ['別技1'] }],
    ), 1);
  });

  it('ランキング表記(speciesName)がメガと進化前で同名でも、speciesKeyが違えば別ポケモンとして扱う', () => {
    // 公式ランキングはメガシンカを「進化前の種族+メガストーン」で表す(speciesNameは進化前のまま)。
    // 自チームの非メガ個体をこれに一致させてはならない(migrations/011)。
    const nonMegaSource: TeamSimilaritySource = {
      species_name: 'リザードン',
      ability_name: 'もうか',
      item_name: 'こだわりハチマキ',
      move_names: ['技1', '技2', '技3', '技4'],
    };
    const megaRankedTarget: TeamSimilarityTarget = {
      speciesName: 'リザードン',
      speciesKey: 'メガリザードンX',
      ability: 'かたいツメ',
      itemName: 'リザードナイトX',
      moveNames: ['技1', '技2', '技3', '技4'],
    };
    assert.equal(calculateTeamSimilarity([nonMegaSource], [megaRankedTarget]), 0);
  });

  it('自チームのメガ個体(species_nameがメガ後名)がランキング側のspeciesKeyと一致すると、メガ一致ボーナスが乗る', () => {
    const megaSource: TeamSimilaritySource = {
      species_name: 'メガリザードンX',
      ability_name: 'かたいツメ',
      item_name: 'リザードナイトX',
      move_names: ['技1', '技2', '技3', '技4'],
    };
    const megaRankedTarget: TeamSimilarityTarget = {
      speciesName: 'リザードン',
      speciesKey: 'メガリザードンX',
      ability: 'かたいツメ',
      itemName: 'リザードナイトX',
      moveNames: ['技1', '技2', '技3', '技4'],
    };
    // 1(種族一致) + 3(特性・アイテム・技全一致) + 3(メガ一致ボーナス) = 7
    assert.equal(calculateTeamSimilarity([megaSource], [megaRankedTarget]), 7);
  });

  it('speciesKeyが無いランキング個体とは一致しない', () => {
    const source = makeSource(1);
    const targetWithoutKey: TeamSimilarityTarget = {
      speciesName: '種族1',
      speciesKey: null,
      ability: '特性1',
      itemName: 'アイテム1',
      moveNames: ['技1-1', '技1-2', '技1-3', '技1-4'],
    };
    assert.equal(calculateTeamSimilarity([source], [targetWithoutKey]), 0);
  });
});
