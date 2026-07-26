# vendor/jpoke について

このディレクトリは [jpoke](https://github.com/tmwork1/jpoke) (v0.2.0時点) の `src/`,
`pyproject.toml`, `README.md`, `LICENSE`, `LICENSE-DATA` をそのままコピーしたものです。

開発プラン (`docs/plan/開発プラン.md` §4リスク表) の方針「jpoke をバージョン固定で
vendoring し、更新は回帰テスト付きで取り込む」に基づき、CI・Cloudflareのビルド環境に
存在しない `../jpoke`(兄弟ディレクトリ)への依存を無くすために導入した。

`scripts/build-master-data/build.mjs` と `extract_autocomplete.py` は既定でこの
`vendor/jpoke` を参照する(`JPOKE_DIR` 環境変数で上書き可能。ローカルで手元の
`../jpoke` の最新版を試したい場合などに使う)。

## 更新手順(手動・シンプル)

自動化スクリプトは用意していない(過剰設計を避けるため)。更新時は以下を手動で行う。

1. 手元の `jpoke` リポジトリを更新したいバージョンにする(`git checkout <tag>` 等)。
2. このディレクトリの中身を一旦削除し、以下を新しい jpoke からコピーし直す。
   - `src/` (ただし `__pycache__/`, `*.egg-info/` は除外)
   - `pyproject.toml`
   - `README.md`
   - `LICENSE`, `LICENSE-DATA`(存在すれば)
3. `npm run build:master-data` を実行し、エラーなく完走することを確認する。
4. `npm test` および Phase 2-5 で追加される回帰テスト(jpoke ネイティブ実行との計算結果一致確認)を実行し、
   計算結果に不整合が無いことを確認してからコミットする。
5. コミットメッセージに更新元の jpoke バージョン(例: `v0.3.0`)を明記する。

## 画像URL組み立て周りの追加確認事項

`src/lib/sprite-urls.ts`(アイテム画像・タイプ画像・テラスタイプ画像のURL組み立て)は
`src/jpoke/utils/pokeapi.py` を参照実装として移植したものであり、
`scripts/build-master-data/extract_autocomplete.py` の `_load_item_sprite_paths` は
`src/jpoke/data/pokeapi/*.json` を直接読んで items.json の spritePath を生成している。
更新時は上記手順に加えて以下も確認すること。

6. `src/jpoke/utils/pokeapi.py` の `get_item_image_url` / `get_type_image_url` /
   `get_tera_type_image_url` / `TYPE_NAME_TO_ID` の実装(URLのディレクトリ構成・拡張子・
   サブディレクトリの入り方、和名タイプ→ID対応)に変更が無いか確認し、変更があれば
   `src/lib/sprite-urls.ts` に反映する。
7. `src/jpoke/data/pokeapi/ja_to_id_map.json`・`id_map.json`・`item_sprite_subdir_map.json`
   のスキーマ(`sections.item`/`sections.item_jpoke` の構造、`slug_to_subdir` のキー名)に
   変更が無いか確認し、変更があれば `extract_autocomplete.py` の `_load_item_sprite_paths`
   を追従させる。
8. `data/pokeapi/ja_to_id_map.json` の `sections.pokemon`(`by_ja_name` のスキーマ・カバレッジ)
   に変更が無いか確認する。ポケモンの画像ID(`imageId`、メガシンカ/キョダイマックス等の特殊
   フォルムの画像解決に使う)は `extract_autocomplete.py` の `_load_pokemon_image_id_map` が
   ここを読んでいるため、キー名や和名表記のルールが変わると `imageId` が解決できなくなり、
   スプライトがベース種族の画像にフォールバックしてしまう。
