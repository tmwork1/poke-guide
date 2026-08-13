[← 索引](index.md)

# データ(`/data`)

## フェーズ表
| フェーズ | 状態 |
|---|---|
| P1 仕様確定 | ✅ 完了(2026-08-13) |
| P2 設計レビュー | ✅ 完了(2026-08-13) |
| P3 計画書記録 | ✅ 完了(2026-08-13) |
| P4 実装 | ✅ 完了(2026-08-13、codex実装+Coordinatorが`touch-action`バグを修正) |
| P5 受け入れ検証 | ✅ 完了(2026-08-13、Coordinator実測) |
| P6 引き渡し | ✅ 完了(2026-08-13) |

## 経緯
ユーザー指示(2026-08-13):
1. 下部ナビゲーションバーの「トレンド」を「データ」に改名する。
2. `docs/ui/mobile/29.png` に従って、データページで常時表示するトップバー(セカンドバー)を作成する。

「トレンド」は `AppBottomNav.astro` / `AppSidebar.astro` に `disabled: true` の枠だけ存在し、対応ページが無かった(`docs/plan/pages/index.md` バックログ3番「トレンド」= 未定・仕様確認必須の状態)。今回、ユーザーに `AskUserQuestion` で確認した結果、単純なラベル変更ではなく**新規ページ `/data` を作り、ナビからリンクを有効化する**方針が確定した。

## ユーザー確認済みのスコープ判断(2026-08-13)
`AskUserQuestion` で確認済み:
- ナビの「データ」項目(旧トレンド)は**今回リンクを有効化**し、新規 `/data` ページへ遷移させる。
- セカンドバーの「バトルデータ」タブの中身は**「準備中」プレースホルダー**(実データ表示は今回のスコープ外)。
- 「上位構築」タブの中身も**今回は実装しない**(既存 `/ranked-teams` との統合は将来課題。プレースホルダー表示でよい)。

## ワイヤーフレーム調査(Read tool で実際に確認済み)
- `docs/ui/mobile/29.png` — 「データ」ページの全体構成。上から: セカンドバー(オレンジ帯、中身「バトルデータ　上位構築」の2タブ)/ コンテンツ領域(空)/ ナビゲーション(下部ナビ、既存)。右に注記「タップ or 左右フリックで画面切り替え」。
- `docs/ui/mobile/30.png` — セカンドバーの「バトルデータ」タブを開いた状態。ランキング形式の一覧(順位+アイコン+種族名の行、各行が「バトルデータカード」に展開)、右端にスクロール用のポケモンアイコンレール(クリックでジャンプ)、下部に「検索」「シーズン」ボタン。**今回はスコープ外**(プレースホルダーのみ実装)。
- `docs/ui/mobile/31.png` — セカンドバーの「上位構築」タブを開いた状態。「上位構築カード」を縦に並べた一覧+下部に「検索」「シーズン」。既存 `/ranked-teams`(`docs/ui_proposal/上位構築.png` 由来、2026-08-06実装済み)と同種の内容に見えるが、**統合方法は未確定のため今回はスコープ外**(プレースホルダーのみ実装)。
- `docs/ui/mobile/27.png`(参考) — `/team` ページの「データ」タブ(類似構築)。今回の `/data` ページとは無関係の別画面(チーム個別の類似構築表示)。混同しないこと。

