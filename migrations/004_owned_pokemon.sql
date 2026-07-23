-- migrations/004_owned_pokemon.sql
-- 育成済みポケモン管理機能 (docs/plan/育成データ管理計画.md §3)。
-- poke-commonsで初めて auth.users に紐づく「本人所有」データを保持するテーブル群。
-- pgcrypto (gen_random_uuid()) は 001_initial.sql で既に有効化済みのため追加対応は不要。

-- owned_pokemon: ユーザーが継続して管理する育成済み個体 (計画書§3.1)。
-- builds(既存)の書き捨てスナップショットとは異なり、レベル・ニックネーム・タグ・ピン留めを
-- 持つ、長期にわたり編集され続ける可変レコード。
CREATE TABLE IF NOT EXISTS owned_pokemon (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- 所有者。ユーザー削除時に個体も削除
  nickname text, -- 表示名。空なら図鑑名(species_name)を表示に流用
  species_name text NOT NULL, -- 図鑑名 (public/master-data/ を参照)
  level int, -- レベル(1〜100)
  nature text, -- 性格
  ability_name text, -- 特性
  item_name text, -- 持ち物
  tera_type text, -- テラスタイプ
  evs jsonb NOT NULL DEFAULT '{}', -- 努力値。builds.evs と同形式(チャンピオンズ形式・0〜32刻み)
  ivs jsonb NOT NULL DEFAULT '{}', -- 個体値。既定31
  move_names text[] NOT NULL DEFAULT '{}', -- 技構成(最大4)。builds.move_names と同形式
  memo text, -- 自由記述メモ
  tags text[] NOT NULL DEFAULT '{}', -- フラットなタグ(多対多、階層フォルダにしない)
  is_pinned boolean NOT NULL DEFAULT false, -- ピン留め/お気に入り。一覧上部への固定表示に使用
  source_build_slug text, -- builds から取り込まれた場合の元 share_slug (履歴参照用、任意)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), -- 最終更新日時。一覧の並び替えに使用
  last_used_at timestamptz -- 最終使用日時(対戦相手メモ作成・ダメージ計算機読み込み時に更新)。一覧の並び替えに使用
);

-- 一覧表示(最終更新順)・ピン留めフィルタの主要クエリ用 (計画書§3.3 Phase B-4)
CREATE INDEX IF NOT EXISTS idx_owned_pokemon_user_updated ON owned_pokemon(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_owned_pokemon_user_pinned ON owned_pokemon(user_id, is_pinned);

-- opponent_notes: 1個体に対する複数の対戦相手ごとの想定ダメージ計算メモ (計画書§3.2)。
-- 保存・更新のたびに匿名化コピーが damage_calcs/events へ二重記録される想定(Phase D、本マイグレー
-- ションの範囲外)。
CREATE TABLE IF NOT EXISTS opponent_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owned_pokemon_id uuid NOT NULL REFERENCES owned_pokemon(id) ON DELETE CASCADE, -- 紐づく所有個体
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- RLS簡素化のための非正規化 (owned_pokemon経由のJOINに依存しない)
  opponent_build jsonb NOT NULL DEFAULT '{}', -- 相手の想定構成(種族・性格・特性・持ち物・テラス・努力値・個体値・技など)
  field jsonb NOT NULL DEFAULT '{}', -- 天候・地形・壁等のフィールド条件
  move_name text, -- 自分側(owned_pokemon)が使用する技
  client_result jsonb, -- Pyodide計算結果のスナップショット。UI表示用の未検証値(既存damage_calcs.client_resultと同じ扱い)
  memo text, -- 自由記述メモ
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 個体詳細画面でのメモ一覧取得・RLSポリシー(auth.uid() = user_id)の絞り込み高速化用 (計画書§3.3 Phase B-4)
CREATE INDEX IF NOT EXISTS idx_opponent_notes_owned_pokemon ON opponent_notes(owned_pokemon_id);
CREATE INDEX IF NOT EXISTS idx_opponent_notes_user ON opponent_notes(user_id);
