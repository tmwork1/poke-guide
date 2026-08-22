import type { SupabaseClient } from '@supabase/supabase-js';

export interface RankedTeamMember {
  slot: number;
  speciesKey: string | null;
  speciesName: string;
  formName: string | null;
  itemName: string | null;
  ability: string | null;
  nature: string | null;
  evs: number[] | null;
  moveNames: string[];
  type1: string | null;
  type2: string | null;
}

export interface RankedTeam {
  id: string;
  season: string;
  rank: number;
  rating: number | null;
  rule: string;
  trainerName: string | null;
  articleUrl: string | null;
  articleTitle: string | null;
  articleHost: string | null;
  members: RankedTeamMember[];
}

export interface RankedSeason {
  season: string;
  seasonNumber: number;
}

interface RawMember {
  slot: number;
  species_key: string | null;
  species_name: string;
  form_name: string | null;
  item_name: string | null;
  ability: string | null;
  nature: string | null;
  evs: number[] | null;
  move_names: string[] | null;
  type1: string | null;
  type2: string | null;
}

interface RawTeam {
  id: string;
  season: string;
  rank: number;
  rating: string | number | null;
  rule: string;
  trainer_name: string | null;
  article_url: string | null;
  article_title: string | null;
  article_host: string | null;
  ranked_team_members: RawMember[] | null;
}

const TEAM_SELECT = `
  id, season, rank, rating, rule, trainer_name, article_url, article_title, article_host,
  ranked_team_members (slot, species_key, species_name, form_name, item_name, ability, nature, evs, move_names, type1, type2)
`;

export async function listRankedSeasons(supabase: SupabaseClient): Promise<RankedSeason[]> {
  const { data, error } = await supabase
    .from('ranked_teams')
    .select('season, season_number')
    .order('season_number', { ascending: false });

  if (error) throw new Error('上位構築のシーズン一覧を取得できませんでした', { cause: error });

  const bySeason = new Map<string, RankedSeason>();
  for (const row of data ?? []) {
    const season = String(row.season);
    if (!bySeason.has(season)) {
      bySeason.set(season, { season, seasonNumber: Number(row.season_number) });
    }
  }
  return [...bySeason.values()].sort((a, b) => b.seasonNumber - a.seasonNumber);
}

export async function listRankedTeamsBySeason(
  season: string,
  supabase: SupabaseClient,
): Promise<RankedTeam[]> {
  const { data, error } = await supabase
    .from('ranked_teams')
    .select(TEAM_SELECT)
    .eq('season', season)
    .order('rank', { ascending: true })
    .order('slot', { foreignTable: 'ranked_team_members', ascending: true });

  if (error) throw new Error('上位構築を取得できませんでした', { cause: error });

  return ((data ?? []) as unknown as RawTeam[]).map((row) => {
    const numericRating = row.rating === null ? null : Number(row.rating);
    return {
      id: row.id,
      season: row.season,
      rank: row.rank,
      rating: numericRating !== null && Number.isFinite(numericRating) ? numericRating : null,
      rule: row.rule,
      trainerName: row.trainer_name,
      articleUrl: row.article_url,
      articleTitle: row.article_title,
      articleHost: row.article_host,
      members: (row.ranked_team_members ?? [])
        .map((member) => ({
          slot: member.slot,
          speciesKey: member.species_key,
          speciesName: member.species_name,
          formName: member.form_name,
          itemName: member.item_name,
          ability: member.ability,
          nature: member.nature,
          evs: member.evs,
          // 記事に技の記載がない NULL は、描画側で反復可能な空配列へ正規化する。
          moveNames: member.move_names ?? [],
          type1: member.type1,
          type2: member.type2,
        }))
        .sort((a, b) => a.slot - b.slot),
    };
  });
}
