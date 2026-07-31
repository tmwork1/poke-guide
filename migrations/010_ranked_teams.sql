-- migrations/010_ranked_teams.sql
-- 過去シーズンのランクバトル上位入賞チーム(バトルデータベース チャンピオンズ由来)を保持する
-- ranked_teams / ranked_team_members の2テーブル。
--
-- 位置づけ: ユーザーの私物である teams / owned_pokemon (007_teams.sql / 004_owned_pokemon.sql)
-- とは完全に別系統の、user_id を持たない**公開参照データ**。環境考察・型サンプルの提示に使う。
-- 002_enable_rls.sql の *_public_read と同じく anon/authenticated には SELECT のみを許可し、
-- 書き込みは service_role (scripts/db/seed-ranked-teams.mjs) だけが行う。
--
-- データの出自と精度差(重要):
--   ・チームの並び(種族・フォルム・持ち物)とレーティングは docs/ranker/*.json = 公式ランキング
--     由来で、全チームについて欠損なく存在する。
--   ・性格 / 特性 / テラスタイプ / 技 / 努力値 は**構築記事がある300チームにしか無い**。
--     さらに記事の書式はホストごとにバラバラで、pokesol.app のように構造化データが埋まっている
--     ものと、散文から読み取るしかないものが混在する。したがってこれらの列は全て NULL 可とし、
--     どこから来た値かを extraction_source / extraction_confidence に必ず残す。
--     「NULL = その項目が記事に書かれていなかった」であり「0や空配列」とは意味が違うため、
--     移入時に既定値で埋めない。
--
-- 冪等性: seed スクリプトは (season, rule, rank) を衝突キーとして upsert し、メンバーは
-- team ごとに全DELETE→全INSERTする。ranked_team_members の ON DELETE CASCADE がそれを支える。

CREATE TABLE IF NOT EXISTS ranked_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season text NOT NULL,                 -- 'M-1' 等。表示にそのまま使うため元表記を保つ
  season_number int NOT NULL,           -- 1,2,3... 並べ替え用(season のパースを各所でやらせない)
  rule text NOT NULL,                   -- 'シングル' 等
  rank int NOT NULL,                    -- シーズン最終順位
  rating numeric(10,3),                 -- レート。JSON の rating_value をそのまま
  trainer_name text,                    -- 構築記事側にのみ存在
  article_url text,
  article_title text,
  article_host text,                    -- 'pokesol.app' 等。抽出精度の傾向がホストで決まるため保持
  source_updated_at timestamptz,        -- 元JSONの updated_at (取り込み元データの鮮度)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season, rule, rank)
);
CREATE INDEX IF NOT EXISTS idx_ranked_teams_season_rank ON ranked_teams (season, rank);
-- 「構築記事があるチームだけ一覧したい」が主要導線になるため部分インデックスを張る
CREATE INDEX IF NOT EXISTS idx_ranked_teams_with_article ON ranked_teams (season, rank)
  WHERE article_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS ranked_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ranked_team_id uuid NOT NULL REFERENCES ranked_teams(id) ON DELETE CASCADE,
  slot int NOT NULL CHECK (slot BETWEEN 1 AND 6),

  -- --- ランキングJSON由来(常に存在) ---
  -- dex_no + form_no は元JSONの id ('0479-02') を分解したもの。007_teams.sql の設計レビュー R-1 が
  -- 示すとおり、同一 dexNo に複数の name が対応するためポケモンの同定は名前ではなく dexNo で行う。
  dex_no int NOT NULL,
  form_no int NOT NULL,
  species_name text NOT NULL,           -- 'ロトム' 等
  form_name text,                       -- 'ウォッシュロトム' 等。フォルム無しは NULL
  type1 text,
  type2 text,
  category text,                        -- '一般' 等(禁止級/伝説の区分)
  item_name text,                       -- 空文字は NULL に正規化して投入する

  -- --- 構築記事由来(記事が無い/記載が無ければ NULL) ---
  -- 現在のデータ(シーズンM-1〜M-3)ではテラスタルは1件も存在せず、この列は常に NULL になる
  -- (ランキングHTMLのテラスアイコン1800枠がすべて空、pokesolのカードにも tera-type が無い)。
  -- チャンピオンズがメガシンカ主体のルールであるため。将来ルールが変わった場合に備えて残す。
  tera_type text,
  nature text,
  ability text,
  move_names text[],                    -- 4つ未満しか判明しない記事があるため固定長にしない
  -- チャンピオンズの努力値は 0〜32 スケール(通常作品の 0〜252 ではない)。
  -- 6要素 [H, A, B, C, D, S] の配列で持ち、部分的にしか判明しない場合は配列ごと NULL にする。
  evs int[],
  CONSTRAINT ranked_team_members_evs_len CHECK (evs IS NULL OR array_length(evs, 1) = 6),

  -- --- 抽出のメタ情報 ---
  -- 'pokesol' = 記事に埋まっている構造化データを機械的に読んだもの(誤りは原理的に無い)
  -- 'llm'     = 散文をLLMに読ませて抽出したもの(誤りうる)
  -- NULL      = 構築記事が無い/抽出できなかった
  extraction_source text CHECK (extraction_source IN ('pokesol', 'llm')),
  extraction_confidence text CHECK (extraction_confidence IN ('high', 'medium', 'low')),

  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ranked_team_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_ranked_team_members_team ON ranked_team_members (ranked_team_id);
-- 「この種族を使った上位チーム」検索が想定される主用途
CREATE INDEX IF NOT EXISTS idx_ranked_team_members_dex ON ranked_team_members (dex_no, form_no);

-- RLS: 002_enable_rls.sql の *_public_read と同じ方針。公開参照データなので anon にも SELECT を許す。
ALTER TABLE ranked_teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY ranked_teams_public_read ON ranked_teams FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE ranked_team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY ranked_team_members_public_read ON ranked_team_members FOR SELECT TO anon, authenticated USING (true);

-- 003_grant_table_privileges.sql の教訓: RLSポリシーだけではテーブル権限の時点で弾かれる。
GRANT SELECT ON ranked_teams, ranked_team_members TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ranked_teams, ranked_team_members TO service_role;
