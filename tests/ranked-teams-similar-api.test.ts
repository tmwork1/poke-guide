import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RankedTeam } from '../src/lib/ranked-teams.ts';
import { resolveSimilarRankedTeams } from '../src/lib/ranked-teams/similar-api.ts';

const memberQuery = encodeURIComponent(JSON.stringify([{
  species_name: 'ピカチュウ', ability_name: 'せいでんき', item_name: null, move_names: [],
}]));
const fakeClient = {} as SupabaseClient;

function rankedTeam(id: string, rank: number, speciesKey: string, ability: string | null): RankedTeam {
  return {
    id, season: 'M-1', rank, rating: null, rule: 'single', trainerName: null,
    articleUrl: null, articleTitle: null, articleHost: null,
    members: [{ slot: 1, speciesKey, speciesName: speciesKey, formName: null, itemName: null,
      ability, nature: null, evs: null, moveNames: [], type1: null, type2: null }],
  };
}

describe('GET /api/ranked-teams/similar', () => {
  it('正の類似度だけを現行順で全件返す', async () => {
    const teams = [
      rankedTeam('species-rank-1', 1, 'ピカチュウ', null),
      rankedTeam('exact-rank-2', 2, 'ピカチュウ', 'せいでんき'),
      rankedTeam('unrelated', 3, 'イーブイ', null),
    ];
    const result = await resolveSimilarRankedTeams(
      new URL(`http://localhost/api/ranked-teams/similar?season=M-1&members=${memberQuery}`),
      fakeClient,
      {
        listCandidates: async (speciesKeys, _client, season) => {
          assert.deepEqual(speciesKeys, ['ピカチュウ']);
          assert.equal(season, 'M-1');
          return teams;
        },
        seasonExists: async () => true,
      },
    );
    assert.equal(result.status, 200);
    const body = result.body as { teams: RankedTeam[] };
    assert.deepEqual(body.teams.map((team) => team.id), ['exact-rank-2', 'species-rank-1']);
  });

  it('入力不正をDB取得前に400にする', async () => {
    let called = false;
    const result = await resolveSimilarRankedTeams(
      new URL('http://localhost/api/ranked-teams/similar?season=M-1&members=[]'),
      fakeClient,
      {
        listCandidates: async () => { called = true; return []; },
        seasonExists: async () => true,
      },
    );
    assert.equal(result.status, 400);
    assert.equal(called, false);
  });

  it('候補0件のときだけシーズンの存在を確認して、存在しなければ400にする', async () => {
    let existenceChecks = 0;
    const result = await resolveSimilarRankedTeams(
      new URL(`http://localhost/api/ranked-teams/similar?season=M-999&members=${memberQuery}`),
      fakeClient,
      {
        listCandidates: async () => [],
        seasonExists: async (season) => {
          existenceChecks += 1;
          assert.equal(season, 'M-999');
          return false;
        },
      },
    );
    assert.equal(result.status, 400);
    assert.equal(existenceChecks, 1);
  });

  it('候補があればシーズン存在確認を省略する', async () => {
    let existenceChecks = 0;
    const result = await resolveSimilarRankedTeams(
      new URL(`http://localhost/api/ranked-teams/similar?season=M-1&members=${memberQuery}`),
      fakeClient,
      {
        listCandidates: async () => [rankedTeam('candidate', 1, 'ピカチュウ', null)],
        seasonExists: async () => { existenceChecks += 1; return true; },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(existenceChecks, 0);
  });
});
