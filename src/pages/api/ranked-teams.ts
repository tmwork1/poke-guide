import type { APIContext } from 'astro';
import { listRankedSeasons, listRankedTeamsBySeason } from '../../lib/ranked-teams';
import { normalizeSeasonParam } from '../../lib/ranked-teams-validation';
import { getSupabasePublicClient } from '../../lib/supabase';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';

export const prerender = false;

export async function GET({ url }: APIContext): Promise<Response> {
  const season = normalizeSeasonParam(url.searchParams.get('season'));
  if (!season) return badRequest('シーズンを指定してください');

  try {
    const supabase = await getSupabasePublicClient();
    const seasons = await listRankedSeasons(supabase);
    if (!seasons.some((entry) => entry.season === season)) {
      return badRequest('存在しないシーズンです');
    }
    const teams = await listRankedTeamsBySeason(season, supabase);
    return jsonResponse({ season, teams }, 200, {
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