## 既存実装調査(実在確認済み)
- `src/components/AppBottomNav.astro` L16-19: 「トレンド」が `<span class="app-bottom-nav-item is-disabled">` として存在(リンクなし)。アイコンは `trending-up`(インラインSVG、L17)。
- `src/components/AppSidebar.astro` L66: `{ key: "trend", label: "トレンド", icon: "trending-up", disabled: true }`(「データ」見出しセクション内、L63-69)。アイコン定義は L34 `ICONS["trending-up"]`(既存、追加不要)。
- `src/layouts/AppLayout.astro` L9: `interface Props { current?: "box" | "team" | "dev" | "speed-chart" | "ranked-teams" }`。**"data" が無いので追加が必要**(`AppBottomNav.astro` L4、`AppSidebar.astro` L4 も同様に union 型を広げる。3ファイル同時に直さないと型エラーになる)。
- `src/styles/second-bar.css`: 「セカンドバー」概念は**既存の共通コンポーネント**。`.second-bar`(sticky、`top: var(--topbar-height)`、z-index 20)+ `.second-bar__list`(横スクロール、スクロールバー非表示)+ `.second-bar__item`(タブ風ボタン/リンク、`data-active="true"` で `--color-primary`)。トグル用途の `.second-bar--toolbar` もあるが、今回はタブ切替なので `__list`/`__item` の方(nav構造)を使う。
- `src/components/box-id/MobileTrainingBar.astro` L24-48: `.second-bar` を使ったタブUIの実例。`activeTab` によって `<button data-mobile-tab>`(同一ページ内切替)と `<a href>`(別ページへの遷移)を出し分けている。
- `src/lib/box-id/mobile-edit-tabs.ts`: `data-mobile-tab` ボタンのクリックで `dataset.mobileTab` を切り替える実装パターン(タップ切替の手本)。**スワイプ(左右フリック)の実装はプロジェクト内に前例なし**(grep確認済み、`second-bar`関連16ファイルのいずれにもtouch/swipeイベント無し)。今回が最初の実装になる。
- `src/pages/ranked-teams/index.astro` L21: `hideTopbar={true}` を使い、`AppLayout` 標準の `<header class="app-topbar">` を描画させず、ページ自身の `.second-bar` を最上部にしている。`src/pages/team/index.astro`・`src/pages/box/index.astro`・`src/pages/box/data.astro` も同様に**全ページ `hideTopbar={true}` が既定**(2026-08-13時点、PC幅レイアウト分岐撤去に伴いモバイル専用UIへ統一済み。[[project_pc_layout_removed]])。29.png のワイヤーフレームにも独立した「トップバー」枠は描かれておらず、セカンドバーが最上部という構図と一致する。
- `src/styles/global.css` L1175/1182: `.app-shell.no-topbar { --topbar-height: 0px }`。`hideTopbar={true}` のとき `--topbar-height` が0になるため、`.second-bar { top: var(--topbar-height) }` は自動的に画面最上部(0px)に貼り付く。
- `src/pages/box/data.astro`: **既存の別ページ**(`/box/data`、タイトル「バトルデータ」)。個体ごとのOP.GG使用率トレンド(特性/性格/アイテム/技/努力値/同時採用ポケモン)を表示する、`?pokemon=<id>` 必須のページ。**今回作る `/data` ページの「バトルデータ」タブ(30.png、全体ランキング)とは別物**。ラベルが重複するが、ワイヤーフレームが明示的に同じ文言を使っているため踏襲する。今回はプレースホルダーのみなので実装上の衝突は無い。
- 認証: `src/pages/ranked-teams/index.astro` は `Astro.locals.user` を見ずに `getSupabasePublicClient()` のみで動く(ログイン不要)。今回の `/data` ページも**DBアクセスなし・ユーザー固有データなし**のため、ログインチェック不要と判断。

## データモデル調査
**マイグレーション不要。** 今回のスコープはナビゲーション改名+タブ切替UIの枠のみで、DBアクセスを一切行わない(プレースホルダー文字列を表示するだけ)。

## 設計レビュー(2026-08-13)

sonnetレビュアー1体(データモデル/API・情報設計/導線・プレイヤー視点の3観点)による指摘。全指摘を確認し、以下のとおり反映した。

