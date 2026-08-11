---
name: css-consolidate
description: `.astro` ページ/コンポーネントに直書きされた `<style>` / `<style is:global>` を、`src/styles/` 配下の対象別CSSファイル(`box-card.css`・`box-edit-page.css` のような命名)へ切り出す、見た目を一切変えないリファクタリング。ルートの `CLAUDE.md`「スタイル定義」が必須としている構成に既存コードを後追いで合わせるときに使う(例:「`team/[id].astro` の埋め込みCSSを外に出して」「このページのstyleブロックを分離して」)。値やデザインの調整を伴う依頼は `ui` skill の担当で、このskillの対象外。Coordinatorは分割方針の確定・委譲・スクリーンショット検証・commitに徹し、CSSの移動そのものは必ずサブエージェント(codexが使えれば優先)に委託する。
---

# 埋め込みCSSの外部ファイル化

ルートの `CLAUDE.md`「スタイル定義」は、画面・コンポーネント固有のスタイルを対象ごとのCSSファイルへ集約することを必須としています。しかし既存コードには `.astro` に直書きされた `<style>` が大量に残っています(例: `src/pages/team/[id].astro` は約5,000行のうち大半が埋め込みCSS)。このskillは、その後追い切り出しを安全に繰り返すための手順です。

**このskillが扱うのは「移動」だけです。** セレクタ・プロパティ・値は一字一句変えません。

## この skill を使ってよい条件

- 対象の `.astro` ページ/コンポーネントに埋め込みの `<style>` / `<style is:global>` があり、それを `src/styles/` 配下の専用CSSファイルへ切り出す依頼であること
- **見た目・機能を一切変えない、純粋なリファクタリングであること**

デザイン変更・余白や色の調整・トークン化といった「値を変える」作業は `ui` skill の担当です。切り出し中に「ついでにここも直したい」と思っても、このskillの中ではやりません。切り出しをcommitしたうえで、別途 `ui` skill として実施します(見た目を変える変更が混ざると、後述のスクリーンショット差分検証が成立しなくなります)。

**特に指示のない限り `main` で直接作業します**(→ ルートの `CLAUDE.md`「作業方針」)。着手前に `git status` で作業ツリーがクリーンか確認します。

## 手順

### 1. 対象範囲を確認し、役割ごとにグルーピングする

埋め込みstyleブロックを読み、**1つの意味のある単位 = 1ファイル**になるように分けます。`src/pages/box/[id].astro` を切り出した前例が基準になります。

| 単位 | 実例 |
|---|---|
| 複数画面で使う共通カード部品 | `src/styles/box-card.css`(`/box` と `/team` が `@import` で共有) |
| ページ全体のレイアウト | `src/styles/box-edit-page.css`(`/box/[id]`)、`src/styles/box-page.css`(`/box`)、`src/styles/team-page.css`(`/team`) |
| 単体コンポーネント | `src/styles/box-pokemon-preview.css`(モバイル編集画面のプレビューバー)、`src/styles/move-picker-dialog.css`、`src/styles/speed-adjust-dialog.css` |
| 画面内の独立したセクション | `src/styles/box-damage-page.css` + `src/styles/box-damage-card.css`(ダメージ計算タブ) |

判断の目安:

- **他の画面でも使われている(または使われそうな)部品は独立ファイルにする。** `box-card.css` は `.box-grid .box-card` を基底セレクタとして `--box-card-*` のカスタムプロパティ一式を定義し、子孫セレクタが `var(--box-card-*)` を参照する構造になっています。取り込む側(`box-page.css` / `team-page.css`)は先頭で `@import "./box-card.css";` し、変数だけを上書きします。切り出す対象が同じ性質なら、この構造を踏襲します
- **細かく割りすぎない。** 「同一対象のスタイルを無秩序に複数ファイルへ分ける」ことも `CLAUDE.md` が禁止しています。迷ったらページ単位1ファイルから始め、明確に独立した部品だけを別ファイルに切ります
- 分割案が決まらない/対象が大きい場合は、Explore エージェント(sonnet)に埋め込みstyleの棚卸し(セレクタの一覧と役割の分類)を委託してから決めてよいです

