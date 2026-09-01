// Client-side adapter for team data. Authenticated visitors use the existing
// HTTP API; guest visitors use the browser-only guest store.

import type { Team } from '../team';
import type { TeamRequestBody } from '../team-validation';
import {
  createGuestTeamWithId,
  deleteGuestTeam,
  getGuestTeam,
  listGuestTeams,
  updateGuestTeam,
} from './guest-store';
import { isGuestMode } from './guest-mode';
import { ensureFixedGuestPokemon, GUEST_FIXED_POKEMON } from './pokemon-repo';

export interface ListTeamsPageOptions {
  limit: number;
  offset: number;
}

export interface TeamsPage {
  teams: Team[];
  hasMore: boolean;
}

export const GUEST_FIXED_TEAM_ID = 'guest-fixed-team';

/** Create the one fixed six-slot team after its fixed Pokémon are available. */
export function ensureFixedGuestTeam(): void {
  ensureFixedGuestPokemon();
  if (getGuestTeam(GUEST_FIXED_TEAM_ID)) return;

  createGuestTeamWithId(GUEST_FIXED_TEAM_ID, {
    memo: 'ゲスト用サンプルチーム',
    members: GUEST_FIXED_POKEMON.map((pokemon, index) => ({
      slot: index + 1,
      owned_pokemon_id: pokemon.id,
    })),
  });
}

export async function listTeamsPage(options: ListTeamsPageOptions): Promise<TeamsPage> {
  if (isGuestMode()) {
    ensureFixedGuestTeam();
    const allTeams = listGuestTeams();
    const teams = allTeams.slice(options.offset, options.offset + options.limit);
    return { teams, hasMore: options.offset + teams.length < allTeams.length };
  }

  const params = new URLSearchParams({
    limit: String(options.limit),
    offset: String(options.offset),
  });
  const response = await fetch(`/api/teams?${params}`, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Failed to load teams (status=${response.status})`);
  }
  return await response.json() as TeamsPage;
}

export async function deleteTeam(id: string): Promise<void> {
  if (isGuestMode()) {
    if (!deleteGuestTeam(id)) throw new Error('Team not found');
    return;
  }

  const response = await fetch(`/api/teams/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Failed to delete team (status=${response.status})`);
  }
}

export async function createTeam(): Promise<{ id: string }> {
  if (isGuestMode()) {
    throw new Error('ログインすると、新しいチームを作成できます。');
  }

  const response = await fetch('/api/teams', {
    method: 'POST',
    credentials: 'same-origin',
  });
  const body = (await response.json().catch(() => ({}))) as { team?: { id?: string }; error?: string };
  if (!response.ok || !body.team?.id) {
    throw new Error(body.error ?? `Failed to create team (status=${response.status})`);
  }
  return { id: body.team.id };
}

export async function updateTeam(id: string, payload: TeamRequestBody): Promise<void> {
  if (isGuestMode()) {
    if (!updateGuestTeam(id, payload)) throw new Error('Team not found');
    return;
  }

  const response = await fetch(`/api/teams/${encodeURIComponent(id)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to update team (status=${response.status})`);
  }
}

/** Read a guest team for client-side hydration of the team editor. */
export function getTeamForGuest(id: string): Team | null {
  return getGuestTeam(id);
}
