// Client-side adapter for owned Pokémon data. Authenticated visitors use the
// existing HTTP API; guest visitors use the browser-only guest store.

import type { OwnedPokemonRecord } from '../owned-pokemon';
import type { OwnedPokemonRequestBody } from '../owned-pokemon-validation';
import {
  deleteGuestPokemon,
  listGuestPokemon,
  updateGuestPokemon,
} from './guest-store';
import { isGuestMode } from './guest-mode';

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
  if (isGuestMode()) {
    const allPokemon = listGuestPokemon();
    const data = allPokemon.slice(options.offset, options.offset + options.limit);
    return { data, hasMore: options.offset + data.length < allPokemon.length };
  }

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
  if (isGuestMode()) {
    deleteGuestPokemon(id);
    return;
  }

  const response = await fetch(`/api/owned-pokemon/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`削除に失敗しました (status=${response.status})`);
  }
}

/** Create a Pokémon in the active data store. */
export async function createOwnedPokemon(payload: OwnedPokemonRequestBody): Promise<{ id: string }> {
  if (isGuestMode()) {
    throw new Error('ログインすると、新しいポケモンを作成できます。');
  }

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
  return { id: body.data.id };
}

/** Replace a Pokémon in the active data store. */
export async function updateOwnedPokemon(id: string, payload: OwnedPokemonRequestBody): Promise<void> {
  if (isGuestMode()) {
    if (!updateGuestPokemon(id, payload)) {
      throw new Error('更新に失敗しました (指定された個体が見つかりません)');
    }
    return;
  }

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
}
