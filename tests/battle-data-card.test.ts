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
  it('努力値配分をH/A/B/C/D/Sの表記にする', () => {
    assert.equal(
      evSpreadLabel({ hp: 252, attack: 252, defense: 0, specialAttack: 0, specialDefense: 0, speed: 4 }),
      'H252/A252/B0/C0/D0/S4',
    );
  });
});
