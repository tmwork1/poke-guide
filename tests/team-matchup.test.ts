// 相性チェック(src/lib/team-matchup.ts、ユーザー要望 2026-08-02)の純粋ロジックのテスト。
//
// ダメージ計算そのもの(jpoke)ではなく、「相手の技構成をどう決めるか」「割合をどう平均するか」
// 「平均値をどうアイコンの濃さに写すか」という、このアプリ側の判断だけを対象にする。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCHUP_MIN_OPACITY,
  MATCHUP_SCORE_MIN_RANGE,
  OPPONENT_EVS,
  OPPONENT_MIN_MOVE_RATIO,
  averageRatio,
  damageRatio,
  matchupOpacity,
  matchupDisadvantageScore,
  pickOpponentAttackMoves,
  pickTeamAttackMoves,
  scoreToOpacities,
} from '../src/lib/team-matchup.ts';

// 実データ(migrations/014 の suggestions.kind='popular_move')に近い形の入力。
// ガブリアスの実測値(じしん0.932 / ステルスロック0.473 / げきりん0.402 /
// スケイルショット0.344 / つるぎのまい0.295 / ドラゴンテール0.222 / がんせきふうじ0.212)。
const GARCHOMP_MOVES = [
  { value: 'じしん', ratio: 0.932 },
  { value: 'ステルスロック', ratio: 0.473 },
  { value: 'げきりん', ratio: 0.402 },
  { value: 'スケイルショット', ratio: 0.344 },
  { value: 'つるぎのまい', ratio: 0.295 },
  { value: 'ドラゴンテール', ratio: 0.222 },
  { value: 'がんせきふうじ', ratio: 0.212 },
];

const STATUS_MOVES = new Set(['ステルスロック', 'つるぎのまい', 'まもる', 'みがわり', 'こうそくいどう']);
const isAttackMove = (name: string) => !STATUS_MOVES.has(name);

describe('OPPONENT_EVS', () => {
  it('ユーザー指示どおりHのみ32振り(チャンピオンズ形式)', () => {
    assert.deepEqual([...OPPONENT_EVS], [32, 0, 0, 0, 0, 0]);
  });
});

describe('pickOpponentAttackMoves', () => {
  it('変化技を除き、採用率20%以上の技を高い順にすべて選ぶ', () => {
    const selected = pickOpponentAttackMoves(GARCHOMP_MOVES, isAttackMove);
    assert.equal(selected.length, 5);
    assert.deepEqual(selected.slice(0, 4), [
      'じしん',
      'げきりん',
      'スケイルショット',
      'ドラゴンテール',
    ]);
  });

  it('入力が採用率順に並んでいなくても結果は変わらない', () => {
    const shuffled = [...GARCHOMP_MOVES].reverse();
    assert.deepEqual(
      pickOpponentAttackMoves(shuffled, isAttackMove),
      pickOpponentAttackMoves(GARCHOMP_MOVES, isAttackMove),
    );
  });

  it('攻撃技が4本に満たなければあるだけ返す', () => {
    const few = [
      { value: 'じしん', ratio: 0.9 },
      { value: 'まもる', ratio: 0.8 },
      { value: 'みがわり', ratio: 0.7 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(few, isAttackMove), ['じしん']);
  });

  it('攻撃技が1本も無ければ空(呼び出し側が「データなし」として扱う)', () => {
    const statusOnly = [
      { value: 'まもる', ratio: 0.9 },
      { value: 'つるぎのまい', ratio: 0.5 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(statusOnly, isAttackMove), []);
  });

  it('同じ技が重複して届いても枠を二重に食わない', () => {
    const dup = [
      { value: 'じしん', ratio: 0.9 },
      { value: 'じしん', ratio: 0.8 },
      { value: 'げきりん', ratio: 0.7 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(dup, isAttackMove), ['じしん', 'げきりん']);
  });

  it('4枠では打ち切らない', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: `技${i}`, ratio: 1 - i * 0.05 }));
    assert.equal(pickOpponentAttackMoves(many, () => true).length, 10);
    assert.equal(OPPONENT_MIN_MOVE_RATIO, 0.2);
  });

  it('採用率20%未満の攻撃技は選ばない', () => {
    const moves = [
      { value: 'high', ratio: 0.2 },
      { value: 'low', ratio: 0.199 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(moves, () => true), ['high']);
  });
});

describe('pickTeamAttackMoves', () => {
  it('変化技・空文字・重複を落として攻撃技だけ返す', () => {
    const moves = ['じしん', 'つるぎのまい', '', 'げきりん', 'じしん', null, undefined];
    assert.deepEqual(pickTeamAttackMoves(moves, isAttackMove), ['じしん', 'げきりん']);
  });

  it('攻撃技を1本も持たない個体は空(平均には0として効く)', () => {
    assert.deepEqual(pickTeamAttackMoves(['まもる', 'みがわり'], isAttackMove), []);
  });

  it('前後の空白は取り除いてから判定する', () => {
    assert.deepEqual(pickTeamAttackMoves(['  じしん  '], isAttackMove), ['じしん']);
  });
});

