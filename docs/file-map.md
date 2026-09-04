# ファイルマップ

「この画面/機能を触るならどのファイルを見ればいいか」を素早く判断するための対応表。
新しい画面・機能を追加/削除したら、このファイルも一緒に更新すること。

命名規則: 画面名(`box-id` / `speed-chart` など)を `src/pages` `src/components` `src/lib` `src/styles` `tests` 横断で揃えているため、
どこか1箇所のパスが分かれば grep で他も大体見つかる。ただし CSS ファイル名だけは `box-edit-page.css` のように「画面名 + 用途」の形で少し崩れているので注意。

## 画面(pages)別マッピング

### box/[id].astro — ボックス個体編集画面
- page: `src/pages/box/[id].astro`
- components: `src/components/box-id/LeftPanel.astro`, `RightPanel.astro`, `DamageCalcSection.astro`, `BulkAdjustDialog.astro`, `SpeedAdjustDialog.astro`, `MobilePokemonPreview.astro`
- lib: `src/lib/box-id/*`(`left-panel.ts` `right-panel.ts` `damage-calc.ts` `damage-suggest.ts` `bulk-adjust.ts` `bulk-adjust-solver.ts` `durability-index.ts` `stat-adjustment-panel.ts` `mobile-edit-tabs.ts` `shared-core.ts`)、`src/lib/owned-pokemon.ts`, `owned-pokemon-form.ts`, `owned-pokemon-validation.ts`
- styles: `box-edit-page.css`, `owned-pokemon-card.css`, `box-damage-card.css`, `box-damage-page.css`, `bulk-adjust-dialog.css`, `speed-adjust-dialog.css`, `stat-adjustment-panel.css`, `move-picker-dialog.css`, `damage-detail-panel.css`
- tests: `tests/bulk-adjust-solver.test.ts`, `tests/damage-calc-suggest.test.ts`, `tests/damage-calc-validation.test.ts`, `tests/damage-summary.test.ts`, `tests/owned-pokemon-validation.test.ts`, `tests/e2e/damage-calc.spec.ts`, `tests/e2e/stats-lethal-sequence.spec.ts`
- 関連API: `src/pages/api/owned-pokemon.ts`, `owned-pokemon/[id].ts`, `owned-pokemon/[id]/share.ts`, `damage-calcs.ts`, `suggestions.ts`
- ダメージ計算の仕様は `jpoke` skill を参照(`vendor/jpoke` を直接読む前に)

### box/data.astro — 個体の対戦データ入力画面
- page: `src/pages/box/data.astro`
- components: `src/components/data/BattleDataCard.astro`, `src/components/box-id/MobilePokemonPreview.astro`
- lib: `src/lib/battle-data-card.ts`, `owned-pokemon.ts`
- styles: `box-insight-page.css`, `battle-data-card.css`
- tests: `tests/battle-data-card.test.ts`

### box/ranked.astro — 個体のランクマ戦績タブ
- page: `src/pages/box/ranked.astro`
- lib: `src/lib/ranked-teams.ts`, `ranked-teams-validation.ts`, `owned-pokemon.ts`
- styles: `box-insight-page.css`, `team-card.css`
- 関連API: `src/pages/api/ranked-teams.ts`
- tests: `tests/ranked-teams-validation.test.ts`

### box/index.astro — ボックス一覧
- page: `src/pages/box/index.astro`
- components: `AppHeader.astro`, `SecondHeader.astro`
- styles: `box-page.css`, `app-header.css`, `second-header.css`
- lib: `src/lib/owned-pokemon-card.ts`, `card-delete-mode.ts`

### damage-calc/index.astro, damage-calc-poc/index.astro — ダメージ計算単体ページ
- page: `src/pages/damage-calc/index.astro`(本番), `src/pages/damage-calc-poc/index.astro`(PoC)
- lib: `src/lib/pyodide-engine.ts`(jpoke呼び出し)、`src/lib/box-id/damage-calc.ts`
- styles: `damage-calc-poc-page.css`
- 参照: `jpoke` skill、`poc/pyodide-jpoke/`

