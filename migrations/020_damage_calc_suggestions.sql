-- migrations/020_damage_calc_suggestions.sql
-- ダメージ計算のサジェスト(ユーザー要望、2026-08-05)。個体育成画面の右パネルに
-- 「そのポケモンの型でよく行われているダメージ計算」を出すための集計。
--
-- ■ 集計の単位: (攻守の向き, 相手種族, 技) の3つ組
-- 個体編集のダメージ計算カード1枚 = opponent_notes 1行 = 相手1体 + 技列(最大6)なので、
-- 「1枚のカード」をそのまま単位にすると同じ相手でも技の組み合わせ違いで無数に散らばる。
-- 実際にユーザーが知りたいのは「誰に対して、どの技で、与える側/受ける側どちらの計算をするか」
-- なので、カードを技ごとにばらして3つ組で数える(クリック時にカード1枚として復元できる
-- 最小の単位でもある)。
--
-- ■ なぜ damage_calcs(匿名テーブル)ではなく opponent_notes を集計するか
-- opponent_notes は保存のたびに damage_calcs/events へ匿名コピーされる
-- (src/lib/opponent-note-secondary-record.ts)が、その匿名化(opponent-note-anonymize.ts の
-- FIELD_SPEC_KEYS)は field から direction と attacks を落とす。つまり damage_calcs 側には
-- ①攻守の向きが残らない(防御カードなのに「所持ポケモンが attacker」として記録される)
-- ②2列目以降の技が残らない(move_name = attacks[0] のみ)という2つの欠落があり、
-- このサジェストに必要な情報がそもそも入っていない。
-- 一方 009/014/019 の refresh_popular_builds 系は元から owned_pokemon(本人限定テーブル)を
-- 直接 GROUP BY して suggestions(集計済み・公開)へ書き出す方式で、収集拒否(008)と
-- k-匿名性で保護している。ここもその既存の流儀に合わせ、opponent_notes を直接集計する
-- (個票は一切 suggestions に出さない。出るのは種族名・技名・向きと、その最頻の相手ビルド)。
--
-- ■ 2粒度(型・種族)で同じ集計を2回書き出す理由
-- 依頼「型が判別できない場合は種族のみで集計したサジェストを行う」に対応する。型
-- (species|item|role、015/017/018)は持ち物が未入力なら決まらないので、種族だけのキーを
-- 常に併走させ、APIは型キー → 無ければ種族キーの順に引く(src/pages/api/damage-calc-suggestions.ts)。
-- 019 の popular_move_archetype がレギュレーション別スコープも作るのに対し、こちらは
-- 横断(スコープなし)のみにする ── ダメージ計算は個体1体あたりのカード枚数が
-- 技構成より桁で少なく、レギュレーションで割るとk-匿名性の閾値をまず超えないため。
--
-- ■ k-匿名性
-- 019 と同じく、キーごとの母集団(そのキーに属し、ダメージ計算を1件以上持つ**個体数**)が
-- min_sample_size 未満なら suggestions 行自体を作らない。母数・分子とも
-- count(DISTINCT owned_pokemon.id) にしてあるのは、1人が同じ計算のカードを何枚作っても
-- 「よく行われている」の票が水増しされないようにするため。

