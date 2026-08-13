import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatEvRanked, formatRanked, hasSingleBattleData } from '../src/lib/battle-data-card.ts';

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

describe('formatRanked', () => {
  it('上位4件を "順位. 名前 — 使用率%" で改行区切りにする', () => {
    const rows = [
      { rank: 1, name: 'じしん', usageRate: 99.5 },
      { rank: 2, name: 'げきりん', usageRate: 29.1 },
    ];
    assert.equal(formatRanked(rows), '1. じしん — 99.5%\n2. げきりん — 29.1%');
  });

  it('5件以上は上位4件のみ表示する', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, name: `わざ${i + 1}`, usageRate: 10 }));
    assert.equal(formatRanked(rows)?.split('\n').length, 4);
  });

  it('teammate=trueのときは使用率を出さず「使用率非公開」にする', () => {
    assert.equal(formatRanked([{ rank: 1, name: 'ガブリアス', usageRate: 40 }], true), '1. ガブリアス — 使用率非公開');
  });

  it('usageRateがnullなら「使用率非公開」にする', () => {
    assert.equal(formatRanked([{ rank: 1, name: 'ガブリアス', usageRate: null }]), '1. ガブリアス — 使用率非公開');
  });

  it('データが無ければ「データなし」を返す', () => {
    assert.equal(formatRanked(undefined), 'データなし');
    assert.equal(formatRanked([]), 'データなし');
  });
});

describe('formatEvRanked', () => {
  it('努力値配分をH/A/B/C/D/Sの表記でまとめる', () => {
    const rows = [{ rank: 1, usageRate: 60, values: { hp: 252, attack: 252, defense: 0, specialAttack: 0, specialDefense: 0, speed: 4 } }];
    assert.equal(formatEvRanked(rows), '1. H252/A252/B0/C0/D0/S4 — 60%');
  });

  it('データが無ければ「データなし」を返す', () => {
    assert.equal(formatEvRanked(undefined), 'データなし');
  });
});