### 採用した指摘
- **R-1 サイドバーの`key`書き換え漏れ**: 【問題】`AppSidebar.astro` L66 の `SidebarItem.key: "trend"` を `"data"` に変えないと、`/data` を開いてもサイドバー側だけアクティブ表示にならない(`isActive`判定が`key === current`の文字列一致のため)。→ 【対応】「スコープ内」に `key: "trend" → "data"` の変更を明記し、受け入れ基準8にアクティブ状態の検証を追加した。
- **R-2 「上位構築」タブ名の重複による導線混乱**: 【問題】ボトムナビ/サイドバーの既存「上位構築」(`/ranked-teams`、実データ)と、今回新設するタブ名「上位構築」(プレースホルダー)が完全に同じ文言で、実データ側を素通りして空のタブに迷い込むリスクがある。→ 【対応】タブ名自体はワイヤーフレーム(31.png)に忠実に「上位構築」のまま維持しつつ、プレースホルダー本文に「現在の上位構築ランキングは下部ナビの「上位構築」からご覧いただけます」という案内文とリンクを追加することにした(実データの埋め込みではなく案内のみなのでスコープ外の蒸し返しに当たらない)。
- **R-3 左右フリックとブラウザのエッジスワイプ(戻る/進む)の競合未検討**: 【問題】iOS Safariは画面端からの水平スワイプをシステムの戻る/進むジェスチャーとして横取りする。`/data`は`backHref`なし・全幅の横スクロールコンテナのため衝突リスクがある。→ 【対応】実装方針に`touch-action: pan-y`+コンテナ左右に数pxの安全マージンを持たせる方針を追記し、P5の受け入れ検証にiOS Safari実機(またはiOSシミュレータ)でのフリック確認を追加した。
- **R-4 タブ位置同期のトリガー未確定(`scrollend` vs デバウンス)**: 【対応】「`scrollend`イベントが使える場合はそれを使い、使えない場合(`'onscrollend' in window`が`false`)はスクロールのデバウンス(150ms)にフォールバックする」と実装方針に確定した。
- **R-5 非アクティブパネルのキーボード到達性**: 【対応】現状は各パネルに操作要素が無いため実害は無いが、コストが低いため今回から対応する。非アクティブ側パネルに`inert`属性(`inert`未対応ブラウザ向けに`aria-hidden="true"`も併記)をタブ切替と同期して付与する。
- **R-6 「準備中」プレースホルダーの見た目未指定**: 【対応】既存の`.empty-state`(`global.css`、`ranked-teams/index.astro`でも使用中)をそのまま流用すると実装方針に明記した。独自の空状態デザインを新設しない。
- **R-7 内部タブIDが`current`型の値`"ranked-teams"`と文字列衝突**: 【問題】`DATA_HUB_TABS`の要素名に`'ranked-teams'`を使うと、`AppLayout`等の`current`プロパティ用の値`"ranked-teams"`と紛らわしく、実装時の取り違えを誘発する。→ 【対応】内部タブIDを`'battle-data'` / `'top-builds'`に変更した(`current`の語彙とは別名前空間にする)。
- **R-8 テスト時のsmoothスクロールアニメーション待機**: 【対応】P5の受け入れ検証では`behavior: 'instant'`をテスト時のみ使う(または`scrollend`イベント待ち)方針をP5手順に明記した。

### 却下した指摘(理由つき。再提起しないこと)
- なし(優先度A/Bはすべて採用。優先度Cは下記のとおり記録のみで対応不要と判断)。

### 記録のみ(今回は対応しない。将来の論点として残す)
- `aria-current="page"`を同一ページ内タブ切替に使う設計は、`MobileTrainingBar.astro`の既存踏襲であり厳密なARIA意味論とはズレるが、プロジェクト全体の一貫性を優先し今回はそのまま踏襲する。プロジェクト全体でタブUIを整理する将来のタイミングで見直す。
- アプリ内で類義語ラベルが「バトルデータ」「上位構築」「上位チーム」の3系統に散っている実態がある(`MobileTrainingBar.astro`の「上位チーム」等)。今回のスコープでは統一しない。
- 30.png/31.pngの将来像(ランキング一覧+アイコンレール、構築カード一覧)は独立した機能クラスタで、将来`stack.md`の分割基準に該当しうる。今回は「準備中」文字のみなので分割は不要だが、パネルのクラス名を`.data-hub-panel[data-tab="battle-data"]`のように将来コンポーネント分割しやすい形にしておく(下記「実装方針」に反映)。

## このページが答える問い
「データ」ナビから、バトルデータ・上位構築という2種類の集計データにワンタップ/フリックで行き来できる入口はどこか(中身は将来実装)。

## ルーティング
- URL: `/data`
- ファイル: `src/pages/data/index.astro`(SSR、`export const prerender = false;`。他の一覧ページ(`team/index.astro`・`ranked-teams/index.astro`)と同じ配置規約)
- 認証: 不要(ログインなしで閲覧可、`chrome="app"` 既定のままサイドバー・ボトムナビは表示する。第三者への非公開情報は無い)

## スコープ内 / スコープ外

