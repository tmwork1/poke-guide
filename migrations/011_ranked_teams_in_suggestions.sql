-- migrations/011_ranked_teams_in_suggestions.sql
-- 上位入賞チームの個体(ranked_team_members、010)を、匿名集計サジェスト
-- (suggestions の popular_nature/popular_item/popular_tera/popular_move)の母集団に加える。
--
-- ウェイトは owned_pokemon と同じ ── 「上位チームだから2票」のような重み付けはしない。
-- 1個体 = 1票で単純に足し合わせる。
--
-- ■ 1. species_key: 突き合わせのためのキー
-- ranked_team_members は公式ランキングの表記をそのまま持っている(species_name='ロトム',
-- form_name='ウォッシュロトム')が、アプリ側の owned_pokemon.species_name は
-- public/master-data/autocomplete/pokemon.json の名前('ウォッシュロトム')。さらに公式ランキングは
-- メガシンカを「進化前 + メガストーン」で表す(ギャラドス@ギャラドスナイト)のに対し、アプリは
-- 種族名そのものを「メガギャラドス」にして持ち物をメガストーンに固定する
-- (src/lib/box-id/shared-core.ts の resolveMegaStoneItem)。
-- そのまま species_name で集計すると、フォルム違いが1種族に潰れ、メガ個体のデータが
-- ユーザーの編集画面(subject_key='メガギャラドス')に一生届かない。
-- アプリ側の語彙に寄せた species_key を scripts/ranker/build_ranked_teams.py が付けており
-- (species_key_of()、実測 6241体すべて解決・うち1895体がメガ)、集計はこれをキーにする。
-- 値の投入は scripts/db/seed-ranked-teams.mjs が行うため、ここでは列の追加だけを行う。
ALTER TABLE ranked_team_members ADD COLUMN IF NOT EXISTS species_key text;

COMMENT ON COLUMN ranked_team_members.species_key IS
  'アプリ内の正式な種族名(owned_pokemon.species_name と同じ語彙)。メガストーン所持個体は'
  'メガ後の種族名になる。サジェスト集計 refresh_popular_builds() の突き合わせキー。';

CREATE INDEX IF NOT EXISTS idx_ranked_team_members_species_key
  ON ranked_team_members(species_key);

