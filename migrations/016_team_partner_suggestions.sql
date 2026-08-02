-- migrations/016_team_partner_suggestions.sql
-- チーム編集画面のポケモンサジェスト(ユーザー要望、2026-08-02)の集計基盤。
-- 「自チームのポケモンの型」を起点に、上位入賞チーム(ranked_teams、010/011)の中で
-- それらとよく一緒にいるポケモンの型を返す。
--
-- ■ なぜ事前集計テーブル(009/011のsuggestions方式)ではなくリクエスト時のSQL関数なのか
-- suggestions は (kind, subject_key) が一意で、subject_key は「種族名」のような単一のキーだった。
-- 今回の subject は「チームに今入っている最大6体の組み合わせ」であり、事前に列挙すると
-- 組合せ爆発する。一方で母集団は 1041チーム / 6241個体 と小さく、下記の関数は実測で
-- いずれも数ms(EXPLAIN ANALYZE)で返る。009 が Postgres 側に集計を閉じ込めた理由は
-- 「Cloudflare Workers Free の CPU 10ms 制約で JS 側に全件を持ってこられない」ことであり、
-- 「DBが重い」ことではない。したがって本機能も同じ制約を、集計をDB側に置いたまま
-- リクエスト時に解くことで満たす(Worker が受け取る行数は数十〜千行に収まる)。
--
-- ■ スコアリングの数式はここに書かない
-- 本ファイルの関数が返すのは**生のカウント**だけで、lift・縮小推定(shrinkage)・
-- 種族レベルへのバックオフといった判断は src/lib/team-suggest.ts(純粋関数、node --test で
-- 直接検証できる)が行う。SQLに数式を埋めると単体テストから触れなくなるため。
--
-- ■ 突き合わせキーは species_key(011と同じ)
-- ranked_team_members.species_name は公式ランキング表記('ロトム')で、アプリ側の
-- owned_pokemon.species_name('ウォッシュロトム')とは語彙が違う。メガシンカの扱いも異なる
-- (公式は「進化前+メガストーン」、アプリは種族名そのものが「メガギャラドス」)。
-- 011 が追加した species_key がアプリ側の語彙に揃っているので、本機能も一貫してこれを使う。

-- ============================================================================
-- 1. ranked_team_members への archetype_id
-- ============================================================================
-- 015 が owned_pokemon に対して行ったのと同じことを、上位入賞チームの個体にも行う。
-- 「自チームの型」と「構築データの型」を同じ archetypes 行(= 同じ語彙)で表せないと、
-- そもそも型どうしの比較ができないため、両者は同一テーブルを共有する必要がある。
--
-- 分類が plpgsql ではなく TypeScript 側(src/lib/archetype.ts)にある理由は 015 と同じ:
-- role の判定に種族値(public/master-data/detail/pokemon.json)と技分類(detail/moves.json)が
-- 要り、これらはDBに無い。投入は scripts/db/backfill-ranked-archetypes.mjs が行う。
--
-- NULL が普通に残る点が owned_pokemon と違う: 010 のコメントどおり特性・努力値は
-- 構築記事のある個体にしか無く、実測で分類可能なのは 6241体中 3118体。
-- 残りは「観測できていない」であって「型が無い」ではないため、集計側は NULL 行を
-- 単に母数から外す(011 が sample_size の定義で採ったのと同じ扱い)。
ALTER TABLE ranked_team_members
  ADD COLUMN IF NOT EXISTS archetype_id uuid REFERENCES archetypes(id) ON DELETE SET NULL;

COMMENT ON COLUMN ranked_team_members.archetype_id IS
  '型(archetypes、015)への参照。owned_pokemon.archetype_id と同じ語彙を共有し、'
  '「自チームの型」と「構築データの型」を突き合わせられるようにする。'
  '構築記事に特性・努力値が無い個体では NULL のまま(未観測であり、型が無いという意味ではない)。';

CREATE INDEX IF NOT EXISTS idx_ranked_team_members_archetype
  ON ranked_team_members(archetype_id);

-- ============================================================================
-- 2. 共通ビュー: チーム × 種族 / チーム × 型
-- ============================================================================
-- 下記3関数がいずれも「チームにその種族(型)が居たか」の重複なし集合を必要とするため、
-- ビューとして一度だけ定義する。チーム内の種族重複はルール上禁止(src/lib/team-validation.ts
-- の duplicate-species)だが、構築データ側の表記ゆれで同じ species_key が2行になる可能性を
-- 潰すため DISTINCT を明示する(1チームが同じ種族に2票入れると lift が壊れる)。
CREATE OR REPLACE VIEW ranked_team_species AS
  SELECT DISTINCT ranked_team_id, species_key
  FROM ranked_team_members
  WHERE species_key IS NOT NULL;

CREATE OR REPLACE VIEW ranked_team_archetypes AS
  SELECT DISTINCT m.ranked_team_id, m.archetype_id, m.species_key
  FROM ranked_team_members m
  WHERE m.archetype_id IS NOT NULL AND m.species_key IS NOT NULL;

GRANT SELECT ON ranked_team_species, ranked_team_archetypes TO anon, authenticated;