### data/index.astro — データハブ(統計)
- page: `src/pages/data/index.astro`
- components: `BattleDataCard.astro`, `AppHeader.astro`
- lib: `src/lib/data-hub-tabs.ts`, `battle-data-card.ts`, `ranked-teams.ts`, `ranked-teams-validation.ts`, `pokemon-master-data.ts`
- styles: `data-hub-page.css`, `battle-data-card.css`, `team-card.css`, `app-header.css`
- tests: `tests/data-hub-tabs.test.ts`

### speed-chart/index.astro — 速度早見表
- page: `src/pages/speed-chart/index.astro`
- components: `src/components/speed-chart/ChartTable.astro`, `OwnedPanel.astro`
- lib: `src/lib/speed-chart.ts`, `speed-chart-validation.ts`, `src/lib/speed-chart/chart-table.ts`, `owned-panel.ts`, `regulations.ts`
- styles: `speed-chart-page.css`, `speed-chart-table.css`, `speed-chart-owned-panel.css`, `speed-adjust-dialog.css`
- config: `src/config/speed-chart.json`
- tests: `tests/speed-chart.test.ts`, `tests/speed-chart-validation.test.ts`

### team/[id].astro, team/index.astro — チーム編集/一覧
- page: `src/pages/team/[id].astro`, `src/pages/team/index.astro`
- lib: `src/lib/team.ts`, `team-validation.ts`, `team-matchup.ts`, `team-suggest.ts`, `team-card.ts`, `team-mate-card.ts`, `archetype.ts`, `archetypes.ts`, `build-similarity.ts`, `regulations.ts`, `ranked-teams.ts`
- styles: `team-page.css`, `team-pokemon-card.css`, `team-pokemon-tab.css`, `team-data-tab.css`, `team-card.css`, `owned-pokemon-card.css`, `floating-list-controls.css`
- 関連API: `src/pages/api/teams.ts`, `teams/[id].ts`, `team-suggestions.ts`, `matchup-targets.ts`
- tests: `tests/team-validation.test.ts`, `team-matchup.test.ts`, `team-suggest.test.ts`, `build-similarity.test.ts`, `archetype.test.ts`

### ranked-teams/index.astro — ランクマチーム一覧
- page: `src/pages/ranked-teams/index.astro`
- lib: `src/lib/ranked-teams.ts`, `ranked-teams-validation.ts`, `src/lib/ranked-teams/card.ts`
- 関連API: `src/pages/api/ranked-teams.ts`
- データ生成元: `scripts/ranker/`(下記参照)

### search/index.astro — ポケモン検索
- page: `src/pages/search/index.astro`
- lib: `src/lib/pokemon-master-data.ts`, `kana.ts`, `search-validation.ts`
- styles: `search-page.css`
- 関連API: `src/pages/api/search.ts`
- tests: `tests/search-validation.test.ts`, `tests/pokemon-datalist-usage.test.ts`, `tests/kana.test.ts`

### share/[slug].astro — 個体の共有ページ
- page: `src/pages/share/[slug].astro`
- lib: `src/lib/owned-pokemon.ts`(`getPublicOwnedPokemonBySlug`), `pokemon-master-data.ts`, `sprite-urls.ts`, `stats.ts`
- styles: `share-page.css`
- 関連API: `src/pages/api/share/[slug].ts`, `owned-pokemon/[id]/share.ts`
- tests: `tests/sprite-urls.test.ts`, `tests/stats.test.ts`

### index.astro — トップページ
- page: `src/pages/index.astro`
- styles: `home-page.css`, `app-header.css`

### 共通レイアウト/ヘッダー
- `src/layouts/AppLayout.astro`
- `src/components/AppHeader.astro`(styles: `app-header.css`)
- `src/components/SecondHeader.astro`(styles: `second-header.css`)
- `src/components/AppBottomNav.astro`(styles: `app-bottom-nav.css`)
- 共通フォーム部品/ボタン: `form-controls.css`, `buttons.css`, `box-add-button.css`, `mobile-pokemon-preview.css`
- 全体共通: `src/styles/global.css`(スタイル配置ルールは `CLAUDE.md` 参照)

