import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TERA_TYPES,
  compareTypeListsByTeraOrder,
  compareTypesByTeraOrder,
} from '../src/lib/tera-types.ts';

describe('テラスタル選択順のタイプ比較', () => {
  it('五十音順ではなくテラスタル選択モーダルの順番で並べる', () => {
    const types = ['フェアリー', 'あく', 'ノーマル', 'ほのお', 'みず'];
    assert.deepEqual(types.sort(compareTypesByTeraOrder), ['ノーマル', 'ほのお', 'みず', 'あく', 'フェアリー']);
  });

  it('19タイプすべての基準順はTERA_TYPESと一致する', () => {
    assert.deepEqual([...TERA_TYPES].reverse().sort(compareTypesByTeraOrder), [...TERA_TYPES]);
  });

  it('複合タイプは第1タイプ、第2タイプの順で比較する', () => {
    const typeLists = [
      ['みず'],
      ['ノーマル', 'フェアリー'],
      ['ほのお'],
      ['ノーマル', 'ひこう'],
      ['ノーマル'],
    ];
    assert.deepEqual(typeLists.sort(compareTypeListsByTeraOrder), [
      ['ノーマル'],
      ['ノーマル', 'ひこう'],
      ['ノーマル', 'フェアリー'],
      ['ほのお'],
      ['みず'],
    ]);
  });
});
