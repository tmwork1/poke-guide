// 実数値計算(src/lib/stats.ts)の回帰テスト。
// ラウンド18: /box, /box/[id], /share/[slug], /pokemon/[name] の4画面にコピーされていた
// 計算関数をこのファイルに統合した際、統合前後で表示される実数値が一切変わらないことを
// 担保するために追加した。期待値の根拠は以下の2種類:
//   1. vendor/jpoke の計算式そのもの(.claude/skills/jpoke/references/ruleset.md
//      「2. 実数値の計算式」出典つき)を手計算した値。
//   2. 実データ(メガリザードンX個体・リザードン種族)に対して、統合前のコピー実装で
//      実際にPlaywrightで実測して確認済みの値(/box, /box/[id], /share, /pokemon/リザードン で
//      153/200/131/135/105/136、153/185、104/136が一致することを確認した上での回帰)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAT_KEYS,
  NATURE_STAT_MODIFIERS,
  chmpToLegacyEffort,
  calcHpStat,
  calcOtherStat,
  calcHpStatAtLv50Iv31,
  calcOtherStatAtLv50Iv31,
} from '../src/lib/stats.ts';

describe('chmpToLegacyEffort', () => {
  it('n=0のときだけ特例で0を返す(8n-4だと-4になってしまうため)', () => {
    assert.equal(chmpToLegacyEffort(0), 0);
  });

  it('n=1〜32は8n-4で素の努力値に変換する', () => {
    assert.equal(chmpToLegacyEffort(1), 4);
    assert.equal(chmpToLegacyEffort(2), 12);
    assert.equal(chmpToLegacyEffort(3), 20);
    assert.equal(chmpToLegacyEffort(16), 124);
    assert.equal(chmpToLegacyEffort(31), 244);
    assert.equal(chmpToLegacyEffort(32), 252);
  });
});

describe('calcHpStat: ヌケニン特例', () => {
  it('種族値HP=1は個体値・努力値・レベルによらず常に1を返す', () => {
    assert.equal(calcHpStat(50, 1, 31, 0), 1);
    assert.equal(calcHpStat(50, 1, 31, 32), 1);
    assert.equal(calcHpStat(50, 1, 0, 0), 1);
    assert.equal(calcHpStat(100, 1, 31, 32), 1);
  });

  it('種族値HPが1以外なら通常の式で計算する', () => {
    // base=78, iv=31, ev=0, level=50 → floor((78*2+31+0)*50/100)+50+10 = 153
    assert.equal(calcHpStat(50, 78, 31, 0), 153);
  });
});

describe('calcOtherStat: 性格補正', () => {
  // base=100, iv=31, ev=0, level=50 → floor((100*2+31+0)*50/100)+5 = floor(115.5)+5 = 115+5 = 120
  const BASE_VALUE = 120;

  it('上昇補正(1.1倍)', () => {
    assert.equal(calcOtherStat(50, 100, 31, 0, 1.1), Math.floor(BASE_VALUE * 1.1));
    assert.equal(calcOtherStat(50, 100, 31, 0, 1.1), 132);
  });

  it('下降補正(0.9倍)', () => {
    assert.equal(calcOtherStat(50, 100, 31, 0, 0.9), Math.floor(BASE_VALUE * 0.9));
    assert.equal(calcOtherStat(50, 100, 31, 0, 0.9), 108);
  });

  it('補正なし(1.0倍)', () => {
    assert.equal(calcOtherStat(50, 100, 31, 0, 1.0), BASE_VALUE);
  });
});

describe('NATURE_STAT_MODIFIERS', () => {
  it('25種の性格すべてが定義されている', () => {
    assert.equal(Object.keys(NATURE_STAT_MODIFIERS).length, 25);
  });

  it('補正なし性格(まじめ・てれや・がんばりや・すなお・きまぐれ)はup/downともにnull', () => {
    for (const name of ['まじめ', 'てれや', 'がんばりや', 'すなお', 'きまぐれ']) {
      assert.deepEqual(NATURE_STAT_MODIFIERS[name], { up: null, down: null });
    }
  });

  it('いじっぱりは攻撃↑特攻↓(実データの個体で使用している性格)', () => {
    assert.deepEqual(NATURE_STAT_MODIFIERS['いじっぱり'], { up: 'atk', down: 'spa' });
  });

  it('STAT_KEYSはHPを先頭にした6要素(evs/ivs配列の並びと一致)', () => {
    assert.deepEqual(STAT_KEYS, ['hp', 'atk', 'def', 'spa', 'spd', 'spe']);
  });
});

describe('実際の個体の実数値(回帰テスト): メガリザードンX', () => {
  // /box, /box/[id], /share/[slug] で実測して一致を確認済みの値(既知の正解)。
  // 性格: いじっぱり(攻撃↑特攻↓)、種族値: [78,130,111,130,85,100]、
  // 個体値: 全て31、努力値(Champions形式): [0,32,0,0,0,16]、レベル50。
  const LEVEL = 50;
  const BASE = [78, 130, 111, 130, 85, 100];
  const IVS = [31, 31, 31, 31, 31, 31];
  const EVS = [0, 32, 0, 0, 0, 16];
  const NATURE = NATURE_STAT_MODIFIERS['いじっぱり'];
  const EXPECTED = [153, 200, 131, 135, 105, 136];

  it('H/A/B/C/D/Sの実数値が既知の正解(153/200/131/135/105/136)と完全一致する', () => {
    const actual = STAT_KEYS.map((key, i) => {
      if (key === 'hp') return calcHpStat(LEVEL, BASE[i], IVS[i], EVS[i]);
      const nc = NATURE.up === key ? 1.1 : NATURE.down === key ? 0.9 : 1.0;
      return calcOtherStat(LEVEL, BASE[i], IVS[i], EVS[i], nc);
    });
    assert.deepEqual(actual, EXPECTED);
  });
});

describe('calcHpStatAtLv50Iv31 / calcOtherStatAtLv50Iv31 (/pokemon/[name] 用ラッパー): リザードン', () => {
  // /pokemon/リザードン で実測して一致を確認済みの値(既知の正解)。
  // 種族値: [78,84,78,109,85,100](HP, 攻撃, 防御, 特攻, 特防, 素早さ)。
  const HP_BASE = 78;
  const ATK_BASE = 84;

  it('HP: 無振(EV0)=153, 全振(EV32)=185', () => {
    assert.equal(calcHpStatAtLv50Iv31(HP_BASE, 0), 153);
    assert.equal(calcHpStatAtLv50Iv31(HP_BASE, 32), 185);
  });

  it('攻撃: 無振(EV0)=104, 全振(EV32)=136', () => {
    assert.equal(calcOtherStatAtLv50Iv31(ATK_BASE, 0), 104);
    assert.equal(calcOtherStatAtLv50Iv31(ATK_BASE, 32), 136);
  });

  it('Lv50・IV31固定・性格補正なし(nc=1.0)で計算した結果と一致する(ラッパーの委譲先を直接確認)', () => {
    assert.equal(calcHpStatAtLv50Iv31(HP_BASE, 0), calcHpStat(50, HP_BASE, 31, 0));
    assert.equal(calcOtherStatAtLv50Iv31(ATK_BASE, 0), calcOtherStat(50, ATK_BASE, 31, 0, 1.0));
  });

  it('ヌケニン特例はこのラッパー経由でも効く(種族値HP=1は常に1)', () => {
    assert.equal(calcHpStatAtLv50Iv31(1, 0), 1);
    assert.equal(calcHpStatAtLv50Iv31(1, 32), 1);
  });
});
