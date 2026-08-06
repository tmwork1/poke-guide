// GET/PUT/DELETE /api/teams/:id (docs/plan/pages/team.md「確定した設計 > API契約」)。
//
// 認証必須(401)。実際のクエリは全て src/lib/team.ts へ委譲し、このファイル自身は
// 生の Supabase クエリを書かない(userIdフィルタ漏れによる他人データ露出を防ぐための設計、
// 詳細は src/lib/team.ts 冒頭のコメント参照)。
// 対象が存在しない場合と他人の所有物である場合はいずれも同じ404を返し、存在の有無を漏らさない。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, isValidUuid, jsonResponse, methodNotAllowed, readRequiredJsonBody } from '../_shared';
import { getSessionUser } from '../../../lib/user-session';
import { getSupabaseAdminClient } from '../../../lib/supabase';
import { validateTeamRequestBody, validateTeamComposition, type TeamCompositionMember, type TeamCompositionViolation } from '../../../lib/team-validation';
import { deleteTeam, getTeam, replaceTeam, updateTeamPinStatus } from '../../../lib/team';
import { getOwnedPokemon } from '../../../lib/owned-pokemon';
import { resolveDexNo } from '../../../lib/species-dex';
import { teamsRateLimiter } from '../../../lib/rate-limit';

export const prerender = false;

function notFound(): Response {
  return jsonResponse({ error: 'Team not found' }, 404);
}

// validateTeamComposition() が返す違反種別ごとの日本語メッセージ。ページ担当がそのまま
// 表示に使える文言にする(依頼元の指示どおり)。
const COMPOSITION_VIOLATION_MESSAGES: Record<TeamCompositionViolation, string> = {
  'over-capacity': 'チームには6体まで編成できます',
  'duplicate-species': '同じ種族の個体を複数編成することはできません',
  // 画面全体の用語を「アイテム」に統一する。
  'duplicate-item': '同じアイテムの個体を複数編成することはできません',
};

export async function GET({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const supabase = await getSupabaseAdminClient();
  const result = await getTeam(user.id, id, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ team: result.data }, 200);
}

export async function PUT({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = teamsRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;

  // PUT は「全項目を毎回送る」置換契約(docs/plan/pages/team.md「確定した設計 > API契約」)のため、
  // 置換対象の全フィールドが payload に存在することを必須にする(mode: 'replace')。
  // owned-pokemon と同種のデータ消失バグの再発防止(src/pages/api/owned-pokemon/[id].ts:55-58 参照)。
  const validation = validateTeamRequestBody(body.data, { mode: 'replace' });
  if (!validation.ok) return badRequest(validation.error);

  const supabase = await getSupabaseAdminClient();

  // R-3: validateTeamComposition() を書き込み前に必ず通す(UIのdisabledはdevtoolsから
  // 素通りできるため)。判定に必要な dexNo/itemName は members[] の owned_pokemon_id から
  // 本人の個体を引いて解決する。他人のIDが混ざっていた場合はここでは取得できない
  // (getOwnedPokemonはuser_idで絞るため)ため dexNo/itemName は null になるが、それは
  // 後段の replaceTeam の所有権チェック(R-2)が forbidden として確実に弾く。
  const compositionMembers: TeamCompositionMember[] = [];
  for (const member of validation.value.members) {
    const ownedResult = await getOwnedPokemon(user.id, member.owned_pokemon_id, supabase);
    if (!ownedResult.ok) {
      return jsonResponse({ error: ownedResult.error }, 500);
    }
    compositionMembers.push({
      slot: member.slot,
      dexNo: ownedResult.data ? resolveDexNo(ownedResult.data.species_name) : null,
      itemName: ownedResult.data ? ownedResult.data.item_name : null,
    });
  }

  const compositionResult = validateTeamComposition(compositionMembers);
  if (!compositionResult.ok) {
    return badRequest(COMPOSITION_VIOLATION_MESSAGES[compositionResult.violation]);
  }

  const result = await replaceTeam(user.id, id, validation.value, supabase);
  if (!result.ok) {
    if (result.violation === 'forbidden') {
      return badRequest('他人の個体を編成に含めることはできません');
    }
    return jsonResponse({ error: result.error }, 500);
  }
  if (!result.data) return notFound();

  return jsonResponse({ team: result.data }, 200);
}

export async function DELETE({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = teamsRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const supabase = await getSupabaseAdminClient();
  const result = await deleteTeam(user.id, id, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ data: { id } }, 200);
}

// PATCH /api/teams/:id: is_pinnedのみを更新する軽量経路(owned-pokemon.tsのPATCH
// /api/owned-pokemon/:idと同じ設計。src/pages/api/owned-pokemon/[id].ts参照)。
// UI改修依頼(チームトップ画面)「ボックス画面と同様にお気に入り機能を追加する」。
export async function PATCH({ request, cookies, params }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = teamsRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const id = params.id;
  if (!isValidUuid(id)) return notFound();

  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;

  // このエンドポイントは { is_pinned: boolean } のみを受け付ける(それ以外のフィールドは
  // 全項目上書き契約のPUTの役割のため、ここでは受け付けない)。
  const payload = body.data;
  const isPlainObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload);
  const keys = isPlainObject ? Object.keys(payload as object) : [];

  if (!isPlainObject || keys.length !== 1 || keys[0] !== 'is_pinned') {
    return badRequest('Request body must be exactly { is_pinned: boolean }');
  }

  const isPinned = (payload as { is_pinned?: unknown }).is_pinned;
  if (typeof isPinned !== 'boolean') {
    return badRequest('Request body must be exactly { is_pinned: boolean }');
  }

  const supabase = await getSupabaseAdminClient();
  const result = await updateTeamPinStatus(user.id, id, isPinned, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return notFound();

  return jsonResponse({ team: result.data }, 200);
}

export const POST = () => methodNotAllowed(['GET', 'PUT', 'PATCH', 'DELETE']);
