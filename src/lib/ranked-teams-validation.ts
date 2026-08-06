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
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) =>
    members.some((member) =>
      kanaIncludes(member.speciesKey ?? '', word) || kanaIncludes(member.speciesName, word),
    ),
  );
}
