// Browser-only storage for data created while the visitor is not signed in.
//
// This module deliberately does not import any server/runtime dependencies. It is
// intended to be imported from client-side <script> tags only.

import type { OwnedPokemonRecord } from '../owned-pokemon';
import type { Team, TeamMember, TeamRecord } from '../team';

const STORAGE_KEY = 'pokeguide.guest.v2';
const LEGACY_STORAGE_KEY = 'pokeguide.guest.v1';
const GUEST_ID_PREFIX = 'guest-';

/** The persisted form omits server-only account and migration columns. */
export type GuestPokemonData = Omit<OwnedPokemonRecord, 'user_id' | 'guest_local_id'>;

/** The persisted form keeps the local Pokémon reference, just like team_members. */
export interface GuestTeamMemberInput {
  slot: number;
  owned_pokemon_id: string;
  item_override?: string | null;
}

export interface GuestTeamData extends Omit<TeamRecord, 'user_id'> {
  members: GuestTeamMemberInput[];
}

export type GuestPokemonInput = Partial<
  Omit<GuestPokemonData, 'id' | 'created_at' | 'updated_at'>
>;

export interface GuestTeamInput {
  memo?: string | null;
  members?: readonly GuestTeamMemberInput[];
  is_pinned?: boolean;
}

interface GuestStoreState {
  version: 2;
  initialized: boolean;
  pokemon: GuestPokemonData[];
  teams: GuestTeamData[];
}

let memoryState: GuestStoreState = emptyState();
let storageUnavailable = false;
let legacyStorageChecked = false;

function emptyState(): GuestStoreState {
  return { version: 2, initialized: false, pokemon: [], teams: [] };
}

function isGuestId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(GUEST_ID_PREFIX);
}

function clonePokemon(pokemon: GuestPokemonData): GuestPokemonData {
  return {
    ...pokemon,
    evs: [...pokemon.evs],
    ivs: [...pokemon.ivs],
    move_names: [...pokemon.move_names],
    tags: [...pokemon.tags],
  };
}

function cloneMember(member: GuestTeamMemberInput): GuestTeamMemberInput {
  return { ...member, item_override: member.item_override ?? null };
}

function cloneTeam(team: GuestTeamData): GuestTeamData {
  return { ...team, members: team.members.map(cloneMember) };
}

function cloneState(state: GuestStoreState): GuestStoreState {
  return {
    version: 2,
    initialized: state.initialized,
    pokemon: state.pokemon.map(clonePokemon),
    teams: state.teams.map(cloneTeam),
  };
}

function warnStorageUnavailable(error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[guest-store] localStorage is unavailable; guest data will only be kept in memory.', error);
}

function warnInvalidStoredData(error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('[guest-store] Ignoring invalid guest data stored in localStorage.', error);
}

function isStoredState(value: unknown): value is GuestStoreState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<GuestStoreState>;
  return state.version === 2
    && typeof state.initialized === 'boolean'
    && Array.isArray(state.pokemon)
    && Array.isArray(state.teams);
}

/**
 * Read the persisted snapshot. A storage exception permanently selects the
 * in-memory fallback for this module instance, so subsequent operations stay
 * usable even in private-browsing environments.
 */
function readState(): GuestStoreState {
  if (storageUnavailable) return cloneState(memoryState);

  let raw: string | null;
  try {
    // v1 contains the retired guest samples and any old user-created records.
    // This is intentionally a discard rather than a migration.
    if (!legacyStorageChecked) {
      globalThis.localStorage.removeItem(LEGACY_STORAGE_KEY);
      legacyStorageChecked = true;
    }
    raw = globalThis.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    storageUnavailable = true;
    warnStorageUnavailable(error);
    return cloneState(memoryState);
  }

  if (!raw) {
    memoryState = emptyState();
    return cloneState(memoryState);
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredState(parsed)) {
      warnInvalidStoredData(new Error('Unexpected guest-store snapshot format'));
      memoryState = emptyState();
      return cloneState(memoryState);
    }
    memoryState = cloneState(parsed);
    return cloneState(memoryState);
  } catch (error) {
    warnInvalidStoredData(error);
    memoryState = emptyState();
    return cloneState(memoryState);
  }
}

