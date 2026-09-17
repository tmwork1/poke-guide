import type { SupabaseClient } from '@supabase/supabase-js';
import { createOpponentNote } from '../opponent-notes';
import type { OpponentBuildInput } from '../opponent-notes-validation';
import { validateOpponentNoteRequestBody } from '../opponent-notes-validation';
import { createOwnedPokemon, listOwnedPokemon } from '../owned-pokemon';
import type { OwnedPokemonRequestBody } from '../owned-pokemon-validation';
import { validateOwnedPokemonRequestBody } from '../owned-pokemon-validation';
import { getSupabaseAdminClient } from '../supabase';
import { createTeam, replaceTeam } from '../team';
import { validateTeamRequestBody } from '../team-validation';

/** Fixed samples supplied to every newly-created anonymous user. */
export const ANONYMOUS_STARTER_POKEMON: OwnedPokemonRequestBody[] = [
  { species_name: 'フシギバナ', level: 50, nature: 'ずぶとい', ability_name: 'しんりょく', item_name: 'たべのこし', tera_type: 'みず', evs: [32, 0, 32, 0, 0, 2], ivs: [31, 31, 31, 31, 31, 31], move_names: ['ギガドレイン', 'ヘドロばくだん', 'やどりぎのタネ', 'こうごうせい'], memo: null, tags: [] },
  { species_name: 'リザードン', level: 50, nature: 'おくびょう', ability_name: 'もうか', item_name: 'リザードナイトY', tera_type: 'はがね', evs: [2, 0, 0, 32, 0, 32], ivs: [31, 31, 31, 31, 31, 31], move_names: ['かえんほうしゃ', 'エアスラッシュ', 'りゅうのはどう', 'おにび'], memo: null, tags: [] },
  { species_name: 'カメックス', level: 50, nature: 'ひかえめ', ability_name: 'げきりゅう', item_name: 'オボンのみ', tera_type: 'フェアリー', evs: [2, 0, 0, 32, 0, 32], ivs: [31, 31, 31, 31, 31, 31], move_names: ['ハイドロポンプ', 'れいとうビーム', 'あくのはどう', 'からをやぶる'], memo: null, tags: [] },
  { species_name: 'ジュカイン', level: 50, nature: 'おくびょう', ability_name: 'しんりょく', item_name: 'きあいのタスキ', tera_type: 'くさ', evs: [2, 0, 0, 32, 0, 32], ivs: [31, 31, 31, 31, 31, 31], move_names: ['リーフストーム', 'りゅうのはどう', 'きあいだま', 'みがわり'], memo: null, tags: [] },
  { species_name: 'バシャーモ', level: 50, nature: 'いじっぱり', ability_name: 'かそく', item_name: 'いのちのたま', tera_type: 'ほのお', evs: [2, 32, 0, 0, 0, 32], ivs: [31, 31, 31, 31, 31, 31], move_names: ['フレアドライブ', 'インファイト', 'まもる', 'つるぎのまい'], memo: null, tags: [] },
  { species_name: 'ラグラージ', level: 50, nature: 'いじっぱり', ability_name: 'げきりゅう', item_name: 'ラグラージナイト', tera_type: 'はがね', evs: [32, 32, 0, 0, 0, 2], ivs: [31, 31, 31, 31, 31, 31], move_names: ['じしん', 'たきのぼり', 'れいとうパンチ', 'クイックターン'], memo: null, tags: [] },
  { species_name: 'メガニウム', level: 50, nature: 'ずぶとい', ability_name: 'しんりょく', item_name: 'メガニウムナイト', tera_type: 'みず', evs: [32, 0, 32, 0, 0, 2], ivs: [31, 31, 31, 31, 31, 31], move_names: ['やどりぎのタネ', 'リフレクター', 'ちょうはつ', 'タネマシンガン'], memo: null, tags: [] },
  { species_name: 'バクフーン', level: 50, nature: 'おくびょう', ability_name: 'もうか', item_name: 'こだわりスカーフ', tera_type: 'くさ', evs: [2, 0, 0, 32, 0, 32], ivs: [31, 31, 31, 31, 31, 31], move_names: ['かえんほうしゃ', 'だいちのちから', 'きあいだま', 'れいとうビーム'], memo: null, tags: [] },
  { species_name: 'オーダイル', level: 50, nature: 'いじっぱり', ability_name: 'げきりゅう', item_name: 'ラムのみ', tera_type: 'ノーマル', evs: [2, 32, 0, 0, 0, 32], ivs: [31, 31, 31, 31, 31, 31], move_names: ['じしん', 'たきのぼり', 'しんそく', 'アイアンテール'], memo: null, tags: [] },
];

