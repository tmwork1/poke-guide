// src/lib/speed-chart-validation.ts(`?reg=`/`?owned=` の検証・適用ペイロードの検証)の回帰テスト。
// tests/owned-pokemon-validation.test.ts が手本。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOwnedQueryParam,
  resolveSpeedChartRegulation,
  validateRegulationQueryParam,
  validateSpeedChartApplyPayload,
} from '../src/lib/speed-chart-validation.ts';

describe('parseOwnedQueryParam', () => {
  it('正しいUUID形式はそのまま返す', () => {
    assert.equal(
      parseOwnedQueryParam('123e4567-e89b-12d3-a456-426614174000'),
      '123e4567-e89b-12d3-a456-426614174000',
    );
  });

  it('大文字混じりのUUIDも受け入れる', () => {
    assert.equal(
      parseOwnedQueryParam('123E4567-E89B-12D3-A456-426614174000'),
      '123E4567-E89B-12D3-A456-426614174000',
    );
  });

  it('UUID形式でない文字列はnullを返す(強制リダイレクトしない設計。呼び出し側が右カラム非表示に使う)', () => {
    assert.equal(parseOwnedQueryParam('not-a-uuid'), null);
    assert.equal(parseOwnedQueryParam('123'), null);
  });

  it('null/undefined/空文字はnullを返す', () => {
    assert.equal(parseOwnedQueryParam(null), null);
    assert.equal(parseOwnedQueryParam(undefined), null);
    assert.equal(parseOwnedQueryParam(''), null);
    assert.equal(parseOwnedQueryParam('   '), null);
  });
});

describe('validateRegulationQueryParam', () => {
  const known = ['M-A', 'M-B'];

  it('既知のレギュレーション名はそのまま返す', () => {
    assert.equal(validateRegulationQueryParam('M-A', known), 'M-A');
    assert.equal(validateRegulationQueryParam('M-B', known), 'M-B');
  });

  it('未知の値・空文字・nullはnullに正規化する', () => {
    assert.equal(validateRegulationQueryParam('M-Z', known), null);
    assert.equal(validateRegulationQueryParam('', known), null);
    assert.equal(validateRegulationQueryParam(null, known), null);
    assert.equal(validateRegulationQueryParam(undefined, known), null);
  });
});

describe('resolveSpeedChartRegulation(P1確定仕様: ?reg= → 連携個体のregulation → REGULATIONSの末尾)', () => {
  const known = ['M-A', 'M-B'];

  it('?reg=が有効ならそれを最優先する(連携個体のregulationより優先)', () => {
    assert.equal(resolveSpeedChartRegulation('M-A', 'M-B', known), 'M-A');
  });

  it('?reg=が無い/無効なら連携個体のregulationを使う', () => {
    assert.equal(resolveSpeedChartRegulation(null, 'M-A', known), 'M-A');
    assert.equal(resolveSpeedChartRegulation('M-Z', 'M-A', known), 'M-A');
  });

  it('?reg=も連携個体のregulationも無ければ、REGULATIONSの末尾(最新)を使う', () => {
    assert.equal(resolveSpeedChartRegulation(null, null, known), 'M-B');
  });

  it('レギュレーション未指定は許さない: knownRegulationsが非空なら必ず何らかの文字列を返す', () => {
    const resolved = resolveSpeedChartRegulation(undefined, undefined, known);
    assert.notEqual(resolved, null);
  });

  it('knownRegulationsが空(異常系)のときのみnullを返す', () => {
    assert.equal(resolveSpeedChartRegulation(null, null, []), null);
  });
});

describe('validateSpeedChartApplyPayload', () => {
  it('正しい形のペイロードを受け入れる', () => {
    const result = validateSpeedChartApplyPayload({ nature: 'ようき', evSpe: 32, itemName: 'こだわりスカーフ' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.nature, 'ようき');
      assert.equal(result.value.evSpe, 32);
      assert.equal(result.value.itemName, 'こだわりスカーフ');
    }
  });

  it('itemNameがnullでも受け入れる(持ち物なし)', () => {
    const result = validateSpeedChartApplyPayload({ nature: 'ようき', evSpe: 0, itemName: null });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.itemName, null);
    }
  });

  it('natureが空文字/非文字列なら拒否する', () => {
    assert.equal(validateSpeedChartApplyPayload({ nature: '', evSpe: 0, itemName: null }).ok, false);
    assert.equal(validateSpeedChartApplyPayload({ nature: '   ', evSpe: 0, itemName: null }).ok, false);
    assert.equal(validateSpeedChartApplyPayload({ nature: 123, evSpe: 0, itemName: null }).ok, false);
  });

  it('evSpeが範囲(0〜32)を超える場合は拒否する', () => {
    assert.equal(validateSpeedChartApplyPayload({ nature: 'ようき', evSpe: -1, itemName: null }).ok, false);
    assert.equal(validateSpeedChartApplyPayload({ nature: 'ようき', evSpe: 33, itemName: null }).ok, false);
  });

  it('evSpeが整数でない場合は拒否する', () => {
    assert.equal(validateSpeedChartApplyPayload({ nature: 'ようき', evSpe: 4.5, itemName: null }).ok, false);
  });

  it('itemNameが文字列でもnullでもない場合は拒否する', () => {
    assert.equal(validateSpeedChartApplyPayload({ nature: 'ようき', evSpe: 0, itemName: 123 }).ok, false);
  });

  it('bodyがオブジェクトでない場合は拒否する', () => {
    assert.equal(validateSpeedChartApplyPayload(null).ok, false);
    assert.equal(validateSpeedChartApplyPayload([1, 2, 3]).ok, false);
    assert.equal(validateSpeedChartApplyPayload('string').ok, false);
  });
});
