import { kanaIncludes } from './kana.ts';
import type { RankedSeason } from './ranked-teams.ts';

export const RANKED_TEAMS_PAGE_SIZE = 50;

export function normalizeSeasonParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

export function resolveDefaultSeason(seasons: RankedSeason[]): string | null {
  if (seasons.length === 0) return null;
  return seasons.reduce((latest, season) =>
    season.seasonNumber > latest.seasonNumber ? season : latest,
  ).season;
}

export function matchesSpeciesSearch(
  members: ReadonlyArray<{ speciesKey: string | null; speciesName: string }>,
  term: string,
): boolean {
  // 複数の入力方法を許容しつつ、各語がチーム内のいずれかに一致する AND 条件は維持する。
  const words = term.trim().split(/[\s、,，・\/／]+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) =>
    members.some((member) =>
      kanaIncludes(member.speciesKey ?? '', word) || kanaIncludes(member.speciesName, word),
    ),
  );
}

export function matchesBuildSearch(
  members: ReadonlyArray<{
    ability: string | null;
    itemName: string | null;
    moveNames: readonly string[];
  }>,
  term: string,
): boolean {
  // 特性・アイテム・技を横断し、区切った各語は別メンバーに一致してもよい。
  const words = term.trim().split(/[\s、,，・\/／]+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) =>
    members.some((member) =>
      kanaIncludes(member.ability ?? '', word)
      || kanaIncludes(member.itemName ?? '', word)
      || member.moveNames.some((moveName) => kanaIncludes(moveName, word)),
    ),
  );
}