-- ============================================================================
-- 3. ranked_species_usage(): 種族ごとの採用チーム数
-- ============================================================================
-- 用途は2つ。(a) 段1の lift の分母、(b) チームが空のときのフォールバック
-- (共起の起点が無いので、単純な採用率順で「まず入れるとよい種族」を出す)。
-- 201行しか返らないので絞り込み引数は設けない。
CREATE OR REPLACE FUNCTION ranked_species_usage()
RETURNS TABLE (
  species_key text,
  teams int,
  total_teams int
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.species_key,
    count(*)::int AS teams,
    (SELECT count(DISTINCT ranked_team_id)::int FROM ranked_team_species) AS total_teams
  FROM ranked_team_species s
  GROUP BY s.species_key;
$$;

-- ============================================================================
-- 4. team_partner_species_stats(): 段1 — 種族どうしの共起
-- ============================================================================
-- 自チームの各種族(seed)について、同じチームに居た他種族(candidate)ごとのチーム数を返す。
-- 呼び出し側は既にチームに入っている種族を p_species_keys に渡す。戻り値からは
-- seed 自身と他の seed を除外してあるので、そのまま候補として扱える。
--
-- p_min_co_teams: 共起1回きりのペアは実測で3615ペア中1855(51%)を占め、そのほとんどは
-- 偶然の同居でしかない。既定値2で切ることで、Worker が受け取る行数を半減させつつ
-- lift の分散が最も大きい領域を落とす。0を渡せば全ペアを取得できる(調査用)。
-- p_min_candidate_teams: 採用チーム数が極端に少ない種族は lift が跳ねやすいうえ、
-- 提案として実用性が無い(009 の k-匿名性とは別目的の、統計的な足切り)。
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
AS $$
  WITH species_usage AS (
    SELECT * FROM ranked_species_usage()
  ),
  pairs AS (
    SELECT
      seed.species_key AS seed_species,
      other.species_key AS candidate_species,
      count(*)::int AS co_teams
    FROM ranked_team_species seed
    JOIN ranked_team_species other
      ON other.ranked_team_id = seed.ranked_team_id
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

-- ============================================================================
-- 5. team_partner_archetype_stats(): 段2 — 候補種族の中でどの型を薦めるか
-- ============================================================================
-- 段1で選ばれた候補種族(p_candidate_species)それぞれについて、その種族の型ごとに
-- 3つの観測値を返す。呼び出し側(src/lib/team-suggest.ts)はこれをサンプル数に応じて
-- 混ぜ、疎な型レベルの推定を密な種族レベルへバックオフさせる。
--
--   teams_total            この型が出現したチーム数(文脈を無視した素の人気)
--   teams_co_species       自チームの**種族**のいずれかと同居したチーム数(密・粗い文脈)
--   weighted_co_archetype  自チームの**型**のいずれかと同居したチーム数の重み付き和
--                          (疎・細かい文脈。重みの意味は下記)
--
-- ■ p_seed_ids / p_seed_weights — 「型どうしの近さ」を持ち込むための引数
-- 自チームの型が構築データに1件も存在しないことは珍しくない(実測: 510型のうち248型は
-- 1チームにしか出現しない)。そこで呼び出し側は「自チームの型そのもの」ではなく
-- 「自チームの型に近い構築データ上の型」の集合を、近さを重み(0〜1)として添えて渡す。
-- 近さの定義(特性・持ち物・roleの重み付き距離)は src/lib/team-suggest.ts が持つ。
-- 完全一致だけを見たい場合は重み1の単一idを渡せばよく、種族レベルまで緩めたい場合は
-- その種族の全型を重み1で渡せばよい ── どちらも同じ関数で表現できる。
--
-- 2つの配列は同じ長さで対応する位置が同じ型を指す前提(unnest の2引数形式)。
-- 長さが違う場合、短い側は NULL で埋められるため、重み側の NULL は 0 として扱う。
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
    -- 候補種族の型 × 出現チーム(重複なし)
    SELECT ta.ranked_team_id, ta.archetype_id, ta.species_key
    FROM ranked_team_archetypes ta
    WHERE ta.species_key = ANY (p_candidate_species)
  ),
  -- 自チームの種族が1体でも居るチーム
  seed_species_teams AS (
    SELECT DISTINCT ranked_team_id
    FROM ranked_team_species
    WHERE species_key = ANY (p_seed_species)
  ),
  -- 自チームの型に近い型が居るチームと、その近さの重み。
  -- 1チームに複数の seed 型が居る場合は最も近いものだけを採る(max)。
  -- 合計にすると「自チームと2体被っているチーム」が2票入り、共起の強さではなく
  -- チームの重なり具合を測ってしまうため。
  seed_archetype_teams AS (
    SELECT ta.ranked_team_id, max(coalesce(s.w, 0))::numeric AS w
    FROM unnest(p_seed_ids, p_seed_weights) AS s(id, w)
    JOIN ranked_team_archetypes ta ON ta.archetype_id = s.id
    GROUP BY ta.ranked_team_id
  )
  SELECT
    c.archetype_id,
    c.species_key,
    a.ability_name,
    a.item_name,
    a.role,
    count(*)::int AS teams_total,
    count(*) FILTER (WHERE sst.ranked_team_id IS NOT NULL)::int AS teams_co_species,
    coalesce(sum(sat.w), 0)::numeric AS weighted_co_archetype
  FROM candidates c
  JOIN archetypes a ON a.id = c.archetype_id
  LEFT JOIN seed_species_teams sst ON sst.ranked_team_id = c.ranked_team_id
  LEFT JOIN seed_archetype_teams sat ON sat.ranked_team_id = c.ranked_team_id
  GROUP BY c.archetype_id, c.species_key, a.ability_name, a.item_name, a.role;
$$;

-- ============================================================================
-- 6. 権限
-- ============================================================================
-- いずれも公開参照データ(ranked_*、archetypes)だけを読む SECURITY INVOKER 関数のため、
-- 002/010/015 の *_public_read ポリシーがそのまま効く。service_role 専用にする理由は無い。
GRANT EXECUTE ON FUNCTION ranked_species_usage() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION team_partner_species_stats(text[], int, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION team_partner_archetype_stats(uuid[], numeric[], text[], text[]) TO anon, authenticated;
