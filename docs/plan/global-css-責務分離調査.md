# global.css の責務分離調査

- 調査日: 2026-08-10
- 対象: `src/styles/global.css`（1,348行）と、そのスタイルを利用する `src/layouts` / `src/pages` / `src/components`
- 結論: 共通トークンとUIプリミティブは適切に集約されている一方、特定機能専用の部品・一覧画面用のレイアウト・要素セレクタによる既定値まで同居している。`global.css` は「全画面へ無条件に適用する基盤」に絞り、機能固有スタイルを段階的に移す余地がある。

## 判断基準

`global.css` に置く対象は、次のすべてを満たすものとする。

1. 複数画面で利用される。
2. 意味・DOM構造・振る舞いが同じである。
3. 画面固有の上書きをほとんど必要としない。

利用箇所が複数でも、機能ごとに意味やレイアウトが異なる場合は、機能別CSSまたはコンポーネントの `style` に置く。

## 現状の分類

| 区分 | 代表例 | 判定 |
|---|---|---|
| デザイントークン・基礎 | `--color-*`、`--space-*`、`--font-size-*`、`box-sizing`、`body` | 維持 |
| 再利用可能なUIプリミティブ | `.btn-*`、`.field*`、`.card`、`.badge`、`.toggle-switch`、`.empty-state`、`.spinner` | 維持。ただし全画面の要件として定期的に見直す |
| アプリレイアウト | `.app-shell`、`.app-topbar`、`.app-sidebar`、`--topbar-height` | 維持可。将来 `AppLayout.astro` 専用へ寄せる選択肢あり |
| 一覧画面専用の部品 | `.panel-toolbar`、`.favorite-filter-toggle*`、`.search-input-wrap`、`.sort-select-wrap`、`.sort-dir-toggle*` | 一覧用スタイルとして分離候補 |
| 機能専用の部品 | `.rank-field*`、`.rank-stepper*`、`.stat-input*`、`.move-inputs`、`dialog#opponent-note-form-container` | 分離対象 |
| 要素セレクタの既定値 | `button`、`input`、`select`、`table`、`dl`、`label` | 影響範囲が広く、縮小・明文化の対象 |

## 分離を優先する箇所

### 1. 特定IDのダイアログ

`dialog#opponent-note-form-container` はIDで対象を固定しており、再利用可能な共通部品ではない。該当するダメージ計算／相手メモ機能のコンポーネントへ移す。

優先度は最優先。移動しても他画面への影響がなく、依存方向を最も分かりやすく改善できる。

### 2. speed-chart 固有のランク操作

`.rank-field`、`.rank-stepper-group`、`.rank-stepper` は `components/speed-chart/OwnedPanel.astro` のランク操作に対応する部品である。汎用名だが、現状では同一構造の横断利用が確認できない。

`OwnedPanel.astro` のスタイルへ移し、将来同じランク操作を別機能で採用するときに、構造ごと共有コンポーネントとして再昇格させる。

### 3. ポケモン編集用の入力群

`.stat-grid-label`、`.stat-inputs`、`.stat-input`、`.stat-input-controls`、`.move-inputs` は、汎用フォームの `.field` とは粒度・用途が異なる。ボックス編集関連コンポーネントへ寄せる。

### 4. 一覧ツールバーのドメイン部品

`.panel-toolbar` は `/box`、`/team`、`/ranked-teams` で共有されているため、直ちに各ページへ複製する必要はない。一方で `.favorite-filter-toggle*`、検索・ソート入力の内側余白、`.sort-dir-toggle*` までが同じグローバル層にあり、一覧UIの詳細が基盤へ漏れている。

まず `src/styles/list-toolbar.css` のような任意ロードの共有CSSへ切り出し、一覧ページだけで読み込む。共通化自体は維持する。

### 5. `.severity-bar`

ダメージ計算と speed-chart の双方で利用されるため、即時のローカル化は優先しない。ただしダメージ計算側には表示・配色・余白の局所上書きが多い。共通部分を「状態通知」として残すか、ダメージ計算専用の結果表示へ分けるかを、上書きが増える時点で判断する。

## 広域セレクタの注意点

以下は全ページの標準UIを意図する場合のみ許容する。

- `button` と `a.btn-*`
- `input` / `select` / `textarea` と各 `type` セレクタ
- `table`、`th`、`td`、`dl`、`dt`、`dd`、`fieldset`、`legend`、`label`

現在、ページ／コンポーネント側には、入力の最小幅・高さ、ボタンの太さやpadding、`[hidden]`、hover状態を局所的に打ち消す記述がある。これは「共通既定値が各画面に適合しない」兆候である。

ただし全面撤廃は行わない。まず `input[type="text"] { min-width: 12em; }` のようなレイアウトまで含む既定値を、必要なコンポーネントのクラスへ移す。フォント、色、フォーカスリングなどのアクセシビリティ上の基礎は維持する。

## 推奨する移行順

1. `dialog#opponent-note-form-container` を該当機能へ移動する。
2. `.rank-*` を speed-chart の `OwnedPanel.astro` へ移動する。
3. `.stat-*` と `.move-inputs` をボックス編集関連へ移動する。
4. 一覧ツールバー関連を任意ロードの共有CSSへ分割する。
5. 要素セレクタを監査し、レイアウト値を含むものからクラス化する。

各段階で、対象画面のライト／ダークテーマ、モバイル幅、キーボードフォーカス、`hidden` による非表示を確認する。グローバルから削除する前に移動先のスタイルを追加し、一段階ずつ視覚回帰を防ぐ。

## 実施しないこと

- `.btn-*`、`.field*`、`.card` などをページごとに複製しない。
- 共有候補を利用箇所数だけで判断しない。同じ意味・DOM構造・振る舞いを必須条件とする。
- 既存画面の上書きを一度に全て解消しようとしない。影響が狭い箇所から移動する。
