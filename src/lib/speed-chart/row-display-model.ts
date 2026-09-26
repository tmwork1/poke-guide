import {
  SPEED_SPREADS,
  type SpeedChartEntry,
  type SpeedChartRow,
  type SpeedModifierEntry,
  type SpeedSpreadKind,
} from '../speed-chart.ts';

export interface SpeedChartRowMasterData {
  imageIdByName: ReadonlyMap<string, number>;
  baseSpeedByName: ReadonlyMap<string, number>;
}

export interface SpeedChartChipView {
  formName: string;
  rank: number;
  originName: string | null;
  imageId: number | null;
}

export interface SpeedChartRowGroupView {
  spreadKind: SpeedSpreadKind;
  spreadLabel: string;
  baseSpeed: number;
  baseSpeedLabel: string;
  magnitudeLabel: string | null;
  entries: SpeedChartChipView[];
}

export interface SpeedChartPhysicalRowView {
  value: number;
  valueText: string;
  classNames: string[];
  group: SpeedChartRowGroupView | null;
}

export function speedChartSpriteUrl(imageId: number): string {
  return `/pokemon-champion-sprites/icon/${imageId}.webp`;
}

/** Astro とブラウザの双方が使う、DOM に依存しない行表示モデル。 */
export function createSpeedChartRowDisplayModel(
  rows: readonly SpeedChartRow[],
  masterData: SpeedChartRowMasterData,
): SpeedChartPhysicalRowView[] {
  const result: SpeedChartPhysicalRowView[] = [];
  for (const row of rows) {
    if (row.entries.length === 0) {
      result.push({
        value: row.value,
        valueText: String(row.value),
        classNames: [
          'speed-chart-row',
          'speed-chart-row-owned-only',
          'speed-chart-row-single-group',
          'speed-chart-row-value-end',
        ],
        group: null,
      });
      continue;
    }

    const groups = groupEntriesIntoRowGroups(row.entries, masterData);
    groups.forEach((group, index) => {
      const classNames = ['speed-chart-row'];
      if (groups.length === 1) classNames.push('speed-chart-row-single-group');
      if (index === groups.length - 1) classNames.push('speed-chart-row-value-end');
      result.push({
        value: row.value,
        valueText: index === 0 ? String(row.value) : '',
        classNames,
        group,
      });
    });
  }
  return result;
}

function groupEntriesIntoRowGroups(
  entries: readonly SpeedChartEntry[],
  masterData: SpeedChartRowMasterData,
): SpeedChartRowGroupView[] {
  const groups = new Map<string, SpeedChartRowGroupView>();
  for (const entry of entries) {
    const baseSpeed = masterData.baseSpeedByName.get(entry.formName) ?? 0;
    const magnitudeLabel = entry.modifier ? formatModifierMagnitude(entry.modifier.modifier) : null;
    const key = `${entry.spread}|${baseSpeed}|${magnitudeLabel ?? 'none'}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        spreadKind: entry.spread,
        spreadLabel: SPEED_SPREADS[entry.spread].label,
        baseSpeed,
        baseSpeedLabel: `${baseSpeed}族`,
        magnitudeLabel,
        entries: [],
      };
      groups.set(key, group);
    }
    const originName = entry.modifier?.name ?? null;
    const existing = group.entries.find((candidate) => candidate.formName === entry.formName);
    if (!existing) {
      group.entries.push({
        formName: entry.formName,
        rank: entry.rank,
        originName,
        imageId: masterData.imageIdByName.get(entry.formName) ?? null,
      });
    } else if (existing.originName && originName && !existing.originName.split('/').includes(originName)) {
      existing.originName = `${existing.originName}/${originName}`;
    }
  }

  return Array.from(groups.values(), (group) => ({
    ...group,
    entries: [...group.entries].sort((a, b) => a.rank - b.rank || a.formName.localeCompare(b.formName, 'ja')),
  })).sort((a, b) => b.baseSpeed - a.baseSpeed);
}

function formatModifierMagnitude(modifier: SpeedModifierEntry): string {
  const ratio = modifier.kind === 'rank'
    ? (2 + modifier.stages) / 2
    : modifier.numerator / modifier.denominator;
  return `×${Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(1)}`;
}
