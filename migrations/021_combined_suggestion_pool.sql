-- migrations/021_combined_suggestion_pool.sql
-- サジェストの集計元を「本アプリに登録されているデータ + 過去のランキングデータ」の
-- 重みづけなし合算プールに統一する(ユーザー指示、2026-08-05)。
--
-- ■ 背景: 3つのサジェストだけが合算されていなかった
-- 009/011/014/019 の refresh_popular_builds 系(人気の性格・持ち物・テラス・技)は当初から
-- owned_pokemon と ranked_team_members を UNION ALL し、011 のコメントどおり「1個体 = 1票、
-- 上位チームだから2票のような重み付けはしない」で集計している。ところが次の3つは
-- ランキングデータ(ranked_*)しか見ておらず、アプリに登録されたデータが母集団から
-- 丸ごと抜けていた。本ファイルはこの3つを合算プールへ揃える。
--   (a) チーム編集のポケモンサジェスト(016 の team_partner_* / ranked_species_usage)
--   (b) 相性チェックの相手上位N体(src/pages/api/matchup-targets.ts が (a) と同じ関数を使用)
--   (c) すばやさ早見表の種族使用率(src/pages/speed-chart/index.astro が
--       ranked_team_members を直接ページングして集計していた)
--
-- ■ 「1票」の単位が2種類あることについて
-- (a) は**共起**(同じチームに一緒に居たか)の集計なので、票の単位はチームでしかありえない。
-- 単独で登録されただけの個体は「誰と一緒に使われたか」の情報を持たないため、原理的に
-- 共起プールへは入れられない。したがって (a) はアプリ側の母集団を teams / team_members とし、
-- 「ランキングの1チーム = アプリの1チーム」で合算する。
-- (b)(c) は**使用率**なので個体単位で数えられる。ここは 009/011 と同じ「1個体1票」に揃え、
-- アプリ側は owned_pokemon 全件(チーム未所属の個体を含む)を母集団に入れる。
-- 2つの単位が併存するのは母集団の恣意的な使い分けではなく、指標そのものの性質による。
--
-- ■ 使用率の分母を「チーム相当数」にする理由
-- (b)(c) の既存の表示はどちらも「全Nチーム中M チームが採用(=M/N%)」という**チーム採用率**で、
-- src/config/speed-chart.json の speciesAdoptionRate.threshold(0.005 = 0.5%)や
-- minSampleSize(50 = 総チーム数)もその尺度で調整済みである。分母を素の総個体数へ変えると
-- 率が一律で 1/6 になり、これらの閾値が全て意味を失う。
-- そこで分母は「チーム相当数 = ランキングの実チーム数 + アプリ側個体数 ÷ 6」とする。
--   - ランキングだけの母集団では実チーム数そのものになるため、既存の数値・閾値は不変
--     (ranked_team_members はチーム内で種族が重複しないので「採用チーム数 = 個体数」であり、
--      合算前後で ranked 由来の分子・分母はどちらも完全に一致する)。
--   - アプリ側は「6体で1パーティ」というルール上の定数で換算するだけで、係数による
--     重み付けではない(1個体の重みはランキング側の1個体と同じ 1/6 チーム)。
--
-- ■ プライバシー
-- owned_pokemon / teams / team_members は本人限定の非公開テーブル(005/007)なので、
-- 合算プールを読むビューには anon/authenticated への SELECT 権限を一切与えず、
-- 集計結果だけを返す SECURITY DEFINER 関数からのみ参照する。関数が外へ出すのは件数と
-- 比率だけで、個票は一切出さない(009 以来の方針と同じ)。
-- 収集拒否(008 の collection_opt_out_until)は 009 と同じ式で毎回判定し、拒否中の個体は
-- 使用率プールからも共起プールからも外れる。
-- k-匿名性は 009 に合わせて既定 5。ただし 3 種類の指標で効かせ方が違う:
--   - combined_species_usage(): プール内の個体数が閾値未満の種族は行ごと返さない。
--   - team_partner_species_stats(): 既存の p_min_co_teams(2) / p_min_candidate_teams(5) を
--     そのまま使う(候補として外へ出るのは5チーム以上で採用されている種族だけ)。
--   - team_partner_archetype_stats(): 候補種族が上記で既に絞られた後にしか呼ばれない。

