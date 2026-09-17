// Client-side adapter for owned Pokémon data. Authenticated visitors use the
// existing HTTP API; guest visitors use the browser-only guest store.

import type { OwnedPokemonRecord } from '../owned-pokemon';
import type { OwnedPokemonRequestBody } from '../owned-pokemon-validation';
import type { OpponentBuildInput } from '../opponent-notes';
import {
  deleteGuestPokemon,
  ensureFixedGuestData,
  listGuestPokemon,
  updateGuestPokemon,
  type FixedGuestOpponentNoteInput,
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

/** Deterministic records available to every guest visitor. */
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
    item_name: 'リザードナイトY', tera_type: 'はがね', evs: [2, 0, 0, 32, 0, 32],
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
    item_name: 'ラグラージナイト', tera_type: 'はがね', evs: [32, 32, 0, 0, 0, 2],
    move_names: ['じしん', 'たきのぼり', 'れいとうパンチ', 'クイックターン'],
  },
  {
    id: 'guest-fixed-メガニウム',
    species_name: 'メガニウム', level: 50, nature: 'ずぶとい', ability_name: 'しんりょく',
    item_name: 'メガニウムナイト', tera_type: 'みず', evs: [32, 0, 32, 0, 0, 2],
    move_names: ['やどりぎのタネ', 'リフレクター', 'ちょうはつ', 'タネマシンガン'],
  },
  {
    id: 'guest-fixed-バクフーン',
    species_name: 'バクフーン', level: 50, nature: 'おくびょう', ability_name: 'もうか',
    item_name: 'こだわりスカーフ', tera_type: 'くさ', evs: [2, 0, 0, 32, 0, 32],
    move_names: ['かえんほうしゃ', 'だいちのちから', 'きあいだま', 'れいとうビーム'],
  },
  {
    id: 'guest-fixed-オーダイル',
    species_name: 'オーダイル', level: 50, nature: 'いじっぱり', ability_name: 'げきりゅう',
    item_name: 'ラムのみ', tera_type: 'ノーマル', evs: [2, 32, 0, 0, 0, 32],
    move_names: ['じしん', 'たきのぼり', 'しんそく', 'アイアンテール'],
  },
];

export const GUEST_FIXED_DATA_VERSION = 1;

const GUEST_FIXED_OPPONENTS = {
  garchomp: {
    name: 'ガブリアス', level: 50, nature: 'いじっぱり', abilityName: 'さめはだ', itemName: 'オボンのみ',
    moveNames: ['ドラゴンテール', 'じしん', 'ステルスロック', 'まきびし'], evs: [32, 0, 32, 0, 0, 2],
  },
  incineroar: {
    name: 'ガオガエン', level: 50, abilityName: 'いかく', itemName: 'オボンのみ',
    moveNames: ['つるぎのまい', 'ドレインパンチ'],
  },
  gholdengo: {
    name: 'サーフゴー', level: 50, abilityName: 'おうごんのからだ', itemName: 'こだわりスカーフ',
    moveNames: ['ゴールドラッシュ', 'シャドーボール', '10まんボルト', 'トリック'], evs: [1, 0, 0, 32, 1, 32],
  },
  corviknight: {
    name: 'アーマーガア', level: 50, nature: 'しんちょう', abilityName: 'プレッシャー', itemName: 'たべのこし',
    moveNames: ['ブレイブバード', 'ビルドアップ', 'はねやすめ', 'ちょうはつ'], evs: [32, 0, 0, 0, 28, 6],
  },
  swampert: {
    name: 'ラグラージ', level: 50, nature: 'いじっぱり', abilityName: 'すいすい', itemName: 'ラグラージナイト',
    moveNames: ['ウェーブタックル', 'じしん', 'れいとうパンチ', 'まもる'], evs: [16, 23, 0, 0, 0, 27],
  },
} satisfies Record<string, OpponentBuildInput>;

