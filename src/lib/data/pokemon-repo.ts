// Client-side adapter for owned Pokémon data. Every signed-in user, including an
// anonymous user, uses the same authenticated HTTP API and database records.

import type { OwnedPokemonRecord } from '../owned-pokemon';
import type { OwnedPokemonRequestBody } from '../owned-pokemon-validation';
import { bumpUserDataRevision } from '../shared/reload-on-bfcache-restore';

export interface ListOwnedPokemonPageOptions {
  limit: number;
  offset: number;
}

export interface OwnedPokemonPage {
  data: OwnedPokemonRecord[];
  hasMore: boolean;
}

export async function listOwnedPokemonPage(
  options: ListOwnedPokemonPageOptions,
): Promise<OwnedPokemonPage> {
  const params = new URLSearchParams({
    limit: String(options.limit),
    offset: String(options.offset),
  });
  const response = await fetch(`/api/owned-pokemon?${params}`, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`一覧の取得に失敗しました (status=${response.status})`);
  }
  return await response.json() as OwnedPokemonPage;
}

export async function deleteOwnedPokemon(id: string): Promise<void> {
  const response = await fetch(`/api/owned-pokemon/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `削除に失敗しました (status=${response.status})`);
  }
  bumpUserDataRevision();
}

/** Create a Pokémon in the active account. Anonymous users are rejected by the API. */
export async function createOwnedPokemon(payload: OwnedPokemonRequestBody): Promise<{ id: string }> {
  const response = await fetch('/api/owned-pokemon', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: { id?: string }; error?: string };
  if (!response.ok || !body.data?.id) {
    throw new Error(body.error ?? `登録に失敗しました (status=${response.status})`);
  }
  bumpUserDataRevision();
  return { id: body.data.id };
}

/** Replace a Pokémon in the active account. */
export async function updateOwnedPokemon(id: string, payload: OwnedPokemonRequestBody): Promise<void> {
  const response = await fetch(`/api/owned-pokemon/${encodeURIComponent(id)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `更新に失敗しました (status=${response.status})`);
  }
  bumpUserDataRevision();
}