const STARTER_OPPONENTS = {
  garchomp: { name: 'ガブリアス', level: 50, nature: 'いじっぱり', abilityName: 'さめはだ', itemName: 'オボンのみ', moveNames: ['ドラゴンテール', 'じしん', 'ステルスロック', 'まきびし'], evs: [32, 0, 32, 0, 0, 2] },
  incineroar: { name: 'ガオガエン', level: 50, abilityName: 'いかく', itemName: 'オボンのみ', moveNames: ['つるぎのまい', 'ドレインパンチ'] },
  gholdengo: { name: 'サーフゴー', level: 50, abilityName: 'おうごんのからだ', itemName: 'こだわりスカーフ', moveNames: ['ゴールドラッシュ', 'シャドーボール', '10まんボルト', 'トリック'], evs: [1, 0, 0, 32, 1, 32] },
  corviknight: { name: 'アーマーガア', level: 50, nature: 'しんちょう', abilityName: 'プレッシャー', itemName: 'たべのこし', moveNames: ['ブレイブバード', 'ビルドアップ', 'はねやすめ', 'ちょうはつ'], evs: [32, 0, 0, 0, 28, 6] },
  swampert: { name: 'ラグラージ', level: 50, nature: 'いじっぱり', abilityName: 'すいすい', itemName: 'ラグラージナイト', moveNames: ['ウェーブタックル', 'じしん', 'れいとうパンチ', 'まもる'], evs: [16, 23, 0, 0, 0, 27] },
} satisfies Record<string, OpponentBuildInput>;

type StarterOpponentNote = { speciesName: string; opponentBuild: OpponentBuildInput; moveNames: string[] };

function starterNote(speciesName: string, opponentBuild: OpponentBuildInput, moveNames: string[]): StarterOpponentNote {
  return { speciesName, opponentBuild, moveNames };
}

/** Two fixed damage cards for each starter Pokémon. */
export const ANONYMOUS_STARTER_OPPONENT_NOTES: StarterOpponentNote[] = [
  starterNote('フシギバナ', STARTER_OPPONENTS.garchomp, ['ヘドロばくだん']), starterNote('フシギバナ', STARTER_OPPONENTS.garchomp, ['ギガドレイン', 'ヘドロばくだん']),
  starterNote('リザードン', STARTER_OPPONENTS.gholdengo, ['かえんほうしゃ']), starterNote('リザードン', STARTER_OPPONENTS.gholdengo, ['エアスラッシュ', 'かえんほうしゃ']),
  starterNote('カメックス', STARTER_OPPONENTS.incineroar, ['ハイドロポンプ']), starterNote('カメックス', STARTER_OPPONENTS.incineroar, ['ハイドロポンプ', 'れいとうビーム']),
  starterNote('ジュカイン', STARTER_OPPONENTS.swampert, ['リーフストーム']), starterNote('ジュカイン', STARTER_OPPONENTS.swampert, ['リーフストーム', 'きあいだま']),
  starterNote('バシャーモ', STARTER_OPPONENTS.corviknight, ['フレアドライブ']), starterNote('バシャーモ', STARTER_OPPONENTS.corviknight, ['フレアドライブ', 'インファイト']),
  starterNote('ラグラージ', STARTER_OPPONENTS.garchomp, ['じしん']), starterNote('ラグラージ', STARTER_OPPONENTS.garchomp, ['じしん', 'たきのぼり']),
  starterNote('メガニウム', STARTER_OPPONENTS.garchomp, ['タネマシンガン']), starterNote('メガニウム', STARTER_OPPONENTS.garchomp, ['タネマシンガン', 'タネマシンガン']),
  starterNote('バクフーン', STARTER_OPPONENTS.gholdengo, ['かえんほうしゃ']), starterNote('バクフーン', STARTER_OPPONENTS.gholdengo, ['かえんほうしゃ', 'だいちのちから']),
  starterNote('オーダイル', STARTER_OPPONENTS.incineroar, ['たきのぼり']), starterNote('オーダイル', STARTER_OPPONENTS.incineroar, ['じしん', 'たきのぼり']),
];

