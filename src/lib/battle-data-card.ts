// バトルデータカード(特性/性格/アイテム/わざ/努力値/同時採用ポケモン)の表示用ロジック。
// KVに保存するOP.GG使用率データの formats.single と同じ形の値を受け取る。
// DOMに依存しない純粋関数のみをここに置き、マークアップは
// src/components/data/BattleDataCard.astro 側に集約する。

import movesMasterRaw from '../../public/master-data/autocomplete/moves.json' with { type: 'json' };
import pokemonMasterRaw from '../../public/master-data/autocomplete/pokemon.json' with { type: 'json' };
import { NATURE_STAT_MODIFIERS, type StatKey } from './stats';
import { normalizeDigits } from './text-normalize.ts';

const STAT_SHORT_LABELS: Record<StatKey, string> = {
  hp: 'H',
  atk: 'A',
  def: 'B',
  spa: 'C',
  spd: 'D',
  spe: 'S',
};

export const MOVE_TYPE_BY_NAME: ReadonlyMap<string, string> = new Map(
  (movesMasterRaw as Array<{ name: string; type: string | null }>)
    .filter((move) => move.type !== null)
    .map((move) => [normalizeDigits(move.name), move.type!] as const),
);

export function moveTypeByName(name: string): string | null {
  return MOVE_TYPE_BY_NAME.get(normalizeDigits(name)) ?? null;
}

export const IMAGE_ID_BY_NAME: ReadonlyMap<string, number> = new Map(
  (pokemonMasterRaw as Array<{ name: string; imageId: number }>).map((pokemon) => [normalizeDigits(pokemon.name), pokemon.imageId]),
);

export function imageIdByName(name: string): number | null {
  return IMAGE_ID_BY_NAME.get(normalizeDigits(name)) ?? null;
}

export interface RankedRow {
  rank: number;
  name: string;
  usageRate: number | null;
}

export interface EvRankedRow {
  rank: number;
  usageRate: number;
  values: Record<string, number>;
}

export interface SingleFormatData {
  abilities?: RankedRow[];
  natures?: RankedRow[];
  items?: RankedRow[];
  moves?: RankedRow[];
  evs?: EvRankedRow[];
  teammates?: RankedRow[];
}

// OP.GG使用率データの1件(formats.singleを持つポケモン単位のレコード)が
// シングルバトルの表示に足るデータを持っているかどうか。
export function hasSingleBattleData(value: { formats?: { single?: SingleFormatData } } | null | undefined): boolean {
  const single = value?.formats?.single;
  return Boolean(
    single &&
      (['abilities', 'natures', 'items', 'moves', 'evs', 'teammates'] as const).some(
        (key) => Array.isArray(single[key]) && single[key]!.length > 0,
      ),
  );
}

export function usageRateLabel(usageRate: number | null): string {
  if (usageRate !== null) return `${usageRate.toFixed(0)}%`;
  return usageRate === null ? '使用率非公開' : `${usageRate}%`;
}

/** 性格名の能力補正を「A↑ C↓」形式で表示する。無補正・未知の性格は空文字列。 */
export function natureModifierLabel(name: string): string {
  const modifier = NATURE_STAT_MODIFIERS[name];
  if (!modifier?.up || !modifier.down) return '';
  return `${STAT_SHORT_LABELS[modifier.up]}↑ ${STAT_SHORT_LABELS[modifier.down]}↓`;
}

export function evSpreadLabel(values: Record<string, number>): string {
  const stats = [
    ['H', values.hp],
    ['A', values.attack],
    ['B', values.defense],
    ['C', values.specialAttack],
    ['D', values.specialDefense],
    ['S', values.speed],
  ] as const;

  return stats.filter(([, value]) => value !== 0).map(([label, value]) => `${label}${value}`).join(' ') || '0';
}