function writeState(state: GuestStoreState): void {
  memoryState = cloneState(state);
  if (storageUnavailable) return;

  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    storageUnavailable = true;
    warnStorageUnavailable(error);
  }
}

function mutateState<T>(mutate: (state: GuestStoreState) => T): T {
  const state = readState();
  const result = mutate(state);
  state.initialized = true;
  writeState(state);
  return result;
}

function guestId(): string {
  return `${GUEST_ID_PREFIX}${crypto.randomUUID()}`;
}

function toOwnedPokemonRecord(pokemon: GuestPokemonData): OwnedPokemonRecord {
  // Existing client rendering code expects the authenticated record shape. The
  // empty value is only a type-compatibility placeholder and is never persisted.
  return { ...clonePokemon(pokemon), user_id: '', guest_local_id: null };
}

function normalizeMembers(
  members: readonly GuestTeamMemberInput[],
  pokemon: readonly GuestPokemonData[],
): GuestTeamMemberInput[] {
  const pokemonIds = new Set(pokemon.map((entry) => entry.id));
  const slots = new Set<number>();
  const pokemonIdsInTeam = new Set<string>();
  const normalized: GuestTeamMemberInput[] = [];

  for (const member of members) {
    if (
      !Number.isInteger(member.slot)
      || member.slot < 1
      || member.slot > 6
      || !isGuestId(member.owned_pokemon_id)
      || !pokemonIds.has(member.owned_pokemon_id)
      || slots.has(member.slot)
      || pokemonIdsInTeam.has(member.owned_pokemon_id)
    ) {
      continue;
    }
    slots.add(member.slot);
    pokemonIdsInTeam.add(member.owned_pokemon_id);
    normalized.push({
      slot: member.slot,
      owned_pokemon_id: member.owned_pokemon_id,
      item_override: member.item_override ?? null,
    });
  }

  return normalized.sort((a, b) => a.slot - b.slot);
}

function resolveTeam(team: GuestTeamData, pokemon: readonly GuestPokemonData[]): Team {
  const pokemonById = new Map(pokemon.map((entry) => [entry.id, entry]));
  const members: TeamMember[] = team.members
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .flatMap((member) => {
      const ownedPokemon = pokemonById.get(member.owned_pokemon_id);
      if (!ownedPokemon) return [];
      return [{
        slot: member.slot,
        item_override: member.item_override ?? null,
        owned_pokemon: toOwnedPokemonRecord(ownedPokemon),
      }];
    });

  return { ...cloneTeam(team), user_id: '', members };
}

/** List guest Pokémon in the same newest-first order as the server store. */
export function listGuestPokemon(): OwnedPokemonRecord[] {
  return readState()
    .pokemon
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(toOwnedPokemonRecord);
}

export function getGuestPokemon(id: string): OwnedPokemonRecord | null {
  const pokemon = readState().pokemon.find((entry) => entry.id === id);
  return pokemon ? toOwnedPokemonRecord(pokemon) : null;
}

export function createGuestPokemon(input: GuestPokemonInput = {}): OwnedPokemonRecord {
  return createGuestPokemonWithId(guestId(), input);
}

/** Insert a deterministic record used by the fixed guest starter data. */
export function createGuestPokemonWithId(id: string, input: GuestPokemonInput = {}): OwnedPokemonRecord {
  if (!isGuestId(id)) throw new Error('Guest Pokémon IDs must start with guest-');
  return mutateState((state) => {
    const existing = state.pokemon.find((pokemon) => pokemon.id === id);
    if (existing) return toOwnedPokemonRecord(existing);

    const now = new Date().toISOString();
    const pokemon: GuestPokemonData = {
      id,
      species_name: input.species_name ?? '',
      level: input.level ?? null,
      nature: input.nature ?? null,
      ability_name: input.ability_name ?? null,
      item_name: input.item_name ?? null,
      tera_type: input.tera_type ?? null,
      evs: [...(input.evs ?? [0, 0, 0, 0, 0, 0])],
      ivs: [...(input.ivs ?? [31, 31, 31, 31, 31, 31])],
      move_names: [...(input.move_names ?? [])],
      memo: input.memo ?? null,
      tags: [...(input.tags ?? [])],
      source_build_slug: input.source_build_slug ?? null,
      share_slug: input.share_slug ?? null,
      is_public: input.is_public ?? false,
      created_at: now,
      updated_at: now,
      last_used_at: input.last_used_at ?? null,
      collection_opt_out_until: input.collection_opt_out_until ?? null,
      archetype_id: input.archetype_id ?? null,
    };
    state.pokemon.push(pokemon);
    return toOwnedPokemonRecord(pokemon);
  });
}