describe('damageRatio', () => {
  it('ダメージ÷最大HP', () => {
    assert.equal(damageRatio(90, 180), 0.5);
  });

  it('確1(HPを超えるダメージ)は1で頭打ち', () => {
    assert.equal(damageRatio(400, 180), 1);
  });

  it('HPが0以下・非数のときは0(データ欠損を有利側に数えない)', () => {
    assert.equal(damageRatio(90, 0), 0);
    assert.equal(damageRatio(90, Number.NaN), 0);
    assert.equal(damageRatio(Number.NaN, 180), 0);
  });

  it('ダメージ0(何も通らない)は0', () => {
    assert.equal(damageRatio(0, 180), 0);
  });
});

describe('averageRatio', () => {
  it('単純平均', () => {
    assert.equal(averageRatio([0.2, 0.4, 0.6]), 0.4000000000000001);
  });

  it('打点を持たないメンバーの0も母数に含める', () => {
    assert.equal(averageRatio([1, 0]), 0.5);
  });

  it('メンバーが0人なら null', () => {
    assert.equal(averageRatio([]), null);
  });
});

describe('matchupOpacity', () => {
  it('攻撃は「大きいほど不利=濃い」', () => {
    const low = matchupOpacity(0.2, 0.2, 0.8, 'attack');
    const high = matchupOpacity(0.8, 0.2, 0.8, 'attack');
    assert.equal(low, MATCHUP_MIN_OPACITY);
    assert.equal(high, 1);
  });

  it('防御も「大きいほど不利=濃い」', () => {
    const low = matchupOpacity(0.2, 0.2, 0.8, 'defense');
    const high = matchupOpacity(0.8, 0.2, 0.8, 'defense');
    assert.equal(low, MATCHUP_MIN_OPACITY);
    assert.equal(high, 1);
  });

  it('必ず MATCHUP_MIN_OPACITY 〜 1 に収まる', () => {
    for (const score of [-1, 0, 0.33, 1, 2]) {
      for (const direction of ['attack', 'defense'] as const) {
        const value = matchupOpacity(score, 0, 1, direction);
        assert.ok(value >= MATCHUP_MIN_OPACITY && value <= 1, `${direction} ${score} -> ${value}`);
      }
    }
  });

  it('実レンジが MATCHUP_SCORE_MIN_RANGE より狭いときはコントラストも弱まる(誤差を拡大しない)', () => {
    // 差が0.05しか無い2体。min-max正規化なら最大コントラストになってしまうところを、
    // 0.05/0.25 = 20% ぶんの濃淡差に抑える。
    const min = 0.4;
    const max = 0.45;
    const opacityAtMax = matchupOpacity(max, min, max, 'defense');
    const expected = MATCHUP_MIN_OPACITY + (1 - MATCHUP_MIN_OPACITY) * (0.05 / MATCHUP_SCORE_MIN_RANGE);
    assert.ok(Math.abs(opacityAtMax - expected) < 1e-9, `${opacityAtMax} != ${expected}`);
    assert.ok(opacityAtMax < 1, '狭いレンジで最大コントラストまで振り切らない');
  });

  it('全員同じ値なら濃淡は付かない', () => {
    assert.equal(matchupOpacity(0.5, 0.5, 0.5, 'attack'), MATCHUP_MIN_OPACITY);
    assert.equal(matchupOpacity(0.5, 0.5, 0.5, 'defense'), MATCHUP_MIN_OPACITY);
  });
});

describe('matchupDisadvantageScore', () => {
  it('攻撃側だけ向きを反転し、防御側と同じ「高い=不利」へ揃える', () => {
    assert.equal(matchupDisadvantageScore(0.2, 'attack'), 0.8);
    assert.equal(matchupDisadvantageScore(0.2, 'defense'), 0.2);
  });
});

describe('scoreToOpacities', () => {
  it('計算できなかった相手(score=null)は min/max の母数から外し、opacity も null にする', () => {
    const result = scoreToOpacities(
      [
        { item: 'A', score: 0.2 },
        { item: 'B', score: null },
        { item: 'C', score: 0.8 },
      ],
      'attack',
    );
    assert.equal(result[1].opacity, null);
    // A(最小)と C(最大)だけで正規化されている = B が居ても居なくても同じ結果になる。
    assert.equal(result[0].opacity, matchupOpacity(0.2, 0.2, 0.8, 'attack'));
    assert.equal(result[2].opacity, matchupOpacity(0.8, 0.2, 0.8, 'attack'));
  });

  it('全員が計算不能なら全部 null(min/maxが作れない)', () => {
    const result = scoreToOpacities([{ item: 'A', score: null }], 'defense');
    assert.deepEqual(
      result.map((r) => r.opacity),
      [null],
    );
  });

  it('元の並び順を保つ(使用率順のまま表示するため)', () => {
    const result = scoreToOpacities(
      [
        { item: 'A', score: 0.9 },
        { item: 'B', score: 0.1 },
      ],
      'attack',
    );
    assert.deepEqual(
      result.map((r) => r.item),
      ['A', 'B'],
    );
  });
});
