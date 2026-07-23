-- migrations/005_owned_pokemon_rls.sql
-- owned_pokemon/opponent_notes のRLS有効化 (docs/plan/育成データ管理計画.md §3.3)。
--
-- 002_enable_rls.sql の冒頭コメントは「poke-commonsには auth.uid() ベースの『本人限定』ポリシー
-- は存在しない」と明言しているが、本マイグレーションでその前提に初めて例外を作る。この2テーブル
-- は既存テーブル(events/damage_calcs/builds/searches/suggestions、いずれも匿名・公開閲覧可)とは
-- 性質が異なり、閲覧も含めて完全に非公開の本人限定データである。そのため anon ロールへの公開
-- SELECTポリシーは一切作らない(002とは方針が異なる旨をここに明記する。002自体の文面は本マイグ
-- レーションでは変更しない)。

ALTER TABLE owned_pokemon ENABLE ROW LEVEL SECURITY;
CREATE POLICY owned_pokemon_select_own ON owned_pokemon FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY owned_pokemon_insert_own ON owned_pokemon FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY owned_pokemon_update_own ON owned_pokemon FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY owned_pokemon_delete_own ON owned_pokemon FOR DELETE TO authenticated USING (auth.uid() = user_id);

ALTER TABLE opponent_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY opponent_notes_select_own ON opponent_notes FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY opponent_notes_insert_own ON opponent_notes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY opponent_notes_update_own ON opponent_notes FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY opponent_notes_delete_own ON opponent_notes FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- GRANT: RLSポリシーを作っただけではPostgresの基本的なテーブル権限(GRANT)は付与されない
-- (003_grant_table_privileges.sql のコメント参照。実機検証で判明した既知の落とし穴)。

-- service_role: 書き込みAPI(Phase C/Dで別途実装)が getSupabaseAdminClient() (service_role、
-- RLSバイパス) 経由で読み書きするために必須。
GRANT SELECT, INSERT, UPDATE, DELETE ON owned_pokemon, opponent_notes TO service_role;

-- authenticated: 現行の書き込みAPI設計は service_role 経由のみを使う(計画書§2.3)ため必須では
-- ないが、上記の auth.uid() = user_id ポリシーは「将来クライアントSDKから直接アクセスする経路を
-- 開ける設計上の保険」(計画書§2.3)として本人限定で用意されている。GRANTを伴わないRLSポリシー
-- は(003の教訓どおり)テーブル権限の時点で弾かれる死んだ設定になり「保険」として機能しないため、
-- ここで authenticated にも本人限定のCRUD権限を実際に付与しておく(anon には一切付与しない=
-- 閲覧も含め完全非公開を維持)。
GRANT SELECT, INSERT, UPDATE, DELETE ON owned_pokemon, opponent_notes TO authenticated;

-- pgcrypto (gen_random_uuid()) は 001_initial.sql で既に有効化済みのため追加対応は不要。
