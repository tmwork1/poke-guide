// teams / team_members への読み書きを集約するデータアクセス層
// (docs/plan/pages/team.md「確定した設計 > データモデル / API契約」)。
//
// ##### 最重要: このファイルが「他人のデータへの唯一の砦」であること #####
// src/lib/owned-pokemon.ts 冒頭のコメントと同じ方針: poke-commons の書き込みAPIは全て
// getSupabaseAdminClient()(service_role、RLSを常にバイパスする)経由で実行する設計のため、
// teams/team_members の RLSポリシー(migrations/007_teams.sql)はこの経路には一切効かない。
// 「ログイン中のユーザーが自分以外のチームを閲覧・改ざんできない」ことを保証するのは、
// この下の各関数が発行するクエリに必ず含む `.eq('user_id', userId)` のみである。
//
// そのため、この下の関数を実装・変更する際は必ず以下を守ること:
//   1. すべての公開関数は第一引数として `userId: string` を受け取る
//   2. teams / team_members への SELECT/UPDATE/DELETE には必ず `.eq('user_id', userId)` を含める
//      (対象行の所有者チェックを兼ねる。存在しないIDと他人のIDのいずれも同じ「0件」として扱い、
//      リソースの存在自体を漏らさない)
//   3. INSERT の user_id には必ずこの引数の userId を書き込む(リクエストボディ由来の値は使わない)
//   4. Supabase クライアントは呼び出し元(APIルート等)から注入させる(このファイル自身は
//      import.meta.env や getSupabaseAdminClient() を呼ばない)
//
// ##### セキュリティ: 他人の owned_pokemon をチームに紐付けられないようにする #####
// service_role は RLS をバイパスするため、`members[]` に含まれる owned_pokemon_id が
// 本人のものであることを、書き込み(replaceTeamMembers)前に必ずこのファイルで検証する。
// 1件でも他人のIDが混ざっていれば DB に一切書き込まず forbidden 扱いで拒否する。
// RPC関数(replace_team_members)側でも同じ検証を行うが、それは「最後の砦」であって
// このlib層の検証を省略してよい理由にはならない。
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OwnedPokemonRecord } from './owned-pokemon';
import type { TeamMemberInput } from './team-validation';

