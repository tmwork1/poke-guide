import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggUsageBattleDataList, getOpggUsageManifest, sortOpggSeasons } from '../../lib/opgg-usage';

export const prerender = false;

export async function GET({ request }: APIContext): Promise<Response> {
  const manifest = await getOpggUsageManifest(env.OPGG_USAGE);
  const seasons = sortOpggSeasons(manifest);
  const requestedSeason = new URL(request.url).searchParams.get('season');
  const season = requestedSeason
    ? seasons.find((entry) => entry.id === requestedSeason)
    : seasons[0];
  if (requestedSeason && !season) return badRequest('season is invalid');

  const entries = season ? await getOpggUsageBattleDataList(env.OPGG_USAGE, season) : [];
  return jsonResponse(Object.fromEntries(entries.map((entry) => [entry.name, entry.single])), 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
