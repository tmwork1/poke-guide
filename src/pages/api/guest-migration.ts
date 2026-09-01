// POST /api/guest-migration: ログイン前にブラウザ内へ保存したポケモン・チームを
// 現在のアカウントへ追加する。一部の不正データや個別書き込みの失敗で、残りの正常な
// データまで失敗させないベストエフォートな移行にする(docs/plan/guest_mode.md §11)。
import type { APIContext } from 'astro';
import { badRequest, isSameOrigin, jsonResponse, readRequiredJsonBody } from './_shared';
import type { GuestDataExport } from '../../lib/data/guest-store';
import type { OwnedPokemonRequestBody } from '../../lib/owned-pokemon-validation';
import { validateOwnedPokemonRequestBody } from '../../lib/owned-pokemon-validation';
import { validateTeamComposition, validateTeamRequestBody, type TeamRequestBody } from '../../lib/team-validation';
import { createOwnedPokemon, findOwnedPokemonByGuestLocalIds } from '../../lib/owned-pokemon';
import { createTeam, replaceTeam } from '../../lib/team';
import { guestMigrationRateLimiter } from '../../lib/rate-limit';
import { getSupabaseAdminClient } from '../../lib/supabase';

export const prerender = false;

const MAX_GUEST_POKEMON = 200;
const MAX_GUEST_TEAMS = 50;
const GUEST_ID_PREFIX = 'guest-';

interface ValidGuestPokemon {
  guestLocalId: string;
  input: OwnedPokemonRequestBody;
}

interface MigrationSummary {
  pokemonMigrated: number;
  pokemonSkipped: number;
  teamsMigrated: number;
  teamsSkipped: number;
  teamsSkippedMembers: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGuestMigrationBody(value: unknown): value is GuestDataExport {
  return isPlainObject(value) && Array.isArray(value.pokemon) && Array.isArray(value.teams);
}

function isGuestLocalId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(GUEST_ID_PREFIX) && value.length > GUEST_ID_PREFIX.length;
}

/**
 * Team members still point at browser-local IDs in the request. Resolve those
 * references before using the normal UUID-based team validator. Members without
 * a matching migrated Pokémon are deliberately omitted rather than rejecting
 * an otherwise valid team.
 */
function validateMigratedTeam(
  rawTeam: unknown,
  ownedPokemonIdsByGuestId: ReadonlyMap<string, string>,
): { ok: true; value: TeamRequestBody; skippedMembers: number }
  | { ok: false; skippedMembers: number } {
  if (!isPlainObject(rawTeam) || !Array.isArray(rawTeam.members)) {
    return { ok: false, skippedMembers: 0 };
  }

  const members: Array<Record<string, unknown>> = [];
  let skippedMembers = 0;
  for (const rawMember of rawTeam.members) {
    if (!isPlainObject(rawMember)) {
      skippedMembers += 1;
      continue;
    }
    const guestLocalId = rawMember.owned_pokemon_id;
    const ownedPokemonId = typeof guestLocalId === 'string'
      ? ownedPokemonIdsByGuestId.get(guestLocalId)
      : undefined;
    if (!ownedPokemonId) {
      skippedMembers += 1;
      continue;
    }
    members.push({ ...rawMember, owned_pokemon_id: ownedPokemonId });
  }

  // replaceTeam() と同じ完全置換の入力契約で検証する。メンバーのIDはここまでに実UUIDへ
  // 解決済みなので、既存のUUID検証・slot重複検証などもそのまま利用できる。
  const validation = validateTeamRequestBody({ memo: rawTeam.memo, members }, { mode: 'replace' });
  if (!validation.ok) return { ok: false, skippedMembers };

  const composition = validateTeamComposition(
    validation.value.members.map((member) => ({ slot: member.slot })),
  );
  if (!composition.ok) return { ok: false, skippedMembers };

  return { ok: true, value: validation.value, skippedMembers };
}

