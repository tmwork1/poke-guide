// 上位入賞チームの個体(ranked_team_members)に型(アーキタイプ)を付与するバックフィル
// スクリプト。migrations/016_team_partner_suggestions.sql が追加した archetype_id 列を埋める。
//
// scripts/db/backfill-archetypes.mjs(owned_pokemon 側)の姉妹スクリプトで、分類には全く同じ
// src/lib/archetype.ts の classifyArchetype() / src/lib/archetypes.ts の findOrCreateArchetype()
// を使う。両者が同じ archetypes 行に落ちることがサジェスト機能の前提(「自チームの型」と
// 「構築データの型」を突き合わせられる)なので、分類コードパスを分岐させてはならない。
//
// ■ owned_pokemon 側との違い
//   1. 種族名は species_name(公式ランキング表記 'ロトム')ではなく species_key
//      (アプリ語彙 'ウォッシュロトム'、migrations/011)を使う。archetypes.species_name は
//      owned_pokemon.species_name と同じ語彙でなければ突き合わせが成立しないため。
//   2. 個体値はチャンピオンズルールにより 31 固定(ranked_team_members に ivs 列は無い)。
//   3. 分類できるのは持ち物が判明している個体、実測で 6241体中およそ 6210体。持ち物は公式
//      ランキング由来で全チームに存在する(010 のコメント)ため、ほぼ全件が型を持つ。
//      残る約31体は持ち物なしの個体で、「NULL = 未観測」であって「型が無い」ではない。
//      努力値が無い個体は role: 'unknown' として分類され(migrations/017)、特性は識別キーに
//      含まれない(migrations/018)。この2つを必須にしていた頃は 3118体しか拾えていなかった。
//
// 実行方法:
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<service_roleキー> \
//     node scripts/db/backfill-ranked-archetypes.mjs --dry-run   # 集計のみ、書き込みなし
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/db/backfill-ranked-archetypes.mjs
//
// npm run ranker:seed で新しいシーズンを投入したあとは、本スクリプトを再実行して
// 新規個体の archetype_id を埋める必要がある(seed 側は archetype_id を触らない)。
//
// ■ 古いデータで走らせたあとの後始末(archetypes に孤児が残る)
//   findOrCreateArchetype() は「無ければ作る」だけで、参照されなくなった archetypes 行を
//   消す仕組みは無い。そのため **修正前の ranked_team_members に対して本スクリプトを
//   走らせると、その時の値で作られた型の行が誰からも参照されないまま永久に残る**。
//   2026-08-02、item_name の全角を半角に直す前(「リザードナイトＹ」等)にバックフィルが
//   走っており、半角化+再seed後に流し直しても全角時代の9行が残っていた。
//   ranked-teams.json を作り直して再seedしたときは、本スクリプトの再実行だけでなく
//   archetype_id を持つ4テーブル(ranked_team_members / ranked_team_archetypes /
//   owned_pokemon / archetype_modal_ability)からの参照が0の archetypes 行が
//   増えていないかを点検し、あれば削除すること。
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

// チャンピオンズルールでは個体値は31固定(docs/plan の Champions ルール、src/lib/stats.ts の
// SPECIES_PAGE_IV と同値)。ranked_team_members には ivs 列自体が無いため定数で補う。
const CHAMPIONS_IVS = [31, 31, 31, 31, 31, 31];

async function fetchPage(supabase, offset) {
  const { data, error } = await supabase
    .from('ranked_team_members')
    .select('id, species_key, ability, item_name, nature, evs, move_names, archetype_id')
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`Failed to fetch ranked_team_members page (offset=${offset}): ${error.message}`);
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

  // 同じ型が何千回も出るため、findOrCreateArchetype の往復をプロセス内でメモ化する
  // (owned_pokemon 側は426件と小さくメモ化不要だったが、こちらは6241件ある)。
  const archetypeIdCache = new Map();

  for (;;) {
    const rows = await fetchPage(supabase, offset);
    if (rows.length === 0) break;

    for (const row of rows) {
      totalRows += 1;
      const key = classifyArchetype({
        speciesName: row.species_key,
        itemName: row.item_name,
        nature: row.nature,
        evs: row.evs,
        ivs: CHAMPIONS_IVS,
        moveNames: row.move_names,
      });

      let newArchetypeId = null;
      if (key) {
        const cacheKey = `${key.speciesName} ${key.itemName} ${key.role}`;
        // --dry-run では findOrCreateArchetype を呼ばない。この関数は「見つからなければ
        // 作る」ので、呼んだ時点で archetypes への INSERT が走り dry-run が読み取り専用で
        // なくなるため(姉妹スクリプト backfill-archetypes.mjs はこの区別をしていない)。
        // 件数の報告に必要なのは型の一意キーだけで、id は要らない。
        if (DRY_RUN) {
          archetypeIdCache.set(cacheKey, null);
          classifiedCount += 1;
          // id を引かないので「既存の archetype_id と同じか」は厳密には判定できない。
          // 未設定(NULL)の行はこれから必ず埋まるので、そこだけを要更新として数える。
          if (row.archetype_id === null) updatedCount += 1;
          continue;
        }
        let cached = archetypeIdCache.get(cacheKey);
        if (cached === undefined) {
          const result = await findOrCreateArchetype(key, supabase);
          cached = result.ok ? result.data : null;
          if (!result.ok) {
            console.error(`[backfill-ranked-archetypes] findOrCreateArchetype failed for ranked_team_member ${row.id}: ${result.error}`);
          }
          archetypeIdCache.set(cacheKey, cached);
        }
        if (cached) {
          newArchetypeId = cached;
          classifiedCount += 1;
        } else {
          errorCount += 1;
        }
      } else {
        unclassifiedCount += 1;
      }

      if (newArchetypeId !== row.archetype_id) {
        updatedCount += 1;
        if (!DRY_RUN) {
          const { error } = await supabase
            .from('ranked_team_members')
            .update({ archetype_id: newArchetypeId })
            .eq('id', row.id);
          if (error) {
            errorCount += 1;
            console.error(`[backfill-ranked-archetypes] update failed for ranked_team_member ${row.id}: ${error.message}`);
          }
        }
      }
    }

    console.log(`Processed ${totalRows} rows so far...`);
    offset += PAGE_SIZE;
  }

  console.log('--- backfill-ranked-archetypes summary ---');
  console.log(`mode: ${DRY_RUN ? 'dry-run (no writes)' : 'live'}`);
  console.log(`total rows: ${totalRows}`);
  console.log(`classified: ${classifiedCount}`);
  console.log(`unclassified (archetype_id -> null): ${unclassifiedCount}`);
  console.log(`distinct archetypes touched: ${archetypeIdCache.size}`);
  console.log(`rows requiring update: ${updatedCount}`);
  console.log(`errors: ${errorCount}`);
}

main().catch((e) => {
  console.error('Failed to run backfill-ranked-archetypes:', e);
  process.exit(1);
});
