// Client-side adapter for owned Pokémon data. Authenticated visitors use the
// existing HTTP API; guest visitors use the browser-only guest store.

import type { OwnedPokemonRecord } from '../owned-pokemon';
import type { OwnedPokemonRequestBody } from '../owned-pokemon-validation';
import {
  createGuestPokemon,
  deleteGuestPokemon,
  isGuestStoreInitialized,
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

// Names for species, natures, items, tera types, and moves are copied from
// scripts/db/dummy-species-pools.mjs. Ability names are also present in the
// application's master data. EVs use this app's Champions-format scale
// (0-32 per stat, 66 total budget — see owned-pokemon-validation.ts and
// LeftPanel.astro's `66 - total` remaining-EV calculation), not the
// standard 0-252/510 scale.
export const GUEST_SAMPLE_POKEMON = [
  {
    species_name: 'カイリュー',
    level: 50,
    nature: 'いじっぱり',
    ability_name: 'マルチスケイル',
    item_name: 'こだわりハチマキ',
    tera_type: 'ほのお',
    evs: [2, 32, 0, 0, 0, 32],
    move_names: ['じしん', 'げきりん', 'しんそく', 'りゅうのまい'],
  },
  {
    species_name: 'ハバタクカミ',
    level: 50,
    nature: 'おくびょう',
    ability_name: 'こだいかっせい',
    item_name: 'こだわりメガネ',
    tera_type: 'フェアリー',
    evs: [2, 0, 0, 32, 0, 32],
    move_names: ['ムーンフォース', 'シャドーボール', 'ちょうはつ', 'こごえるかぜ'],
  },
  {
    species_name: 'パオジアン',
    level: 50,
    nature: 'ようき',
    ability_name: 'わざわいのつるぎ',
    item_name: 'きあいのタスキ',
    tera_type: 'あく',
    evs: [2, 32, 0, 0, 0, 32],
    move_names: ['つららばり', 'ふいうち', 'つるぎのまい', 'けたぐり'],
  },
];

export function ensureGuestSamples(): void {
  if (isGuestStoreInitialized()) return;

  for (const pokemon of GUEST_SAMPLE_POKEMON) {
    createGuestPokemon(pokemon);
  }
}

export async function listOwnedPokemonPage(
  options: ListOwnedPokemonPageOptions,
): Promise<OwnedPokemonPage> {
  if (isGuestMode()) {
    ensureGuestSamples();
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
    return { id: createGuestPokemon(payload).id };
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
      throw new Error('保存に失敗しました (指定された個体が見つかりません)');
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
    throw new Error(body.error ?? `保存に失敗しました (status=${response.status})`);
  }
}
