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