### 2. ファイル名を既存の命名規則に揃える

`<画面/対象名>-<役割>.css`(すべて小文字ケバブケース)。既存: `box-card.css` / `box-page.css` / `box-edit-page.css` / `box-damage-page.css` / `box-damage-card.css` / `box-pokemon-preview.css` / `box-add-button.css` / `team-page.css` / `data-page.css` / `move-picker-dialog.css` / `speed-adjust-dialog.css` / `floating-list-controls.css` / `second-bar.css`。

**新しい命名パターンを作りません。** 一覧ページは `-page`、カード部品は `-card`、モーダルは `-dialog` が既に確立しています。

### 3. 実装(実際のCSS移動)はサブエージェントに委託する

**Coordinator自身は Edit/Write でコードを書きません**(このリポジトリの一貫した方針。Coordinatorの仕事は分割方針の確定・diff確認・検証・commit)。**委託先はcodexが使えるなら `codex` skill 経由の `codex exec` を優先し**(2026-08-04 方針)、疎通不良のときだけ sonnet の Agent tool にフォールバックします。

複数ファイルへ切り出す場合でも、**同じ `.astro` を複数エージェントに同時に触らせません**(元ファイルからの削除が衝突します)。1つの `.astro` = 1エージェントにまとめるか、ファイルごとに順番に実行します。

委譲プロンプトに必ず含めること:

- 対象の `.astro` の絶対パスと、新規作成するCSSファイルの絶対パス・そこへ移すセレクタの範囲
- **移動対象のセレクタ・プロパティ・値を一字一句変えないこと。** 整形(インデント・改行位置)程度は可。プロパティの並べ替え、ショートハンド化、値の丸め、トークンへの置き換え、未使用に見えるルールの削除は**すべて禁止**。デザイン調整も禁止(このタスクは純粋な移動)
- 新ファイルの先頭に、対象を1行で説明する短い日本語コメントを入れること。既存ファイルの書き方に揃える(例: `/* /box: モバイル用のポケモン一覧画面。カード本体の見た目は box-card.css に分離する。 */`)
- 元の `.astro` のフロントマターに `import '../../styles/<file>.css';` を追加し(パスの深さは対象ファイルの位置に合わせる。実例: `src/pages/box/index.astro:42` の `import '../../styles/box-page.css';`、`src/components/box-id/MobileTrainingBar.astro:7` の `import '../../styles/box-pokemon-preview.css';`)、埋め込み `<style>` から移した分のルールを削除すること。ブロックが空になったら `<style>` タグごと削除する
- 他のCSSファイルへの依存が要る場合は、テンプレート側で二重にimportせず、CSSファイル先頭の `@import "./xxx.css";` で解決すること(実例: `team-page.css` の `@import "./box-card.css";`)
- **`<style is:global>` にあったルールの扱い**: JSが `document.createElement` 等で動的生成する要素向けのセレクタが `is:global` に置かれているのは、Astroのscoped styleが `data-astro-cid-*` の付いた静的マークアップにしか当たらないためです(→ `.claude/skills/ui/references/pitfalls.md`「Astroのscoped styleはJSで生成した要素に効かない」)。**外部CSSファイルへ移せば素のグローバルCSSになるので、scoped / `is:global` の区別自体が不要になります。** `:global()` を付け足したり、セレクタを書き換えたりする必要はありません
- **`git commit` / `git push` は絶対にしないこと**(commitはCoordinatorが行う)
- 完了後に「作成/変更したファイル一覧」と「移動したセレクタの数・移動しなかったルールがあればその理由」を報告させる

### 4. 検証する(最優先事項)

