// バトルデータカード(特性/性格/アイテム/わざ/努力値/同時採用ポケモン)の表示用ロジック。
// data/opgg-champions-usage の formats.single/double と同じ形の値を受け取る。
// DOMに依存しない純粋関数のみをここに置き、マークアップは
// src/components/data/BattleDataCard.astro 側に集約する。

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

// opgg-champions-usage の1件(formats.single/doubleを持つポケモン単位のレコード)が
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
