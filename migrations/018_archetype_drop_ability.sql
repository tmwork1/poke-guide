-- migrations/018_archetype_drop_ability.sql
-- 型の識別キーから特性を外す。型は 種族名・持ち物名・role の3つで決まるようになる。
--
-- ■ なぜ外すか(2026-08-02 の実測に基づく、ユーザー判断)
-- 決め手は「その列が構築データでどれだけ観測できているか」の差である。
--
--   持ち物  6210 / 6241体 (99.5%) ── 公式ランキング由来で全チームに存在する(010のコメント)
--   特性    3666 / 6241体 (58.7%) ── 構築記事のある個体にしか無い
--   努力値  3382 / 6241体 (54.2%) ── 同上(017 で role: 'unknown' として救済済み)
--
-- 特性をキーに入れている限り、型レイヤは「構築記事のある半分」でしか成立しない。外すと:
--
--   分類できる個体              3664 → 6210
--   型レベル共起が成立するチーム   683 → 1036 / 1041
--
-- しかもデータが7割増えるのに**型の数は減る**(種族+持ち物で554型・1チームのみ40.3% に対し、
-- 種族+特性+持ち物では602型・51.8%)。疎さが両側から改善する。
--
-- ■ 失う情報とその扱い
-- 持ち物が分かっていれば最頻特性が87.7%当たる(実測)。内訳は (種族,持ち物) 組あたり
-- 「特性は1種類だけ」1012体 /「最頻90%以上」1212体 /「75〜90%」866体 /
-- 「75%未満= 特性が本当に効く」574体(15.7%)。ブリジュラス(じきゅうりょく/がんじょう)、
-- アーマーガア(プレッシャー/ミラーアーマー)、メガギャラドス(かたやぶり/いかく)などは
-- 実際に割れるので、この15.7%は割り切りである。
--
-- 代わりに特性は**識別子ではなく推定値**として扱う: 下の archetype_modal_ability ビューが
-- 型ごとの最頻特性を返し、team_partner_archetype_stats がそれを添えて返す。画面に出す情報は
-- 減らさず、集計だけを密にする。技を識別キーに入れずに代表値で見せるのと同じ方針。
--
-- ■ ability_name 列を落としてよい理由
-- archetypes.ability_name は owned_pokemon.ability_name / ranked_team_members.ability から
-- 導出しただけの派生データで、原本は両テーブルに残る。ここで消えるのは「型の同一性判定に
-- 特性を使う」という判断だけで、特性そのものの情報は失われない。
--
-- 適用後に scripts/db/backfill-ranked-archetypes.mjs と(本番では)backfill-archetypes.mjs の
-- 再実行が必要。

-- ============================================================================
-- 1. 特性だけが違う型どうしを統合する
-- ============================================================================
-- 残す行は (species_name, item_name, role) ごとに created_at → id 順の先頭。
-- 参照側(owned_pokemon / ranked_team_members)を先に付け替えてから重複行を消す
-- (先に消すと ON DELETE SET NULL が働いて archetype_id が失われるため順序が重要)。
CREATE TEMP TABLE archetype_merge_map AS
SELECT
  id AS old_id,
  first_value(id) OVER (
    PARTITION BY species_name, item_name, role
    ORDER BY created_at, id
  ) AS keep_id
FROM archetypes;

UPDATE ranked_team_members m
SET archetype_id = k.keep_id
FROM archetype_merge_map k
WHERE m.archetype_id = k.old_id AND k.old_id <> k.keep_id;

UPDATE owned_pokemon p
SET archetype_id = k.keep_id
FROM archetype_merge_map k
WHERE p.archetype_id = k.old_id AND k.old_id <> k.keep_id;

DELETE FROM archetypes a
USING archetype_merge_map k
WHERE a.id = k.old_id AND k.old_id <> k.keep_id;

DROP TABLE archetype_merge_map;