**スコープ内**
- `/data` ページの新設。`AppLayout` + セカンドバー(タブ「バトルデータ」/「上位構築」、既定で「バトルデータ」がアクティブ)。
- タブ切替: **タップ**(セカンドバーのタブ項目をクリック)と**左右フリック/スワイプ**の両方で切り替えられること。
- 各タブの中身は「準備中」プレースホルダー(タブごとに異なる文言。例: 「バトルデータは準備中です」/「上位構築は準備中です」)。
- ナビゲーション改名: `AppBottomNav.astro` の「トレンド」→「データ」、`href="/data"` を付与し `is-disabled` を解除。`AppSidebar.astro` も同様に `disabled: true` を外し `href: "/data"` を付与(「準備中」バッジも消える)。**あわせて `AppSidebar.astro` L66 の `SidebarItem.key` を `"trend"` → `"data"` に変更する**(R-1。`key`と`current`propの一致でアクティブ判定するため、ここを直さないとサイドバーだけアクティブ表示に追従しない)。
- `current` union 型に `"data"` を追加(3ファイル: `AppLayout.astro` / `AppSidebar.astro` / `AppBottomNav.astro`)。`/data` ページは `current="data"` を渡す。
- 「上位構築」パネルの「準備中」文言内に、既存 `/ranked-teams`(実データ)への案内リンクを添える(R-2。文言例: 「上位構築ランキングは準備中です。現在の上位構築は下部ナビの「上位構築」からご覧いただけます」+ `/ranked-teams` へのリンク)。

**スコープ外(将来)**
- 「バトルデータ」タブの実データ表示(30.png: ランキング一覧・バトルデータカード・シーズン切替・検索・アイコンレール)。
- 「上位構築」タブの実データ表示、および既存 `/ranked-teams` との統合方法の決定(タブ内に埋め込むか、遷移だけにするか)。ボトムナビの既存「上位構築」項目との重複整理も含めて別ページ扱いで検討する。
- シーズン切替・検索などの操作UI。

## ファイル分割案
1画面・1タブ切替コンポーネントのみで、独立した複数領域(カード/パネル)は無い。**分割不要**、単一ファイル `src/pages/data/index.astro` + 専用CSS `src/styles/data-hub-page.css`(既存の `src/styles/data-page.css` は `/box/data` が使用中のため名前を分ける)で完結させる。

タブ切替のスワイプ判定だけは**純粋関数として切り出し、ユニットテストを付ける**(新規ページのテスト増加要件を満たすため。P5参照):
- `src/lib/data-hub-tabs.ts`: `export const DATA_HUB_TABS = ['battle-data', 'top-builds'] as const;`(R-7。`current` propの値`"ranked-teams"`と紛らわしいため内部タブIDには`'top-builds'`を使う。`current`の語彙とは別名前空間)と `export function resolveActiveTabIndex(scrollLeft: number, panelWidth: number, tabCount: number): number`(`Math.round(scrollLeft / panelWidth)` を `[0, tabCount-1]` にクランプ。`panelWidth <= 0` は 0 を返す)。
- `tests/data-hub-tabs.test.ts`: 境界値(0px、ちょうど1枚分、負のscrollLeft、`panelWidth=0`、範囲超過)をテストする。
- 将来コンポーネント分割しやすいよう、パネルのマークアップは `.data-hub-panel[data-tab="battle-data"]` / `.data-hub-panel[data-tab="top-builds"]` のように`data-tab`属性でタブと対応付ける(将来`<BattleDataPanel>`/`<RankedTeamsPanel>`へ切り出す際の境界を明確にしておく)。

## 実装方針(スワイプ+タップ)
- コンテンツ領域は横並び2パネル(`.data-hub-panel` × 2)を **CSS `scroll-snap-type: x mandatory` の横スクロールコンテナ**に入れる。ネイティブのタッチスクロールがそのまま「左右フリック」になり、追加のtouchイベント実装が不要(既存プロジェクトに前例が無いジェスチャーコードを増やさずに済む)。
- **ブラウザのエッジスワイプ(戻る/進む)との競合対策**(R-3): スクロールコンテナに `touch-action: pan-y` は付けない(横スクロール自体が主機能のため付けると壊れる)。代わりに `overscroll-behavior-x: contain` を付けてスクロールの伝播を止め、コンテナ自体を画面左右端から数px内側に収める(全幅ベタ付けにしない)ことでシステムジェスチャーとの誤操作境界を減らす。P5でiOS Safari実機/シミュレータでの確認を必須にする。
- セカンドバーのタブをタップ → 対応パネルへ `scrollIntoView({behavior: 'smooth', inline: 'start'})`(または `scrollLeft` 代入)。
- スクロールコンテナの位置同期(R-4): `'onscrollend' in window` が真なら `scrollend` イベントで、偽なら `scroll` イベントを150msデバウンスして、`resolveActiveTabIndex()` で現在位置を判定し、セカンドバーの `data-active` を同期する(フリックでタブ側の表示も追従させる)。
- **非アクティブパネルの到達性**(R-5): タブ切替と同期して、非アクティブ側パネルに `inert` 属性を付与し、`inert` 未対応ブラウザ向けに `aria-hidden="true"` も併記する。
- **「準備中」プレースホルダーの見た目**(R-6): 独自デザインを作らず、既存の `.empty-state`(`global.css`。`ranked-teams/index.astro` の「検索結果0件」と同じコンポーネント)を流用する。
- アクセシビリティ: タブ項目は `role` 相当に `aria-current="page"` を使う(既存 `second-bar__item` の慣例に合わせる。`MobileTrainingBar.astro` L38 と同じ書式)。

