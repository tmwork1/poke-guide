import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateBuildSimilarity } from '../src/lib/build-similarity.ts';

describe('calculateBuildSimilarity', () => {
  it('特性・アイテム・技が全て一致すると3を返す', () => {
    assert.equal(calculateBuildSimilarity(
      {
        ability_name: 'しんりょく',
        item_name: 'きあいのタスキ',
        move_names: ['リーフストーム', 'ヘドロばくだん', 'だいちのちから', 'みがわり'],
      },
      {
        ability: 'しんりょく',
        itemName: 'きあいのタスキ',
        moveNames: ['リーフストーム', 'ヘドロばくだん', 'だいちのちから', 'みがわり'],
      },
    ), 3);
  });

  it('何も一致しないと0を返す', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: 'しんりょく', item_name: 'きあいのタスキ', move_names: ['まもる'] },
      { ability: 'もうか', itemName: 'こだわりスカーフ', moveNames: ['かえんほうしゃ'] },
    ), 0);
  });

  it('技が2/4一致すると技スコアの0.5だけを加算する', () => {
    assert.equal(calculateBuildSimilarity(
      {
        ability_name: 'しんりょく',
        item_name: 'きあいのタスキ',
        move_names: ['リーフストーム', 'ヘドロばくだん'],
      },
      {
        ability: 'もうか',
        itemName: 'こだわりスカーフ',
        moveNames: ['リーフストーム', 'ヘドロばくだん', 'だいちのちから', 'みがわり'],
      },
    ), 0.5);
  });

  it('一方の特性またはアイテムが空文字列かnullなら一致とみなさない', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: '', item_name: null, move_names: [] },
      { ability: '', itemName: null, moveNames: [] },
    ), 0);
    assert.equal(calculateBuildSimilarity(
      { ability_name: 'しんりょく', item_name: 'きあいのタスキ', move_names: [] },
      { ability: null, itemName: '', moveNames: [] },
    ), 0);
    assert.equal(calculateBuildSimilarity(
      { ability_name: null, item_name: '', move_names: [] },
      { ability: 'しんりょく', itemName: 'きあいのタスキ', moveNames: [] },
    ), 0);
  });

  it('target.moveNamesが空配列でも技スコアを加算しない', () => {
    assert.equal(calculateBuildSimilarity(
      { ability_name: 'しんりょく', item_name: 'きあいのタスキ', move_names: ['まもる'] },
      { ability: 'しんりょく', itemName: 'きあいのタスキ', moveNames: [] },
    ), 2);
  });
});
