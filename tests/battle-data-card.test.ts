import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evSpreadLabel, hasSingleBattleData, usageRateLabel } from '../src/lib/battle-data-card.ts';

describe('hasSingleBattleData', () => {
  it('single.abilitiesなど何れかの配列に要素があればtrue', () => {
    assert.equal(hasSingleBattleData({ formats: { single: { abilities: [{ rank: 1, name: 'いかく', usageRate: 50 }] } } }), true);
  });

  it('single配下の配列が全て空ならfalse', () => {
    assert.equal(hasSingleBattleData({ formats: { single: { abilities: [], items: [] } } }), false);
  });

  it('single自体が無ければfalse', () => {
    assert.equal(hasSingleBattleData({ formats: {} }), false);
  });

  it('valueがnull/undefinedでも例外にならずfalse', () => {
    assert.equal(hasSingleBattleData(null), false);
    assert.equal(hasSingleBattleData(undefined), false);
  });
});

describe('usageRateLabel', () => {
  it('通常の使用率をパーセント表記にする', () => {
    assert.equal(usageRateLabel(99.5), '99.5%');
  });

  it('usageRateがnullなら「使用率非公開」にする', () => {
    assert.equal(usageRateLabel(null), '使用率非公開');
  });
});

describe('evSpreadLabel', () => {
  it('0以外の努力値配分をH/A/B/C/D/S順の表記にする', () => {
    assert.equal(
      evSpreadLabel({ hp: 252, attack: 252, defense: 0, specialAttack: 0, specialDefense: 0, speed: 4 }),
      'H252 A252 S4',
    );
  });

  it('0の努力値を表記から省略する', () => {
    assert.equal(
      evSpreadLabel({ hp: 32, attack: 0, defense: 32, specialAttack: 0, specialDefense: 2, speed: 0 }),
      'H32 B32 D2',
    );
  });

  it('全項目が0の場合は0を返す', () => {
    assert.equal(
      evSpreadLabel({ hp: 0, attack: 0, defense: 0, specialAttack: 0, specialDefense: 0, speed: 0 }),
      '0',
    );
  });
});