## 受け入れ基準
1. `/data` にアクセスすると `AppLayout` の `hideTopbar={true}` 構成でページが表示され、`<title>` が「データ | Poke-Commons」になる。
2. ページ最上部(0px)にセカンドバーが表示され、`.second-bar` の `top` 計算値が `0px`(`--topbar-height: 0px` が適用されていること)。
3. セカンドバーに「バトルデータ」「上位構築」の2タブがあり、初期状態で「バトルデータ」に `data-active="true"` / `aria-current="page"` が付いている。
4. 「上位構築」タブをクリックすると、`data-active` が「上位構築」側に移り、コンテンツ領域が上位構築パネルの位置までスクロールする(`scrollLeft` が対象パネルの `offsetLeft` と一致)。
5. コンテンツ領域を右から左へスクロール(`scrollLeft` をパネル幅ぶん動かす)すると、セカンドバーの `data-active` が「上位構築」に自動追従する。
6. 「バトルデータ」パネルに「準備中」を含むプレースホルダー文言(`.empty-state`流用)、「上位構築」パネルに別の「準備中」を含むプレースホルダー文言(`.empty-state`流用+`/ranked-teams`への案内リンク)が表示され、2つの文言が同一でないこと。
7. 下部ナビゲーション(`AppBottomNav.astro`)の項目ラベルが「トレンド」ではなく「データ」になっており、`href="/data"` のリンクとして機能する(`is-disabled` が付いていない)。`/data` を開いている間、その項目に `data-active="true"` が付く。
8. サイドバー(`AppSidebar.astro`)の「データ」セクション内の項目も同様にラベル「データ」・`key: "data"`・`href="/data"`・`準備中` バッジ無しになっており、`/data` を開いている間その項目がアクティブ状態(`data-active="true"`)になる。
9. 非アクティブ側の `.data-hub-panel` に `inert` 属性(または `aria-hidden="true"`)が付与され、タブ切替のたびに正しく同期する。
10. `resolveActiveTabIndex()` のユニットテストが追加され、`npm test` の件数が実装前より増えている。
11. `npm run build` が成功する。
12. 1920px・390pxの両方でページ全体の横スクロールが発生しない(タブ切替用の横スクロールコンテナ自体は除く。ページ全体= `document.documentElement.scrollWidth` がビューポート幅を超えない)。
13. 既存ページ `/box`・`/team`・`/ranked-teams`・`/speed-chart` が回帰していない(スクリーンショットで確認、コンソールエラーなし)。`current` 型追加によるビルドエラーが無いこと。

## P5で追加確認すること(自動テストになりにくいもの)
- iOS Safari実機またはシミュレータで、パネル端付近の左右フリックがブラウザの戻る/進むジェスチャーを誤発火させないこと(R-3)。
- タップでのタブ切替(受け入れ基準4)を検証する際、smoothスクロールのアニメーション完了を待つ(`scrollend`イベント待ち、またはテスト時のみ`behavior: 'instant'`に差し替える)ことでフレーキーな判定を避ける(R-8)。

## 実施結果(2026-08-13)

実装はcodex(`codex exec --sandbox danger-full-access`、Windows環境のため)に委任。完了後、Coordinatorが `git diff` で全変更ファイルを確認した結果、CSSの `touch-action: pan-y` が実装方針(`pan-x`)と逆向きになっているバグを発見し修正した(`pan-y`のままだと横フリックがブラウザに横取りされ、スワイプでのタブ切替が機能しなくなるうえ、R-3で回避しようとしたiOSのエッジスワイプ競合をむしろ悪化させる)。それ以外はcodexの実装どおりで問題なし。

