// POST /api/events: 匿名イベントログの受け口 (開発プラン §2.4, §2.6, §3 Phase1-4)。
// 計算条件・検索語などの「入力」を events テーブルへ append-only で記録する。
// client_result のような未検証値が payload に含まれていても events.payload (jsonb) は
// 何でも受け付けるため、ここでは分岐せずそのまま保存する（真正性は集計側 [Phase 5] が扱う）。
import type { APIContext } from 'astro';
import { badRequest, jsonResponse, methodNotAllowed, readRequiredJsonBody } from './_shared';
import { validateEventRequestBody } from '../../lib/event-validation';
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

  const validation = validateEventRequestBody(body.data);
  if (!validation.ok) return badRequest(validation.error);

  // セッションCookie (pc_sid): 非個人情報のランダムID。無ければここで発行する。
  let sessionId = cookies.get(SESSION_COOKIE_NAME)?.value;
  const isNewSession = !sessionId;
  if (!sessionId) {
    sessionId = generateSessionId();
  }

  // レートリミットのキーは IP（Cloudflareが付与する cf-connecting-ip）を優先し、
  // 取得できない場合のみ一時セッションIDを使う。いずれもメモリ上でのみ保持し、
  // DBには一切保存しない（開発プラン §2.4、レート制御専用の一時利用）。
  const rateLimitKey = request.headers.get('cf-connecting-ip') ?? sessionId;
  const rateLimit = eventsRateLimiter.check(rateLimitKey);
  if (!rateLimit.allowed) {
    return jsonResponse(
      { error: 'Too many requests' },
      429,
    );
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
  let sessionHash: string;
  try {
    sessionHash = await computeSessionHash(sessionId, secret, getUtcDateString());
  } catch (error) {
    // イベント記録自体がこのAPIの主目的なので、匿名化を保証できない設定不備は成功として扱わず500にする。
    // eslint-disable-next-line no-console
    console.error('Failed to configure session hash for event recording:', error);
    return jsonResponse({ error: 'Failed to record event' }, 500);
  }

  const supabase = await getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('events')
    .insert({
      event_type: validation.value.event_type,
      payload: validation.value.payload,
      session_hash: sessionHash,
    })
    .select('id')
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to insert event:', error);
    return jsonResponse({ error: 'Failed to record event' }, 500);
  }

  return jsonResponse({ data: { id: data?.id } }, 201);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
