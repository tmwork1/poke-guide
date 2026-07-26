-- migrations/006_owned_pokemon_sharing.sql
-- 個体(owned_pokemon)の公開共有機能。builds(匿名共有用テーブル)は
-- owned_pokemonへの一本化に伴い廃止する(docs/plan/ui_plan.md)。

ALTER TABLE owned_pokemon ADD COLUMN share_slug text UNIQUE;
ALTER TABLE owned_pokemon ADD COLUMN is_public boolean NOT NULL DEFAULT false;

-- 公開個体(is_public = true)は所有者以外(anon含む)からもSELECT可能にする。
-- 005で作成済みの owned_pokemon_select_own(本人限定)ポリシーとはOR条件で併存する。
CREATE POLICY owned_pokemon_select_public ON owned_pokemon FOR SELECT TO anon, authenticated USING (is_public = true);

-- anonロールは005時点で一切GRANTされていない(完全非公開だったため)。公開閲覧のため追加。
GRANT SELECT ON owned_pokemon TO anon;

-- builds は owned_pokemon への統合により廃止。
DROP TABLE IF EXISTS builds;
