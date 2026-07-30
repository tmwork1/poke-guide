-- migrations/008_owned_pokemon_collection_opt_out.sql
-- 匿名集計サジェスト機能(性格・アイテム・テラスタル・技の人気傾向を種族ごとに集計し、
-- 個体編集ページでサジェスト表示する)の第1段階。
--
-- owned_pokemon は本人限定の非公開データ(005_owned_pokemon_rls.sql)だが、匿名集計
-- (件数のみ、k-匿名性を満たす種族のみ公開。009_popular_build_suggestions.sql 参照)に
-- 限っては本人が個体ごとに拒否できる仕組みを用意する。
--
-- collection_opt_out_until:
--   - NULL = 収集対象(既定値。マイグレーション時点の既存行も全てNULLになり収集対象になる)
--   - 値が未来(now() より後) = 拒否期間中(集計対象から除外)
--   - 値が過去(now() 以前) = 拒否期間が満了しており収集対象に自動復帰
-- 「期限切れを検知して列を戻す」バッチは用意しない。集計関数(refresh_popular_builds)側で
-- 毎回 `collection_opt_out_until IS NULL OR collection_opt_out_until < now()` を判定するだけで
-- 十分なため(値を戻す処理自体が不要。設計のシンプルさを優先)。
ALTER TABLE owned_pokemon ADD COLUMN IF NOT EXISTS collection_opt_out_until timestamptz;

-- RLS/GRANT: 変更なし。owned_pokemon の書き込みは既に service_role 経由のみ
-- (005_owned_pokemon_rls.sql の方針を継続)であり、この列も既存の
-- updatePinStatus 等と同様のPATCH経路(service_role)からのみ書き込まれる。
