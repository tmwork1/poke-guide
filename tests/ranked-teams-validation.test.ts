import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  matchesSpeciesSearch,
  matchesTopBuildSearch,
  matchesTopBuildMemberSearch,
  normalizeSeasonParam,
  parseSimilarTeamMembers,
  resolveDefaultSeason,
  RANKED_TEAMS_PAGE_SIZE,
} from '../src/lib/ranked-teams-validation.ts';

describe('parseSimilarTeamMembers', () => {
  it('1〜6体の育成内容を受け付ける', () => {
    const members = [{ species_name: 'ピカチュウ', ability_name: null, item_name: 'でんきだま', move_names: ['10まんボルト'] }];
    assert.deepEqual(parseSimilarTeamMembers(JSON.stringify(members)), members);
  });

  it('空配列・7体・不正なフィールドを拒否する', () => {
    assert.equal(parseSimilarTeamMembers('[]'), null);
    assert.equal(parseSimilarTeamMembers(JSON.stringify(Array(7).fill({ species_name: 'ピカチュウ', ability_name: null, item_name: null, move_names: [] }))), null);
    assert.equal(parseSimilarTeamMembers(JSON.stringify([{ species_name: '', ability_name: null, item_name: null, move_names: [] }])), null);
    assert.equal(parseSimilarTeamMembers('{'), null);
  });
});

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

describe('matchesTopBuildMemberSearch', () => {
  const member = {
    ability: 'マルチスケイル',
    itemName: 'こだわりスカーフ',
    moveNames: ['りゅうせいぐん', 'だいもんじ'],
  };

  it('空の検索語では一致する', () => assert.equal(matchesTopBuildMemberSearch(member, '  '), true));
  it('特性・持ち物または技に一致する', () => {
    assert.equal(matchesTopBuildMemberSearch(member, 'マルチ'), true);
    assert.equal(matchesTopBuildMemberSearch(member, 'スカーフ'), true);
    assert.equal(matchesTopBuildMemberSearch(member, 'りゅうせい'), true);
  });
  it('複数語は同じ個体の持ち物・技に対してAND検索する', () => {
    assert.equal(matchesTopBuildMemberSearch(member, 'スカーフ だいもんじ'), true);
    assert.equal(matchesTopBuildMemberSearch(member, 'スカーフ じしん'), false);
  });
  it('ポケモン名は検索対象にしない', () => {
    assert.equal(matchesTopBuildMemberSearch(member, 'カイリュー'), false);
  });
});

describe('matchesTopBuildSearch', () => {
  const members = [
    {
      speciesKey: 'ピカチュウ',
      speciesName: 'ピカチュウ',
      ability: 'せいでんき',
      itemName: 'でんきだま',
      moveNames: ['10まんボルト'],
    },
  ];

  it('特性でも検索できる', () => assert.equal(matchesTopBuildSearch(members, 'せいでんき'), true));
  it('特性を含む複数語をAND検索できる', () => assert.equal(matchesTopBuildSearch(members, 'ピカチュウ せいでんき'), true));
});

it('1ページの表示件数は24件', () => assert.equal(RANKED_TEAMS_PAGE_SIZE, 24));
