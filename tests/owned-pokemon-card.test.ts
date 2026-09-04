import assert from 'node:assert/strict';
import test from 'node:test';
import { splitBoxCardDisplayName } from '../src/lib/box-card-display-name.ts';

test('splitBoxCardDisplayName は末尾の括弧書きを補足表記へ分ける', () => {
  assert.deepEqual(splitBoxCardDisplayName('ダイケンキ(ヒスイ)'), {
    name: 'ダイケンキ',
    suffix: '(ヒスイ)',
  });
});

test('splitBoxCardDisplayName は括弧書きのない名前をそのまま返す', () => {
  assert.deepEqual(splitBoxCardDisplayName('ピカチュウ'), { name: 'ピカチュウ', suffix: null });
});
