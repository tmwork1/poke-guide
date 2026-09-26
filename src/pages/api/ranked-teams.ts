import type { APIContext } from 'astro';
import { listAllRankedTeams, listRankedTeamsBySeason, rankedSeasonExists } from '../../lib/ranked-teams';
import { ALL_SEASONS_PARAM, normalizeSeasonParam } from '../../lib/ranked-teams-validation';
import { getSupabasePublicClient } from '../../lib/supabase';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';

export const prerender = false;
const MAX_PAGE_SIZE = 50;

function parseNonNegativeInteger(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function GET({ url }: APIContext): Promise<Response> {
  const season = normalizeSeasonParam(url.searchParams.get('season'));
  if (!season) return badRequest('シーズンを指定してください');
  const limit = parseNonNegativeInteger(url.searchParams.get('limit'));
  const offset = parseNonNegativeInteger(url.searchParams.get('offset'));
  if (limit === null || offset === null || (limit !== undefined && (limit < 1 || limit > MAX_PAGE_SIZE))) {
    return badRequest(`limit must be between 1 and ${MAX_PAGE_SIZE}; offset must be a non-negative integer`);
  }

  try {
    const supabase = await getSupabasePublicClient();
    const page = season === ALL_SEASONS_PARAM
      ? (limit === undefined
        ? { teams: await listAllRankedTeams(supabase), hasMore: false }
        : await listAllRankedTeams(supabase, { limit, offset }))
      : (limit === undefined
        ? { teams: await listRankedTeamsBySeason(season, supabase), hasMore: false }
        : await listRankedTeamsBySeason(season, supabase, { limit, offset }));
    // 1件でも取得できれば、その結果自体がシーズンの存在証明になる。
    // 0件時だけ軽量な存在確認を行い、末尾を越えたoffsetと存在しないシーズンを区別する。
    if (season !== ALL_SEASONS_PARAM && page.teams.length === 0 && !await rankedSeasonExists(season, supabase)) {
      return badRequest('存在しないシーズンです');
    }
    return jsonResponse({ season, ...page }, 200, {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
    });
  } catch (error) {
    console.error('[api/ranked-teams] GET failed:', error);
    return jsonResponse({ error: '上位構築を取得できませんでした' }, 500);
  }
}

const rejectWrite = () => methodNotAllowed(['GET']);
export const POST = rejectWrite;
export const PUT = rejectWrite;
export const PATCH = rejectWrite;
export const DELETE = rejectWrite;
