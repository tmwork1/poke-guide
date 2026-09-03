import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sortPokemonNamesByOpggRanking } from '../src/lib/owned-pokemon-form.ts';

describe('種族名datalistのOP.GGランキング順', () => {
  const physicalOrder = ['フシギダネ', 'フシギソウ', 'フシギバナ', 'ヒトカゲ', 'リザード'];

  it('ランキング上位の種族を先に並べる', () => {
    assert.deepEqual(
      sortPokemonNamesByOpggRanking(physicalOrder, ['フシギバナ', 'ヒトカゲ']),
      ['フシギバナ', 'ヒトカゲ', 'フシギダネ', 'フシギソウ', 'リザード'],
    );
  });

  it('ランキングにない種族は元の順序のまま後ろに並べる', () => {
    assert.deepEqual(
      sortPokemonNamesByOpggRanking(physicalOrder, ['ヒトカゲ']),
      ['ヒトカゲ', 'フシギダネ', 'フシギソウ', 'フシギバナ', 'リザード'],
    );
  });

  it('ランキング配列が空なら元の順序をそのまま保つ', () => {
    assert.deepEqual(sortPokemonNamesByOpggRanking(physicalOrder, []), physicalOrder);
  });
});
