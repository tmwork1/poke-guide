// 相性チェック(src/lib/team-matchup.ts、ユーザー要望 2026-08-02)の純粋ロジックのテスト。
//
// ダメージ計算そのもの(jpoke)ではなく、「相手の技構成をどう決めるか」「割合をどう集計するか」
// 「スコアをどうアイコンの濃さに写すか」という、このアプリ側の判断だけを対象にする。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCHUP_MIN_OPACITY,
  MATCHUP_SCORE_MIN_RANGE,
  MATCHUP_FORM_MIN_RATE,
  OPPONENT_EVS,
  OPPONENT_MIN_MOVE_RATIO,
  MEMBER_DAMAGE_THRESHOLD,
  damageRatio,
  heavyDamageShare,
  isHeavyDamage,
  opponentEvsFromOpgg,
  expandMatchupTargetForms,
  extendMatchupScores,
  matchupOpacity,
  matchupDisadvantageScore,
  pickOpponentAttackMoves,
  pickTeamAttackMoves,
  scoreToOpacities,
} from '../src/lib/team-matchup.ts';

describe('expandMatchupTargetForms', () => {
  const base = { speciesName: 'リザードン', dexNo: 6 };
  const megas = [
    { speciesName: 'メガリザードンX', dexNo: 6, megaStoneName: 'リザードナイトX' },
    { speciesName: 'メガリザードンY', dexNo: 6, megaStoneName: 'リザードナイトY' },
  ];

  it('X 70% / Y 15%なら通常を隠し、Xだけを返す', () => {
    assert.deepEqual(
      expandMatchupTargetForms(base, megas, [
        { name: 'リザードナイトX', usageRate: 70 },
        { name: 'リザードナイトY', usageRate: 15 },
      ]),
      [{ speciesName: 'メガリザードンX', dexNo: 6, isMega: true }],
    );
  });

  it('X 50% / Y 40%なら通常を隠し、両メガを返す', () => {
    assert.deepEqual(
      expandMatchupTargetForms(base, megas, [
        { name: 'リザードナイトX', usageRate: 50 },
        { name: 'リザードナイトY', usageRate: 40 },
      ]),
      [
        { speciesName: 'メガリザードンX', dexNo: 6, isMega: true },
        { speciesName: 'メガリザードンY', dexNo: 6, isMega: true },
      ],
    );
  });

  it('X 30%なら通常の直後にXを返す', () => {
    assert.deepEqual(
      expandMatchupTargetForms(base, megas, [{ name: 'リザードナイトX', usageRate: 30 }]),
      [base, { speciesName: 'メガリザードンX', dexNo: 6, isMega: true }],
    );
  });

  it('所持率データなしは0%扱いにして通常フォルムだけを返す', () => {
    assert.deepEqual(expandMatchupTargetForms(base, megas, null), [base]);
    assert.equal(MATCHUP_FORM_MIN_RATE, 20);
  });
});

describe('extendMatchupScores', () => {
  it('既計算のスコアを添字ごと残し、増えたぶんだけ未計算の枠を足す', () => {
    const scores = [0.2, null, 0.8];
    const extended = extendMatchupScores(scores, 6);

    assert.deepEqual(extended, [0.2, null, 0.8, undefined, undefined, undefined]);
    assert.equal(extended[1], null);
  });

  it('すでに件数が足りていれば既存の配列をそのまま返す', () => {
    const scores = [0.2, null, 0.8];
    assert.equal(extendMatchupScores(scores, 2), scores);
  });
});

// 実データ(migrations/014 の suggestions.kind='popular_move')に近い形の入力。
// ガブリアスの実測値(採用率はOP.GGと同じパーセント表記。じしん93.2 / ステルスロック47.3 /
// げきりん40.2 / スケイルショット34.4 / つるぎのまい29.5 / ドラゴンテール22.2 / がんせきふうじ21.2)。
const GARCHOMP_MOVES = [
  { value: 'じしん', ratio: 93.2 },
  { value: 'ステルスロック', ratio: 47.3 },
  { value: 'げきりん', ratio: 40.2 },
  { value: 'スケイルショット', ratio: 34.4 },
  { value: 'つるぎのまい', ratio: 29.5 },
  { value: 'ドラゴンテール', ratio: 22.2 },
  { value: 'がんせきふうじ', ratio: 21.2 },
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
      { value: 'じしん', ratio: 90 },
      { value: 'まもる', ratio: 80 },
      { value: 'みがわり', ratio: 70 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(few, isAttackMove), ['じしん']);
  });

  it('攻撃技が1本も無ければ空(呼び出し側が「データなし」として扱う)', () => {
    const statusOnly = [
      { value: 'まもる', ratio: 90 },
      { value: 'つるぎのまい', ratio: 50 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(statusOnly, isAttackMove), []);
  });

  it('同じ技が重複して届いても枠を二重に食わない', () => {
    const dup = [
      { value: 'じしん', ratio: 90 },
      { value: 'じしん', ratio: 80 },
      { value: 'げきりん', ratio: 70 },
    ];
    assert.deepEqual(pickOpponentAttackMoves(dup, isAttackMove), ['じしん', 'げきりん']);
  });

  it('4枠では打ち切らない', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: `技${i}`, ratio: 100 - i * 5 }));
    assert.equal(pickOpponentAttackMoves(many, () => true).length, 10);
    assert.equal(OPPONENT_MIN_MOVE_RATIO, 20);
  });

  it('採用率20%未満の攻撃技は選ばない', () => {
    const moves = [
      { value: 'high', ratio: 20 },
      { value: 'low', ratio: 19.9 },
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

describe('isHeavyDamage', () => {
  it('しきい値は0.5で、超えたときだけ真(ちょうど0.5は偽)', () => {
    assert.equal(MEMBER_DAMAGE_THRESHOLD, 0.5);
    assert.equal(isHeavyDamage(0.51), true);
    assert.equal(isHeavyDamage(0.5), false);
    assert.equal(isHeavyDamage(0), false);
  });
});

describe('heavyDamageShare', () => {
  it('しきい値を超えたメンバーの人数の割合', () => {
    assert.equal(heavyDamageShare([0.9, 0.6, 0.4, 0.1]), 0.5);
  });

  it('平均と違い、1体の過剰火力では上がらない', () => {
    assert.equal(heavyDamageShare([1, 0.1, 0.1, 0.1]), 0.25);
  });

  it('打点を持たないメンバーの0も母数に含める', () => {
    assert.equal(heavyDamageShare([1, 0]), 0.5);
  });

  it('メンバーが0人なら null', () => {
    assert.equal(heavyDamageShare([]), null);
  });
});

describe('opponentEvsFromOpgg', () => {
  it('OP.GGのキー順を[H,A,B,C,D,S]へ並べ替える', () => {
    assert.deepEqual(
      opponentEvsFromOpgg({ hp: 1, attack: 32, defense: 1, specialAttack: 0, specialDefense: 0, speed: 32 }),
      [1, 32, 1, 0, 0, 32],
    );
  });

  it('欠けたキーは0、範囲外は0〜32に丸める', () => {
    assert.deepEqual(opponentEvsFromOpgg({ attack: 40, speed: -3 }), [0, 32, 0, 0, 0, 0]);
  });

  it('努力値データが無ければ null(既定値へ退避させる)', () => {
    assert.equal(opponentEvsFromOpgg(null), null);
    assert.equal(opponentEvsFromOpgg({}), null);
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
