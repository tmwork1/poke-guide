-- migrations/012_teams_is_pinned.sql
-- チームのお気に入り(ピン留め)機能(UI改修依頼、2026-08-01「チームトップ画面にボックス画面と
-- 同様のお気に入り機能(フィルタも)を追加する」)。owned_pokemon.is_pinned
-- (migrations/004_owned_pokemon.sql)と全く同じ設計(列名・デフォルト値・インデックスの形)を
-- teamsテーブルに追加する。新しい設計は作らない。

ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false; -- ピン留め/お気に入り。一覧上部への固定表示に使用
CREATE INDEX IF NOT EXISTS idx_teams_user_pinned ON teams(user_id, is_pinned);
