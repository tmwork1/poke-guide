// owned_pokemon への読み書きを集約するデータアクセス層。HTTP/セッションに依存しない。
//
// ##### 最重要: このファイルが「他人のデータへの唯一の砦」であること #####
// poke-commons の書き込みAPIは全て getSupabaseAdminClient()(service_role、RLSを常にバイパスする)
// 経由で実行する設計。つまり owned_pokemon の
// RLSポリシー(migrations/005_owned_pokemon_rls.sql)はこの経路には一切効かない。
// 「ログイン中のユーザーが自分以外の個体を閲覧・改ざんできない」ことを保証するのは、
// この下の各関数が発行するクエリに必ず含む `.eq('user_id', userId)` のみである。
//
// そのため、この下の関数を実装・変更する際は必ず以下を守ること:
//   1. すべての公開関数は第一引数として `userId: string` を受け取る
//   2. owned_pokemon への SELECT/UPDATE/DELETE には必ず `.eq('user_id', userId)` を含める
//      (対象行の所有者チェックを兼ねる。存在しないIDと他人のIDのいずれも同じ「0件」として扱い、
//      リソースの存在自体を漏らさない)
//   3. INSERT の user_id には必ずこの引数の userId を書き込む(リクエストボディ由来の値は使わない)
//   4. Supabase クライアントは呼び出し元(APIルート等)から注入させる(このファイル自身は
//      import.meta.env や getSupabaseAdminClient() を呼ばない)。これにより
//      tests/db/owned-pokemon-lib.test.ts のような plain `node --test` からも
//      (Cloudflare Workers ランタイム専用の `cloudflare:workers` に依存せず)直接呼び出せる、
//      userId と入出力だけに依存する純粋なデータアクセス層になる
//
// テスト: tests/db/owned-pokemon-lib.test.ts で「userAが作成した個体をuserBのuserIdで
// 取得・更新・削除しようとすると失敗/0件になる」ことを実DBに対して検証している。

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OwnedPokemonRequestBody } from './owned-pokemon-validation';
import { classifyArchetype } from './archetype.ts';
import { findOrCreateArchetype } from './archetypes.ts';

export interface OwnedPokemonRecord {
  id: string;
  user_id: string;
  nickname: string | null;
  species_name: string;
  level: number | null;
  nature: string | null;
  ability_name: string | null;
  item_name: string | null;
  tera_type: string | null;
  // レギュレーション(migrations/013_regulation.sql)。'M-A' 等、未指定は null。
  regulation: string | null;
  evs: number[];
  ivs: number[];
  move_names: string[];
  memo: string | null;
  tags: string[];
  is_pinned: boolean;
  source_build_slug: string | null;
  share_slug: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  // 匿名集計サジェスト機能の収集拒否(migrations/008)。NULL=収集対象。値が未来なら拒否期間中、
  // 過去日付でも収集対象として扱う(都度判定、詳細はmigrations/008のコメント参照)。
  collection_opt_out_until: string | null;
  // 型(アーキタイプ)分類(migrations/015_archetypes.sql)。種族/特性/持ち物のいずれかが
  // 未入力、または種族がマスターデータに無い等で分類不能な場合はnull。クライアントから
  // 直接送らせず、createOwnedPokemon/updateOwnedPokemonが毎回サーバー側で再計算する。
  archetype_id: string | null;
}

// 公開共有(share.ts / owned-pokemon/[id]/share.ts)経由で第三者に見せてよい列のみを持つ型。
// memo・tags・user_id・is_pinned 等の個人的/内部情報は含めない。
export interface PublicOwnedPokemonRecord {
  nickname: string | null;
  species_name: string;
  level: number | null;
  nature: string | null;
  ability_name: string | null;
  item_name: string | null;
  tera_type: string | null;
  evs: number[];
  ivs: number[];
  move_names: string[];
  share_slug: string | null;
  created_at: string;
}

export type OwnedPokemonSort = 'updated_at' | 'last_used_at' | 'nickname';

