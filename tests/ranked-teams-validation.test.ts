import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  matchesSpeciesSearch,
  normalizeSeasonParam,
  resolveDefaultSeason,
  RANKED_TEAMS_PAGE_SIZE,
} from '../src/lib/ranked-teams-validation.ts';

describe('normalizeSeasonParam', () => {
  it('文字列の前後空白を除去する', () => assert.equal(normalizeSeasonParam('  M-3  '), 'M-3'));
  it('空文字と空白だけの文字列をnullにする', () => {
    assert.equal(normalizeSeasonParam(''), null);
    assert.equal(normalizeSeasonParam('   '), null);
  });
  it('文字列以外をnullにする', () => {
    assert.equal(normalizeSeasonParam(undefined), null);
    assert.equal(normalizeSeasonParam(3), null);
  });
});

describe('resolveDefaultSeason', () => {
  it('seasonNumberが最大のシーズンを返す', () => {
    assert.equal(resolveDefaultSeason([
      { season: 'M-1', seasonNumber: 1 },
      { season: 'M-3', seasonNumber: 3 },
      { season: 'M-2', seasonNumber: 2 },
    ]), 'M-3');
  });
  it('空配列ではnullを返す', () => assert.equal(resolveDefaultSeason([]), null));
});

describe('matchesSpeciesSearch', () => {
  const members = [
    { speciesKey: 'メガゲンガー', speciesName: 'ゲンガー' },
    { speciesKey: null, speciesName: 'ハラバリー' },
  ];

  it('空の検索語は一致する', () => assert.equal(matchesSpeciesSearch(members, '  '), true));
  it('speciesKeyとspeciesNameのどちらにも一致する', () => {
    assert.equal(matchesSpeciesSearch(members, 'メガゲンガー'), true);
    assert.equal(matchesSpeciesSearch(members, 'ゲンガー'), true);
  });
  it('ひらがなとカタカナの違いを吸収する', () => {
    assert.equal(matchesSpeciesSearch(members, 'げんがー'), true);
  });
  it('空白区切りの各語が別メンバーに一致してもANDを満たす', () => {
    assert.equal(matchesSpeciesSearch(members, 'ゲンガー ハラバリー'), true);
  });
  it('いずれかの語がどのメンバーにも無ければ一致しない', () => {
    assert.equal(matchesSpeciesSearch(members, 'ゲンガー ピカチュウ'), false);
  });
  it('speciesKeyがnullでもspeciesNameへフォールバックする', () => {
    assert.equal(matchesSpeciesSearch(members, 'はらばりー'), true);
  });
});

it('1ページの表示件数は50件', () => assert.equal(RANKED_TEAMS_PAGE_SIZE, 50));
