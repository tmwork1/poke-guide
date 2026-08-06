import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sortPokemonNamesByUsage } from '../src/lib/owned-pokemon-form.ts';

describe('種族名datalistの使用率順', () => {
  const physicalOrder = ['フシギダネ', 'フシギソウ', 'フシギバナ', 'ヒトカゲ', 'リザード'];

  it('使用率が高い種族を先に並べる', () => {
    assert.deepEqual(
      sortPokemonNamesByUsage(physicalOrder, { ヒトカゲ: 8, フシギバナ: 20 }),
      ['フシギバナ', 'ヒトカゲ', 'フシギダネ', 'フシギソウ', 'リザード'],
    );
  });

  it('使用率データがない種族は元の順序のまま後ろに並べる', () => {
    assert.deepEqual(
      sortPokemonNamesByUsage(physicalOrder, { ヒトカゲ: 8 }),
      ['ヒトカゲ', 'フシギダネ', 'フシギソウ', 'フシギバナ', 'リザード'],
    );
  });

  it('使用率が同じ種族は元の順序を保つ', () => {
    assert.deepEqual(
      sortPokemonNamesByUsage(physicalOrder, { フシギソウ: 5, ヒトカゲ: 5 }),
      ['フシギソウ', 'ヒトカゲ', 'フシギダネ', 'フシギバナ', 'リザード'],
    );
  });

  it('使用率データが空なら元の順序をそのまま保つ', () => {
    assert.deepEqual(sortPokemonNamesByUsage(physicalOrder, {}), physicalOrder);
  });
});
