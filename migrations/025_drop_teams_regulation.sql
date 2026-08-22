-- migrations/025_drop_teams_regulation.sql
-- UI改修に伴い、チームのレギュレーション選択UIを廃止するため teams.regulation を削除する。
-- (owned_pokemon.regulationは022で廃止済み。teams.regulationはどのSQL関数からも参照されていない。)
ALTER TABLE teams DROP COLUMN IF EXISTS regulation;
