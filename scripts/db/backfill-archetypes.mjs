// 既存の owned_pokemon 全件に対して型(アーキタイプ)分類を遡及適用するバックフィルスクリプト
// (migrations/015_archetypes.sql 導入時の一回限りの移行用)。
//
// 他の scripts/db/*.mjs(refresh-suggestions.mjs 等)は pg + DATABASE_URL 直結だが、本スクリプトは
// src/lib/archetype.ts の classifyArchetype()(種族値・技分類マスターJSONへの依存あり)と
// src/lib/archetypes.ts の findOrCreateArchetype()(SupabaseClient引数)をそのまま再利用し、
// 本番の createOwnedPokemon/updateOwnedPokemon と全く同じ分類コードパスを通すことで
// SQLだけの再実装によるロジック乖離を防ぐ。そのため @supabase/supabase-js +
// SUPABASE_URL/SUPABASE_SECRET_KEY を使う(tests/db/owned-pokemon-lib.test.ts と同じ接続方式)。
//
// 実行方法:
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<service_roleキー> \
//     node scripts/db/backfill-archetypes.mjs --dry-run   # 集計のみ、書き込みなし
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/db/backfill-archetypes.mjs  # 実書き込み
//
// 重要: 本番Supabaseへの実書き込みは、必ず --dry-run で件数を確認しユーザーの明示的な承認を
// 得てから実行すること(このファイル自体は実行しない)。
import { createClient } from '@supabase/supabase-js';
import { classifyArchetype } from '../../src/lib/archetype.ts';
import { findOrCreateArchetype } from '../../src/lib/archetypes.ts';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_URL/SUPABASE_SECRET_KEY not set. Export them (local default: SUPABASE_URL=http://127.0.0.1:54321).');
  process.exit(1);
}

const PAGE_SIZE = 500;

async function fetchPage(supabase, offset) {
  const { data, error } = await supabase
    .from('owned_pokemon')
    .select('id, species_name, ability_name, item_name, nature, evs, ivs, move_names, archetype_id')
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`Failed to fetch owned_pokemon page (offset=${offset}): ${error.message}`);
  return data ?? [];
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let offset = 0;
  let totalRows = 0;
  let classifiedCount = 0;
  let unclassifiedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  for (;;) {
    const rows = await fetchPage(supabase, offset);
    if (rows.length === 0) break;

    for (const row of rows) {
      totalRows += 1;
      const key = classifyArchetype({
        speciesName: row.species_name,
        itemName: row.item_name,
        nature: row.nature,
        evs: row.evs,
        ivs: row.ivs,
        moveNames: row.move_names,
      });

      let newArchetypeId = null;
      if (key) {
        const result = await findOrCreateArchetype(key, supabase);
        if (result.ok) {
          newArchetypeId = result.data;
          classifiedCount += 1;
        } else {
          errorCount += 1;
          console.error(`[backfill-archetypes] findOrCreateArchetype failed for owned_pokemon ${row.id}: ${result.error}`);
        }
      } else {
        unclassifiedCount += 1;
      }

      if (newArchetypeId !== row.archetype_id) {
        updatedCount += 1;
        if (!DRY_RUN) {
          const { error } = await supabase
            .from('owned_pokemon')
            .update({ archetype_id: newArchetypeId })
            .eq('id', row.id);
          if (error) {
            errorCount += 1;
            console.error(`[backfill-archetypes] update failed for owned_pokemon ${row.id}: ${error.message}`);
          }
        }
      }
    }

    console.log(`Processed ${totalRows} rows so far...`);
    offset += PAGE_SIZE;
  }

  console.log('--- backfill-archetypes summary ---');
  console.log(`mode: ${DRY_RUN ? 'dry-run (no writes)' : 'live'}`);
  console.log(`total rows: ${totalRows}`);
  console.log(`classified: ${classifiedCount}`);
  console.log(`unclassified (archetype_id -> null): ${unclassifiedCount}`);
  console.log(`rows requiring update: ${updatedCount}`);
  console.log(`errors: ${errorCount}`);
}

main().catch((e) => {
  console.error('Failed to run backfill-archetypes:', e);
  process.exit(1);
});
