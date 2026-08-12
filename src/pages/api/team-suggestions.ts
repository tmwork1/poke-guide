// GET /api/team-suggestions: チーム編集画面のポケモンサジェスト。
// 編集中のチームメンバー(owned_pokemon の id)を受け取り、合算プールのチーム
// (上位入賞チーム ranked_teams + アプリで組まれたチーム teams、migrations/021)の中で
// それらとよく一緒にいるポケモンの型をランキングして返す。
//
// ■ なぜチームIDではなくメンバーIDの配列を受け取るのか
// チーム編集画面は自動保存(700msデバウンス)で、ユーザーが枠を触ってから保存が完了するまでの
// 間はDB上のチームと画面上のチームが食い違う。サジェストは「今画面に並んでいる編成」に
// 追随しないと意味が無いため、保存済みのチームを読み直すのではなくクライアントの現在状態を
// そのまま受け取る。IDだけを受け取り個体の中身はサーバで引き直すのは、所有権の確認
// (listOwnedPokemonByIds の user_id 絞り込み)を必ず通すため。
//
// ■ スコアリングは src/lib/team-suggest.ts、集計は migrations/016 のSQL関数
// このファイルの責務は「認証・入力検証・呼び出し順の制御・レスポンス整形」だけで、
// 数式もSQLも書かない(既存APIルートが生のSupabaseクエリをlib層へ委譲しているのと同じ分業)。
import type { APIContext } from 'astro';
import { badRequest, isValidUuid, jsonResponse, methodNotAllowed } from './_shared';
import { getSessionUser } from '../../lib/user-session';
import { getSupabaseAdminClient, getSupabasePublicClient } from '../../lib/supabase';
import { listOwnedPokemonByIds } from '../../lib/owned-pokemon';
import { classifyArchetype, type ArchetypeKey, type ArchetypeRole } from '../../lib/archetype';
import { resolveDexNo } from '../../lib/species-dex';
import {
  chooseArchetypeForSpecies,
  rankPartnerSpecies,
  rankSpeciesByUsage,
  weightSeedArchetypes,
  type ArchetypeStat,
  type RankedArchetype,
  type SpeciesPairStat,
  type SpeciesScore,
} from '../../lib/team-suggest';

export const prerender = false;

// チームは6体までなので、それを超えるIDが来たら入力が壊れている。
const MAX_MEMBER_IDS = 6;

// 段1で残す候補種族の数。段2のSQL(team_partner_archetype_stats)へ渡す種族数がこれで決まる。
// 実測でこの数の種族に対して返る行は数十行のため、Workerの負荷はほぼ候補数に比例しない。
const CANDIDATE_SPECIES_LIMIT = 12;
// 画面に出す最終的な件数。右パネルの高さに収まる範囲。
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;

interface SuggestionItem {
  speciesName: string;
  dexNo: number | null;
  /**
   * 型の識別子ではなく推定値 ── その型で最も多く採用されている特性(migrations/018)。
   * 構築データ上の観測率が持ち物99.5%に対し特性58.7%しかないため識別キーから外した。
   * 実測では持ち物が分かっていれば最頻特性が87.7%当たる。
   */
  abilityName: string | null;
  itemName: string | null;
  role: ArchetypeRole | null;
  /** その種族を薦めるとき、提示した型である確からしさ(0〜1)。型が無い場合は null */
  archetypeShare: number | null;
  /** 提示した型が出現したチーム数 */
  archetypeTeams: number | null;
  /** 候補種族の採用チーム数と母集団 */
  usageTeams: number;
  totalTeams: number;
  /** 持ち物が自チームの誰かと重複する(そのままでは編成できない) */
  itemConflict: boolean;
  /** 表示する根拠。チームが空のときは null(採用率順のため主語が無い) */
  reason: {
    seedSpeciesName: string;
    coTeams: number;
    seedTeams: number;
    ratio: number;
    lift: number;
  } | null;
}

function parseMemberIds(raw: string | null): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!raw || raw.trim() === '') return { ok: true, ids: [] };
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length > MAX_MEMBER_IDS) {
    return { ok: false, error: `member_ids must contain at most ${MAX_MEMBER_IDS} ids` };
  }
  for (const id of ids) {
    if (!isValidUuid(id)) return { ok: false, error: 'member_ids must be a comma-separated list of uuids' };
  }
  // 同じ個体が2回渡ってきても共起の重みが二重に効かないよう畳む。
  return { ok: true, ids: [...new Set(ids)] };
}