-- ============================================================================
-- 1. 合算チームプール(#5 チーム編集のポケモンサジェスト用)
-- ============================================================================
-- ranked_team_id(uuid)と teams.id(uuid)は別テーブルの主キーなので、そのまま UNION すると
-- 衝突の可能性を排除できない。'r:' / 't:' の接頭辞を付けた text をチームの識別子にする。

-- アプリ側のチーム × 種族。species_name は owned_pokemon の語彙で、011 が
-- ranked_team_members.species_key をこの語彙へ揃えてあるため、そのまま突き合わせられる。
CREATE OR REPLACE VIEW app_team_species AS
  SELECT DISTINCT tm.team_id, p.species_name AS species_key
  FROM team_members tm
  JOIN owned_pokemon p ON p.id = tm.owned_pokemon_id
  WHERE p.species_name IS NOT NULL
    AND btrim(p.species_name) <> ''
    AND (p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now());

CREATE OR REPLACE VIEW app_team_archetypes AS
  SELECT DISTINCT tm.team_id, p.archetype_id, p.species_name AS species_key
  FROM team_members tm
  JOIN owned_pokemon p ON p.id = tm.owned_pokemon_id
  WHERE p.archetype_id IS NOT NULL
    AND p.species_name IS NOT NULL
    AND btrim(p.species_name) <> ''
    AND (p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now());

-- 共起プールに入れるアプリ側チームの条件: 収集拒否を除いた後に2体以上残ること。
-- 1体しか入っていないチーム(編集途中で放置されたものが典型)は共起のペアを1つも作れない
-- のに total_teams と seed_teams だけを増やし、lift(= 実測共起 / 独立仮定の期待共起)の
-- 期待値を押し下げてしまう。情報を持たない行を母数にだけ足すことになるので除外する。
CREATE OR REPLACE VIEW app_cooccurrence_teams AS
  SELECT team_id
  FROM app_team_species
  GROUP BY team_id
  HAVING count(*) >= 2;

-- UNION ではなく UNION ALL でよい理由: 両辺は team_key の接頭辞('r:' / 't:')が違うので
-- 絶対に重複せず、各辺は元のビュー側で既に重複が潰れている(016 の ranked_team_species は
-- DISTINCT、app_team_species も DISTINCT)。UNION にすると 6,000行超に対して毎回
-- 重複排除のソート/ハッシュが走る。実測(ローカル、1041ランキングチーム + アプリ2チーム)で
-- team_partner_species_stats が UNION で約40ms、UNION ALL で約20〜27ms だった。
-- なお 016 のランキング単独時は数msで、合算により母集団が増えた分は元から遅くなる。
-- 016 が挙げた制約は Workers の CPU 10ms であって DB 時間ではない(DB待ちはI/O扱い)ため、
-- この範囲は許容する。
CREATE OR REPLACE VIEW combined_team_species AS
  SELECT 'r:' || s.ranked_team_id::text AS team_key, s.species_key
  FROM ranked_team_species s
  UNION ALL
  SELECT 't:' || a.team_id::text, a.species_key
  FROM app_team_species a
  JOIN app_cooccurrence_teams c ON c.team_id = a.team_id;

CREATE OR REPLACE VIEW combined_team_archetypes AS
  SELECT 'r:' || ta.ranked_team_id::text AS team_key, ta.archetype_id, ta.species_key
  FROM ranked_team_archetypes ta
  UNION ALL
  SELECT 't:' || a.team_id::text, a.archetype_id, a.species_key
  FROM app_team_archetypes a
  JOIN app_cooccurrence_teams c ON c.team_id = a.team_id;

-- 016 の ranked_team_species / ranked_team_archetypes は公開データだけを見るビューなので
-- anon へ GRANT されているが、こちらは owned_pokemon / teams を含むため公開しない。
-- (003 のとおりこのプロジェクトの public スキーマには anon 向けのデフォルト権限が無いので
--  実際には無権限で作られるが、意図であることを明示するために REVOKE も書いておく。)
REVOKE ALL ON app_team_species, app_team_archetypes, app_cooccurrence_teams,
              combined_team_species, combined_team_archetypes
  FROM PUBLIC, anon, authenticated;

COMMENT ON VIEW combined_team_species IS
  'チーム共起サジェストの母集団。上位入賞チーム(ranked_teams)とアプリのチーム(teams)を'
  '1チーム1票で合算したもの。非公開データを含むため SECURITY DEFINER 関数からのみ読む。';

-- ============================================================================
-- 2. #5 / #6 の関数を合算プールへ差し替え
-- ============================================================================
-- 016 の2関数は本体だけを差し替える(引数・戻り値の型と列名は一切変えないので、
-- 呼び出し側 src/pages/api/team-suggestions.ts のマッピングは無変更で動く)。
-- 非公開テーブルを読むようになるため SECURITY INVOKER から SECURITY DEFINER へ変える。
-- SECURITY DEFINER 関数は search_path を固定するのが定石なので明示する。

CREATE OR REPLACE FUNCTION team_partner_species_stats(
  p_species_keys text[],
  p_min_co_teams int DEFAULT 2,
  p_min_candidate_teams int DEFAULT 5
)
RETURNS TABLE (
  seed_species text,
  candidate_species text,
  co_teams int,
  seed_teams int,
  candidate_teams int,
  total_teams int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH species_usage AS (
    -- 016 は ranked_species_usage() を呼んでいたが、その関数はランキングだけの母集団を返す。
    -- lift の分母(seed_teams / candidate_teams / total_teams)は分子(co_teams)と同じ
    -- プールから取らなければ比率が壊れるため、ここで合算プールから数え直す。
    SELECT s.species_key,
           count(*)::int AS teams,
           (SELECT count(DISTINCT team_key)::int FROM combined_team_species) AS total_teams
    FROM combined_team_species s
    GROUP BY s.species_key
  ),
  pairs AS (
    SELECT
      seed.species_key AS seed_species,
      other.species_key AS candidate_species,
      count(*)::int AS co_teams
    FROM combined_team_species seed
    JOIN combined_team_species other
      ON other.team_key = seed.team_key
     AND other.species_key <> seed.species_key
    WHERE seed.species_key = ANY (p_species_keys)
      -- 候補が自チームの他のメンバーと同じ種族なら提案しても入れられない
      -- (team-validation.ts の duplicate-species)。ここで落として往復を減らす。
      AND NOT (other.species_key = ANY (p_species_keys))
    GROUP BY 1, 2
  )
  SELECT
    p.seed_species,
    p.candidate_species,
    p.co_teams,
    su.teams AS seed_teams,
    cu.teams AS candidate_teams,
    cu.total_teams
  FROM pairs p
  JOIN species_usage su ON su.species_key = p.seed_species
  JOIN species_usage cu ON cu.species_key = p.candidate_species
  WHERE p.co_teams >= p_min_co_teams
    AND cu.teams >= p_min_candidate_teams;
$$;

-- 型に添える特性は 018 のとおり識別キーではなく最頻値(推定値)。その最頻値も
-- ランキングだけで決めていたので合算プールから採り直す。018 の archetype_modal_ability は
-- 公開ビュー(anon に GRANT 済み)だが、こちらは owned_pokemon を含むので公開しない。
-- 018 の元ビューは削除せず残す ── ランキングだけの最頻特性という別の観測値であり、
-- 孤児 archetypes 行の点検手順(scripts/db/backfill-ranked-archetypes.mjs 冒頭のコメントが
-- 挙げる「参照が0の行を探す4テーブル」)がこのビューを数えることを前提にしているため。
CREATE OR REPLACE VIEW combined_archetype_modal_ability AS
  WITH abilities AS (
    SELECT m.archetype_id, m.ability AS ability_name
    FROM ranked_team_members m
    WHERE m.archetype_id IS NOT NULL AND m.ability IS NOT NULL
    UNION ALL
    SELECT p.archetype_id, p.ability_name
    FROM owned_pokemon p
    WHERE p.archetype_id IS NOT NULL AND p.ability_name IS NOT NULL
      AND btrim(p.ability_name) <> ''
      AND (p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now())
  )
  SELECT
    archetype_id,
    mode() WITHIN GROUP (ORDER BY ability_name) AS ability_name,
    count(*)::int AS ability_known_members
  FROM abilities
  GROUP BY archetype_id;

REVOKE ALL ON combined_archetype_modal_ability FROM PUBLIC, anon, authenticated;

COMMENT ON VIEW archetype_modal_ability IS
  '型ごとの最頻特性(上位入賞チームのみを母集団とする旧定義、018)。サジェストの表示には'
  '合算プール版の combined_archetype_modal_ability を使う(021)。';

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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH candidates AS (
    SELECT ta.team_key, ta.archetype_id, ta.species_key
    FROM combined_team_archetypes ta
    WHERE ta.species_key = ANY (p_candidate_species)
  ),
  seed_species_teams AS (
    SELECT DISTINCT team_key
    FROM combined_team_species
    WHERE species_key = ANY (p_seed_species)
  ),
  -- 1チームに複数の seed 型が居る場合は最も近いものだけを採る(016 と同じ理由: 合計にすると
  -- 「自チームと2体被っているチーム」が2票入り、共起の強さではなく重なり具合を測ってしまう)。
  seed_archetype_teams AS (
    SELECT ta.team_key, max(coalesce(s.w, 0))::numeric AS w
    FROM unnest(p_seed_ids, p_seed_weights) AS s(id, w)
    JOIN combined_team_archetypes ta ON ta.archetype_id = s.id
    GROUP BY ta.team_key
  )
  SELECT
    c.archetype_id,
    c.species_key,
    ma.ability_name,
    a.item_name,
    a.role,
    count(*)::int AS teams_total,
    count(*) FILTER (WHERE sst.team_key IS NOT NULL)::int AS teams_co_species,
    coalesce(sum(sat.w), 0)::numeric AS weighted_co_archetype
  FROM candidates c
  JOIN archetypes a ON a.id = c.archetype_id
  LEFT JOIN combined_archetype_modal_ability ma ON ma.archetype_id = c.archetype_id
  LEFT JOIN seed_species_teams sst ON sst.team_key = c.team_key
  LEFT JOIN seed_archetype_teams sat ON sat.team_key = c.team_key
  GROUP BY c.archetype_id, c.species_key, ma.ability_name, a.item_name, a.role;
$$;

-- SECURITY DEFINER になったので、PUBLIC への暗黙の EXECUTE を明示的に剥がし直す
-- (016 の GRANT TO anon, authenticated は CREATE OR REPLACE で維持されるが、
--  権限の意図をこのファイル単体で読めるように再掲する)。
REVOKE ALL ON FUNCTION team_partner_species_stats(text[], int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION team_partner_archetype_stats(uuid[], numeric[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_partner_species_stats(text[], int, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION team_partner_archetype_stats(uuid[], numeric[], text[], text[]) TO anon, authenticated;

-- ============================================================================
-- 3. combined_species_usage(): 使用率(#5のフォールバック / #6 / #7)
-- ============================================================================
-- 「1個体1票」の合算プールから、レギュレーション別と横断の種族使用率を返す。
-- 013/014 と同じスコープ表現を使う: regulation = '' が横断、それ以外がレギュレーション別。
-- レギュレーション不明の個体(season_regulations に対応の無いシーズン、regulation 未設定の
-- 登録個体)は横断にだけ入る。
--
-- 戻り値:
--   regulation       '' = 横断、'M-A' 等 = そのレギュレーション
--   species_key      種族(フォルム)名。owned_pokemon.species_name と同じ語彙。
--   pokemon          そのスコープのプールに居るその種族の個体数(= 採用チーム数相当)
--   total_pokemon    そのスコープのプールの総個体数(参考値。率の分母ではない)
--   team_equivalents 率の分母。ランキングの実チーム数 + アプリ個体数 ÷ 6(冒頭の解説参照)
CREATE FUNCTION combined_species_usage(
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
    -- ① アプリに登録された個体(収集拒否中は除く。008)
    SELECT p.species_name AS species_key, p.regulation, false AS from_ranked
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
  -- ランキング側だけは実チーム数が分かるので、換算せずそのまま分母に使う。
  -- これにより合算前(ランキングのみ)の使用率と完全に一致する。
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
      -- アプリ側は個体しか無いので 6体 = 1チーム相当で換算して足す。
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
  -- k-匿名性: プール内の個体数が閾値未満の種族は返さない(009 と同じ既定 5)。
  -- 分母(total_pokemon / team_equivalents)は足切り前の全件から算出しているので、
  -- 足切りによって率が持ち上がることはない。
  HAVING count(*) >= p_min_pokemon;
$$;

REVOKE ALL ON FUNCTION combined_species_usage(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION combined_species_usage(int, text) TO anon, authenticated;

COMMENT ON FUNCTION combined_species_usage(int, text) IS
  '種族使用率の唯一の集計口。アプリ登録個体(owned_pokemon)と上位入賞チームの個体'
  '(ranked_team_members)を1個体1票で合算したプールから、レギュレーション別(regulation)'
  'と横断(regulation = '''')の使用数を返す。率の分母は team_equivalents。';

-- ============================================================================
-- 4. ranked_species_usage() の廃止
-- ============================================================================
-- 016 で作った「ランキングだけの使用率」を返す関数。呼び出し側は
-- src/pages/api/team-suggestions.ts と src/pages/api/matchup-targets.ts の2箇所だけで、
-- どちらも本ファイルの combined_species_usage() へ移行する。同じ「使用率」を意味する関数が
-- 2つ残ると、次に使う人がどちらの母集団を見ているのか分からなくなるため削除する
-- (上の team_partner_species_stats からの参照も本ファイルで解消済み)。
DROP FUNCTION IF EXISTS ranked_species_usage();
