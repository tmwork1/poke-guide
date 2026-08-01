-- migrations/014_popular_move_top_n.sql
-- refresh_popular_builds() の技(popular_move)だけ上位N件の上限を広げる(ユーザー指示
-- 2026-08-01「くさわけ・こうそくいどう を手動除外リストで弾くのではなく、技の使用率で
-- 制御すべき」)。
--
-- 経緯: すばやさ早見表(/speed-chart)は当初 src/config/speed-chart.json の disabled.moves で
-- くさわけ・こうそくいどう を手で落としていた(013時点)。この2技は広く覚えられる(M-Bで
-- 129/92フォルム)ため、採用率フィルタ(adoptionRate)を技にも適用すれば手動除外は不要になる
-- はずだった。ところが実際に有効化すると、本来10%以上の採用率がある技まで一緒に落ちてしまう
-- 事例が見つかった。
--
-- 原因は集計側(013の refresh_popular_builds)にある。013の top_n はどの kind にも一律
-- 5件が適用されるが、1個体は技を最大4本持つため、種族全体では技の種類が20種類以上に
-- 散らばる。row_number() で種族ごと上位5技に切り捨てると、実際には採用率10%以上・
-- サンプル数5以上ある技が suggestions に書き出される前に落ちてしまう(ranked_team_members の
-- 生データ(切り捨てなし)と suggestions(top_n=5)を実測比較したところ、10%以上・n>=5を
-- 満たす(種族, 技)の組が生データでは10組あるのに suggestions では5組しか出ていなかった。
-- 落ちていた5組: メガメタグロス/こうそくいどう、イダイトウ(オス)/こうそくいどう、
-- メガメガニウム/くさわけ、メガスターミー/こうそくスピン、メガバシャーモ/りゅうのまい)。
--
-- 性格・持ち物・テラスタイプ(popular_nature/popular_item/popular_tera)は1個体につき1票しか
-- 入らず選択肢の種類も技ほど多くないため、top_n=5の切り捨てで実採用の値を落とす事例は
-- 確認されていない。挙動を変えないため、これらの既定値(min_sample_size/top_n)はそのまま
-- 据え置き、技(popular_move)だけ専用の上限(move_top_n)を新設する。
--
-- 013の関数本体(89〜203行目)からロジックは1文字も変えていない。変更点は次の2箇所のみ:
--   1. 引数に move_top_n int DEFAULT 20 を追加(min_sample_size/top_n の既定値は変更しない)。
--   2. 「WHERE r.rn <= top_n」を、kind が popular_move のときだけ move_top_n を見るように
--      変更(r.kind は payloads CTE のこの位置で参照できる。ranked CTE が c.kind を
--      そのまま r.kind として持ち回っているため)。
CREATE OR REPLACE FUNCTION refresh_popular_builds(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- now() はトランザクション開始時刻で、この関数呼び出しの中では変化しない。
  -- 下のINSERTで computed_at をこの値に揃えておき、最後に「この値より古いまま残っている行」
  -- = 今回の集計対象から外れた行、として消す(011と同じ掃除方式)。
  computed timestamptz := now();
  kinds text[] := ARRAY['popular_nature', 'popular_item', 'popular_tera', 'popular_move'];
BEGIN
  WITH src AS (
    -- ① ユーザーが登録した個体(収集拒否中の行は除く。008参照)
    SELECT species_name AS species_key, regulation, nature, item_name, tera_type,
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
  -- レギュレーション別のスコープにも同じ閾値がそのまま効く(横断では閾値を超えていても
  -- レギュレーション別では足りない、という組み合わせは黙って出力されない)。
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
    -- 014: 技(popular_move)だけ上限を move_top_n に広げる。1個体が4技持つため、
    -- 他のkind(1個体1票)と同じ top_n=5 では実採用の技まで切り捨てられてしまうため
    -- (このファイル冒頭のコメント参照)。r.kind は ranked CTE が c.kind をそのまま
    -- 持ち回っているのでここで参照できる。
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
  -- レギュレーション別の行(subject_key='種族名|M-A')もこの1文でまとめて掃除される。
  DELETE FROM suggestions
  WHERE kind = ANY (kinds)
    AND computed_at < computed;
END;
$$;

-- 013で作った2引数版(refresh_popular_builds(int, int))は、今回の3引数版と共存すると
-- 呼び出し側(scripts/db/refresh-suggestions.mjs 等)の「引数なしで呼ぶ」SELECT
-- refresh_popular_builds() がどちらの既定値を使うべきか曖昧になり、
-- "function is not unique" エラーになる。3引数版に一本化するため明示的に削除する。
DROP FUNCTION IF EXISTS refresh_popular_builds(int, int);

-- 009/011/013と同じ防御方針(Postgresは関数作成時にPUBLICへEXECUTEを付けるので明示的に剥がす)。
REVOKE ALL ON FUNCTION refresh_popular_builds(int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds(int, int, int) TO service_role;
