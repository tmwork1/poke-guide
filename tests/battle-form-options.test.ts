// getBattleFormOptions()(自分のポケモンが対戦中に切り替わるフォルムの候補算出)の回帰テスト。
// メガシンカ・ギルガルドのシールド/ブレードのような単純な相互切替・ザシアン/ザマゼンタの
// 「Crowned」(対応アイテム所持時のみ)・候補なし(disabled相当)のケースを確認する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getBattleFormOptions, isBattleSwitchableForm } from '../src/lib/box-id/battle-form-options.ts';
import type { PokemonMasterEntry } from '../src/lib/pokemon-master-data.ts';

function entry(name: string, dexNo: number, forme: string | null, types: string[] = []): PokemonMasterEntry {
  return { name, dexNo, imageId: dexNo, forme, types };
}

const MASTER: PokemonMasterEntry[] = [
  // メガシンカ(リザードン)
  entry('リザードン', 6, null, ['ほのお', 'ひこう']),
  entry('メガリザードンX', 6, 'Mega-X', ['ほのお', 'ドラゴン']),
  entry('メガリザードンY', 6, 'Mega-Y', ['ほのお', 'ひこう']),
  // ギルガルド(シールド/ブレード)
  entry('ギルガルド(シールド)', 681, null, ['はがね', 'ゴースト']),
  entry('ギルガルド(ブレード)', 681, 'Blade', ['はがね', 'ゴースト']),
  // ザシアン(れきせん/けんのおう)
  entry('ザシアン(れきせん)', 888, null, ['フェアリー']),
  entry('ザシアン(けんのおう)', 888, 'Crowned', ['フェアリー', 'はがね']),
  // 対戦中に切り替わらない別種族(比較用)
  entry('フシギダネ', 1, null, ['くさ', 'どく']),
];

const MEGA_STONE_BY_SPECIES = new Map([
  ['メガリザードンX', 'リザードナイトX'],
  ['メガリザードンY', 'リザードナイトY'],
]);

describe('getBattleFormOptions', () => {
  it('メガストーンを持っていない場合は候補に含めない', () => {
    const options = getBattleFormOptions('リザードン', 'こだわりハチマキ', MASTER, MEGA_STONE_BY_SPECIES);
    assert.deepEqual(options.map((o) => o.name), ['リザードン']);
  });

  it('対応するメガストーンを持っている場合はそのメガフォルムだけを候補に含める', () => {
    const options = getBattleFormOptions('リザードン', 'リザードナイトY', MASTER, MEGA_STONE_BY_SPECIES);
    assert.deepEqual(options.map((o) => o.name), ['リザードン', 'メガリザードンY']);
  });

  it('保存種族がメガシンカの場合は、メガシンカ前の基本フォルムを候補に含める', () => {
    const options = getBattleFormOptions('メガリザードンX', 'リザードナイトX', MASTER, MEGA_STONE_BY_SPECIES);
    assert.deepEqual(options.map((o) => o.name), ['メガリザードンX', 'リザードン']);
  });

  it('ギルガルドはシールド/ブレードを相互に候補として持つ', () => {
    const fromShield = getBattleFormOptions('ギルガルド(シールド)', '', MASTER, new Map());
    assert.deepEqual(fromShield.map((o) => o.name), ['ギルガルド(シールド)', 'ギルガルド(ブレード)']);

    const fromBlade = getBattleFormOptions('ギルガルド(ブレード)', '', MASTER, new Map());
    assert.deepEqual(fromBlade.map((o) => o.name), ['ギルガルド(ブレード)', 'ギルガルド(シールド)']);
  });

  it('ザシアンはくちたけんを持っている場合だけけんのおうの姿を候補に含める', () => {
    const withoutItem = getBattleFormOptions('ザシアン(れきせん)', 'きあいのタスキ', MASTER, new Map());
    assert.deepEqual(withoutItem.map((o) => o.name), ['ザシアン(れきせん)']);

    const withItem = getBattleFormOptions('ザシアン(れきせん)', 'くちたけん', MASTER, new Map());
    assert.deepEqual(withItem.map((o) => o.name), ['ザシアン(れきせん)', 'ザシアン(けんのおう)']);
  });

  it('保存種族自体がけんのおうの姿の場合は、アイテムに関わらずれきせんの姿へ戻す候補を含める', () => {
    const options = getBattleFormOptions('ザシアン(けんのおう)', 'きあいのタスキ', MASTER, new Map());
    assert.deepEqual(options.map((o) => o.name), ['ザシアン(けんのおう)', 'ザシアン(れきせん)']);
  });

  it('対戦中に切り替わるフォルムを持たない種族は自分自身だけを返す', () => {
    const options = getBattleFormOptions('フシギダネ', '', MASTER, new Map());
    assert.deepEqual(options.map((o) => o.name), ['フシギダネ']);
  });

  it('マスターデータに存在しない種族は空配列を返す', () => {
    const options = getBattleFormOptions('存在しないポケモン', '', MASTER, new Map());
    assert.deepEqual(options, []);
  });

  it('isBattleSwitchableForm はメガフォルム・BATTLE_FORMES登録フォルムをtrueにする', () => {
    assert.equal(isBattleSwitchableForm(entry('メガリザードンY', 6, 'Mega-Y')), true);
    assert.equal(isBattleSwitchableForm(entry('ギルガルド(ブレード)', 681, 'Blade')), true);
    assert.equal(isBattleSwitchableForm(entry('ザシアン(けんのおう)', 888, 'Crowned')), true);
    assert.equal(isBattleSwitchableForm(entry('リザードン', 6, null)), false);
  });
});
