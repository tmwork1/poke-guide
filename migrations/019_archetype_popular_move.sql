-- migrations/019_archetype_popular_move.sql
-- 技の人気度を「種族」だけでなく、現在の型(種族名・持ち物名・role)単位でも集計する。
-- 既存4 kind の集計本体は014の関数を改名してそのまま保持し、同じ引数を受けるラッパーから
-- 型集計を続けて呼ぶ。既存SQLへ分岐を足さないことで後方互換を明確に保つ。

ALTER FUNCTION refresh_popular_builds(int, int, int) RENAME TO refresh_popular_builds_species;

CREATE FUNCTION refresh_archetype_popular_moves(
  min_sample_size int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- 1回の再集計で採用された行だけを残すため、全INSERTで同じ時刻を使う(014と同じ方式)。
  computed timestamptz := now();
BEGIN
  WITH src AS (
    -- archetype_id は既存参照だけを利用し、この集計では型行の作成・バックフィルを行わない。
    SELECT a.species_name, coalesce(a.item_name, '') AS item_name, a.role,
           p.regulation, nullif(p.move_names, '{}'::text[]) AS move_names
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
  -- regulation不明の個体は横断だけ、判明している個体は横断と規制別の双方へ数える(013/014と同じ)。
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
    -- k未満の型キーはpayloadを空で出さず、suggestions行自体を作らない。
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

  -- 閾値未満へ変化したキーや集計元から消えたキーを残さない(014と同じ世代削除)。
  DELETE FROM suggestions
  WHERE kind = 'popular_move_archetype' AND computed_at < computed;
END;
$$;

CREATE FUNCTION refresh_popular_builds(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- 既存4 kind は014の実装・引数を一切変えずに更新する。
  PERFORM refresh_popular_builds_species(min_sample_size, top_n, move_top_n);
  PERFORM refresh_archetype_popular_moves(min_sample_size, move_top_n);
END;
$$;

-- DB関数はPostgresが既定でPUBLICへEXECUTEを付けるため、既存関数と同じ権限へ絞る。
REVOKE ALL ON FUNCTION refresh_popular_builds_species(int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_archetype_popular_moves(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_popular_builds(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds_species(int, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_archetype_popular_moves(int, int) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_popular_builds(int, int, int) TO service_role;
