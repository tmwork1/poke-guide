// This module is server-only (SSR/API routes). Do not import it from browser scripts.
// It statically imports detail/pokemon.json (1.6 MB), so including it in a client bundle
// makes initial page JavaScript enormous; this previously happened via archetype.ts.
import pokemonDetailList from '../../public/master-data/detail/pokemon.json' with { type: 'json' };
import moveDetailList from '../../public/master-data/detail/moves.json' with { type: 'json' };

interface PokemonDetailEntry {
  name: string;
  baseStats: number[];
}

interface MoveDetailEntry {
  name: string;
  category: import('./archetype').MoveCategory;
}

export const SERVER_BASE_STATS_BY_SPECIES: ReadonlyMap<string, number[]> = new Map(
  (pokemonDetailList as PokemonDetailEntry[]).map((pokemon) => [pokemon.name, pokemon.baseStats]),
);

const MOVE_CATEGORY_BY_NAME: ReadonlyMap<string, import('./archetype').MoveCategory> = new Map(
  (moveDetailList as MoveDetailEntry[]).map((move) => [move.name, move.category]),
);

export function serverGetMoveCategory(
  moveName: string,
): import('./archetype').MoveCategory | undefined {
  return MOVE_CATEGORY_BY_NAME.get(moveName);
}
