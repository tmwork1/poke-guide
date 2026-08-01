-- migrations/013_regulation.sql
-- 個体(owned_pokemon)・チーム(teams)にレギュレーション属性を追加し、匿名集計サジェスト
-- (suggestions)をレギュレーション別にも集計できるようにする(UI改修依頼 2026-08-01
-- 「ポケモンの個体とチームにレギュレーション属性を追加する / サジェストもレギュレーションに
-- フォーカスして精度を高めたい」)。
--
-- 値域は jpoke の `jpoke.types.Regulation`(2026-08-01時点で 'M-A' / 'M-B')。
-- ただしDB側にCHECK制約は置かない ── jpoke にレギュレーションが1つ増えるたびに
-- マイグレーションを書き足す運用になってしまい、「一覧はjpokeから取得する」という
-- 単一の情報源(src/lib/regulations.ts → public/master-data/autocomplete/regulations.json)が
-- 二重管理になるため。値の由来は UI 側の選択ボックス(SSRで REGULATIONS から描画)に限られ、
-- サーバー側の検証(src/lib/owned-pokemon-validation.ts / team-validation.ts)は
-- nature/item_name/tera_type と同じく「任意の文字列 or NULL」として扱う(既存の流儀に揃える)。
-- NULL = レギュレーション未指定(選択ボックスの placeholder 状態)。

ALTER TABLE owned_pokemon ADD COLUMN IF NOT EXISTS regulation text;
COMMENT ON COLUMN owned_pokemon.regulation IS
  'この個体を使うレギュレーション(jpoke の Regulation、例 M-A)。NULL=未指定。';

ALTER TABLE teams ADD COLUMN IF NOT EXISTS regulation text;
COMMENT ON COLUMN teams.regulation IS
  'このチームを使うレギュレーション(jpoke の Regulation、例 M-A)。NULL=未指定。';

-- ------------------------------------------------------------------------------------------
-- season_regulations: シーズン(season)→ レギュレーションの対応表
-- ------------------------------------------------------------------------------------------
-- 010_ranked_teams.sql が持つのは公式ランキングの「シーズン」表記(M-1/M-2/M-3)であって、
-- jpoke の「レギュレーション」(M-A/M-B)ではない。両者の対応はどちらのデータにも存在しない
-- (公式ランキングHTMLにもjpokeのCSVにも書かれていない)。
--
-- この対応をアプリ側のコードや集計SQLの CASE 式に焼き込むと、シーズンが増えるたびに
-- マイグレーション/スクリプトを書き直すことになる。ユーザー指示(2026-08-01)
-- 「season (M-n) と regulation (M-A, M-B, etc) の対応をDBに持っておく」に従い、
-- 独立した対応表テーブルとして持つ。新しいシーズンが始まったらこのテーブルに1行 INSERT する
-- だけでよく、SQL関数もアプリのコードも一切変更しなくてよい。
--
-- 位置づけは ranked_teams と同じ公開参照データ(user_id を持たない)。
-- 対応が未登録のシーズンは JOIN で落ちて regulation が NULL になり、
-- 「全レギュレーション横断」の母集団にだけ入る(レギュレーション別集計には寄与しない)。
-- 誤った対応で嘘の集計値を作るより安全側に倒す。
CREATE TABLE IF NOT EXISTS season_regulations (
  season text PRIMARY KEY,              -- ranked_teams.season と同じ表記('M-1' 等)
  regulation text NOT NULL,             -- jpoke の Regulation('M-A' 等)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE season_regulations IS
  '公式ランキングのシーズン表記(ranked_teams.season)と jpoke のレギュレーションの対応表。'
  '新シーズン開始時はこのテーブルに行を足すだけでよい(SQL関数・アプリコードの変更は不要)。';

-- 2026-08-01時点で取り込み済みのシーズン(ユーザー確認により確定した対応)。
INSERT INTO season_regulations (season, regulation) VALUES
  ('M-1', 'M-A'),
  ('M-2', 'M-A'),
  ('M-3', 'M-B')
ON CONFLICT (season) DO UPDATE
  SET regulation = EXCLUDED.regulation, updated_at = now();

-- RLS: 002_enable_rls.sql / 010_ranked_teams.sql の *_public_read と同じ方針。
ALTER TABLE season_regulations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS season_regulations_public_read ON season_regulations;
CREATE POLICY season_regulations_public_read ON season_regulations
  FOR SELECT TO anon, authenticated USING (true);

-- 003_grant_table_privileges.sql の教訓: RLSポリシーだけではテーブル権限の時点で弾かれる。
GRANT SELECT ON season_regulations TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON season_regulations TO service_role;

-- ------------------------------------------------------------------------------------------
-- refresh_popular_builds(): レギュレーション別の集計を追加する
-- ------------------------------------------------------------------------------------------
-- 011_ranked_teams_in_suggestions.sql の実装をベースに、母集団を「(種族, スコープ)」の
-- 2軸に拡張する。スコープは次の2種類で、1個体は両方に1票ずつ入る:
--     scope = ''         … 全レギュレーション横断(従来の集計。subject_key は種族名そのまま)
--     scope = 'M-A' 等   … その個体のレギュレーション限定(subject_key は '種族名|M-A')
--
-- なぜ subject_key に埋め込むか: suggestions は (kind, subject_key) の2列がキーの汎用テーブルで、
-- 列を増やすと 002_enable_rls.sql / GET /api/suggestions を含む既存の読み出し経路すべてに
-- 波及する。subject_key を複合キーにすれば API(src/pages/api/suggestions.ts)は無変更のまま、
-- フロント側が subject_key に '|レギュレーション' を付けるかどうかだけで切り替えられる
-- (src/lib/box-id/left-panel.ts の fetchSuggestionPayload 参照)。
-- 種族名に '|' は現れない(public/master-data/autocomplete/pokemon.json 全1290件で確認できる
-- 命名規則。フォルムは全角括弧を使う)ため、区切り文字として安全。
--
-- 従来の横断集計(scope='')を残す理由: レギュレーション未指定の個体を編集しているときは
-- 従来どおり全体の人気度を出したいのと、レギュレーション別はサンプル数が減って
-- k-匿名性の閾値(min_sample_size)に届かないケースが増えるため、フォールバック先が要る。
--
-- 分母(sample_size)の定義は 011 のまま「その項目の値が分かっている個体数」。
CREATE OR REPLACE FUNCTION refresh_popular_builds(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5
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
    WHERE r.rn <= top_n
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

-- 009/011と同じ防御方針(Postgresは関数作成時にPUBLICへEXECUTEを付けるので明示的に剥がす)。
REVOKE ALL ON FUNCTION refresh_popular_builds(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds(int, int) TO service_role;
