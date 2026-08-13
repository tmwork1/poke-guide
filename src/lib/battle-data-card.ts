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

export function formatRanked(rows: RankedRow[] | undefined, teammate = false): string {
  return (
    rows
      ?.slice(0, 4)
      .map((row) => `${row.rank}. ${row.name} — ${teammate || row.usageRate === null ? '使用率非公開' : `${row.usageRate}%`}`)
      .join('\n') || 'データなし'
  );
}

export function formatEvRanked(rows: EvRankedRow[] | undefined): string {
  return (
    rows
      ?.slice(0, 4)
      .map(
        (row) =>
          `${row.rank}. H${row.values.hp}/A${row.values.attack}/B${row.values.defense}/C${row.values.specialAttack}/D${row.values.specialDefense}/S${row.values.speed} — ${row.usageRate}%`,
      )
      .join('\n') || 'データなし'
  );
}