const initializedUserIds = new Set<string>();
const inFlightInitializations = new Map<string, Promise<void>>();

function required<T>(value: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!value.ok) throw new Error(`Anonymous starter data validation failed: ${value.error}`);
  return value.value;
}

async function seedAnonymousStarterData(userId: string, supabase: SupabaseClient): Promise<void> {
  const existing = await listOwnedPokemon(userId, { limit: 1 }, supabase);
  if (!existing.ok) throw new Error(existing.error);
  if (existing.data.length > 0) return;

  const starterIds = new Map<string, string>();
  for (const rawPokemon of ANONYMOUS_STARTER_POKEMON) {
    const pokemon = required(validateOwnedPokemonRequestBody(rawPokemon));
    const created = await createOwnedPokemon(userId, pokemon, supabase);
    if (!created.ok) throw new Error(created.error);
    starterIds.set(created.data.species_name, created.data.id);
  }

  const teamInput = required(validateTeamRequestBody({
    memo: 'ゲスト用サンプルチーム',
    members: ANONYMOUS_STARTER_POKEMON.slice(0, 6).map((pokemon, index) => ({
      slot: index + 1,
      owned_pokemon_id: starterIds.get(pokemon.species_name) ?? '',
    })),
  }, { mode: 'replace' }));
  const createdTeam = await createTeam(userId, supabase);
  if (!createdTeam.ok) throw new Error(createdTeam.error);
  const savedTeam = await replaceTeam(userId, createdTeam.data.id, teamInput, supabase);
  if (!savedTeam.ok || !savedTeam.data) throw new Error(savedTeam.ok ? 'Failed to create starter team' : savedTeam.error);

  for (const note of ANONYMOUS_STARTER_OPPONENT_NOTES) {
    const ownedPokemonId = starterIds.get(note.speciesName);
    if (!ownedPokemonId) throw new Error(`Starter Pokémon is missing: ${note.speciesName}`);
    const input = required(validateOpponentNoteRequestBody({
      owned_pokemon_id: ownedPokemonId,
      opponent_build: note.opponentBuild,
      field: { direction: 'attack', attacks: note.moveNames.map((moveName) => ({ moveName })) },
      move_name: note.moveNames[0] ?? null,
      client_result: null,
      memo: null,
    }, { requireOwnedPokemonId: true }));
    const created = await createOpponentNote(userId, input, supabase);
    if (!created.ok) throw new Error(created.error);
  }
}

/**
 * Seed an anonymous account only when it owns no Pokémon. The process cache avoids
 * repeating the count query for a session while retaining a retry path after failures.
 */
export async function ensureAnonymousStarterData(userId: string): Promise<void> {
  if (initializedUserIds.has(userId)) return;
  const active = inFlightInitializations.get(userId);
  if (active) return active;

  const task = (async () => {
    const supabase = await getSupabaseAdminClient();
    await seedAnonymousStarterData(userId, supabase);
    initializedUserIds.add(userId);
  })();
  inFlightInitializations.set(userId, task);
  try {
    await task;
  } finally {
    inFlightInitializations.delete(userId);
  }
}