export interface TeamRecord {
  id: string;
  user_id: string;
  name: string | null;
  memo: string | null;
  // レギュレーション(migrations/013_regulation.sql)。'M-A' 等、未指定は null。
  regulation: string | null;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

// GET が返す1メンバーの形(docs/plan/pages/team.md「API契約」の TeamMember 型)。
export interface TeamMember {
  slot: number;
  owned_pokemon: OwnedPokemonRecord;
}

// 空き slot は配列に含めない(0〜6要素)。
export interface Team extends TeamRecord {
  members: TeamMember[];
}

export type TeamResult<T> = { ok: true; data: T } | { ok: false; error: string };

// replaceTeamMembers専用の結果型。violation: 'forbidden' はオーナーシップ検証で
// 弾かれたことを示し、呼び出し元(APIルート)がこれを 400 にマッピングできるようにする
// (それ以外の ok:false は DB エラー等の 500 相当として扱う想定)。
export type ReplaceTeamResult =
  | { ok: true; data: Team | null }
  | { ok: false; error: string; violation?: 'forbidden' };

export type TeamSort = 'updated_at' | 'name';

export interface ListTeamsOptions {
  sort?: TeamSort;
  // チーム名の部分一致(一覧の検索欄)。
  search?: string;
}

export interface ReplaceTeamInput {
  name: string | null;
  memo: string | null;
  regulation: string | null;
  members: TeamMemberInput[];
}

const TEAM_COLUMNS = 'id, user_id, name, memo, regulation, is_pinned, created_at, updated_at';

// nickname/species_name/level/nature/ability_name/item_name/tera_type/evs/ivs/move_names は
// 6枠カードの表示(公式絵・ニックネーム・テラスタイプ・持ち物・技4つ)に必要な列。
// memo/tags/is_pinned 等の owned_pokemon 側の個人的情報も、本人のチーム編集画面内でしか
// 出さないため(公開共有はスコープ外)、PublicOwnedPokemonRecord ではなく通常の全列を使う。
const TEAM_MEMBER_SELECT =
  `slot, owned_pokemon:owned_pokemon_id (
    id, user_id, nickname, species_name, level, nature, ability_name, item_name, tera_type,
    regulation, evs, ivs, move_names, memo, tags, is_pinned, source_build_slug, share_slug, is_public,
    created_at, updated_at, last_used_at
  )`;

const TEAM_SELECT_WITH_MEMBERS = `${TEAM_COLUMNS}, team_members ( ${TEAM_MEMBER_SELECT} )`;

function logError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[team] ${context}:`, error);
}

interface RawTeamRow extends TeamRecord {
  team_members: TeamMember[] | null;
}

// Supabase から返る `team_members: [{ slot, owned_pokemon }]` 埋め込み結果を
// Team.members(slot昇順)に正規化する。
function normalizeTeam(row: Record<string, unknown>): Team {
  const { team_members, ...rest } = row as unknown as RawTeamRow;
  const members = (team_members ?? [])
    .filter((m): m is TeamMember => !!m && !!m.owned_pokemon)
    .slice()
    .sort((a, b) => a.slot - b.slot);
  return { ...rest, members };
}

export async function listTeams(
  userId: string,
  options: ListTeamsOptions,
  supabase: SupabaseClient,
): Promise<TeamResult<Team[]>> {
  let query = supabase.from('teams').select(TEAM_SELECT_WITH_MEMBERS).eq('user_id', userId);

  if (options.search && options.search.trim() !== '') {
    // owned-pokemon.ts の listOwnedPokemon と同じ理由: PostgRESTの ilike パターンに使う
    // ワイルドカード文字はエスケープする(検索語由来の予期しないマッチを防ぐ)。
    const term = options.search.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike('name', `%${term}%`);
  }

  // owned-pokemon.tsのlistOwnedPokemonと
  // 同じ方針: ピン留めは常に上部固定したうえで、そのうえで並び替えキーを適用する
  // (実際の一覧画面はクライアント側で再ソートするため、この並びはAPIの契約としての一貫性のため)。
  query = query.order('is_pinned', { ascending: false });
  switch (options.sort) {
    case 'name':
      // 無題チーム(name=null)は末尾(listOwnedPokemonのnicknameソートと同じ方針)。
      query = query.order('name', { ascending: true, nullsFirst: false });
      break;
    case 'updated_at':
    default:
      query = query.order('updated_at', { ascending: false });
      break;
  }

  query = query.order('slot', { foreignTable: 'team_members', ascending: true });

  const { data, error } = await query;
  if (error) {
    logError('listTeams failed', error);
    return { ok: false, error: 'Failed to list teams' };
  }
  return { ok: true, data: (data ?? []).map((row) => normalizeTeam(row as Record<string, unknown>)) };
}

// 見つからない場合と他人の所有物である場合を区別せず null を返す(存在漏洩防止。GET /api/teams/:id は404)。
export async function getTeam(userId: string, id: string, supabase: SupabaseClient): Promise<TeamResult<Team | null>> {
  const { data, error } = await supabase
    .from('teams')
    .select(TEAM_SELECT_WITH_MEMBERS)
    .eq('id', id)
    .eq('user_id', userId)
    .order('slot', { foreignTable: 'team_members', ascending: true })
    .maybeSingle();

  if (error) {
    logError('getTeam failed', error);
    return { ok: false, error: 'Failed to fetch team' };
  }
  return { ok: true, data: data ? normalizeTeam(data as Record<string, unknown>) : null };
}

// 空チームを作成する(/team の追加カード用)。name/memoは未設定(null)、members は空。
export async function createTeam(userId: string, supabase: SupabaseClient): Promise<TeamResult<Team>> {
  const { data, error } = await supabase
    .from('teams')
    .insert({ user_id: userId }) // リクエストボディ由来の値は一切使わない
    .select(TEAM_COLUMNS)
    .single();

  if (error || !data) {
    logError('createTeam failed', error);
    return { ok: false, error: 'Failed to create team' };
  }
  return { ok: true, data: { ...(data as TeamRecord), members: [] } };
}

// PATCH /api/teams/:id: is_pinnedだけを更新する軽量経路(owned-pokemon.tsのupdatePinStatusと
// 同じ設計)。PUT(全項目上書き契約)とは別の追加経路であり、PUTの契約は変更しない。updated_atには
// 一切触れないため、「最終更新順」表示中にこれをトグルしても対象チーム自身の表示順位置が動かない
// ことを保証する。
// owned_pokemonのupdatePinStatusと異なりTeamはmembers(team_membersとのjoin)を持つため、
// UPDATEの.select(TEAM_COLUMNS)だけではmembersを含まないTeamRecordしか返らず、クライアント側の
// Team型(members必須)と不整合になる(実際にPlaywrightで「更新後、renderCardがt.members.lengthで
// クラッシュする」実機バグとして確認した)。そのためUPDATE後にgetTeam()で取り直し、
// 常にmembersを含む完全なTeamを返す(replaceTeamの最終ステップと同じ方針)。
// 対象が存在しない、または他人の所有物の場合は data: null を返す(0件更新。存在漏洩防止)。
export async function updateTeamPinStatus(
  userId: string,
  id: string,
  isPinned: boolean,
  supabase: SupabaseClient,
): Promise<TeamResult<Team | null>> {
  const { data, error } = await supabase
    .from('teams')
    .update({ is_pinned: isPinned })
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人のチームを更新できてしまう
    .select('id')
    .maybeSingle();

  if (error) {
    logError('updateTeamPinStatus failed', error);
    return { ok: false, error: 'Failed to update pin status' };
  }
  if (!data) return { ok: true, data: null };
  return getTeam(userId, id, supabase);
}

// 対象が存在しない、または他人の所有物の場合は false を返す(0件削除。存在漏洩防止)。
// team_members は ON DELETE CASCADE で自動的に削除される。
export async function deleteTeam(userId: string, id: string, supabase: SupabaseClient): Promise<TeamResult<boolean>> {
  const { data, error } = await supabase
    .from('teams')
    .delete()
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人のチームを削除できてしまう
    .select('id');

  if (error) {
    logError('deleteTeam failed', error);
    return { ok: false, error: 'Failed to delete team' };
  }
  return { ok: true, data: (data ?? []).length > 0 };
}

// PUT /api/teams/:id: name/memo/regulation/members の全項目上書き。
// メンバーの置換は supabase.rpc('replace_team_members', ...) で単一トランザクションとして行う
// (素朴な「DELETE→INSERT」の2リクエストにすると、DELETE成功→INSERT失敗で
// メンバーが全消失しうる)。
//
// 処理順序:
//   1. オーナーシップ検証: members[] の全 owned_pokemon_id が本人の owned_pokemon か確認。
//      1件でも欠けていれば DB に一切書き込まず forbidden で拒否する。
//   2. teams.name/memo/regulation を更新(対象が存在しない/他人の所有物なら data:null で即終了。
//      この場合 RPC は呼ばない = 404 相当のケースで無駄な書き込み試行をしない)。
//   3. supabase.rpc('replace_team_members', ...) でメンバーを置換(RPC内部でも所有確認を
//      行う。lib層の検証とは独立した「最後の砦」)。
//   4. 最新状態を getTeam で取り直して返す。
export async function replaceTeam(
  userId: string,
  id: string,
  input: ReplaceTeamInput,
  supabase: SupabaseClient,
): Promise<ReplaceTeamResult> {
  if (input.members.length > 0) {
    const uniqueIds = Array.from(new Set(input.members.map((m) => m.owned_pokemon_id)));
    const { data: ownedRows, error: ownedError } = await supabase
      .from('owned_pokemon')
      .select('id')
      .eq('user_id', userId)
      .in('id', uniqueIds);

    if (ownedError) {
      logError('replaceTeam ownership check failed', ownedError);
      return { ok: false, error: 'Failed to verify owned_pokemon ownership' };
    }

    const ownedIdSet = new Set((ownedRows ?? []).map((r) => (r as { id: string }).id));
    const hasForeignId = uniqueIds.some((memberId) => !ownedIdSet.has(memberId));
    if (hasForeignId) {
      return {
        ok: false,
        error: 'One or more owned_pokemon_id do not belong to the current user',
        violation: 'forbidden',
      };
    }
  }

  const { data: updatedTeam, error: updateError } = await supabase
    .from('teams')
    .update({
      name: input.name,
      memo: input.memo,
      regulation: input.regulation,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人のチームを更新できてしまう
    .select('id')
    .maybeSingle();

  if (updateError) {
    logError('replaceTeam update failed', updateError);
    return { ok: false, error: 'Failed to update team' };
  }
  if (!updatedTeam) {
    // 対象が存在しない、または他人の所有物(存在漏洩防止のため区別しない)。
    return { ok: true, data: null };
  }

  const { error: rpcError } = await supabase.rpc('replace_team_members', {
    p_user_id: userId,
    p_team_id: id,
    p_members: input.members,
  });

  if (rpcError) {
    logError('replaceTeam replace_team_members rpc failed', rpcError);
    return { ok: false, error: 'Failed to replace team members' };
  }

  return getTeam(userId, id, supabase);
}