-- ■ 2. refresh_popular_builds() の作り直し
-- 009 は nature/item/tera/move の4ブロックを、集計用とお掃除用で計8回ほぼ同じ内容で
-- 書いていた。母集団が2テーブルになると16回になってしまうので、
-- 「(species_key, kind, value) の縦持ち」に正規化して1本にまとめる。
-- 動的SQLは使っていないので、009のコメント方針(可読性優先・ループ化しない)には反しない。
--
-- ● 分母(sample_size)の定義を変えている
-- 009 は「値がNULLの行も含めた対象行数」を分母にしていた。owned_pokemon なら空欄は
-- ユーザーが選ばなかったという情報だが、ranked_team_members の NULL は
-- 「構築記事に書かれていなかった=観測できていない」であって選択ではない。
-- 6241体のうち性格が分かるのは1089体しかないので、これを分母に入れると
-- UIの「人気: ようき(47%)」(src/lib/box-id/left-panel.ts)が「ようき(8%)」に化けて嘘になる。
-- そこで分母を **その項目の値が分かっている個体数** に統一した。
-- owned_pokemon 側は実測でほぼ全件が値を持つ(426件中 性格426/持ち物425/テラス424/技425)ため、
-- この変更による既存の集計値への影響は誤差の範囲。
-- k-匿名性の意味も「その種族について5人以上が値を開示していること」となり、むしろ素直になる。
--
-- ● テラスタルについて
-- チャンピオンズにテラスタルは無いため ranked_team_members.tera_type は常にNULLで、
-- popular_tera には1票も入らない(分母にも入らない)。ここで特別扱いはしていない ──
-- 「値が分かっている個体だけを数える」規則から自動的にそうなる。
CREATE OR REPLACE FUNCTION refresh_popular_builds(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- now() はトランザクション開始時刻で、この関数呼び出しの中では変化しない。
  -- 下のINSERTで computed_at をこの値に揃えておき、最後に「この値より古いまま残っている行」
  -- = 今回の集計対象から外れた行、として消す(009の kind ごとの qualifying/DELETE の代わり)。
  computed timestamptz := now();
  kinds text[] := ARRAY['popular_nature', 'popular_item', 'popular_tera', 'popular_move'];
BEGIN
  WITH src AS (
    -- ① ユーザーが登録した個体(収集拒否中の行は除く。008参照)
    SELECT species_name AS species_key, nature, item_name, tera_type,
           nullif(move_names, '{}'::text[]) AS move_names
    FROM owned_pokemon
    WHERE collection_opt_out_until IS NULL OR collection_opt_out_until < now()
    UNION ALL
    -- ② 過去シーズンの上位入賞チームの個体(010)。1個体1票で①と対等に扱う。
    SELECT species_key, nature, item_name, tera_type,
           nullif(move_names, '{}'::text[])
    FROM ranked_team_members
    WHERE species_key IS NOT NULL
  ),
  -- 分母: 項目ごとに「値が分かっている個体数」。技だけは延べ技数ではなく個体数で数える
  -- (「この種族の技構成が分かっている個体のうち何割がこの技を入れているか」にするため)。
  sample_size AS (
    SELECT species_key, 'popular_nature'::text AS kind, count(*) AS sample_size
      FROM src WHERE nature IS NOT NULL GROUP BY species_key
    UNION ALL
    SELECT species_key, 'popular_item', count(*)
      FROM src WHERE item_name IS NOT NULL GROUP BY species_key
    UNION ALL
    SELECT species_key, 'popular_tera', count(*)
      FROM src WHERE tera_type IS NOT NULL GROUP BY species_key
    UNION ALL
    SELECT species_key, 'popular_move', count(*)
      FROM src WHERE move_names IS NOT NULL GROUP BY species_key
  ),
  -- 分子: (種族, 項目, 値) ごとの票数。技は unnest して1体につき最大4票入る。
  counts AS (
    SELECT species_key, 'popular_nature'::text AS kind, nature AS value, count(*) AS cnt
      FROM src WHERE nature IS NOT NULL GROUP BY species_key, nature
    UNION ALL
    SELECT species_key, 'popular_item', item_name, count(*)
      FROM src WHERE item_name IS NOT NULL GROUP BY species_key, item_name
    UNION ALL
    SELECT species_key, 'popular_tera', tera_type, count(*)
      FROM src WHERE tera_type IS NOT NULL GROUP BY species_key, tera_type
    UNION ALL
    SELECT s.species_key, 'popular_move', m.move_name, count(*)
      FROM src s, unnest(s.move_names) AS m(move_name)
      WHERE m.move_name IS NOT NULL GROUP BY s.species_key, m.move_name
  ),
  -- k-匿名性: 開示者が min_sample_size 人未満の (種族, 項目) は書き出さない。
  ranked AS (
    SELECT c.species_key, c.kind, c.value, c.cnt, s.sample_size,
           row_number() OVER (PARTITION BY c.species_key, c.kind
                              ORDER BY c.cnt DESC, c.value) AS rn
    FROM counts c
    JOIN sample_size s ON s.species_key = c.species_key AND s.kind = c.kind
    WHERE s.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT r.kind, r.species_key,
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
    GROUP BY r.kind, r.species_key, r.sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT p.kind, p.species_key, p.payload, computed
  FROM payloads p
  ON CONFLICT (kind, subject_key) DO UPDATE
    SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  -- 閾値未満に転落した種族・データが無くなった種族の掃除。
  -- 上のINSERTで触れた行は computed_at = computed になっているので、それより古い行が残骸。
  DELETE FROM suggestions
  WHERE kind = ANY (kinds)
    AND computed_at < computed;
END;
$$;

-- 009と同じ防御方針(Postgresは関数作成時にPUBLICへEXECUTEを付けるので明示的に剥がす)。
REVOKE ALL ON FUNCTION refresh_popular_builds(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_popular_builds(int, int) TO service_role;