export interface ListOwnedPokemonOptions {
  sort?: OwnedPokemonSort;
  // 指定した全タグを含む個体のみ(AND)に絞り込む(計画書§6.1)。
  tags?: string[];
  // ニックネーム/種族/特性/持ち物/テラスの部分一致(OR)によるサーバー側の簡易絞り込み。
  // 技名(move_names)の部分一致や複数語のAND検索はPostgRESTの配列演算子では表現しづらいため、
  // 一覧ページ(C-2)側は取得した全件をクライアント側で再フィルタする(計画書§6.1が明示的に許容)。
  search?: string;
}

export type OwnedPokemonResult<T> = { ok: true; data: T } | { ok: false; error: string };

const OWNED_POKEMON_COLUMNS =
  'id, user_id, nickname, species_name, level, nature, ability_name, item_name, tera_type, regulation, evs, ivs, move_names, memo, tags, is_pinned, source_build_slug, share_slug, is_public, created_at, updated_at, last_used_at, collection_opt_out_until, archetype_id';

// 公開共有用に安全な列だけを取得する(memo・tags・user_id・is_pinned 等は含めない)。
const PUBLIC_OWNED_POKEMON_COLUMNS =
  'nickname, species_name, level, nature, ability_name, item_name, tera_type, evs, ivs, move_names, share_slug, created_at';

// share_slug 用の英数字ランダム文字列。crypto.randomUUID() のハイフンを除去して先頭Nを使う
// (廃止済みの src/pages/api/builds.ts にあった generateShareSlug() と同じ方式を踏襲した
// ヘルパーをここに複製したもの)。
const SHARE_SLUG_LENGTH = 10;
const MAX_SLUG_RETRIES = 2;
// PostgreSQL の unique_violation エラーコード。
const UNIQUE_VIOLATION_CODE = '23505';

function generateShareSlug(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, SHARE_SLUG_LENGTH);
}

