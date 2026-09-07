import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderPokemonEntriesForDatalist, sortPokemonNamesByOpggRanking } from '../src/lib/owned-pokemon-form.ts';

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

describe('Pokemon selection ordering', () => {
  it('uses the modal ordering for ranked, unranked, and Mega entries', () => {
    assert.deepEqual(
      orderPokemonEntriesForDatalist(
        [
          { name: 'unranked-b', dexNo: 2, forme: null },
          { name: 'mega-unranked-a', dexNo: 1, forme: 'Mega' },
          { name: 'ranked', dexNo: 3, forme: null },
          { name: 'unranked-a', dexNo: 1, forme: null },
          { name: 'mega-ranked', dexNo: 3, forme: 'Mega' },
        ],
        ['ranked'],
      ),
      ['ranked', 'mega-ranked', 'unranked-a', 'mega-unranked-a', 'unranked-b'],
    );
  });
});