export async function POST({ request, locals }: APIContext): Promise<Response> {
  // middleware.ts が全リクエストでセットする認証済みユーザー。リクエストボディの値は
  // user_idとして使わず、下流のデータアクセス層にもこのIDだけを渡す。
  const user = locals.user;
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!isSameOrigin(request)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const rateLimit = guestMigrationRateLimiter.check(user.id);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;
  if (!isGuestMigrationBody(body.data)) {
    return badRequest('Request body must contain pokemon and teams arrays');
  }
  if (body.data.pokemon.length > MAX_GUEST_POKEMON || body.data.teams.length > MAX_GUEST_TEAMS) {
    return badRequest(`pokemon must contain at most ${MAX_GUEST_POKEMON} entries and teams at most ${MAX_GUEST_TEAMS}`);
  }

  const summary: MigrationSummary = {
    pokemonMigrated: 0,
    pokemonSkipped: 0,
    teamsMigrated: 0,
    teamsSkipped: 0,
    teamsSkippedMembers: 0,
  };

  // 個々のゲストポケモンを既存のPOSTと同じバリデータで検証する。ローカルIDが無い・重複
  // しているデータは対応表を一意にできないため、個別スキップとして扱う。
  const validPokemon: ValidGuestPokemon[] = [];
  const seenGuestLocalIds = new Set<string>();
  for (const rawPokemon of body.data.pokemon) {
    if (!isPlainObject(rawPokemon) || !isGuestLocalId(rawPokemon.id) || seenGuestLocalIds.has(rawPokemon.id)) {
      summary.pokemonSkipped += 1;
      continue;
    }
    seenGuestLocalIds.add(rawPokemon.id);

    const validation = validateOwnedPokemonRequestBody(rawPokemon);
    if (!validation.ok) {
      summary.pokemonSkipped += 1;
      continue;
    }
    validPokemon.push({ guestLocalId: rawPokemon.id, input: validation.value });
  }

  const supabase = await getSupabaseAdminClient();
  const existing = await findOwnedPokemonByGuestLocalIds(
    user.id,
    validPokemon.map((pokemon) => pokemon.guestLocalId),
    supabase,
  );
  if (!existing.ok) return jsonResponse({ error: existing.error }, 500);

  // ステップ1: 既に移行済みの行と、今回新規作成した行の両方から同じ対応表を構成する。
  const ownedPokemonIdsByGuestId = new Map<string, string>();
  for (const pokemon of existing.data) {
    if (pokemon.guest_local_id) {
      ownedPokemonIdsByGuestId.set(pokemon.guest_local_id, pokemon.id);
    }
  }

  // ステップ2: まだ対応表にない個体だけを作成する。部分ユニークインデックスの競合が
  // 起きても、直後に再取得すれば別リクエストが先に成功したケースを安全に吸収できる。
  for (const pokemon of validPokemon) {
    if (ownedPokemonIdsByGuestId.has(pokemon.guestLocalId)) {
      summary.pokemonMigrated += 1;
      continue;
    }

    const created = await createOwnedPokemon(
      user.id,
      { ...pokemon.input, guest_local_id: pokemon.guestLocalId },
      supabase,
    );
    if (created.ok) {
      ownedPokemonIdsByGuestId.set(pokemon.guestLocalId, created.data.id);
      summary.pokemonMigrated += 1;
      continue;
    }

    const concurrent = await findOwnedPokemonByGuestLocalIds(user.id, [pokemon.guestLocalId], supabase);
    const concurrentlyMigrated = concurrent.ok
      ? concurrent.data.find((entry) => entry.guest_local_id === pokemon.guestLocalId)
      : undefined;
    if (concurrentlyMigrated) {
      ownedPokemonIdsByGuestId.set(pokemon.guestLocalId, concurrentlyMigrated.id);
      summary.pokemonMigrated += 1;
      continue;
    }
    summary.pokemonSkipped += 1;
  }

  // ステップ3/4: ローカル参照を実UUIDへ解決してから、通常のチーム作成・置換と同じ
  // データアクセス層を順に呼ぶ。個別チームの失敗は他のチームの移行を妨げない。
  for (const rawTeam of body.data.teams) {
    const team = validateMigratedTeam(rawTeam, ownedPokemonIdsByGuestId);
    summary.teamsSkippedMembers += team.skippedMembers;
    if (!team.ok) {
      summary.teamsSkipped += 1;
      continue;
    }

    const created = await createTeam(user.id, supabase);
    if (!created.ok) {
      summary.teamsSkipped += 1;
      continue;
    }

    const replaced = await replaceTeam(user.id, created.data.id, team.value, supabase);
    if (!replaced.ok || !replaced.data) {
      // createTeam後にreplaceTeamが失敗した場合は空チームが残りうる。複数テーブル間の
      // トランザクションは無いため、成功したものだけを成功と数え、結果を正直に返す。
      summary.teamsSkipped += 1;
      continue;
    }
    summary.teamsMigrated += 1;
  }

  return jsonResponse(summary, 200);
}