## API(`src/pages/api/`)

- 認証: `auth/login.ts`, `auth/callback.ts`, `auth/logout.ts`, `_shared.ts`, `src/lib/user-session.ts`, `session-hash.ts`
- 所持ポケモン: `owned-pokemon.ts`, `owned-pokemon/[id].ts`, `owned-pokemon/[id]/share.ts` → `src/lib/owned-pokemon.ts`
- チーム: `teams.ts`, `teams/[id].ts`, `team-suggestions.ts`, `matchup-targets.ts` → `src/lib/team.ts`, `team-suggest.ts`, `team-matchup.ts`
- ランクマ: `ranked-teams.ts` → `src/lib/ranked-teams.ts`
- 対戦相手メモ: `opponent-notes.ts`, `opponent-notes/[id].ts` → `src/lib/opponent-notes.ts`, `opponent-notes-validation.ts`, `opponent-note-anonymize.ts`, `opponent-note-secondary-record.ts`
- ダメージ計算保存: `damage-calcs.ts` → `src/lib/damage-calc-validation.ts`, `damage-calc-suggest.ts`
- イベント記録: `events.ts` → `src/lib/event-validation.ts`
- 検索: `search.ts` → `src/lib/search-validation.ts`
- 提案(汎用): `suggestions.ts`
- 共有: `share/[slug].ts`
- 共通処理・レート制限: `src/pages/api/_shared.ts`, `src/lib/rate-limit.ts`, `validation-primitives.ts`
- tests: `tests/api-shared.test.ts`, `tests/api-required-body-endpoints.test.ts`, `tests/db/*`

## データ生成パイプライン(`scripts/`)

- **ランクマ記事→チーム抽出**: `scripts/ranker/`(`download_articles.py` → `extract_articles.py` → `build_pokesol.py` / `build_ranked_teams.py`)。仕様は `scripts/ranker/EXTRACTION_SPEC.md`。出力は `docs/ranker/*.json` → DBへは `scripts/db/seed-ranked-teams.mjs` 等
- **マスターデータ生成**: `scripts/build-master-data/build.mjs`, `extract_autocomplete.py` → `public/master-data/`, `src/lib/pokemon-master-data.ts`
- **OPGG採用率取得**: `scripts/opgg/fetch-champions-usage.mjs`(GitHub Actions `fetch-opgg-champions-usage.yml` で日次実行)→ Cloudflare KV(`OPGG_USAGE`バインディング、読み取りは`src/lib/opgg-usage.ts`)、`config/opgg-champions-pokemon-map.json`
- **画像アセット生成**: `scripts/pokemon-artwork/`, `scripts/pokemon-champion-sprites/`, `scripts/item-icons/`, `scripts/type-icons/` → `public/pokemon-artwork/`, `public/pokemon-champion-sprites/`, `public/item-icons/`, `public/type-icons/`
- **DB運用**: `scripts/db/`(migration実行 `run-migrations.mjs`、開発用シード `seed-*.mjs`、集計バックフィル `backfill-*.mjs`, `refresh-suggestions.mjs`)。DBスキーマ本体は `migrations/*.sql`

## ダメージ計算エンジン(vendor)

- `vendor/jpoke/`(Python実装、Pyodide経由で `src/lib/pyodide-engine.ts` から呼ばれる)
- 直接ソースを読む前に `jpoke` skill を参照すること(仕様・API・チャンピオンズルールの制約がまとまっている)

## その他ドキュメント

- `docs/plan/*.md`: 個別機能の調査・計画メモ(全体インデックスではないので、関連しそうなタイトルを探す)
- `docs/ui/`: UI改修時のスクリーンショット記録(`ui` skill が使用)
- `docs/ranker/*.json`: ランクマチーム抽出パイプラインの出力サンプル
- ルート `CLAUDE.md`: 作業方針(main直接作業・commit運用)とCSS配置規約