function logError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[owned-pokemon] ${context}:`, error);
}

// 型(アーキタイプ)分類(src/lib/archetype.ts)+ archetypesへのfind-or-create
// (src/lib/archetypes.ts)をまとめて行い、archetype_idを算出する。分類不能(種族/持ち物
// 未入力・未対応種族等)の場合はnullを返す。findOrCreateArchetypeがDB都合で失敗した場合も
// non-fatalとしてnullにフォールバックする(型分類の都合でowned_pokemon本体の保存自体を
// 失敗させないため)。
async function resolveArchetypeId(
  input: OwnedPokemonRequestBody,
  supabase: SupabaseClient,
): Promise<string | null> {
  const key = classifyArchetype({
    speciesName: input.species_name,
    itemName: input.item_name,
    nature: input.nature,
    evs: input.evs,
    ivs: input.ivs,
    moveNames: input.move_names,
  });
  if (!key) return null;

  const result = await findOrCreateArchetype(key, supabase);
  if (!result.ok) {
    logError('resolveArchetypeId: archetype lookup/creation failed, proceeding with archetype_id=null', result.error);
    return null;
  }
  return result.data;
}

export async function listOwnedPokemon(
  userId: string,
  options: ListOwnedPokemonOptions,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord[]>> {
  let query = supabase.from('owned_pokemon').select(OWNED_POKEMON_COLUMNS).eq('user_id', userId);

  if (options.tags && options.tags.length > 0) {
    query = query.contains('tags', options.tags);
  }

  if (options.search && options.search.trim() !== '') {
    // PostgRESTの .or() はカンマ区切りの複合フィルタをそのまま1つの文字列として組み立てるため、
    // `,` `(` `)` はDSLの区切り文字として解釈されてしまう(例: ユーザー入力に "a,b)or(x" が
    // 含まれると不正なフィルタ式になり500エラーになる)。user_id の絞り込みは別のトップレベル
    // フィルタとして独立にANDされる(supabase-jsの.eq()呼び出し)ため、この文字列を壊しても
    // 他ユーザーの行が見えるようになるわけではないが、検索語に起因する500エラーを避けるため
    // DSLの区切り文字は事前に取り除く。ILIKEのワイルドカード文字(%・_)は別途エスケープする。
    const term = options.search
      .trim()
      .replace(/[,()]/g, ' ')
      .replace(/[%_]/g, (m) => `\\${m}`);
    const pattern = `%${term}%`;
    query = query.or(
      [
        `nickname.ilike.${pattern}`,
        `species_name.ilike.${pattern}`,
        `ability_name.ilike.${pattern}`,
        `item_name.ilike.${pattern}`,
        `tera_type.ilike.${pattern}`,
      ].join(','),
    );
  }

  // ピン留めは常に上部固定(計画書§6.1)。そのうえで並び替えキーを適用する。
  query = query.order('is_pinned', { ascending: false });
  switch (options.sort) {
    case 'last_used_at':
      query = query.order('last_used_at', { ascending: false, nullsFirst: false });
      break;
    case 'nickname':
      query = query.order('nickname', { ascending: true, nullsFirst: false }).order('species_name', {
        ascending: true,
      });
      break;
    case 'updated_at':
    default:
      query = query.order('updated_at', { ascending: false });
      break;
  }

  const { data, error } = await query;
  if (error) {
    logError('listOwnedPokemon failed', error);
    return { ok: false, error: 'Failed to list owned pokemon' };
  }
  return { ok: true, data: (data ?? []) as OwnedPokemonRecord[] };
}

// 指定したidの個体をまとめて取得する(チームサジェスト src/pages/api/team-suggestions.ts 用)。
// listOwnedPokemon で全件を引いてJS側で絞るのではなく専用クエリにしているのは、
// Cloudflare Workers Free の CPU 10ms 制約下で不要な行のデシリアライズを避けるため。
// 他の関数と同じく user_id での絞り込みを必ず併用し、他人の個体は静かに結果から落ちる
// (見つからないIDと他人のIDを区別せず、単に返らないだけ ── getOwnedPokemon と同じ方針)。
export async function listOwnedPokemonByIds(
  userId: string,
  ids: readonly string[],
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord[]>> {
  if (ids.length === 0) return { ok: true, data: [] };

  const { data, error } = await supabase
    .from('owned_pokemon')
    .select(OWNED_POKEMON_COLUMNS)
    .eq('user_id', userId)
    .in('id', ids as string[]);

  if (error) {
    logError('listOwnedPokemonByIds failed', error);
    return { ok: false, error: 'Failed to list owned pokemon' };
  }
  return { ok: true, data: (data ?? []) as OwnedPokemonRecord[] };
}

// 見つからない場合と他人の所有物である場合を区別せず null を返す(存在漏洩防止)。
export async function getOwnedPokemon(
  userId: string,
  id: string,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord | null>> {
  const { data, error } = await supabase
    .from('owned_pokemon')
    .select(OWNED_POKEMON_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logError('getOwnedPokemon failed', error);
    return { ok: false, error: 'Failed to fetch owned pokemon' };
  }
  return { ok: true, data: (data as OwnedPokemonRecord | null) ?? null };
}

export async function createOwnedPokemon(
  userId: string,
  input: OwnedPokemonRequestBody,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord>> {
  const archetypeId = await resolveArchetypeId(input, supabase);

  const { data, error } = await supabase
    .from('owned_pokemon')
    .insert({
      user_id: userId, // リクエストボディ由来の値は一切使わない(なりすまし防止)
      nickname: input.nickname,
      species_name: input.species_name,
      level: input.level,
      nature: input.nature,
      ability_name: input.ability_name,
      item_name: input.item_name,
      tera_type: input.tera_type,
      regulation: input.regulation,
      evs: input.evs,
      ivs: input.ivs,
      move_names: input.move_names,
      memo: input.memo,
      tags: input.tags,
      is_pinned: input.is_pinned,
      archetype_id: archetypeId,
    })
    .select(OWNED_POKEMON_COLUMNS)
    .single();

  if (error || !data) {
    logError('createOwnedPokemon failed', error);
    return { ok: false, error: 'Failed to create owned pokemon' };
  }
  return { ok: true, data: data as OwnedPokemonRecord };
}

// 対象が存在しない、または他人の所有物の場合は data: null を返す(0件更新。存在漏洩防止)。
export async function updateOwnedPokemon(
  userId: string,
  id: string,
  input: OwnedPokemonRequestBody,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord | null>> {
  // PUTは「全項目を毎回送る」置換契約(このファイル冒頭のコメント参照)のため、
  // 差分判定はせず毎回無条件で再計算する。
  const archetypeId = await resolveArchetypeId(input, supabase);

  const { data, error } = await supabase
    .from('owned_pokemon')
    .update({
      nickname: input.nickname,
      species_name: input.species_name,
      level: input.level,
      nature: input.nature,
      ability_name: input.ability_name,
      item_name: input.item_name,
      tera_type: input.tera_type,
      regulation: input.regulation,
      evs: input.evs,
      ivs: input.ivs,
      move_names: input.move_names,
      memo: input.memo,
      tags: input.tags,
      is_pinned: input.is_pinned,
      archetype_id: archetypeId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行を更新できてしまう(このファイルの最重要事項)
    .select(OWNED_POKEMON_COLUMNS)
    .maybeSingle();

  if (error) {
    logError('updateOwnedPokemon failed', error);
    return { ok: false, error: 'Failed to update owned pokemon' };
  }
  return { ok: true, data: (data as OwnedPokemonRecord | null) ?? null };
}

export async function updatePinStatus(
  userId: string,
  id: string,
  isPinned: boolean,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord | null>> {
  const { data, error } = await supabase
    .from('owned_pokemon')
    .update({ is_pinned: isPinned })
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行を更新できてしまう(このファイルの最重要事項)
    .select(OWNED_POKEMON_COLUMNS)
    .maybeSingle();

  if (error) {
    logError('updatePinStatus failed', error);
    return { ok: false, error: 'Failed to update pin status' };
  }
  return { ok: true, data: (data as OwnedPokemonRecord | null) ?? null };
}

// 匿名集計サジェスト機能の収集拒否状態のみを更新する専用経路(匿名集計サジェスト機能・第1段階)。
// updatePinStatusと同じ流儀: 対象が存在しない/他人の所有物の場合は data: null を返し、
// updated_atには触れない(この操作で「更新順」表示の並びが動くべきではないため)。
//
// optOut === true の場合、拒否の期限(現在時刻+30日)はこの関数内でサーバー側が計算する。
// 呼び出し元(APIルート)から生の日時を受け取らないことで、クライアントが任意の未来日時を
// 送りつけて拒否期間を不当に延長する経路を作らない。
const COLLECTION_OPT_OUT_DAYS = 30;

export async function updateCollectionOptOut(
  userId: string,
  id: string,
  optOut: boolean,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord | null>> {
  const collectionOptOutUntil = optOut
    ? new Date(Date.now() + COLLECTION_OPT_OUT_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const { data, error } = await supabase
    .from('owned_pokemon')
    .update({ collection_opt_out_until: collectionOptOutUntil })
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行を更新できてしまう(このファイルの最重要事項)
    .select(OWNED_POKEMON_COLUMNS)
    .maybeSingle();

  if (error) {
    logError('updateCollectionOptOut failed', error);
    return { ok: false, error: 'Failed to update collection opt-out status' };
  }
  return { ok: true, data: (data as OwnedPokemonRecord | null) ?? null };
}

// 削除できた場合は true、対象が存在しない/他人の所有物の場合は false を返す。
export async function deleteOwnedPokemon(
  userId: string,
  id: string,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<boolean>> {
  const { data, error } = await supabase
    .from('owned_pokemon')
    .delete()
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行を削除できてしまう(このファイルの最重要事項)
    .select('id');

  if (error) {
    logError('deleteOwnedPokemon failed', error);
    return { ok: false, error: 'Failed to delete owned pokemon' };
  }
  return { ok: true, data: (data ?? []).length > 0 };
}

// 個体の公開/非公開を切り替える。対象が存在しない/他人の所有物の場合は data: null を返す
// (0件更新。存在漏洩防止、他の関数と同じ流儀)。
//
// isPublic === true の場合: 既存の share_slug をまず確認し、無ければ新規生成してUPDATEする
// (再公開時は同じURLを使い続けられるよう、既存の share_slug があればそれを再利用する)。
// isPublic === false の場合: is_public のみ false に更新し、share_slug はそのまま保持する。
export async function setOwnedPokemonSharing(
  userId: string,
  id: string,
  isPublic: boolean,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord | null>> {
  if (!isPublic) {
    const { data, error } = await supabase
      .from('owned_pokemon')
      .update({ is_public: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId) // これが無いと他人の行を更新できてしまう(このファイルの最重要事項)
      .select(OWNED_POKEMON_COLUMNS)
      .maybeSingle();

    if (error) {
      logError('setOwnedPokemonSharing (private) failed', error);
      return { ok: false, error: 'Failed to update sharing' };
    }
    return { ok: true, data: (data as OwnedPokemonRecord | null) ?? null };
  }

  // isPublic === true: 対象行の存在確認を兼ねて現在の share_slug を先に1回SELECTする。
  const { data: current, error: selectError } = await supabase
    .from('owned_pokemon')
    .select('share_slug')
    .eq('id', id)
    .eq('user_id', userId) // これが無いと他人の行の存在を確認できてしまう(このファイルの最重要事項)
    .maybeSingle();

  if (selectError) {
    logError('setOwnedPokemonSharing (select) failed', selectError);
    return { ok: false, error: 'Failed to update sharing' };
  }
  if (!current) {
    // 対象が存在しない、または他人の所有物(存在漏洩防止のため null を返す)。
    return { ok: true, data: null };
  }

  if (current.share_slug) {
    // 既に share_slug を持っている場合は再生成せず再利用する。
    const { data, error } = await supabase
      .from('owned_pokemon')
      .update({ is_public: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select(OWNED_POKEMON_COLUMNS)
      .maybeSingle();

    if (error) {
      logError('setOwnedPokemonSharing (public, existing slug) failed', error);
      return { ok: false, error: 'Failed to update sharing' };
    }
    return { ok: true, data: (data as OwnedPokemonRecord | null) ?? null };
  }

  // share_slug が無い場合は新規生成する。unique制約違反(23505)発生時のみ数回だけ
  // 再生成してリトライする(廃止済みの src/pages/api/builds.ts の POST と同じ方式を踏襲していた)。
  let result: OwnedPokemonRecord | null = null;
  let updateError: { code?: string; message: string } | null = null;
  for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt += 1) {
    const shareSlug = generateShareSlug();
    const { data, error } = await supabase
      .from('owned_pokemon')
      .update({ is_public: true, share_slug: shareSlug, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select(OWNED_POKEMON_COLUMNS)
      .maybeSingle();

    if (!error) {
      result = (data as OwnedPokemonRecord | null) ?? null;
      updateError = null;
      break;
    }

    updateError = error;
    if (error.code !== UNIQUE_VIOLATION_CODE) {
      break;
    }
    // unique_violation の場合のみループを継続してslugを振り直す。
  }

  if (updateError) {
    logError('setOwnedPokemonSharing (public, new slug) failed', updateError);
    return { ok: false, error: 'Failed to update sharing' };
  }
  return { ok: true, data: result };
}

// 公開用に安全な列だけを取得する(公開閲覧のため userId 引数は不要)。
// 明示条件でも is_public = true に絞り込むことで、RLS未適用の呼び出し経路(将来的な誤用)に
// 対しても二重に安全側へ倒す。
export async function getPublicOwnedPokemonBySlug(
  slug: string,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<PublicOwnedPokemonRecord | null>> {
  const { data, error } = await supabase
    .from('owned_pokemon')
    .select(PUBLIC_OWNED_POKEMON_COLUMNS)
    .eq('share_slug', slug)
    .eq('is_public', true)
    .maybeSingle();

  if (error) {
    logError('getPublicOwnedPokemonBySlug failed', error);
    return { ok: false, error: 'Failed to fetch public owned pokemon' };
  }
  return { ok: true, data: (data as PublicOwnedPokemonRecord | null) ?? null };
}
