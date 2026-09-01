// Client-side adapter for owned Pokémon data. Authenticated visitors use the
// existing HTTP API; guest visitors use the browser-only guest store.

import type { OwnedPokemonRecord } from '../owned-pokemon';
import type { OwnedPokemonRequestBody } from '../owned-pokemon-validation';
import {
  createGuestPokemonWithId,
  deleteGuestPokemon,
  listGuestPokemon,
  updateGuestPokemon,
  type GuestPokemonInput,
} from './guest-store';
import { isGuestMode } from './guest-mode';
import { ensureFixedGuestTeam } from './team-repo';

export interface ListOwnedPokemonPageOptions {
  limit: number;
  offset: number;
}

export interface OwnedPokemonPage {
  data: OwnedPokemonRecord[];
  hasMore: boolean;
}

/** The six deterministic records available to every guest visitor. */
export const GUEST_FIXED_POKEMON: Array<{ id: string } & GuestPokemonInput> = [
  {
    id: 'guest-fixed-フシギバナ',
    species_name: 'フシギバナ', level: 50, nature: 'ずぶとい', ability_name: 'しんりょく',
    item_name: 'たべのこし', tera_type: 'みず', evs: [32, 0, 32, 0, 0, 2],
    move_names: ['ギガドレイン', 'ヘドロばくだん', 'やどりぎのタネ', 'こうごうせい'],
  },
  {
    id: 'guest-fixed-リザードン',
    species_name: 'リザードン', level: 50, nature: 'おくびょう', ability_name: 'もうか',
    item_name: 'あつぞこブーツ', tera_type: 'はがね', evs: [2, 0, 0, 32, 0, 32],
    move_names: ['かえんほうしゃ', 'エアスラッシュ', 'りゅうのはどう', 'おにび'],
  },
  {
    id: 'guest-fixed-カメックス',
    species_name: 'カメックス', level: 50, nature: 'ひかえめ', ability_name: 'げきりゅう',
    item_name: 'オボンのみ', tera_type: 'フェアリー', evs: [2, 0, 0, 32, 0, 32],
    move_names: ['ハイドロポンプ', 'れいとうビーム', 'あくのはどう', 'からをやぶる'],
  },
  {
    id: 'guest-fixed-ジュカイン',
    species_name: 'ジュカイン', level: 50, nature: 'おくびょう', ability_name: 'しんりょく',
    item_name: 'きあいのタスキ', tera_type: 'くさ', evs: [2, 0, 0, 32, 0, 32],
    move_names: ['リーフストーム', 'りゅうのはどう', 'きあいだま', 'みがわり'],
  },
  {
    id: 'guest-fixed-バシャーモ',
    species_name: 'バシャーモ', level: 50, nature: 'いじっぱり', ability_name: 'かそく',
    item_name: 'いのちのたま', tera_type: 'ほのお', evs: [2, 32, 0, 0, 0, 32],
    move_names: ['フレアドライブ', 'インファイト', 'まもる', 'つるぎのまい'],
  },
  {
    id: 'guest-fixed-ラグラージ',
    species_name: 'ラグラージ', level: 50, nature: 'いじっぱり', ability_name: 'げきりゅう',
    item_name: 'とつげきチョッキ', tera_type: 'はがね', evs: [32, 32, 0, 0, 0, 2],
    move_names: ['じしん', 'たきのぼり', 'れいとうパンチ', 'クイックターン'],
  },
];

/** Create any missing fixed guest records without replacing guest edits. */
export function ensureFixedGuestPokemon(): void {
  const existingIds = new Set(listGuestPokemon().map((pokemon) => pokemon.id));
  for (const { id, ...pokemon } of GUEST_FIXED_POKEMON) {
    if (!existingIds.has(id)) createGuestPokemonWithId(id, pokemon);
  }
}

export async function listOwnedPokemonPage(
  options: ListOwnedPokemonPageOptions,
): Promise<OwnedPokemonPage> {
  if (isGuestMode()) {
    ensureFixedGuestTeam();
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
