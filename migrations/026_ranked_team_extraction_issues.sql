-- migrations/026_ranked_team_extraction_issues.sql
-- ranked_team_members(010_ranked_teams.sql)の nature/ability/moves/evs が NULL になった理由を
-- 記録する専用ログテーブル。
--
-- 背景: build_ranked_teams.py はこれら4項目が取れなかった場合、単に列を NULL にするだけで、
-- 「構築記事が無い」「記事はあるが取得に失敗した」「本文に個体情報が無かった」
-- 「LLM/pokesolは処理したがこの項目だけ記載が無かった」「値はあったが検証で不採用にした」
-- のどれなのかがDBに残らない。この区別は抽出パイプラインの改善(記事取得のリトライ対象の
-- 絞り込みや、LLM再抽出の優先度付け)に必要なので、専用テーブルに残す。
--
-- 位置づけ: 010_ranked_teams.sql と同じく user_id を持たない公開参照データ。
-- 002_enable_rls.sql の *_public_read と同じく anon/authenticated には SELECT のみを許可し、
-- 書き込みは service_role (scripts/db/seed-ranked-teams.mjs) だけが行う。
--
-- 行の粒度: (ranked_team_member, field) 単位。1メンバーで複数フィールドが欠落していれば
-- 複数行になる。値が入っているフィールドについては行を作らない。
--
-- 冪等性: ranked_team_members と同じ思想で、build実行のたびに対象メンバーの行を全削除→
-- 全再挿入する(履歴は持たない)。ranked_team_members が team 単位で全DELETE→全INSERTされる際、
-- ON DELETE CASCADE によりこのテーブルの行も連動して消えるため、seed側での明示的なDELETEは不要。

CREATE TABLE IF NOT EXISTS ranked_team_member_extraction_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ranked_team_member_id uuid NOT NULL REFERENCES ranked_team_members(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('nature', 'ability', 'moves', 'evs')),
  -- 粗め分類。5種で固定し、これ以上細分化しない:
  --   article_not_found      構築記事が見つからなかった
  --   fetch_failed           記事は見つかったが取得(HTTP)/構造化データ(pokesol .data)の解析に失敗した
  --   no_extractable_content 記事の取得・本文化はできたが、本文に個体情報が無かった
  --                          (画像のみ・X/Twitterの短文投稿・動画のみ等。LLMの has_content:false に対応)
  --   extraction_incomplete  本文はあり抽出も試みたが、この項目についてはLLM/pokesolの出力に
  --                          記載が無かった、またはスロット割当ができなかった
  --   validation_rejected    LLM出力にこの項目の値は入っていたが、build_ranked_teams.py の検証
  --                          (語彙照合・努力値レンジ等)で不採用になった
  reason_code text NOT NULL CHECK (reason_code IN (
    'article_not_found', 'fetch_failed', 'no_extractable_content',
    'extraction_incomplete', 'validation_rejected'
  )),
  detail text,                          -- reason_code の補足(HTTPステータス、元の生値等)。無ければ NULL
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ranked_team_member_id, field)
);
CREATE INDEX IF NOT EXISTS idx_ranked_team_member_extraction_issues_member
  ON ranked_team_member_extraction_issues (ranked_team_member_id);
-- 「この理由で何件欠けているか」の集計が主要用途
CREATE INDEX IF NOT EXISTS idx_ranked_team_member_extraction_issues_reason
  ON ranked_team_member_extraction_issues (reason_code);

ALTER TABLE ranked_team_member_extraction_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY ranked_team_member_extraction_issues_public_read
  ON ranked_team_member_extraction_issues FOR SELECT TO anon, authenticated USING (true);

-- 003_grant_table_privileges.sql の教訓: RLSポリシーだけではテーブル権限の時点で弾かれる。
GRANT SELECT ON ranked_team_member_extraction_issues TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ranked_team_member_extraction_issues TO service_role;
