import type { OwnedPokemonRecord } from '../owned-pokemon';
import { championSpriteUrl, officialArtworkUrl } from '../pokemon-master-data';
import { itemIconUrl, typeIconUrl } from '../sprite-urls';
import { NATURE_STAT_MODIFIERS, STAT_KEYS, type NatureStatModifier, type StatKey, calcHpStat, calcOtherStat } from '../stats';
import { DEFAULT_TYPE_COLOR, TYPE_COLORS, TYPE_COLOR_CSS_VARIABLES } from '../type-colors';

export interface PreviewPokemonMasterEntry {
  name: string;
  imageId: number;
  types: string[];
}

export interface PreviewPokemonDetailEntry {
  name: string;
  baseStats: number[];
  abilities?: string[];
}

export interface PokemonPreviewMasterData {
  species?: PreviewPokemonMasterEntry;
  detail?: PreviewPokemonDetailEntry;
}

export interface PokemonPreviewViewModel {
  speciesName: string;
  abilityName: string;
  itemName: string;
  moves: string[];
  level: number;
  natureName: string;
  nature: NatureStatModifier;
  ivs: number[];
  evs: number[];
  evLabels: string[];
  stats: Array<number | null>;
  imageId: number | undefined;
  championSpriteUrl: string | undefined;
  officialArtworkUrl: string | undefined;
  types: string[];
  typeIcons: Array<{ name: string; url: string | null; fallbackColor: string }>;
  background: string | undefined;
  itemIconUrl: string | undefined;
}

function statValues(values: readonly number[] | null | undefined, fallback: number): number[] {
  return STAT_KEYS.map((_, index) => values?.[index] ?? fallback);
}

function backgroundForTypes(types: readonly string[]): string | undefined {
  if (types.length === 0) return undefined;
  // メガ切替時に使っていた色式をSSRとクライアントで同一にする。
  const toMixedColor = (typeName: string): string => {
    const color = TYPE_COLOR_CSS_VARIABLES[typeName] ?? DEFAULT_TYPE_COLOR;
    return `color-mix(in srgb, ${color} 26%, var(--color-bg))`;
  };
  return types.length >= 2
    ? `linear-gradient(to right, ${toMixedColor(types[0])}, ${toMixedColor(types[1])})`
    : toMixedColor(types[0] ?? '');
}

/**
 * プレビューで使う表示値を、SSR・ゲスト復元・メガ切替で共通に組み立てる。
 * マスタの取得元は呼び出し側に任せ、ここでは表示計算だけを行う。
 */
export function buildPokemonPreviewViewModel(
  pokemon: Pick<OwnedPokemonRecord, 'species_name' | 'ability_name' | 'item_name' | 'move_names' | 'level' | 'nature' | 'ivs' | 'evs'>,
  master: PokemonPreviewMasterData,
): PokemonPreviewViewModel {
  const speciesName = pokemon.species_name.trim();
  const itemName = pokemon.item_name?.trim() ?? '';
  const level = pokemon.level ?? 50;
  const natureName = pokemon.nature ?? '';
  const nature = NATURE_STAT_MODIFIERS[natureName] ?? { up: null, down: null };
  const ivs = statValues(pokemon.ivs, 31);
  const evs = statValues(pokemon.evs, 0);
  const baseStats = master.detail?.baseStats;
  const stats = STAT_KEYS.map((key, index) => {
    const base = baseStats?.[index];
    if (typeof base !== 'number') return null;
    const multiplier = nature.up === key ? 1.1 : nature.down === key ? 0.9 : 1;
    return index === 0
      ? calcHpStat(level, base, ivs[index], evs[index])
      : calcOtherStat(level, base, ivs[index], evs[index], multiplier);
  });
  const types = master.species?.types ?? [];
  const imageId = master.species?.imageId;

  return {
    speciesName,
    abilityName: pokemon.ability_name?.trim() ?? '',
    itemName,
    moves: [0, 1, 2, 3].map((index) => pokemon.move_names[index] ?? ''),
    level,
    natureName,
    nature,
    ivs,
    evs,
    evLabels: evs.map((ev) => ev ? `+${ev}` : '-'),
    stats,
    imageId,
    championSpriteUrl: imageId === undefined ? undefined : championSpriteUrl(imageId),
    officialArtworkUrl: imageId === undefined ? undefined : officialArtworkUrl(imageId),
    types,
    typeIcons: types.map((name) => ({
      name,
      url: typeIconUrl(name),
      fallbackColor: TYPE_COLORS[name] ?? DEFAULT_TYPE_COLOR,
    })),
    background: backgroundForTypes(types),
    itemIconUrl: itemName ? itemIconUrl(itemName) : undefined,
  };
}

export { STAT_KEYS };
export type { StatKey };