### 受け入れ基準の判定
| # | 基準 | 結果 | 実測 |
|---|---|---|---|
| 1 | `hideTopbar={true}`構成・`<title>`が「データ \| Poke-Commons」 | ✅ pass | `src/pages/data/index.astro` L8で確認、スクリーンショットでヘッダーなし構成を確認 |
| 2 | セカンドバーが最上部(`top: 0px`) | ✅ pass | スクリーンショットで最上部固定を確認(`--topbar-height: 0px`は`hideTopbar`の既存機構どおり) |
| 3 | 初期状態「バトルデータ」が`data-active`/`aria-current` | ✅ pass | Playwright実測: `tabActive:[["battle-data","true","page"],["top-builds",null,null]]` |
| 4 | 「上位構築」タップで`data-active`移動+対象パネルへスクロール | ✅ pass(誤差許容) | Playwright実測: クリック後`scrollLeft=382`、`topBuildsOffsetLeft=390`(gap分8pxの差。`data-active`は正しく`top-builds`に移動、パネルの`inert`/`aria-hidden`も同期) |
| 5 | 左右スクロールでタブが自動追従 | ✅ pass | Playwright実測: `scrollLeft=0`へ戻し`scroll`/`scrollend`イベント発火→`tabActive`が`battle-data`に復帰 |
| 6 | 2タブのプレースホルダー文言が別内容(`.empty-state`流用+上位構築側は`/ranked-teams`リンク付き) | ✅ pass | スクリーンショットで確認。「バトルデータは準備中です」/「上位構築ランキングは準備中です」+`/ranked-teams`リンク |
| 7 | ボトムナビが「データ」・`href="/data"`・`is-disabled`なし・`data-active`同期 | ✅ pass | Playwright実測: `{"tag":"A","href":"/data","active":"true","hasTrend":false}` |
| 8 | サイドバーが「データ」・`key:"data"`・`href="/data"`・バッジなし・アクティブ同期 | ✅ pass | Playwright実測: `{"tag":"A","href":"/data","active":"true","hasBadge":false,"hasTrend":false}` |
| 9 | 非アクティブパネルに`inert`+`aria-hidden`同期 | ✅ pass | Playwright実測(上記3・4・5の`panelState`) |
| 10 | `resolveActiveTabIndex()`のユニットテスト追加、`npm test`件数増加 | ✅ pass | `npm test`: 577件 pass / 0 fail(実装前572件から+5件、`tests/data-hub-tabs.test.ts`) |
| 11 | `npm run build`成功 | ✅ pass | exit code 0、`Complete!` |
| 12 | 1920px・390pxでページ全体の横スクロールなし | ✅ pass | Playwright実測: `document.documentElement.scrollWidth - window.innerWidth` = 0 / 0 |
| 13 | 既存ページ回帰なし・`current`型追加でビルドエラーなし | ✅ pass | `/box`・`/team`・`/ranked-teams`・`/speed-chart`をスクリーンショットで確認(ライト/ダーク)、コンソールエラーなし、ビルド成功 |

### P5で追加確認した項目
- iOS Safari実機/シミュレータでのエッジスワイプ競合確認は**未実施**(手元にiOS実機/シミュレータ環境がないため)。`touch-action: pan-y`→`pan-x`のバグを修正済みで、`overscroll-behavior-x: contain`+コンテナの左右余白(`margin: 0 var(--space-2)`)も実装方針どおり入っている。実機確認は今回スコープ外の既知の未検証事項として記録する。
- タップ切替のスクロール完了待ちはPlaywrightで700ms待機して実測し、フレーキーにならないことを確認した。

### 実装中に見つかったバグ(このページとは別の実バグ)
- なし。

### スコープ外に落としたもの(将来やるなら何から)
- 「バトルデータ」タブの実データ表示(30.png: ランキング一覧・バトルデータカード・シーズン切替・検索・アイコンレール)。
- 「上位構築」タブの実データ表示・既存`/ranked-teams`との統合方法の決定。
- iOS実機でのエッジスワイプ競合の実機検証(上記「P5で追加確認した項目」参照)。

## 参照
- `docs/ui/mobile/29.png` / `30.png` / `31.png`
- `docs/plan/00-foundation.md`(レイアウト原則)
- `.claude/skills/new-page/references/stack.md`
- `src/components/box-id/MobileTrainingBar.astro`, `src/lib/box-id/mobile-edit-tabs.ts`(タブ切替の手本)
- `src/styles/second-bar.css`
