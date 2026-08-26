-- ポケモン個体は種族名のみを表示名として使う。既存のニックネームは保存しない。
ALTER TABLE owned_pokemon DROP COLUMN IF EXISTS nickname;