-- ============================================================================
-- 2. 識別キーの張り替えと列の削除
-- ============================================================================
ALTER TABLE archetypes DROP CONSTRAINT IF EXISTS archetypes_identity_key;
ALTER TABLE archetypes DROP COLUMN IF EXISTS ability_name;
ALTER TABLE archetypes ADD CONSTRAINT archetypes_identity_key
  UNIQUE (species_name, item_name, role);

-- ============================================================================
-- 3. 型ごとの最頻特性(表示用の推定値)
-- ============================================================================
-- mode() は最頻値を返す順序集合集約。同数の場合はどれか一つが選ばれる(どれになるかは
-- 不定だが、同数ということはどちらも等しく代表的なので実用上問題にしない)。
-- ability が NULL の個体は WHERE で除くので「特性が判明している中での最頻値」になる。
-- 特性が1件も判明していない型では行自体が存在せず、参照側は NULL を受け取る。
CREATE OR REPLACE VIEW archetype_modal_ability AS
SELECT
  m.archetype_id,
  mode() WITHIN GROUP (ORDER BY m.ability) AS ability_name,
  count(*)::int AS ability_known_members
FROM ranked_team_members m
WHERE m.archetype_id IS NOT NULL AND m.ability IS NOT NULL
GROUP BY m.archetype_id;

-- 010/015 と同じ「公開参照データは anon/authenticated に SELECT のみ」パターン。
GRANT SELECT ON archetype_modal_ability TO anon, authenticated;

-- ============================================================================
-- 4. team_partner_archetype_stats(): 特性を archetypes ではなく最頻値から返す
-- ============================================================================
-- 016 の定義と本体は同じで、ability_name の出どころだけが archetypes → 最頻特性ビューに
-- 変わる(戻り値の形は互換なので呼び出し側 src/lib/team-suggest.ts の ArchetypeStat は
-- そのまま使える)。DROP せず CREATE OR REPLACE できるのは引数と戻り値の型が同一のため。
CREATE OR REPLACE FUNCTION team_partner_archetype_stats(
  p_seed_ids uuid[],
  p_seed_weights numeric[],
  p_seed_species text[],
  p_candidate_species text[]
)
RETURNS TABLE (
  archetype_id uuid,
  species_key text,
  ability_name text,
  item_name text,
  role text,
  teams_total int,
  teams_co_species int,
  weighted_co_archetype numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH candidates AS (
    SELECT ta.ranked_team_id, ta.archetype_id, ta.species_key
    FROM ranked_team_archetypes ta
    WHERE ta.species_key = ANY (p_candidate_species)
  ),
  seed_species_teams AS (
    SELECT DISTINCT ranked_team_id
    FROM ranked_team_species
    WHERE species_key = ANY (p_seed_species)
  ),
  seed_archetype_teams AS (
    SELECT ta.ranked_team_id, max(coalesce(s.w, 0))::numeric AS w
    FROM unnest(p_seed_ids, p_seed_weights) AS s(id, w)
    JOIN ranked_team_archetypes ta ON ta.archetype_id = s.id
    GROUP BY ta.ranked_team_id
  )
  SELECT
    c.archetype_id,
    c.species_key,
    ma.ability_name,
    a.item_name,
    a.role,
    count(*)::int AS teams_total,
    count(*) FILTER (WHERE sst.ranked_team_id IS NOT NULL)::int AS teams_co_species,
    coalesce(sum(sat.w), 0)::numeric AS weighted_co_archetype
  FROM candidates c
  JOIN archetypes a ON a.id = c.archetype_id
  LEFT JOIN archetype_modal_ability ma ON ma.archetype_id = c.archetype_id
  LEFT JOIN seed_species_teams sst ON sst.ranked_team_id = c.ranked_team_id
  LEFT JOIN seed_archetype_teams sat ON sat.ranked_team_id = c.ranked_team_id
  GROUP BY c.archetype_id, c.species_key, ma.ability_name, a.item_name, a.role;
$$;

GRANT EXECUTE ON FUNCTION team_partner_archetype_stats(uuid[], numeric[], text[], text[]) TO anon, authenticated;
