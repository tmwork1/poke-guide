// Client-side adapter for team data. Anonymous users share the normal API
// transport; creation and deletion policy is enforced by the server.

import type { Team } from '../team';
import type { TeamRequestBody } from '../team-validation';
import { bumpUserDataRevision } from '../shared/reload-on-bfcache-restore';

export interface ListTeamsPageOptions {
  limit: number;
  offset: number;
}

export interface TeamsPage {
  teams: Team[];
  hasMore: boolean;
}

export async function listTeamsPage(options: ListTeamsPageOptions): Promise<TeamsPage> {
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
  const response = await fetch(`/api/teams/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to delete team (status=${response.status})`);
  }
  bumpUserDataRevision();
}

export async function createTeam(): Promise<{ id: string }> {
  const response = await fetch('/api/teams', {
    method: 'POST',
    credentials: 'same-origin',
  });
  const body = (await response.json().catch(() => ({}))) as { team?: { id?: string }; error?: string };
  if (!response.ok || !body.team?.id) {
    throw new Error(body.error ?? `Failed to create team (status=${response.status})`);
  }
  bumpUserDataRevision();
  return { id: body.team.id };
}

export async function updateTeam(id: string, payload: TeamRequestBody): Promise<void> {
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
  bumpUserDataRevision();
}
