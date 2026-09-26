import type { SupabaseClient } from '@supabase/supabase-js';
import { rankSimilarTeams } from '../build-similarity.ts';
import { listRankedTeamsBySpeciesKeys, rankedSeasonExists, type RankedTeam } from '../ranked-teams.ts';
import { ALL_SEASONS_PARAM, normalizeSeasonParam, parseSimilarTeamMembers } from '../ranked-teams-validation.ts';

export interface SimilarRankedTeamsDependencies {
  listCandidates(speciesKeys: readonly string[], supabase: SupabaseClient, season?: string): Promise<RankedTeam[]>;
  seasonExists(season: string, supabase: SupabaseClient): Promise<boolean>;
}

const defaultDependencies: SimilarRankedTeamsDependencies = {
  listCandidates: listRankedTeamsBySpeciesKeys,
  seasonExists: rankedSeasonExists,
};

export async function resolveSimilarRankedTeams(
  url: URL,
  supabase: SupabaseClient,
  dependencies: SimilarRankedTeamsDependencies = defaultDependencies,
): Promise<{ status: number; body: unknown }> {
  const season = normalizeSeasonParam(url.searchParams.get('season'));
  if (!season) return { status: 400, body: { error: 'シーズンを指定してください' } };
  const members = parseSimilarTeamMembers(url.searchParams.get('members'));
  if (!members) return { status: 400, body: { error: 'members must contain between 1 and 6 valid team members' } };

  const speciesKeys = members.map((member) => member.species_name);
  const teams = await dependencies.listCandidates(
    speciesKeys,
    supabase,
    season === ALL_SEASONS_PARAM ? undefined : season,
  );
  if (season !== ALL_SEASONS_PARAM && teams.length === 0 && !await dependencies.seasonExists(season, supabase)) {
    return { status: 400, body: { error: '存在しないシーズンです' } };
  }

  return {
    status: 200,
    body: { season, teams: rankSimilarTeams(members, teams).map((entry) => entry.team) },
  };
}
