// Client-side adapter for team data. Authenticated visitors use the existing
// HTTP API; guest visitors use the browser-only guest store.

import type { Team } from '../team';
import type { TeamRequestBody } from '../team-validation';
import {
  createGuestTeam,
  deleteGuestTeam,
  getGuestTeam,
  listGuestPokemon,
  listGuestTeams,
  updateGuestTeam,
} from './guest-store';
import { isGuestMode } from './guest-mode';
import { ensureGuestSamples, GUEST_SAMPLE_POKEMON } from './pokemon-repo';

export interface ListTeamsPageOptions {
  limit: number;
  offset: number;
}

export interface TeamsPage {
  teams: Team[];
  hasMore: boolean;
}

function ensureGuestSampleTeam(): void {
  ensureGuestSamples();
  if (listGuestTeams().length > 0) return;

  const pokemon = listGuestPokemon();
  const members = GUEST_SAMPLE_POKEMON.slice(0, 2).flatMap((sample, index) => {
    const entry = pokemon.find((candidate) => candidate.species_name === sample.species_name);
    return entry
      ? [{ slot: index + 1, owned_pokemon_id: entry.id, item_override: null }]
      : [];
  });
  if (members.length === 2) createGuestTeam({ members });
}

export async function listTeamsPage(options: ListTeamsPageOptions): Promise<TeamsPage> {
  if (isGuestMode()) {
    // This is intentionally done before reading teams so /team can bootstrap
    // both sample Pokemon and the sample team, including after /box was opened
    // first and seeded the shared guest store.
    ensureGuestSampleTeam();
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
    return { id: createGuestTeam().id };
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
