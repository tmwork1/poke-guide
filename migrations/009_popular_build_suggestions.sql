-- migrations/009_popular_build_suggestions.sql
-- 匿名集計サジェスト機能・第1段階。owned_pokemon(登録された個体)の性格・アイテム・
-- テラスタル・技を種族(species_name)ごとに集計し、suggestions テーブル
-- (kind='popular_nature'|'popular_item'|'popular_tera'|'popular_move')へ書き込む
-- refresh_popular_builds() 関数を定義する。呼び出し元(cron/GitHub Actionsバッチ、未実装)は
-- 別途配線する。
--
-- なぜPostgres関数(plpgsql)でGROUP BYするか: Cloudflare Workers Freeプランは1呼び出りあたり
-- CPU 10msという制約があり、owned_pokemon全件をJS側でfetchしてループ集計する実装は成立しない。
-- DB側で集計まで完結させ、APIはsuggestionsテーブルを読むだけにする(replace_team_members
-- (007_teams.sql)と同様、集計そのものをPostgres関数に閉じ込める設計)。
--
-- 収集拒否(008_owned_pokemon_collection_opt_out.sql): collection_opt_out_until が
-- NULL または過去日時の行だけを対象にする。「期限切れを検知して列を戻す」バッチは無く、
-- この関数を呼ぶたびに都度 `collection_opt_out_until < now()` を判定するだけで再計算が
-- 自動的に反映される。
--
-- k-匿名性: 種族ごとの総サンプル数(値がNULLの行も含めた、対象となった行数そのもの)が
-- min_sample_size 未満の種族は書き込まない(利用者が極端に少ない種族で個人の入力がほぼ
-- そのまま見えてしまうことを防ぐ)。閾値未満に転落した種族・データが無くなった種族は
-- 既存のsuggestions行をDELETEで掃除する。
--
-- nature/item/tera/moveの4ブロックは、可読性を優先し動的SQLでのループ化はせず明示的に
-- 4回書く(007_teams.sqlのコメント慣習に倣う)。
CREATE OR REPLACE FUNCTION refresh_popular_builds(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- ① 性格(nature)の種族ごとの人気集計
  WITH eligible AS (
    SELECT species_name, nature
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    -- 総サンプル数=値の有無を問わない対象行数(k-匿名性の判定に使う分母)
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  counts AS (
    SELECT species_name, nature AS value, count(*) AS cnt
    FROM eligible
    WHERE nature IS NOT NULL
    GROUP BY species_name, nature
  ),
  ranked AS (
    SELECT c.species_name, c.value, c.cnt,
           row_number() OVER (PARTITION BY c.species_name ORDER BY c.cnt DESC, c.value) AS rn
    FROM counts c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT r.species_name,
           jsonb_build_object(
             'sample_size', s.sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'value', r.value,
                 'count', r.cnt,
                 'ratio', round(r.cnt::numeric / s.sample_size, 3)
               )
               ORDER BY r.cnt DESC, r.value
             )
           ) AS payload
    FROM ranked r
    JOIN sample_size s ON s.species_name = r.species_name
    WHERE r.rn <= top_n
    GROUP BY r.species_name, s.sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT 'popular_nature', p.species_name, p.payload, now()
  FROM payloads p
  ON CONFLICT (kind, subject_key) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  WITH eligible AS (
    SELECT species_name, nature
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  qualifying AS (
    SELECT DISTINCT c.species_name
    FROM (
      SELECT species_name, nature FROM eligible WHERE nature IS NOT NULL
    ) c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  )
  -- 閾値未満に転落した種族・データが無くなった種族の掃除
  DELETE FROM suggestions
  WHERE kind = 'popular_nature'
    AND subject_key NOT IN (SELECT species_name FROM qualifying);

  -- ② アイテム(item_name)の種族ごとの人気集計
  WITH eligible AS (
    SELECT species_name, item_name
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  counts AS (
    SELECT species_name, item_name AS value, count(*) AS cnt
    FROM eligible
    WHERE item_name IS NOT NULL
    GROUP BY species_name, item_name
  ),
  ranked AS (
    SELECT c.species_name, c.value, c.cnt,
           row_number() OVER (PARTITION BY c.species_name ORDER BY c.cnt DESC, c.value) AS rn
    FROM counts c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT r.species_name,
           jsonb_build_object(
             'sample_size', s.sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'value', r.value,
                 'count', r.cnt,
                 'ratio', round(r.cnt::numeric / s.sample_size, 3)
               )
               ORDER BY r.cnt DESC, r.value
             )
           ) AS payload
    FROM ranked r
    JOIN sample_size s ON s.species_name = r.species_name
    WHERE r.rn <= top_n
    GROUP BY r.species_name, s.sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT 'popular_item', p.species_name, p.payload, now()
  FROM payloads p
  ON CONFLICT (kind, subject_key) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  WITH eligible AS (
    SELECT species_name, item_name
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  qualifying AS (
    SELECT DISTINCT c.species_name
    FROM (
      SELECT species_name, item_name FROM eligible WHERE item_name IS NOT NULL
    ) c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  )
  DELETE FROM suggestions
  WHERE kind = 'popular_item'
    AND subject_key NOT IN (SELECT species_name FROM qualifying);

  -- ③ テラスタイプ(tera_type)の種族ごとの人気集計
  WITH eligible AS (
    SELECT species_name, tera_type
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  counts AS (
    SELECT species_name, tera_type AS value, count(*) AS cnt
    FROM eligible
    WHERE tera_type IS NOT NULL
    GROUP BY species_name, tera_type
  ),
  ranked AS (
    SELECT c.species_name, c.value, c.cnt,
           row_number() OVER (PARTITION BY c.species_name ORDER BY c.cnt DESC, c.value) AS rn
    FROM counts c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT r.species_name,
           jsonb_build_object(
             'sample_size', s.sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'value', r.value,
                 'count', r.cnt,
                 'ratio', round(r.cnt::numeric / s.sample_size, 3)
               )
               ORDER BY r.cnt DESC, r.value
             )
           ) AS payload
    FROM ranked r
    JOIN sample_size s ON s.species_name = r.species_name
    WHERE r.rn <= top_n
    GROUP BY r.species_name, s.sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT 'popular_tera', p.species_name, p.payload, now()
  FROM payloads p
  ON CONFLICT (kind, subject_key) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  WITH eligible AS (
    SELECT species_name, tera_type
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  qualifying AS (
    SELECT DISTINCT c.species_name
    FROM (
      SELECT species_name, tera_type FROM eligible WHERE tera_type IS NOT NULL
    ) c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  )
  DELETE FROM suggestions
  WHERE kind = 'popular_tera'
    AND subject_key NOT IN (SELECT species_name FROM qualifying);

  -- ④ 技(move_names、text[]をunnest)の種族ごとの人気集計
  WITH eligible AS (
    SELECT species_name, move_names
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    -- ここでの分母は「対象個体数」であり「延べ技数」ではない(nature/item/teraと同じ定義に揃える)
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  counts AS (
    SELECT e.species_name, m.move_name AS value, count(*) AS cnt
    FROM eligible e, unnest(e.move_names) AS m(move_name)
    WHERE m.move_name IS NOT NULL
    GROUP BY e.species_name, m.move_name
  ),
  ranked AS (
    SELECT c.species_name, c.value, c.cnt,
           row_number() OVER (PARTITION BY c.species_name ORDER BY c.cnt DESC, c.value) AS rn
    FROM counts c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT r.species_name,
           jsonb_build_object(
             'sample_size', s.sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'value', r.value,
                 'count', r.cnt,
                 'ratio', round(r.cnt::numeric / s.sample_size, 3)
               )
               ORDER BY r.cnt DESC, r.value
             )
           ) AS payload
    FROM ranked r
    JOIN sample_size s ON s.species_name = r.species_name
    WHERE r.rn <= top_n
    GROUP BY r.species_name, s.sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT 'popular_move', p.species_name, p.payload, now()
  FROM payloads p
  ON CONFLICT (kind, subject_key) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  WITH eligible AS (
    SELECT species_name, move_names
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
  ),
  sample_size AS (
    SELECT species_name, count(*) AS sample_size
    FROM eligible
    GROUP BY species_name
  ),
  qualifying AS (
    SELECT DISTINCT c.species_name
    FROM (
      SELECT e.species_name, m.move_name
      FROM eligible e, unnest(e.move_names) AS m(move_name)
      WHERE m.move_name IS NOT NULL
    ) c
    JOIN sample_size s ON s.species_name = c.species_name
    WHERE s.sample_size >= min_sample_size
  )
  DELETE FROM suggestions
  WHERE kind = 'popular_move'
    AND subject_key NOT IN (SELECT species_name FROM qualifying);
END;
$$;

-- Postgresは関数作成時にデフォルトでPUBLICにEXECUTEを付与するため、明示的にrevokeしてから
-- service_roleにのみ許可する(replace_team_members(007_teams.sql)と同じ防御方針)。
REVOKE ALL ON FUNCTION refresh_popular_builds(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds(int, int) TO service_role;