export function updateGuestPokemon(id: string, patch: GuestPokemonInput): OwnedPokemonRecord | null {
  return mutateState((state) => {
    const pokemon = state.pokemon.find((entry) => entry.id === id);
    if (!pokemon) return null;

    const next: GuestPokemonData = {
      ...pokemon,
      ...patch,
      evs: patch.evs === undefined ? [...pokemon.evs] : [...patch.evs],
      ivs: patch.ivs === undefined ? [...pokemon.ivs] : [...patch.ivs],
      move_names: patch.move_names === undefined ? [...pokemon.move_names] : [...patch.move_names],
      tags: patch.tags === undefined ? [...pokemon.tags] : [...patch.tags],
      id: pokemon.id,
      created_at: pokemon.created_at,
      updated_at: new Date().toISOString(),
    };
    Object.assign(pokemon, next);
    return toOwnedPokemonRecord(pokemon);
  });
}

/** Deleting a Pokémon also removes its team references, mirroring ON DELETE CASCADE. */
export function deleteGuestPokemon(id: string): boolean {
  return mutateState((state) => {
    const before = state.pokemon.length;
    state.pokemon = state.pokemon.filter((entry) => entry.id !== id);
    if (state.pokemon.length === before) return false;

    const now = new Date().toISOString();
    state.teams = state.teams.map((team) => {
      const members = team.members.filter((member) => member.owned_pokemon_id !== id);
      return members.length === team.members.length ? team : { ...team, members, updated_at: now };
    });
    return true;
  });
}

/** List teams with local owned_pokemon_id references resolved into full records. */
export function listGuestTeams(): Team[] {
  const state = readState();
  return state.teams
    .slice()
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return b.updated_at.localeCompare(a.updated_at);
    })
    .map((team) => resolveTeam(team, state.pokemon));
}

export function getGuestTeam(id: string): Team | null {
  const state = readState();
  const team = state.teams.find((entry) => entry.id === id);
  return team ? resolveTeam(team, state.pokemon) : null;
}

/** Insert a deterministic team used by the fixed guest starter data. */
export function createGuestTeamWithId(id: string, input: GuestTeamInput): Team {
  if (!isGuestId(id)) throw new Error('Guest team IDs must start with guest-');
  return mutateState((state) => {
    const existing = state.teams.find((team) => team.id === id);
    if (existing) return resolveTeam(existing, state.pokemon);

    const now = new Date().toISOString();
    const team: GuestTeamData = {
      id,
      memo: input.memo ?? null,
      is_pinned: input.is_pinned ?? false,
      created_at: now,
      updated_at: now,
      members: normalizeMembers(input.members ?? [], state.pokemon),
    };
    state.teams.push(team);
    return resolveTeam(team, state.pokemon);
  });
}

/** Replaces supplied memo and/or members; omitted properties retain their current value. */
export function updateGuestTeam(id: string, input: GuestTeamInput): Team | null {
  return mutateState((state) => {
    const team = state.teams.find((entry) => entry.id === id);
    if (!team) return null;

    const next: GuestTeamData = {
      ...team,
      memo: input.memo === undefined ? team.memo : input.memo,
      is_pinned: input.is_pinned === undefined ? team.is_pinned : input.is_pinned,
      members: input.members === undefined
        ? team.members.map(cloneMember)
        : normalizeMembers(input.members, state.pokemon),
      updated_at: new Date().toISOString(),
    };
    Object.assign(team, next);
    return resolveTeam(team, state.pokemon);
  });
}

export function deleteGuestTeam(id: string): boolean {
  return mutateState((state) => {
    const before = state.teams.length;
    state.teams = state.teams.filter((entry) => entry.id !== id);
    return state.teams.length !== before;
  });
}

/** Whether the v2 guest store has ever been written. */
export function isGuestStoreInitialized(): boolean {
  return readState().initialized;
}
