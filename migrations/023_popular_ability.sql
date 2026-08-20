-- migrations/023_popular_ability.sql
-- UI改修依頼(2026-08-20)「ダメージ計算タブの詳細設定モーダル・相手ポケモンタブで、
-- 特性のデフォルトを最も採用率の高い特性にする」に対応する。
--
-- refresh_popular_builds_species()(013作成→014改訂→019改名→022でowned_pokemon.regulation
-- 廃止に伴い改訂)は nature/item/tera/moveの4kindを集計しているが、特性(ability)だけ
-- 存在しなかった。ここに5つ目のkind 'popular_ability' を同じ流儀(owned_pokemon.ability_name +
-- ranked_team_members.ability を1個体1票でUNION ALL、k-匿名性min_sample_size、
-- 種族×レギュレーション別/横断の2スコープ)で追加する。関数本体は022時点の実装
-- (owned_pokemon側のregulationはNULL::textに固定済み)から1文字も変えず、abilityに関する行だけを
-- src/scoped/sample_size/counts/kinds の5箇所に足す。
CREATE OR REPLACE FUNCTION refresh_popular_builds_species(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  computed timestamptz := now();
  kinds text[] := ARRAY['popular_nature', 'popular_item', 'popular_tera', 'popular_move', 'popular_ability'];
BEGIN
  WITH src AS (
    -- ① ユーザーが登録した個体(収集拒否中の行は除く。008参照)。
    --    022でowned_pokemon.regulationを廃止したため、常にNULL(=横断集計にのみ算入)として扱う。
    SELECT species_name AS species_key, NULL::text AS regulation, nature, item_name, tera_type, ability_name,
           nullif(move_names, '{}'::text[]) AS move_names
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
    UNION ALL
    -- ② 過去シーズンの上位入賞チームの個体(010)。1個体1票で①と対等に扱う。
    --    レギュレーションはチームのシーズン(ranked_teams.season)を season_regulations で
    --    引き当てて求める。対応が未登録のシーズンは LEFT JOIN で regulation が NULL になり、
    --    横断集計にだけ入る(レギュレーション別には寄与しない)。
    SELECT m.species_key, sr.regulation, m.nature, m.item_name, m.tera_type, m.ability,
           nullif(m.move_names, '{}'::text[])
    FROM ranked_team_members m
    JOIN ranked_teams t ON t.id = m.ranked_team_id
    LEFT JOIN season_regulations sr ON sr.season = t.season
    WHERE m.species_key IS NOT NULL
  ),
  -- 1個体を「横断(scope='')」と「自分のレギュレーション(scope=regulation)」の
  -- 2つの母集団へ同時に数え上げる。レギュレーション不明(NULL)の個体は横断にしか入らない。
  scoped AS (
    SELECT s.species_key, k.scope, s.nature, s.item_name, s.tera_type, s.ability_name, s.move_names
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
    UNION ALL
    SELECT species_key, scope, 'popular_ability', count(*)
      FROM scoped WHERE ability_name IS NOT NULL GROUP BY species_key, scope
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
    UNION ALL
    SELECT species_key, scope, 'popular_ability', ability_name, count(*)
      FROM scoped WHERE ability_name IS NOT NULL GROUP BY species_key, scope, ability_name
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
    -- 014: 技(popular_move)だけ上限を move_top_n に広げる。他のkind(popular_abilityを含む)は
    -- 1個体1票で選択肢の種類も技ほど多くないため、top_n で十分。
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

-- 009/011/013/014/022と同じ防御方針(Postgresは関数作成時にPUBLICへEXECUTEを付けるので明示的に剥がす)。
REVOKE ALL ON FUNCTION refresh_popular_builds_species(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds_species(int, int, int) TO service_role;