CREATE FUNCTION refresh_damage_calc_suggestions(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 12
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- 1回の再集計で採用された行だけを残すため、全INSERTで同じ時刻を使う(014/019と同じ方式)。
  computed timestamptz := now();
BEGIN
  WITH base AS (
    -- archetype_id は既存参照だけを利用し、この集計では型行の作成・バックフィルを行わない(019と同じ)。
    -- LEFT JOIN なのは、型が付いていない個体でも種族粒度の集計には参加させるため。
    SELECT
      p.id AS owned_pokemon_id,
      p.species_name,
      a.item_name,
      a.role,
      -- direction 未指定の既存データは 'attack'(この所持ポケモンが攻撃側)。
      -- src/lib/opponent-notes-validation.ts の既定解釈と揃えること。
      coalesce(n.field->>'direction', 'attack') AS direction,
      nullif(btrim(n.opponent_build->>'name'), '') AS opponent_name,
      n.opponent_build,
      -- 技列(attacks)がある新形式はその全技を、無い旧形式(単発メモ)は move_name 1件を使う。
      -- 同じカード内で同じ技が2列ある場合は DISTINCT で1票に畳む。
      CASE
        WHEN jsonb_typeof(n.field->'attacks') = 'array' AND jsonb_array_length(n.field->'attacks') > 0
          THEN (
            SELECT array_agg(DISTINCT nullif(btrim(x.value->>'moveName'), ''))
            FROM jsonb_array_elements(n.field->'attacks') AS x(value)
          )
        ELSE ARRAY[nullif(btrim(n.move_name), '')]
      END AS move_names
    FROM opponent_notes n
    JOIN owned_pokemon p ON p.id = n.owned_pokemon_id
    LEFT JOIN archetypes a ON a.id = p.archetype_id
    -- 収集拒否(008)。009 と同じく都度判定するだけで期限切れが自動的に戻る。
    WHERE p.collection_opt_out_until IS NULL OR p.collection_opt_out_until < now()
  ),
  src AS (
    SELECT b.owned_pokemon_id, b.species_name, b.item_name, b.role,
           b.direction, b.opponent_name, b.opponent_build, m.move_name
    FROM base b
    CROSS JOIN LATERAL unnest(b.move_names) AS m(move_name)
    -- 相手名・技名のどちらかが空のカード(入力途中で保存されたもの)は計算として成立しない。
    WHERE b.opponent_name IS NOT NULL AND m.move_name IS NOT NULL
      AND b.direction IN ('attack', 'defense')
  ),
  -- 1行を「型キー」と「種族キー」の両方へ複製する。型が無い個体では型キー側が NULL になり
  -- WHERE で落ちるので、種族キーだけに寄与する(=依頼の「型が判別できない場合」の経路)。
  scoped AS (
    SELECT k.kind, k.subject_key, s.*
    FROM src s
    CROSS JOIN LATERAL (
      VALUES
        ('popular_damage_calc_species', s.species_name),
        ('popular_damage_calc_archetype', s.species_name || '|' || s.item_name || '|' || s.role)
    ) AS k(kind, subject_key)
    WHERE k.subject_key IS NOT NULL
  ),
  sample_size AS (
    -- 母数はカード枚数ではなく個体数。「この型の個体のうち何割がこの計算をしているか」の分母。
    SELECT kind, subject_key, count(DISTINCT owned_pokemon_id) AS sample_size
    FROM scoped
    GROUP BY kind, subject_key
  ),
  counts AS (
    SELECT
      kind, subject_key, direction, opponent_name, move_name,
      count(DISTINCT owned_pokemon_id) AS cnt,
      -- 相手のビルドは「その計算をしている個体たちの最頻値」を項目ごとに採る。
      -- 項目ごとに独立して mode() を採るのは既存の popular_nature/popular_item(009)と同じ
      -- 粒度に揃えるため ── ビルド1件を丸ごと最頻値として出すと、努力値まで含んだ
      -- 特定個体の入力がそのまま復元されうる。
      mode() WITHIN GROUP (ORDER BY nullif(btrim(opponent_build->>'nature'), '')) AS opponent_nature,
      mode() WITHIN GROUP (ORDER BY nullif(btrim(opponent_build->>'abilityName'), '')) AS opponent_ability,
      mode() WITHIN GROUP (ORDER BY nullif(btrim(opponent_build->>'itemName'), '')) AS opponent_item,
      mode() WITHIN GROUP (ORDER BY nullif(btrim(opponent_build->>'teraType'), '')) AS opponent_tera,
      mode() WITHIN GROUP (ORDER BY opponent_build->'evs') AS opponent_evs
    FROM scoped
    GROUP BY kind, subject_key, direction, opponent_name, move_name
  ),
  ranked AS (
    SELECT c.*, ss.sample_size,
           row_number() OVER (
             PARTITION BY c.kind, c.subject_key
             ORDER BY c.cnt DESC, c.opponent_name, c.move_name
           ) AS rn
    FROM counts c
    JOIN sample_size ss USING (kind, subject_key)
    -- k未満のキーはpayloadを空で出さず、suggestions行自体を作らない(019と同じ)。
    WHERE ss.sample_size >= min_sample_size
  ),
  payloads AS (
    SELECT kind, subject_key,
           jsonb_build_object(
             'sample_size', sample_size,
             'options', jsonb_agg(
               jsonb_build_object(
                 'direction', direction,
                 'opponent_name', opponent_name,
                 'move_name', move_name,
                 'count', cnt,
                 'ratio', round(cnt::numeric / sample_size, 3),
                 -- 値が判明していない項目はキーごと落とす(UI側で「未入力」と区別せずに済む)。
                 'opponent_build', jsonb_strip_nulls(jsonb_build_object(
                   'nature', opponent_nature,
                   'abilityName', opponent_ability,
                   'itemName', opponent_item,
                   'teraType', opponent_tera,
                   'evs', opponent_evs
                 ))
               )
               ORDER BY cnt DESC, opponent_name, move_name
             )
           ) AS payload
    FROM ranked
    WHERE rn <= top_n
    GROUP BY kind, subject_key, sample_size
  )
  INSERT INTO suggestions (kind, subject_key, payload, computed_at)
  SELECT kind, subject_key, payload, computed
  FROM payloads
  ON CONFLICT (kind, subject_key) DO UPDATE
    SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;

  -- 閾値未満へ変化したキーや集計元から消えたキーを残さない(014/019と同じ世代削除)。
  DELETE FROM suggestions
  WHERE kind IN ('popular_damage_calc_species', 'popular_damage_calc_archetype')
    AND computed_at < computed;
END;
$$;

-- 既存のcron入口(src/worker.ts の scheduled → refresh_popular_builds())から続けて呼ぶ。
-- 019 が refresh_archetype_popular_moves を足したときと同じく、既存の集計本体には手を入れず
-- ラッパーへ1行足すだけにする。
CREATE OR REPLACE FUNCTION refresh_popular_builds(
  min_sample_size int DEFAULT 5,
  top_n int DEFAULT 5,
  move_top_n int DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_popular_builds_species(min_sample_size, top_n, move_top_n);
  PERFORM refresh_archetype_popular_moves(min_sample_size, move_top_n);
  PERFORM refresh_damage_calc_suggestions(min_sample_size);
END;
$$;

-- DB関数はPostgresが既定でPUBLICへEXECUTEを付けるため、既存関数と同じ権限へ絞る。
REVOKE ALL ON FUNCTION refresh_damage_calc_suggestions(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_damage_calc_suggestions(int, int) TO service_role;

-- suggestions を「この個体の型/種族」で引く経路は kind + subject_key の完全一致
-- (uq_suggestions_kind_subject、001)でカバー済みのため、追加インデックスは作らない。
-- 集計側は opponent_notes → owned_pokemon の結合だが、idx_opponent_notes_owned_pokemon(004)が
-- 既にあり、cronでの全件集計は seq scan でも問題にならない規模のため同様に追加しない。
