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

export interface RankedTeamsPage {
  teams: RankedTeam[];
  hasMore: boolean;
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

function toRankedTeams(rows: RawTeam[]): RankedTeam[] {
  return rows.map((row) => {
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

/**
 * 指定シーズンの存在だけを確認する。
 *
 * ページング結果が0件でも、offsetが末尾を越えただけの既存シーズンかもしれないため、
 * API側ではその場合に限ってこの軽量クエリを使う。
 */
export async function rankedSeasonExists(season: string, supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase
    .from('ranked_teams')
    .select('id')
    .eq('season', season)
    .limit(1);

  if (error) throw new Error('上位構築のシーズンを確認できませんでした', { cause: error });
  return (data?.length ?? 0) > 0;
}

function toPage(teams: RankedTeam[], limit: number | undefined): RankedTeam[] | RankedTeamsPage {
  if (limit === undefined) return teams;
  return { teams: teams.slice(0, limit), hasMore: teams.length > limit };
}

export function listRankedTeamsBySeason(
  season: string,
  supabase: SupabaseClient,
): Promise<RankedTeam[]>;
export function listRankedTeamsBySeason(
  season: string,
  supabase: SupabaseClient,
  options: { limit: number; offset?: number },
): Promise<RankedTeamsPage>;
export async function listRankedTeamsBySeason(
  season: string,
  supabase: SupabaseClient,
  options?: { limit?: number; offset?: number },
): Promise<RankedTeam[] | RankedTeamsPage> {
  let query = supabase
    .from('ranked_teams')
    .select(TEAM_SELECT)
    .eq('season', season)
    .order('rank', { ascending: true })
    .order('slot', { foreignTable: 'ranked_team_members', ascending: true });

  if (options?.limit !== undefined) {
    const offset = options.offset ?? 0;
    query = query.range(offset, offset + options.limit);
  }

  const { data, error } = await query;

  if (error) throw new Error('上位構築を取得できませんでした', { cause: error });
  return toPage(toRankedTeams((data ?? []) as unknown as RawTeam[]), options?.limit);
}

/** シーズン選択の「すべて」用。新しいシーズン順→シーズン内はrank順で横断取得する。 */
export function listAllRankedTeams(supabase: SupabaseClient): Promise<RankedTeam[]>;
export function listAllRankedTeams(
  supabase: SupabaseClient,
  options: { limit: number; offset?: number },
): Promise<RankedTeamsPage>;
export async function listAllRankedTeams(
  supabase: SupabaseClient,
  options?: { limit?: number; offset?: number },
): Promise<RankedTeam[] | RankedTeamsPage> {
  let query = supabase
    .from('ranked_teams')
    .select(TEAM_SELECT)
    .order('season_number', { ascending: false })
    .order('rank', { ascending: true })
    .order('slot', { foreignTable: 'ranked_team_members', ascending: true });

  if (options?.limit !== undefined) {
    const offset = options.offset ?? 0;
    query = query.range(offset, offset + options.limit);
  }

  const { data, error } = await query;

  if (error) throw new Error('上位構築を取得できませんでした', { cause: error });
  return toPage(toRankedTeams((data ?? []) as unknown as RawTeam[]), options?.limit);
}

/**
 * 指定種族を1体以上含む上位構築だけを取得する。
 *
 * 絞り込みには別名で2回目に埋め込んだ `match:ranked_team_members!inner` を使う。
 * `ranked_team_members` 側に直接 inner フィルタを掛けると埋め込みメンバーまで一致した
 * 種族だけに削られ、類似度計算に必要な全メンバーが返らないため。候補IDを `in('id', …)` で
 * 渡す2段構成は、人気種族で候補が数百件になるとURL長の上限に当たるので採らない。
 * PostgREST の max-rows(既定1000件)で切られないよう、ページングして全件を集める。
 */
export async function listRankedTeamsBySpeciesKeys(
  speciesKeys: readonly string[],
  supabase: SupabaseClient,
  season?: string,
): Promise<RankedTeam[]> {
  const keys = [...new Set(speciesKeys)];
  if (keys.length === 0) return [];
  const pageSize = 1000;
  const rows: RawTeam[] = [];
  for (let offset = 0; ; offset += pageSize) {
    let query = supabase
      .from('ranked_teams')
      .select(`${TEAM_SELECT}, match:ranked_team_members!inner(species_key)`)
      .in('match.species_key', keys);
    if (season !== undefined) query = query.eq('season', season);
    const { data, error } = await query
      .order('season_number', { ascending: false })
      .order('rank', { ascending: true })
      .order('id', { ascending: true })
      .order('slot', { foreignTable: 'ranked_team_members', ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error('類似する上位構築を取得できませんでした', { cause: error });
    const page = (data ?? []) as unknown as RawTeam[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return toRankedTeams(rows);
}
