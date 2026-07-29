-- migrations/007_teams.sql
-- チーム機能(docs/plan/pages/team.md)。手持ちの育成individu(owned_pokemon)から
-- 大会向けの6体構成を組むための teams / team_members の2テーブルと、
-- メンバー入れ替えを単一トランザクションで行う replace_team_members() 関数を追加する。
--
-- 2テーブル構成・列定義はP1(仕様確定)の案から変更なし(P2の設計レビューで3人のレビュアーが
-- 妥当と評価済み)。編成ルール G-2(同種族の重複禁止)の判定キーは species_name ではなく
-- dexNo(owned_pokemon.species_name → public/master-data/autocomplete/pokemon.json の逆引き)
-- にすることが決まっているが(設計レビュー R-1: 1つのdexNoに複数のnameが対応する組が205件
-- 実在し、species_name一致では実ゲームで重複禁止になる組み合わせが素通りするため)、これは
-- owned_pokemon 側の値に依存する判定でありDB制約では表現できない。アプリ側
-- (src/lib/team-validation.ts の純粋関数)で担保する。

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,                      -- 空/未設定を許容(一覧で「無題のチーム」と表示)
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_user_updated ON teams (user_id, updated_at);

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- lib層が join なしで絞れるよう非正規化
  owned_pokemon_id uuid NOT NULL REFERENCES owned_pokemon(id) ON DELETE CASCADE,
  slot int NOT NULL CHECK (slot BETWEEN 1 AND 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slot),
  UNIQUE (team_id, owned_pokemon_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);

-- RLS + GRANT: migrations/005_owned_pokemon_rls.sql の定型をそのまま踏襲
-- (ENABLE ROW LEVEL SECURITY + select/insert/update/delete の4ポリシー + GRANT)。
-- anon への GRANT は一切付けない(チームの公開共有は今回スコープ外。
-- docs/plan/pages/team.md「スコープ外」参照。非公開データの漏洩を防ぐため)。

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_select_own ON teams FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY teams_insert_own ON teams FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY teams_update_own ON teams FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY teams_delete_own ON teams FOR DELETE TO authenticated USING (auth.uid() = user_id);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_members_select_own ON team_members FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY team_members_insert_own ON team_members FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY team_members_update_own ON team_members FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY team_members_delete_own ON team_members FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- service_role: 書き込みAPI(getSupabaseAdminClient()、RLSバイパス)が使うために必須
-- (003_grant_table_privileges.sql / 005 の教訓: GRANTを伴わないRLSポリシーはテーブル権限の
-- 時点で弾かれる死んだ設定になる)。
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO service_role;

-- authenticated: 005と同じ方針(将来クライアントSDKから直接アクセスする経路を開ける保険として
-- 本人限定のCRUDを付与)。anon には一切付与しない(閲覧も含め完全非公開を維持)。
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO authenticated;

-- ------------------------------------------------------------------------------------------
-- replace_team_members: team_members の全置換(DELETE→INSERT)を単一トランザクションにする。
--
-- なぜ必要か(設計レビュー R-4): owned_pokemon の PUT は単一行 UPDATE なので原子性の問題が
-- 原理的に存在しないが、team_members は複数行の子テーブル。supabase-js の呼び出しは個別の
-- PostgRESTリクエストなので、素朴に「全DELETE→全INSERT」を2回に分けて呼ぶと
-- 「DELETE成功→INSERT失敗」でチームのメンバーが全消失しうる。Postgres関数として
-- 1トランザクションにまとめることでこれを防ぐ。
--
-- scripts/db/run-migrations.mjs:47 はマイグレーションファイル全体を1クエリとして
-- client.query(content) に渡すため、$$ ... $$ を含む関数定義をそのまま書いて問題ない(確認済み)。
--
-- 処理順序(docs/plan/pages/team.md「確定した設計 > データモデル」):
--   ① teams の所有確認(p_user_id と一致しなければ RAISE EXCEPTION)
--   ② p_members の全 owned_pokemon_id が owned_pokemon.user_id = p_user_id を満たすか確認
--      (満たさなければ RAISE EXCEPTION。これは設計レビューR-2の「最後の砦」。
--      src/lib/team.ts の replaceTeam() が書き込み前に行う事前チェックとは独立に、
--      ここでも同じ検証を行う。lib層の検証を省略してよい理由にはならない)
--   ③ DELETE FROM team_members WHERE team_id = p_team_id
--   ④ INSERT(jsonb_to_recordset で展開)
--   ⑤ teams.updated_at = now()
--
-- 同時更新は後勝ちで良い(自動保存のデバウンスは同一タブ内で直列化されるため、複数タブ同時
-- 編集は仕様として許容する。設計レビューR-4)。
CREATE OR REPLACE FUNCTION replace_team_members(
  p_user_id uuid,
  p_team_id uuid,
  p_members jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_count int;
  v_total_distinct int;
  v_owned_distinct int;
BEGIN
  -- ① teams の所有確認
  SELECT count(*) INTO v_owner_count
  FROM teams
  WHERE id = p_team_id AND user_id = p_user_id;

  IF v_owner_count = 0 THEN
    RAISE EXCEPTION 'team % not found or not owned by user %', p_team_id, p_user_id;
  END IF;

  -- ② 全 owned_pokemon_id が本人のものであることを確認(最後の砦)
  WITH members AS (
    SELECT DISTINCT m.owned_pokemon_id
    FROM jsonb_to_recordset(p_members) AS m(slot int, owned_pokemon_id uuid)
  )
  SELECT
    count(*),
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM owned_pokemon op
        WHERE op.id = members.owned_pokemon_id AND op.user_id = p_user_id
      )
    )
  INTO v_total_distinct, v_owned_distinct
  FROM members;

  IF v_total_distinct <> v_owned_distinct THEN
    RAISE EXCEPTION 'one or more owned_pokemon_id do not belong to user %', p_user_id;
  END IF;

  -- ③ 全DELETE
  DELETE FROM team_members WHERE team_id = p_team_id;

  -- ④ 全INSERT(p_membersが空配列なら何も挿入しない = 全員解除)
  INSERT INTO team_members (team_id, user_id, owned_pokemon_id, slot)
  SELECT p_team_id, p_user_id, m.owned_pokemon_id, m.slot
  FROM jsonb_to_recordset(p_members) AS m(slot int, owned_pokemon_id uuid);

  -- ⑤ updated_at 更新
  UPDATE teams SET updated_at = now() WHERE id = p_team_id;
END;
$$;

-- Postgresは関数作成時にデフォルトでPUBLIC(=全ロールの暗黙の親)にEXECUTEを付与するため、
-- 明示的にrevokeしてからservice_roleにのみ許可する(anon/authenticatedがPostgREST経由で
-- 直接この関数を叩けないようにする防御。テーブルのGRANT方針=anonには一切付与しない、と同じ意図)。
REVOKE ALL ON FUNCTION replace_team_members(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_team_members(uuid, uuid, jsonb) TO service_role;
