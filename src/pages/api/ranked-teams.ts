import type { APIContext } from 'astro';
import { listRankedSeasons, listRankedTeamsBySeason } from '../../lib/ranked-teams';
import { normalizeSeasonParam } from '../../lib/ranked-teams-validation';
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
    const seasons = await listRankedSeasons(supabase);
    if (!seasons.some((entry) => entry.season === season)) {
      return badRequest('存在しないシーズンです');
    }
    const page = limit === undefined
      ? { teams: await listRankedTeamsBySeason(season, supabase), hasMore: false }
      : await listRankedTeamsBySeason(season, supabase, { limit, offset });
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
