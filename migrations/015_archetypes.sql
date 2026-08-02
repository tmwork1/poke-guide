-- migrations/015_archetypes.sql
-- 育成データ(owned_pokemon)を「型(アーキタイプ)」で分類する基盤(ユーザー要望、2026-08-02)。
--
-- 型の識別キーは 種族名・特性名・持ち物名・role(物理アタッカー/特殊アタッカー/耐久) のみ。
-- 性格・わざ・テラスタルは個体差が大きいため識別キーに含めない(わざは role 判定の
-- シグナルとしては使うが、archetypes の列には残らない。判定ロジックは src/lib/archetype.ts)。
--
-- なぜ Postgres 関数(plpgsql)で完結させないか(009_popular_build_suggestions.sql の
-- refresh_popular_builds() と方針が異なる点): role の判定には種族値
-- (public/master-data/detail/pokemon.json)と技分類(detail/moves.json)というマスターJSONへの
-- 参照が必要で、これらはDBに存在しない。そのため分類計算は src/lib/archetype.ts(アプリ層の
-- TypeScript純粋関数)で行い、結果(species_name/ability_name/item_name/role の組)だけを
-- find-or-create で下記テーブルに書き込む(src/lib/archetypes.ts)。
CREATE TABLE IF NOT EXISTS archetypes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- pgcryptoは001_initial.sqlで有効化済み
  species_name text NOT NULL,
  ability_name text NOT NULL,
  item_name text NOT NULL,
  -- 物理アタッカー/特殊アタッカー/耐久の3分類(src/lib/archetype.tsのArchetypeRoleと一致させる)。
  role text NOT NULL CHECK (role IN ('physical_attacker', 'special_attacker', 'bulky')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 型の識別キー本体。find-or-create(src/lib/archetypes.ts findOrCreateArchetype)の
  -- 検索条件・重複防止を兼ねる。
  CONSTRAINT archetypes_identity_key UNIQUE (species_name, ability_name, item_name, role)
);

-- 種族単位の絞り込み(将来のサジェスト集計での参照を想定)。
CREATE INDEX IF NOT EXISTS idx_archetypes_species ON archetypes(species_name);

-- owned_pokemon への外部キー列。分類不能(未対応種族/特性・持ち物未入力等)の場合はNULLのまま。
-- ON DELETE SET NULL: archetypesは基本削除しない永続的なマスタ行想定だが、将来の重複整理等で
-- 行を消しても owned_pokemon 自体は残す(CASCADEにしない)。
ALTER TABLE owned_pokemon ADD COLUMN IF NOT EXISTS archetype_id uuid REFERENCES archetypes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_owned_pokemon_archetype ON owned_pokemon(archetype_id);

-- RLS/GRANT: 002_enable_rls.sql / 003_grant_table_privileges.sql と同じ「公開閲覧・書き込みは
-- service_roleのみ」パターン(archetypesは非個人情報のマスターデータ相当のため、
-- owned_pokemon/opponent_notesの本人限定パターン(005)ではなくこちらに倣う)。
ALTER TABLE archetypes ENABLE ROW LEVEL SECURITY;
CREATE POLICY archetypes_public_read ON archetypes FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON archetypes TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON archetypes TO service_role;

-- owned_pokemon側のGRANT(005_owned_pokemon_rls.sql)は既にservice_role/authenticatedへ
-- テーブル単位のCRUD権限を付与済みのため、archetype_id列追加に伴う追加GRANTは不要。
