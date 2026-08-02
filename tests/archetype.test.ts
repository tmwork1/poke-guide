// src/lib/archetype.ts (型分類ロジック) の単体テスト。
// 期待値は public/master-data/detail/pokemon.json の実データ(種族値)を
// src/lib/stats.ts と同じ計算式で手計算した実数値に基づく(tests/stats.test.ts と同じ方針)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyArchetype, ATTACKER_THRESHOLD_MULTIPLIER } from '../src/lib/archetype.ts';

const ALL_31_IVS = [31, 31, 31, 31, 31, 31];
const NO_EVS = [0, 0, 0, 0, 0, 0];

describe('classifyArchetype: 分類不能な入力', () => {
  it('種族名が空/nullなら null', () => {
    assert.equal(
      classifyArchetype({
        speciesName: '',
        abilityName: 'こんじょう',
        itemName: 'いのちのたま',
        nature: null,
        evs: NO_EVS,
        ivs: ALL_31_IVS,
        moveNames: [],
      }),
      null,
    );
  });

  it('特性名/持ち物名が空/nullなら null', () => {
    assert.equal(
      classifyArchetype({
        speciesName: 'カイリキー',
        abilityName: null,
        itemName: 'いのちのたま',
        nature: null,
        evs: NO_EVS,
        ivs: ALL_31_IVS,
        moveNames: [],
      }),
      null,
    );
    assert.equal(
      classifyArchetype({
        speciesName: 'カイリキー',
        abilityName: 'こんじょう',
        itemName: null,
        nature: null,
        evs: NO_EVS,
        ivs: ALL_31_IVS,
        moveNames: [],
      }),
      null,
    );
  });

  it('マスターデータに存在しない種族名なら null', () => {
    assert.equal(
      classifyArchetype({
        speciesName: '存在しないポケモン',
        abilityName: 'こんじょう',
        itemName: 'いのちのたま',
        nature: null,
        evs: NO_EVS,
        ivs: ALL_31_IVS,
        moveNames: [],
      }),
      null,
    );
  });

  it('evs/ivsが6要素でないなら null', () => {
    assert.equal(
      classifyArchetype({
        speciesName: 'カイリキー',
        abilityName: 'こんじょう',
        itemName: 'いのちのたま',
        nature: null,
        evs: [0, 32],
        ivs: ALL_31_IVS,
        moveNames: [],
      }),
      null,
    );
  });
});

describe('classifyArchetype: 実データによる3分類', () => {
  it('物理アタッカー(カイリキー、攻撃全振り+いじっぱり)', () => {
    // baseStats [90,130,80,65,85,55] → hp165, atk200, def100, spa76, spd105
    // bulkAvg(hp,def,spd)=123.33、閾値141.83に対しatk200が上回る
    const result = classifyArchetype({
      speciesName: 'カイリキー',
      abilityName: 'こんじょう',
      itemName: 'こだわりハチマキ',
      nature: 'いじっぱり',
      evs: [0, 32, 0, 0, 0, 0],
      ivs: ALL_31_IVS,
      moveNames: [],
    });
    assert.deepEqual(result, {
      speciesName: 'カイリキー',
      abilityName: 'こんじょう',
      itemName: 'こだわりハチマキ',
      role: 'physical_attacker',
    });
  });

  it('特殊アタッカー(フーディン、特攻全振り+ひかえめ)', () => {
    // baseStats [55,50,45,135,95,120] → hp130, atk63, def65, spa205, spd115
    // bulkAvg=103.33、閾値118.83に対しspa205が上回る
    const result = classifyArchetype({
      speciesName: 'フーディン',
      abilityName: 'シンクロ',
      itemName: 'いのちのたま',
      nature: 'ひかえめ',
      evs: [0, 0, 0, 32, 0, 0],
      ivs: ALL_31_IVS,
      moveNames: [],
    });
    assert.deepEqual(result, {
      speciesName: 'フーディン',
      abilityName: 'シンクロ',
      itemName: 'いのちのたま',
      role: 'special_attacker',
    });
  });

  it('耐久(ハピナス、HP/防御/特防に努力値配分)', () => {
    // baseStats [255,10,10,75,135,55] → hp362, atk30, def46, spa95, spd171
    // bulkAvg=193、閾値221.95に対しatk/spaいずれも下回る
    const result = classifyArchetype({
      speciesName: 'ハピナス',
      abilityName: 'しぜんかいふく',
      itemName: 'しんかのきせき',
      nature: 'まじめ',
      evs: [32, 0, 16, 0, 16, 0],
      ivs: ALL_31_IVS,
      moveNames: [],
    });
    assert.deepEqual(result, {
      speciesName: 'ハピナス',
      abilityName: 'しぜんかいふく',
      itemName: 'しんかのきせき',
      role: 'bulky',
    });
  });
});

describe('classifyArchetype: 物理/特殊軸の判定(技構成 vs 実数値)', () => {
  // ハブネーク baseStats [73,100,60,100,60,65]: 攻撃・特攻の種族値が同値(100)。
  // EV32/32・まじめ(補正なし)で実数値も atk=spa=152 の完全な同値になり、
  // 「技構成が無ければ実数値比較(同値は物理優先)」「技構成があればそちらを優先」を
  // 明確に切り分けて検証できる。
  const baseInput = {
    speciesName: 'ハブネーク',
    abilityName: 'ふゆう',
    itemName: 'たべのこし',
    nature: 'まじめ',
    evs: [0, 32, 0, 32, 0, 0],
    ivs: ALL_31_IVS,
  };

  it('技情報が無い(同数)場合は実数値の同値を物理優先でフォールバックする', () => {
    const result = classifyArchetype({ ...baseInput, moveNames: [] });
    assert.equal(result?.role, 'physical_attacker');
  });

  it('物理技より特殊技が多ければ、実数値が同値でも特殊軸を優先する', () => {
    // あくのはどう・ヘドロばくだん=special、どくづき=physical(2対1で特殊が優勢)
    const result = classifyArchetype({
      ...baseInput,
      moveNames: ['あくのはどう', 'ヘドロばくだん', 'どくづき'],
    });
    assert.equal(result?.role, 'special_attacker');
  });

  it('特殊技より物理技が多ければ物理軸を優先する', () => {
    // どくづき・かみくだく=physical、あくのはどう=special(2対1で物理が優勢)
    const result = classifyArchetype({
      ...baseInput,
      moveNames: ['どくづき', 'かみくだく', 'あくのはどう'],
    });
    assert.equal(result?.role, 'physical_attacker');
  });
});

describe('ATTACKER_THRESHOLD_MULTIPLIER', () => {
  it('経験則の初期値1.15としてエクスポートされている', () => {
    assert.equal(ATTACKER_THRESHOLD_MULTIPLIER, 1.15);
  });
});
