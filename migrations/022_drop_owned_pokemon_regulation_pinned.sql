-- migrations/022_drop_owned_pokemon_regulation_pinned.sql
-- UI改修依頼(2026-08-18)「ポケモンのデータから"レギュレーション"と"お気に入り"属性を廃止」
-- に伴い、owned_pokemon.regulation / owned_pokemon.is_pinned を削除する。
--
-- teams.regulation(013)・teams.is_pinned(012)は今回の対象外(チーム側は別機能として存続)。
-- 「レギュレーション別の人気度集計」自体は廃止しない(ranked_team_members側の season_regulations
-- 経由のデータで引き続き機能する)。owned_pokemon から取得していた regulation の値だけを
-- NULL::text に置き換え、スコープ集計ロジック(scoped CTE の CASE 分岐)には一切手を加えない
-- ── 個体側の値が常にNULLになる結果、これらの個体は自動的に「横断(scope=''）」にのみ
-- 算入されるようになる(013/014/019/021のコメントにある「レギュレーション不明の個体は
-- 横断だけに入る」という既存の分岐がそのまま効く)。

ALTER TABLE owned_pokemon DROP COLUMN IF EXISTS regulation;

DROP INDEX IF EXISTS idx_owned_pokemon_user_pinned;
ALTER TABLE owned_pokemon DROP COLUMN IF EXISTS is_pinned;

-- ------------------------------------------------------------------------------------------
-- refresh_popular_builds_species(): 013作成→014改訂→019改名(refresh_popular_builds→
-- refresh_popular_builds_species)。本体ロジックは014から1文字も変えず、①(owned_pokemon由来)の
-- regulation参照だけを NULL::text に置き換える。②(ranked_team_members由来、season_regulations
-- 経由)は無変更。
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_popular_builds_species(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  computed timestamptz := now();
  kinds text[] := ARRAY['popular_nature', 'popular_item', 'popular_tera', 'popular_move'];
BEGIN
  WITH src AS (
    -- ① ユーザーが登録した個体(収集拒否中の行は除く。008参照)。
    --    022でowned_pokemon.regulationを廃止したため、常にNULL(=横断集計にのみ算入)として扱う。
    SELECT species_name AS species_key, NULL::text AS regulation, nature, item_name, tera_type,
           nullif(move_names, '{}'::text[]) AS move_names
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
    UNION ALL
    -- ② 過去シーズンの上位入賞チームの個体(010)。1個体1票で①と対等に扱う。
    --    レギュレーションはチームのシーズン(ranked_teams.season)を season_regulations で
    --    引き当てて求める。対応が未登録のシーズンは LEFT JOIN で regulation が NULL になり、
    --    横断集計にだけ入る(レギュレーション別には寄与しない)。
    SELECT m.species_key, sr.regulation, m.nature, m.item_name, m.tera_type,
           nullif(m.move_names, '{}'::text[])
    FROM ranked_team_members m
    JOIN ranked_teams t ON t.id = m.ranked_team_id
    LEFT JOIN season_regulations sr ON sr.season = t.season
    WHERE m.species_key IS NOT NULL
  ),
  -- 1個体を「横断(scope='')」と「自分のレギュレーション(scope=regulation)」の
  -- 2つの母集団へ同時に数え上げる。レギュレーション不明(NULL)の個体は横断にしか入らない。
  scoped AS (
    SELECT s.species_key, k.scope, s.nature, s.item_name, s.tera_type, s.move_names
    FROM src s
    CROSS JOIN LATERAL unnest(
      CASE WHEN s.regulation IS NULL THEN ARRAY['']::text[] ELSE ARRAY['', s.regulation] END
    ) AS k(scope)
  ),
  -- 分母: 項目ごとに「値が分かっている個体数」。技だけは延べ技数ではなく個体数で数える。
  sample_size AS (
    SELECT species_key, scope, 'popular_nature'::text AS kind, count(*) AS sample_size
      FROM scoped WHERE nature IS NOT NULL GROUP BY species_key, scope
    UNION ALL
    SELECT species_key, scope, 'popular_item', count(*)
      FROM scoped WHERE item_name IS NOT NULL GROUP BY species_key, scope
    UNION ALL
    SELECT species_key, scope, 'popular_tera', count(*)
      FROM scoped WHERE tera_type IS NOT NULL GROUP BY species_key, scope
    UNION ALL
    SELECT species_key, scope, 'popular_move', count(*)
      FROM scoped WHERE move_names IS NOT NULL GROUP BY species_key, scope
  ),
  -- 分子: (種族, スコープ, 項目, 値) ごとの票数。技は unnest して1体につき最大4票入る。
  counts AS (
    SELECT species_key, scope, 'popular_nature'::text AS kind, nature AS value, count(*) AS cnt
      FROM scoped WHERE nature IS NOT NULL GROUP BY species_key, scope, nature
    UNION ALL
    SELECT species_key, scope, 'popular_item', item_name, count(*)
      FROM scoped WHERE item_name IS NOT NULL GROUP BY species_key, scope, item_name
    UNION ALL
    SELECT species_key, scope, 'popular_tera', tera_type, count(*)
      FROM scoped WHERE tera_type IS NOT NULL GROUP BY species_key, scope, tera_type
    UNION ALL
    SELECT s.species_key, s.scope, 'popular_move', m.move_name, count(*)
      FROM scoped s, unnest(s.move_names) AS m(move_name)
      WHERE m.move_name IS NOT NULL GROUP BY s.species_key, s.scope, m.move_name
  ),
  -- k-匿名性: 開示者が min_sample_size 人未満の (種族, スコープ, 項目) は書き出さない。
  ranked AS (
    SELECT c.species_key, c.scope, c.kind, c.value, c.cnt, s.sample_size,
           row_number() OVER (PARTITION BY c.species_key, c.scope, c.kind
                              ORDER BY c.cnt DESC, c.value) AS rn
    FROM counts c
    JOIN sample_size s
      ON s.species_key = c.species_key AND s.scope = c.scope AND s.kind = c.kind
    WHERE s.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT r.kind, r.species_key, r.scope,
           jsonb_build_object(
             'sample_size', r.sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'value', r.value,
                 'count', r.cnt,
                 'ratio', round(r.cnt::numeric / r.sample_size, 3)
               )
               ORDER BY r.cnt DESC, r.value
             )
           ) AS payload
    FROM ranked r
    -- 014: 技(popular_move)だけ上限を move_top_n に広げる。
    WHERE r.rn <= CASE WHEN r.kind = 'popular_move' THEN move_top_n ELSE top_n END
    GROUP BY r.kind, r.species_key, r.scope, r.sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT p.kind,
         CASE WHEN p.scope = '' THEN p.species_key ELSE p.species_key || '|' || p.scope END,
         p.payload,
         computed
  FROM payloads p
  ON CONFLICT (kind, subject_key) DO UPDATE
    SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  -- 閾値未満に転落した種族・データが無くなった種族の掃除(011と同じ)。
  DELETE FROM suggestions
  WHERE kind = ANY (kinds)
    AND computed_at < computed;
END;
$$;

-- ------------------------------------------------------------------------------------------
-- refresh_archetype_popular_moves(): 019作成。①(owned_pokemon由来)の regulation 参照だけを
-- NULL::text に置き換える。②(ranked_team_members由来)は無変更。
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_archetype_popular_moves(
  min_sample_size int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  computed timestamptz := now();
BEGIN
  WITH src AS (
    -- archetype_id は既存参照だけを利用し、この集計では型行の作成・バックフィルを行わない。
    -- 022でowned_pokemon.regulationを廃止したため、常にNULL(=横断集計にのみ算入)として扱う。
    SELECT a.species_name, coalesce(a.item_name, '') AS item_name, a.role,
           NULL::text AS regulation, nullif(p.move_names, '{}'::text[]) AS move_names
    FROM owned_pokemon p
    JOIN archetypes a ON a.id = p.archetype_id
    WHERE p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now()
    UNION ALL
    SELECT a.species_name, coalesce(a.item_name, '') AS item_name, a.role,
           sr.regulation, nullif(m.move_names, '{}'::text[]) AS move_names
    FROM ranked_team_members m
    JOIN archetypes a ON a.id = m.archetype_id
    JOIN ranked_teams t ON t.id = m.ranked_team_id
    LEFT JOIN season_regulations sr ON sr.season = t.season
  ),
  scoped AS (
    SELECT s.species_name, s.item_name, s.role, k.scope, s.move_names
    FROM src s
    CROSS JOIN LATERAL unnest(
      CASE WHEN s.regulation IS NULL THEN ARRAY['']::text[] ELSE ARRAY['', s.regulation] END
    ) AS k(scope)
  ),
  sample_size AS (
    SELECT species_name, item_name, role, scope, count(*) AS sample_size
    FROM scoped
    WHERE move_names IS NOT NULL
    GROUP BY species_name, item_name, role, scope
  ),
  counts AS (
    SELECT s.species_name, s.item_name, s.role, s.scope, m.move_name AS value, count(*) AS cnt
    FROM scoped s, unnest(s.move_names) AS m(move_name)
    WHERE m.move_name IS NOT NULL
    GROUP BY s.species_name, s.item_name, s.role, s.scope, m.move_name
  ),
  ranked AS (
    SELECT c.*, ss.sample_size,
           row_number() OVER (
             PARTITION BY c.species_name, c.item_name, c.role, c.scope
             ORDER BY c.cnt DESC, c.value
           ) AS rn
    FROM counts c
    JOIN sample_size ss USING (species_name, item_name, role, scope)
    WHERE ss.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT species_name, item_name, role, scope,
           jsonb_build_object(
             'sample_size', sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'value', value,
                 'count', cnt,
                 'ratio', round(cnt::numeric / sample_size, 3)
               )
               ORDER BY cnt DESC, value
             )
           ) AS payload
    FROM ranked
    WHERE rn <= move_top_n
    GROUP BY species_name, item_name, role, scope, sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT 'popular_move_archetype',
         species_name || '|' || item_name || '|' || role ||
           CASE WHEN scope = '' THEN '' ELSE '|' || scope END,
         payload,
         computed
  FROM payloads
  ON CONFLICT (kind, subject_key) DO UPDATE
    SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  DELETE FROM suggestions
  WHERE kind = 'popular_move_archetype' AND computed_at < computed;
END;
$$;

-- ------------------------------------------------------------------------------------------
-- combined_species_usage(): 021作成。①(owned_pokemon由来)の regulation 参照だけを
-- NULL::text に置き換える。②(ranked_team_members由来)・戻り値の形は無変更。
-- ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION combined_species_usage(
  p_min_pokemon int DEFAULT 5,
  p_regulation text DEFAULT NULL
)
RETURNS TABLE (
  regulation text,
  species_key text,
  pokemon int,
  total_pokemon int,
  team_equivalents int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH src AS (
    -- ① アプリに登録された個体(収集拒否中は除く。008)。
    --    022でowned_pokemon.regulationを廃止したため、常にNULL(=横断集計にのみ算入)として扱う。
    SELECT p.species_name AS species_key, NULL::text AS regulation, false AS from_ranked
    FROM owned_pokemon p
    WHERE p.species_name IS NOT NULL
      AND btrim(p.species_name) <> ''
      AND (p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now())
    UNION ALL
    -- ② 過去シーズンの上位入賞チームの個体(010/011)。1個体1票で①と対等に扱う。
    SELECT m.species_key, sr.regulation, true
    FROM ranked_team_members m
    JOIN ranked_teams t ON t.id = m.ranked_team_id
    LEFT JOIN season_regulations sr ON sr.season = t.season
    WHERE m.species_key IS NOT NULL
  ),
  scoped AS (
    SELECT s.species_key, k.scope AS regulation, s.from_ranked
    FROM src s
    CROSS JOIN LATERAL unnest(
      CASE WHEN s.regulation IS NULL THEN ARRAY['']::text[] ELSE ARRAY['', s.regulation] END
    ) AS k(scope)
  ),
  ranked_team_counts AS (
    SELECT k.scope AS regulation, count(*)::int AS teams
    FROM ranked_teams t
    LEFT JOIN season_regulations sr ON sr.season = t.season
    CROSS JOIN LATERAL unnest(
      CASE WHEN sr.regulation IS NULL THEN ARRAY['']::text[] ELSE ARRAY['', sr.regulation] END
    ) AS k(scope)
    GROUP BY k.scope
  ),
  totals AS (
    SELECT
      sc.regulation,
      count(*)::int AS total_pokemon,
      (coalesce(max(rtc.teams), 0)
        + round(count(*) FILTER (WHERE NOT sc.from_ranked)::numeric / 6))::int AS team_equivalents
    FROM scoped sc
    LEFT JOIN ranked_team_counts rtc ON rtc.regulation = sc.regulation
    GROUP BY sc.regulation
  )
  SELECT t.regulation, sc.species_key, count(*)::int, t.total_pokemon, t.team_equivalents
  FROM scoped sc
  JOIN totals t ON t.regulation = sc.regulation
  WHERE p_regulation IS NULL OR sc.regulation = p_regulation
  GROUP BY t.regulation, sc.species_key, t.total_pokemon, t.team_equivalents
  HAVING count(*) >= p_min_pokemon;
$$;

REVOKE ALL ON FUNCTION combined_species_usage(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION combined_species_usage(int, text) TO anon, authenticated;

COMMENT ON FUNCTION combined_species_usage(int, text) IS
  '種族使用率の唯一の集計口。アプリ登録個体(owned_pokemon)と上位入賞チームの個体'
  '(ranked_team_members)を1個体1票で合算したプールから、レギュレーション別(regulation)'
  'と横断(regulation = '''')の使用数を返す。率の分母は team_equivalents。'
  '022時点でowned_pokemon側はレギュレーション属性を持たないため、常に横断側にのみ算入される。';

REVOKE ALL ON FUNCTION refresh_popular_builds_species(int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_archetype_popular_moves(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds_species(int, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_archetype_popular_moves(int, int) TO service_role;