**このskillで最も重要な工程です。** セレクタの詳細度とカスケード順序が変わって見た目が崩れるリスクがあります。

- **既知の罠: scoped `<style>` は `.foo` に `[data-astro-cid-*]` が付くため実質 (0,2,0) の詳細度を持ち、`global.css` より後ろに注入されます**(→ `pitfalls.md`「`global.css` の指定が Astro の scoped style に詳細度で負ける」)。外部CSSファイル化するとこの属性セレクタ分の詳細度が失われるため、**それまで scoped 側が勝っていた指定が `global.css` 側に負けて見た目が変わる**ことがあります。同詳細度どうしでも、読み込み順が変わることで勝敗が入れ替わります
- 手順:
  1. **切り出し前に `npm run shot` で対象画面を撮っておく**(ライト・ダーク両方、必要なら主要ブレークポイント)。事前撮影を省くと「変わっていない」ことを証明できません
  2. 切り出し後に `npx astro build` が通ることを確認する
  3. **dev serverを再起動してから撮り直す**(→ `pitfalls.md`「Windows側から編集した直後のスクリーンショットは『前のコード』を写している」)。再起動を怠ると直っていない/壊れていないの誤診をします
  4. **前後の画像を Read tool で自分の目で見比べ、1ピクセルも変わっていないことを確認する。** 差分があれば必ず詳細度・カスケード順序の変化を疑う(修正は「値を変えて合わせる」ではなく「なぜ順序が変わったか」を潰す)
  5. 対象がインタラクティブな状態(モーダル展開時・タブ切り替え後・hover/focus)を持つなら、その状態も撮る。埋め込みCSSにはこうした状態のルールが多く含まれます
  6. 撮影に使った `.tmp-shots*` ディレクトリを削除する

```bash
npm run shot -- --page team/<id> --out .tmp-shots-before
# 切り出し + dev server 再起動のあと
npm run shot -- --page team/<id> --out .tmp-shots-after
```

- 共通部品として切り出した場合(`box-card.css` のように複数画面が `@import` するもの)は、**その部品を使う全画面を撮って確認する**。1画面だけ見て判断しません(→ `pitfalls.md`「重複CSSの共通化は『持っていなかった画面』だけを壊す」)

### 5. commit する

**Coordinator が `git commit` します**(`git push` はしない)。切り出したファイル単位でコミットを分けると、見た目が崩れたときの切り戻しが容易です。メッセージには「どの `.astro` から何を `src/styles/<file>.css` へ切り出したか」と「見た目の変更なし」を書きます。

## 参照

- `CLAUDE.md`「スタイル定義」 — このskillが満たそうとしている必須ルール
- `src/styles/box-card.css` — カスタムプロパティでテーマ化した共通カード部品の切り出し例(基底セレクタに `--box-card-*` 一式、子孫が `var()` で参照)
- `src/styles/box-page.css` — 一覧ページ(`/box`)固有のレイアウト。`@import` で `box-card.css` を取り込む例
- `src/styles/box-edit-page.css` — 編集ページ(`/box/[id]`)固有のレイアウト
- `src/styles/box-pokemon-preview.css` — 単体コンポーネント(モバイル編集画面のプレビューバー)の切り出し例
- `src/styles/box-damage-page.css` / `src/styles/box-damage-card.css` — 画面内の独立セクションを2ファイルに分けた例
- `src/styles/team-page.css` — `/team` 一覧ページ。他CSSの `@import` を含む
- `src/styles/global.css` — デザイントークン・共有スタイル(**個別画面のスタイルをここへ移さない**)
- `.claude/skills/ui/references/pitfalls.md` — 詳細度・カスケード・scoped styleの既知の罠、撮影前のdev server再起動
- `.claude/skills/codex/SKILL.md` — 実装委譲の手順(Windowsでは `--sandbox danger-full-access` が必要)
- `.claude/skills/ui/SKILL.md` — 見た目を変える改修はこちら
