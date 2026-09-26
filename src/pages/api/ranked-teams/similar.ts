import type { APIContext } from 'astro';
import { createFixedWindowRateLimiter, EVENTS_RATE_LIMIT } from '../../../lib/rate-limit.ts';
import { resolveSimilarRankedTeams } from '../../../lib/ranked-teams/similar-api.ts';
import { getSupabasePublicClient } from '../../../lib/supabase.ts';
import { jsonResponse, methodNotAllowed } from '../_shared.ts';

export const prerender = false;
const similarTeamsRateLimiter = createFixedWindowRateLimiter(EVENTS_RATE_LIMIT);

export async function GET({ request, url }: APIContext): Promise<Response> {
  const rateLimitKey = request.headers.get('cf-connecting-ip') ?? 'anonymous';
  if (!similarTeamsRateLimiter.check(rateLimitKey).allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }
  try {
    const result = await resolveSimilarRankedTeams(url, await getSupabasePublicClient());
    return jsonResponse(result.body, result.status, result.status === 200 ? {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
    } : undefined);
  } catch (error) {
    console.error('[api/ranked-teams/similar] GET failed:', error);
    return jsonResponse({ error: '類似構築を取得できませんでした' }, 500);
  }
}

const rejectWrite = () => methodNotAllowed(['GET']);
export const POST = rejectWrite;
export const PUT = rejectWrite;
export const PATCH = rejectWrite;
export const DELETE = rejectWrite;