export async function GET({ request, cookies, url }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const parsed = parseMemberIds(url.searchParams.get('member_ids'));
  if (!parsed.ok) return badRequest(parsed.error);

  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const value = Number(limitParam);
    if (!Number.isInteger(value) || value < 1) return badRequest('limit must be a positive integer');
    limit = Math.min(value, MAX_LIMIT);
  }

  // 個体の読み出しだけは所有者本人に限る必要があるため admin クライアント + user_id 絞り込み。
  // 集計側は anon クライアントで読む(最小権限)。021 で母集団に非公開テーブル
  // (owned_pokemon / teams)が入ったが、集計関数が SECURITY DEFINER になっていて
  // 返すのは件数と比率だけなので、呼び出し側の権限を上げる必要は無い。
  const admin = await getSupabaseAdminClient();
  const members = await listOwnedPokemonByIds(user.id, parsed.ids, admin);
  if (!members.ok) return jsonResponse({ error: members.error }, 500);

  const seedSpecies = [...new Set(members.data.map((m) => m.species_name).filter((s): s is string => !!s && s !== ''))];
  const seedKeys: (ArchetypeKey | null)[] = members.data.map((m) =>
    classifyArchetype({
      speciesName: m.species_name,
      itemName: m.item_name,
      nature: m.nature,
      evs: m.evs,
      ivs: m.ivs,
      moveNames: m.move_names,
    }),
  );
  // 持ち物の重複はルール違反(src/lib/team-validation.ts の duplicate-item)。
  const usedItems = new Set(
    members.data.map((m) => m.item_name?.trim()).filter((s): s is string => !!s && s !== ''),
  );
  // 種族の重複判定は dexNo で行う(team-validation.ts の duplicate-species)。species_key では
  // 「ギャラドス」と「メガギャラドス」が別物になってしまい、実際には編成できない候補が残る。
  const usedDexNos = new Set(seedSpecies.map((s) => resolveDexNo(s)).filter((n): n is number => n !== null));

  const supabase = await getSupabasePublicClient();

  // --- 段1: おすすめ種族 ---
  // basis はUIの説明文を出し分けるための印。
  //   'cooccurrence'   自チームとの共起で並べた(本来の経路)
  //   'usage'          チームが空なので採用率で並べた
  //   'usage_fallback' 自チームの種族が構築データに1体も居ないので採用率で並べた
  let basis: 'cooccurrence' | 'usage' | 'usage_fallback' = 'cooccurrence';
  let ranked: SpeciesScore[] = [];

  // フォールバックの採用率は combined_species_usage()(migrations/021)の横断スコープ。
  // 共起(team_partner_species_stats)がチーム単位なのに対しこちらは個体単位で、
  // アプリに登録されただけでチームに入っていない個体もここには入る ── 共起は「誰と一緒に
  // 使われたか」の情報を持つ行しか数えられないが、採用率は1個体1票で数えられるため。
  // 2つの母集団はどちらも「アプリのデータ + ランキングのデータ、重みづけなし」で一貫している。
  async function rankByUsage(): Promise<SpeciesScore[] | null> {
    const { data, error } = await supabase.rpc('combined_species_usage', { p_regulation: '' });
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[team-suggestions] combined_species_usage failed:', error);
      return null;
    }
    return rankSpeciesByUsage(
      ((data ?? []) as { species_key: string; pokemon: number; team_equivalents: number }[]).map((r) => ({
        speciesKey: r.species_key,
        teams: r.pokemon,
        totalTeams: r.team_equivalents,
      })),
    );
  }

  if (seedSpecies.length > 0) {
    const { data, error } = await supabase.rpc('team_partner_species_stats', { p_species_keys: seedSpecies });
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[team-suggestions] team_partner_species_stats failed:', error);
      return jsonResponse({ error: 'Failed to compute suggestions' }, 500);
    }
    const pairStats: SpeciesPairStat[] = ((data ?? []) as Record<string, number | string>[]).map((r) => ({
      seedSpecies: r.seed_species as string,
      candidateSpecies: r.candidate_species as string,
      coTeams: r.co_teams as number,
      seedTeams: r.seed_teams as number,
      candidateTeams: r.candidate_teams as number,
      totalTeams: r.total_teams as number,
    }));
    ranked = rankPartnerSpecies(pairStats);
  }

  // 共起が1件も取れなかった場合は採用率順へ退く。チームが空のときだけでなく、
  // 自チームの種族が合算プールのどのチームにも1体も登場しないときにも起きる
  // ── 実測でも「フシギバナ(キョダイ)+メガリザードンX」のように、環境に居ない種族だけで
  // 組んだチームでは共起の起点が存在しない。ここで何も返さないと、そういうチームでは
  // 右パネルが永久に空になってしまうため、環境全体の採用率という弱い情報へ落とす。
  if (ranked.length === 0) {
    const byUsage = await rankByUsage();
    if (byUsage === null) return jsonResponse({ error: 'Failed to compute suggestions' }, 500);
    ranked = byUsage;
    basis = seedSpecies.length === 0 ? 'usage' : 'usage_fallback';
  }

  // 既にチームに居る種族(フォルム違い・メガ違いを含む)を落とす。
  const candidates = ranked
    .filter((s) => {
      const dexNo = resolveDexNo(s.speciesKey);
      return dexNo === null || !usedDexNos.has(dexNo);
    })
    .slice(0, CANDIDATE_SPECIES_LIMIT);

  if (candidates.length === 0) {
    return jsonResponse({ data: [], meta: { seedSpecies, totalTeams: ranked[0]?.totalTeams ?? 0, basis } }, 200);
  }

  // --- 段2: 候補種族それぞれの型を選ぶ ---
  const candidateSpecies = candidates.map((c) => c.speciesKey);

  // 自チームの型に「近い」構築データ上の型を重み付けするため、まず自チーム種族の型一覧を引く。
  // archetypes は公開マスターデータ(migrations/015)なので anon で読める。
  let seedWeights: { id: string; weight: number }[] = [];
  if (seedSpecies.length > 0) {
    const { data, error } = await supabase
      .from('archetypes')
      .select('id, species_name, item_name, role')
      .in('species_name', seedSpecies);
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[team-suggestions] archetypes lookup failed:', error);
      return jsonResponse({ error: 'Failed to compute suggestions' }, 500);
    }
    const rankedArchetypes: RankedArchetype[] = ((data ?? []) as Record<string, string>[]).map((r) => ({
      id: r.id,
      speciesName: r.species_name,
      itemName: r.item_name,
      role: r.role as ArchetypeRole,
    }));
    seedWeights = weightSeedArchetypes(seedKeys, seedSpecies, rankedArchetypes);
  }

  const { data: archData, error: archError } = await supabase.rpc('team_partner_archetype_stats', {
    p_seed_ids: seedWeights.map((s) => s.id),
    // numeric[] へ渡すため、浮動小数の桁を抑えて文字列化せずそのまま送る
    // (supabase-js は JSON number をそのまま numeric として受け付ける)。
    p_seed_weights: seedWeights.map((s) => Number(s.weight.toFixed(4))),
    p_seed_species: seedSpecies,
    p_candidate_species: candidateSpecies,
  });
  if (archError) {
    // eslint-disable-next-line no-console
    console.error('[team-suggestions] team_partner_archetype_stats failed:', archError);
    return jsonResponse({ error: 'Failed to compute suggestions' }, 500);
  }

  const statsBySpecies = new Map<string, ArchetypeStat[]>();
  for (const row of (archData ?? []) as Record<string, string | number | null>[]) {
    const stat: ArchetypeStat = {
      archetypeId: row.archetype_id as string,
      speciesKey: row.species_key as string,
      // 特性は識別キーではなく、その型に分類された個体の最頻値(migrations/018 の
      // archetype_modal_ability)。特性が1件も判明していない型では null で届く。
      abilityName: (row.ability_name as string | null) ?? null,
      itemName: row.item_name as string,
      role: row.role as ArchetypeRole,
      teamsTotal: Number(row.teams_total),
      teamsCoSpecies: Number(row.teams_co_species),
      // numeric は supabase-js から文字列で届くことがあるため必ず Number() を通す。
      weightedCoArchetype: Number(row.weighted_co_archetype),
    };
    const list = statsBySpecies.get(stat.speciesKey);
    if (list) list.push(stat);
    else statsBySpecies.set(stat.speciesKey, [stat]);
  }

  const items: SuggestionItem[] = candidates.slice(0, limit).map((candidate) => {
    const choice = chooseArchetypeForSpecies(statsBySpecies.get(candidate.speciesKey) ?? [], usedItems);
    return {
      speciesName: candidate.speciesKey,
      dexNo: resolveDexNo(candidate.speciesKey),
      // 構築記事に特性・努力値が無い種族では型が1件も無い(010のコメント参照)。
      // その場合は種族だけを薦め、型の欄は null で返す(UIが「型は不明」を出し分ける)。
      abilityName: choice?.abilityName ?? null,
      itemName: choice?.itemName ?? null,
      // 'unknown'(努力値が未観測で役割を判定できなかった、migrations/017)は役割の一種では
      // ないので、型が無いときと同じ null を返す。UIは null のとき役割チップを出さない。
      role: choice && choice.role !== 'unknown' ? choice.role : null,
      archetypeShare: choice?.share ?? null,
      // role: 'unknown' の観測を既知roleへ按分した結果、小数になりうるため丸める
      // (src/lib/team-suggest.ts の foldUnknownRoleStats)。
      archetypeTeams: choice ? Math.round(choice.teamsTotal) : null,
      usageTeams: candidate.candidateTeams,
      totalTeams: candidate.totalTeams,
      itemConflict: choice?.itemConflict ?? false,
      reason: candidate.topSeed
        ? {
            seedSpeciesName: candidate.topSeed.speciesKey,
            coTeams: candidate.topSeed.coTeams,
            seedTeams: candidate.topSeed.seedTeams,
            ratio: candidate.topSeed.ratio,
            lift: candidate.topSeed.lift,
          }
        : null,
    };
  });

  return jsonResponse(
    {
      data: items,
      meta: {
        seedSpecies,
        totalTeams: candidates[0]?.totalTeams ?? 0,
        basis,
      },
    },
    200,
  );
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
