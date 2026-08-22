-- migrations/024_drop_teams_name.sql
-- UI改修に伴い、チーム名を保持しないため teams.name を削除する。
ALTER TABLE teams DROP COLUMN IF EXISTS name;