function fixedGuestNote(
  speciesName: string,
  noteNumber: number,
  opponent_build: OpponentBuildInput,
  moveNames: string[],
): FixedGuestOpponentNoteInput {
  return {
    id: `guest-fixed-note-${speciesName}-${noteNumber}`,
    owned_pokemon_id: `guest-fixed-${speciesName}`,
    input: {
      opponent_build,
      field: { direction: 'attack', attacks: moveNames.map((moveName) => ({ moveName })) },
      move_name: moveNames[0] ?? null,
      client_result: null,
      memo: null,
    },
  };
}

/** Two deterministic damage cards per fixed Pokémon: one hit and a sequence. */
export const GUEST_FIXED_OPPONENT_NOTES: FixedGuestOpponentNoteInput[] = [
  fixedGuestNote('フシギバナ', 1, GUEST_FIXED_OPPONENTS.garchomp, ['ヘドロばくだん']),
  fixedGuestNote('フシギバナ', 2, GUEST_FIXED_OPPONENTS.garchomp, ['ギガドレイン', 'ヘドロばくだん']),
  fixedGuestNote('リザードン', 1, GUEST_FIXED_OPPONENTS.gholdengo, ['かえんほうしゃ']),
  fixedGuestNote('リザードン', 2, GUEST_FIXED_OPPONENTS.gholdengo, ['エアスラッシュ', 'かえんほうしゃ']),
  fixedGuestNote('カメックス', 1, GUEST_FIXED_OPPONENTS.incineroar, ['ハイドロポンプ']),
  fixedGuestNote('カメックス', 2, GUEST_FIXED_OPPONENTS.incineroar, ['ハイドロポンプ', 'れいとうビーム']),
  fixedGuestNote('ジュカイン', 1, GUEST_FIXED_OPPONENTS.swampert, ['リーフストーム']),
  fixedGuestNote('ジュカイン', 2, GUEST_FIXED_OPPONENTS.swampert, ['リーフストーム', 'きあいだま']),
  fixedGuestNote('バシャーモ', 1, GUEST_FIXED_OPPONENTS.corviknight, ['フレアドライブ']),
  fixedGuestNote('バシャーモ', 2, GUEST_FIXED_OPPONENTS.corviknight, ['フレアドライブ', 'インファイト']),
  fixedGuestNote('ラグラージ', 1, GUEST_FIXED_OPPONENTS.garchomp, ['じしん']),
  fixedGuestNote('ラグラージ', 2, GUEST_FIXED_OPPONENTS.garchomp, ['じしん', 'たきのぼり']),
  fixedGuestNote('メガニウム', 1, GUEST_FIXED_OPPONENTS.garchomp, ['タネマシンガン']),
  fixedGuestNote('メガニウム', 2, GUEST_FIXED_OPPONENTS.garchomp, ['タネマシンガン', 'タネマシンガン']),
  fixedGuestNote('バクフーン', 1, GUEST_FIXED_OPPONENTS.gholdengo, ['かえんほうしゃ']),
  fixedGuestNote('バクフーン', 2, GUEST_FIXED_OPPONENTS.gholdengo, ['かえんほうしゃ', 'だいちのちから']),
  fixedGuestNote('オーダイル', 1, GUEST_FIXED_OPPONENTS.incineroar, ['たきのぼり']),
  fixedGuestNote('オーダイル', 2, GUEST_FIXED_OPPONENTS.incineroar, ['じしん', 'たきのぼり']),
];

/** Create and migrate the fixed guest Pokémon and their deterministic note cards. */
export function ensureFixedGuestPokemon(): void {
  ensureFixedGuestData({
    version: GUEST_FIXED_DATA_VERSION,
    pokemon: GUEST_FIXED_POKEMON,
    opponentNotes: GUEST_FIXED_OPPONENT_NOTES,
  });
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
      throw new Error('更新できませんでした (指定されたポケモンが見つかりません)');
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
