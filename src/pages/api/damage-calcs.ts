// POST /api/damage-calcs: ダメージ計算ログの受け口 (開発プラン §2.4, §2.6, §3 Phase2-3)。
// damage_calcs へ計算条件+client_result(未検証)を保存すると同時に、events へも計算条件のみを
// 正データとして二重記録する (events.ts と同じ session_hash 発行・レートリミットの流儀)。
import type { APIContext } from 'astro';
import { badRequest, jsonResponse, methodNotAllowed, readRequiredJsonBody } from './_shared';
import { validateDamageCalcRequestBody } from '../../lib/damage-calc-validation';
import {
  computeSessionHash,
  generateSessionId,
  getUtcDateString,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from '../../lib/session-hash';
import { eventsRateLimiter } from '../../lib/rate-limit';
import { getSupabaseAdminClient } from '../../lib/supabase';
import { readEnv } from '../../config/env';

export const prerender = false;

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;

  const validation = validateDamageCalcRequestBody(body.data);
  if (!validation.ok) return badRequest(validation.error);

  // セッションCookie (pc_sid): 非個人情報のランダムID。無ければここで発行する (events.ts と同じ)。
  let sessionId = cookies.get(SESSION_COOKIE_NAME)?.value;
  const isNewSession = !sessionId;
  if (!sessionId) {
    sessionId = generateSessionId();
  }

  // レートリミットは events.ts と同じ書き込みAPI向け設定を流用する (計算ログも同程度の頻度想定)。
  const rateLimitKey = request.headers.get('cf-connecting-ip') ?? sessionId;
  const rateLimit = eventsRateLimiter.check(rateLimitKey);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  if (isNewSession) {
    cookies.set(SESSION_COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // astro dev (http://localhost) では secure Cookie がセットされないため開発時のみ無効化する。
      secure: !import.meta.env.DEV,
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
  }

  const secret = readEnv('SESSION_HASH_SECRET');
  const sessionHash = await computeSessionHash(sessionId, secret, getUtcDateString());

  const { attacker_name, defender_name, move_name, attacker_build, defender_build, field, client_result } =
    validation.value;

  const supabase = await getSupabaseAdminClient();

  const { data, error } = await supabase
    .from('damage_calcs')
    .insert({
      attacker_name,
      defender_name,
      move_name,
      attacker_build,
      defender_build,
      field,
      client_result: client_result ?? null,
      session_hash: sessionHash,
    })
    .select('id')
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to insert damage_calcs:', error);
    return jsonResponse({ error: 'Failed to record damage calc' }, 500);
  }

  // events への二重記録: 集計は入力(計算条件)のみに依存する方針 (§2.6) のため、
  // client_result はここには含めない (damage_calcs.client_result にのみ保存する)。
  // これは集計用の副次的な記録であり、失敗してもユーザーにとっての主目的(計算ログの保存)は
  // 既に達成済みなので、リクエスト全体を失敗させない(builds.ts と同じ方針)。
  const { error: eventError } = await supabase.from('events').insert({
    event_type: 'damage_calc',
    payload: { attacker_name, defender_name, move_name, attacker_build, defender_build, field },
    session_hash: sessionHash,
  });

  if (eventError) {
    // eslint-disable-next-line no-console
    console.error('Failed to insert events (damage_calc):', eventError);
  }

  return jsonResponse({ data: { id: data?.id } }, 201);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
