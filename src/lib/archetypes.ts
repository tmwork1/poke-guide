// archetypes(型マスターテーブル、migrations/015_archetypes.sql)への find-or-create を担う
// データアクセス層。src/lib/owned-pokemon.ts と同じく Supabase クライアントを呼び出し元
// (APIルート等)から注入させる設計(cloudflare:workers に依存せず node --test から直接呼べる)。
//
// owned-pokemon.ts と異なり archetypes は非個人情報の公開マスターデータ(RLS: 015の
// archetypes_public_read、書き込みはservice_roleのみ)のため、userId による絞り込みは
// 行わない。呼び出し元は必ず service_role の Supabase クライアントを渡すこと
// (anon/authenticated には INSERT/UPDATE 権限が無いため書き込みが失敗する)。

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ArchetypeKey } from './archetype.ts';

export type ArchetypeResult<T> = { ok: true; data: T } | { ok: false; error: string };

// PostgreSQL の unique_violation エラーコード(owned-pokemon.tsのSHARE_SLUG生成と同じ定数)。
const UNIQUE_VIOLATION_CODE = '23505';

function logError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[archetypes] ${context}:`, error);
}

// supabase-jsのクエリビルダーはメソッドチェーンのたびに型が変わるため、
// select()直後のフィルタ共通化はanyで受ける。
function matchKey(query: any, key: ArchetypeKey) {
  return query
    .eq('species_name', key.speciesName)
    .eq('ability_name', key.abilityName)
    .eq('item_name', key.itemName)
    .eq('role', key.role);
}

/**
 * key(種族名・特性名・持ち物名・role)に一致する archetypes 行の id を返す。無ければ作成する。
 * 同時実行での競合(2リクエストが同時に同じkeyをINSERTしようとする)は
 * archetypes_identity_key のunique制約に任せ、23505発生時のみ1回だけ再SELECTして拾う
 * (owned-pokemon.ts の setOwnedPokemonSharing の share_slug 再試行と同じ方針)。
 */
export async function findOrCreateArchetype(
  key: ArchetypeKey,
  supabase: SupabaseClient,
): Promise<ArchetypeResult<string>> {
  const { data: existing, error: selectError } = await matchKey(
    supabase.from('archetypes').select('id'),
    key,
  ).maybeSingle();

  if (selectError) {
    logError('findOrCreateArchetype (select) failed', selectError);
    return { ok: false, error: 'Failed to look up archetype' };
  }
  if (existing) return { ok: true, data: existing.id as string };

  const { data: inserted, error: insertError } = await supabase
    .from('archetypes')
    .insert({
      species_name: key.speciesName,
      ability_name: key.abilityName,
      item_name: key.itemName,
      role: key.role,
    })
    .select('id')
    .single();

  if (!insertError && inserted) return { ok: true, data: inserted.id as string };

  if (insertError?.code === UNIQUE_VIOLATION_CODE) {
    const { data: raceWinner, error: raceError } = await matchKey(
      supabase.from('archetypes').select('id'),
      key,
    ).maybeSingle();
    if (!raceError && raceWinner) return { ok: true, data: raceWinner.id as string };
    logError('findOrCreateArchetype (race re-select) failed', raceError);
  }

  logError('findOrCreateArchetype (insert) failed', insertError);
  return { ok: false, error: 'Failed to create archetype' };
}
