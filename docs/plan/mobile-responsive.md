# モバイルページのレスポンシブ設計

状態: **P1・P2 完了 / 未実装**(2026-08-31 作成)

| フェーズ | 状態 |
|---|---|
| P1 現状調査 | ✅ 完了(2026-08-31) |
| P2 設計(本書) | ✅ 完了(2026-08-31) |
| P3 実装 | ⬜ 未着手 |
| P4 検証(スクショ・実測) | ⬜ 未着手 |

---

## 1. 目的

このアプリの画面はすべてモバイル前提で組んである。しかし幅が広がったときの振る舞いが定義されておらず、次の2つが破綻している。

- カードが画面幅に比例して無制限に巨大化する
- 逆に幅900px以上では「モバイル用レイアウトそのもの」が無効になり、固定スクロール領域が失われる

本計画は次の3点を満たす設計を入れる。

1. **6.3インチ端末(CSS幅412px)を基準に、カードサイズの最大値を定義する。**
2. **幅の増加はカードの拡大ではなくグリッド列数の増加で吸収する。** チームカードの6枠グリッドは、ある閾値で `2行×3列` から `1行×6列` に切り替える。
3. **ポケモンプレビューのようにレイアウトが緻密に組まれた要素は伸ばさない。** 背景だけを画面端まで伸ばし、中身は基準幅のまま中央に置く。

---

## 2. 現状調査(実ファイルで確認済み)

### 2.1 レイアウトの土台

- `src/layouts/AppLayout.astro` … `.app-shell > .app-main` のみ。**最大幅の制約は一切ない**(`global.css:1104-1114`)。`.panel-content { max-width: 1080px }`(`global.css:309`)だけが唯一の幅制約だが、モバイル系ページでは使われていない。
- 共通トークン(`global.css:1096-1101`):
  - `--header-height: 0px`(既定。ページ側で上書き)
  - `--bottom-nav-height: 60px`
  - `--list-grid-edge-gap: var(--space-2)` = **8px**(一覧の左右端余白)
- 補助トークン: `--app-header-height: 40px`(`app-header.css:14`)、`--second-header-height: 52px`(`second-header.css:15`)。
- 余白: `--space-1` = 4px、`--space-2` = 8px。

### 2.2 カードグリッドの現状

| グリッド | 定義箇所 | 現状 | 問題 |
|---|---|---|---|
| `/box` ポケモン一覧 `.box-grid` | `box-card.css:20-26` | `repeat(3, minmax(0,1fr))` 固定・`aspect-ratio: 1/1` | 幅に比例して正方形カードが無限に拡大 |
| チームカードの6枠 | 同じ `.box-grid` を再利用(`src/lib/team-card.ts:64` が `className = "box-grid"`) | 3列 → 6枠が2行3列 | 広幅でも 2×3 のまま。カードも無限拡大 |
| チームカード一覧 `.team-grid` | `team-card.css:94-96` | `minmax(0,1fr)` の1列 | 妥当(変更不要) |
| ホームのメニュー `.home-card-grid` | `home-page.css:184-188` | `repeat(3, minmax(0,1fr))` | 幅に比例して拡大 |
| チーム提案アイコン列 | `team-pokemon-tab.css:132-136` | `repeat(6, minmax(0,1fr))` | 幅に比例して拡大 |
| 味方6枠 `.team-mate-grid` | `team-mate-card.css:96-101` | `repeat(6, minmax(0,1fr))` | 同上 |
| `/data` 使用率一覧 | `data-hub-page.css:196-204` | `repeat(auto-fill, minmax(min(100%, var(--data-hub-entry-width)), var(--data-hub-entry-width)))` | **すでに上限つきで可変**。本計画の考え方の先例 |
| `/box/matchup` | `matchup-panel.css:15` | `repeat(auto-fill, minmax(77px,1fr))` | 可変だがセル上限なし |

### 2.3 幅900px以上でモバイルレイアウトが消える(**最重要の既存バグ**)

`@media (width <= 899px)` / `@media (max-width: 899px)` のブロックが、**上限側の対になる定義を持たないまま**「モバイル専用レイアウト」を丸ごと抱えている。かつてデスクトップ2カラム版が存在した名残で、それは現在廃止済み(`/box/[id]` はタブ切り替えの単一レイアウトのみ)。

| ファイル:行 | `<=899px` の中身 | 900px以上での実害 |
|---|---|---|
| `box-pokemon-preview.css:84` | `.mobile-training-ui` を `position: fixed` にする | プレビュー+ナビの固定が外れる |
| `box-damage-page.css:76,107` | `.edit-shell` / `.edit-layout-left` / `.edit-layout-right` の固定スクロール領域 | ダメージ計算画面のスクロール構造が消える |
| `box-damage-card.css:2148` | ダメージカードの狭幅調整 | — |
| `data-page.css:244` | `.box-data-page` の固定配置 | データタブの固定が外れる |
| `team-pokemon-tab.css:169` | `.team-edit-shell` の flex + スクロール構造 | チーム編集画面のスクロール構造が消える |
| `team-data-tab.css:75` | 同上(データタブ) | 同上 |
| `move-picker-dialog.css:375`, `speed-adjust-dialog.css:73` | モーダルの狭幅表示 | **広幅側に対の定義がある可能性が高い。実装時に個別確認する**(一括で外さない) |

→ 列数を可変にする前に、**まずこの899px上限を外す**(モバイルレイアウトを全幅で無条件に適用する)必要がある。先にやらないと、閾値を跨いだ瞬間にレイアウトが二重に壊れる。

### 2.4 緻密に組まれていて「伸ばしてはいけない」要素

- `.pokemon-preview` / `.pokemon-preview-main`(`box-pokemon-preview.css:99-114`)
  - `grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)`(左情報・スプライト・右情報)
  - `height: var(--pokemon-preview-height)` = **176px 固定**(「全項目表示時の実測値で固定」とコメントあり)
  - 背景が2枚重ね: 外枠 `.pokemon-preview` = `--color-surface`、内側 `.pokemon-preview-main` = `--color-bg`。**中身に max-width を掛けるだけだと内側の背景色が中央だけ帯状に残る**ので、背景の持ち替えが要る。
- 画面端に固定される chrome 類(いずれも `left:0; right:0`):
  - `.app-bottom-nav`(`app-bottom-nav.css:46`、5項目の flex)
  - `.app-header`(sticky、タブレール)/ `.second-header`(sticky)
  - `.box-content`(`box-page.css:39`)、`.edit-layout-left/right`、`.box-data-page`
  - `.floating-list-add-button`(`floating-list-controls.css:50`、`right:` がビューポート右端基準)

---

## 3. 設計

### 3.1 基準寸法(6.3インチ)— カードの最大サイズはグリッドごとに別

6.3インチ級のCSS論理幅は **402〜412px**(iPhone 16 Pro = 402、Pixel 9/10 Pro = 412)。**設計基準幅を 412px** とし、402 / 390(小型端末)でも破綻しないことを条件にする。

**単一の `--card-size-max` を全グリッドで共有してはいけない。** 基準列数も列間も1枚あたりの情報量も違うため、基準幅412pxでの実効サイズがそもそも別の値になる。

| グリッド | 基準列数 | 左右余白 | 列間 | 412pxでの一辺 | 採用する上限トークン |
|---|---|---|---|---|---|
| `.box-grid`(`/box` 一覧、チームカードの6枠) | 3 | 8px×2 | `--space-1` 4px | `(412−16−8)/3` = **129.33px** | `--box-card-size-max: 130px` |
| `.team-overview-thumb-grid`(`/team/[id]` ポケモンタブ) | 2 | 8px×2 | `--space-2` 8px | `(412−16−8)/2` = **194px** | `--team-overview-card-size-max: 194px` |

- 3列カード(`.box-card`)は名前・性格/努力値1行・技4行・持ち物バッジ。
- 2列カード(`.team-overview-preview-card`)は名前・タイプ・持ち物・技4行に加えて **6列×3段の実数値表**(`team-pokemon-card.css:316-320`)まで載る。**130pxでは実数値表が成立しない**し、逆に3列カードを194pxにすると基準幅で1.5列分になって破綻する。

つまり「カードサイズの最大値」は**グリッドの系統ごとに1つずつ**持つ。以下ではこの2つを「3列系」「2列系」と呼ぶ。

### 3.2 導入するトークン(`global.css` の `:root`)

```css
:root {
  /* ── 3列系: /box 一覧、チームカードの6枠 ── */
  --box-card-size-max: 130px;   /* 6.3インチ(412px)で3列に並べたときの実測値 */
  --box-grid-columns: 3;        /* §3.3 の @media ラダーだけが書き換える */

  /* ── 2列系: /team/[id] ポケモンタブ ── */
  --team-overview-card-size-max: 194px; /* 同じく412pxで2列に並べたときの実測値 */
  --team-overview-grid-columns: 2;      /* §3.4 の @media ラダーだけが書き換える */

  /* 全幅chromeの中身を合わせる「本文帯」。既定は3列系の帯 */
  --content-band-max-width: calc(
    var(--box-grid-columns) * var(--box-card-size-max)
    + (var(--box-grid-columns) - 1) * var(--space-1)
  );

  --precision-band-max-width: 480px; /* 内部レイアウトを伸ばしてはいけない要素(ポケモンプレビュー等)の上限 */
}

/* 主グリッドが2列系のページは、chromeの帯もそちらに合わせる */
body.team-edit-page {
  --content-band-max-width: calc(
    var(--team-overview-grid-columns) * var(--team-overview-card-size-max)
    + (var(--team-overview-grid-columns) - 1) * var(--space-2)
  );
}
```

### 3.3 3列系の列数ラダー

列数 N でカードがちょうど上限130pxになる幅は `N×130 + (N−1)×4 + 16`。その値**以上**で N に上げる(手前で上げるとカードが上限より小さく縮む)。

| 列数 | 上限到達幅 | 採用ブレークポイント | 帯幅 |
|---|---|---|---|
| 3 | 414px | (既定) | 398px |
| 4 | 548px | `min-width: 420px` | 532px |
| 5 | 682px | `min-width: 560px` | 666px |
| 6 | 816px | `min-width: 690px` | 800px |
| 7 | 950px | `min-width: 820px` | 934px |
| 8 | 1084px | `min-width: 960px` | 1068px |
| 8(据え置き) | — | 1090px 以上は増やさず中央寄せ | 1068px |

```css
@media (min-width: 420px) { :root { --box-grid-columns: 4; } }
@media (min-width: 560px) { :root { --box-grid-columns: 5; } }
@media (min-width: 690px) { :root { --box-grid-columns: 6; } }
@media (min-width: 820px) { :root { --box-grid-columns: 7; } }
@media (min-width: 960px) { :root { --box-grid-columns: 8; } }
```

上限は8列(帯幅1068px)。それ以上の幅では帯を中央に置き、左右は背景のままにする(→ §6-1 で要確認)。

### 3.4 2列系の列数ラダー

同じ考え方を上限194px・列間8pxで解く。上限到達幅は `N×194 + (N−1)×8 + 16`。

**このグリッドは6枠しか持たないので、列数は 6 の約数だけを使う: `2 → 3 → 6`(ユーザー確定、2026-08-31)。** 4列・5列は 4+2 / 5+1 に割れて行が揃わないため採用しない。

| 列数 | 枠の並び | 上限到達幅 | 採用ブレークポイント | 帯幅 |
|---|---|---|---|---|
| 2 | 2+2+2(3行) | 412px(= 基準幅そのもの) | (既定) | 396px |
| 3 | 3+3(2行) | 614px | `min-width: 620px` | 594px |
| 6 | 6(1行) | 1220px | `min-width: 1220px` | 1204px |
| 6(据え置き) | — | — | 1220px 以上は増やさず中央寄せ | 1204px |

```css
/* 6枠グリッドなので列数は6の約数だけを使う(4列=4+2、5列=5+1 は行が揃わない) */
@media (min-width: 620px)  { :root { --team-overview-grid-columns: 3; } }
@media (min-width: 1220px) { :root { --team-overview-grid-columns: 6; } }
```

- **1220px の根拠**: `6×194 + 5×8 + 16 = 1220px`。この幅未満で6列にすると、カードが上限194pxより小さく縮む(例: 820pxなら128px)。「幅の増加をカードの拡大ではなく列数で吸収する」原則の裏返しとして、**列数を増やすために縮めることもしない**。
- 620〜1219px は3列(3+3)で、余った幅は `justify-content: center` で左右に逃がす。この帯域が広いのは、2列系カードの上限が194pxと大きいことの当然の帰結。
- `/team` 一覧のチームカード6枠(§3.6)は上限130pxの3列系なので **820px** で1×6になる。**同じ「6枠が1行になる」挙動でも閾値が違う**(1220px と 820px)。これはカードの上限サイズが違う以上正しい差であり、揃えようとして片方を縮めないこと。

### 3.5 グリッド本体の書き換え

```css
/* 3列系 */
.box-grid {
  display: grid;
  grid-template-columns: repeat(var(--box-grid-columns), minmax(0, var(--box-card-size-max)));
  justify-content: center;   /* 上限に張り付いたときの余りを左右へ均等に逃がす */
  gap: var(--box-card-grid-gap);
  align-items: stretch;
}

/* 2列系 */
.team-overview-thumb-grid {
  grid-template-columns: repeat(var(--team-overview-grid-columns), minmax(0, var(--team-overview-card-size-max)));
  justify-content: center;
}
```

- `minmax(0, <上限>)` は「空きがあれば上限まで伸び、足りなければ0まで縮む」。基準幅412pxでは3列系が129.33px、2列系が194pxになり、どちらもはみ出さない。
- **`repeat(auto-fill, ...)` を使ってはいけない。** `auto-fill` は列数をトラックの max(固定値)から逆算するため、幅402pxの端末で3列系が `floor((386+4)/134) = 2列` になり、**基準より狭い端末で3列が2列に落ちる**。基準幅より下を壊さない書き方は「列数を明示する @media ラダー」しかない。この理由をCSSのコメントに残すこと(将来 auto-fill へ「簡素化」されるのを防ぐため)。
- `.team-overview-thumb-grid` の `margin-inline: calc(var(--space-5) * -1)` と `padding-inline` は現状のまま残す(親の余白を打ち消して画面端まで使うための既存実装)。`justify-content: center` はその内側で効く。

### 3.6 チームカードの 2×3 → 1×6

チームカードの6枠は `.box-grid` を再利用している(`src/lib/team-card.ts:64`)ので、**ルートのラダーを継承させず、そのスコープで `--box-grid-columns` を上書きする**。

```css
/* チームカードの6枠は3列(2行×3列)で固定し、6枠が上限サイズのまま1行に収まる幅で6列(1行)へ切り替える */
.team-grid .card-team .box-grid { --box-grid-columns: 3; }
@media (min-width: 820px) {
  .team-grid .card-team .box-grid { --box-grid-columns: 6; }
}
```

- 閾値 **820px** の根拠: `6×130 + 5×4 + 16 = 816px`。この幅以上なら6枚を最大サイズのまま1行に置ける。手前で切り替えるとカードが130pxより縮む。
- `.team-grid` 自体は1列のまま(1チーム=1行)。カード内容が中央の帯に収まり、左右は背景になる。
- DOM(`renderTeamMemberGrid`)は変更しない。CSSだけで切り替える。
- 同種の扱いが要る6枠系: `.team-mate-grid`(`team-mate-card.css:96`)、`.team-formation-mobile__suggest-icons`(`team-pokemon-tab.css:132`)。これらは6枠固定なのでセル上限サイズを別途決め、`justify-content: center` で余りを逃がす。

### 3.7 「背景だけ伸ばす」パターン

全幅で固定/stickyされる要素は **外枠 = 全幅の背景・境界線 / 内側 = 帯幅で中央寄せ** の2層に分ける。

```css
/* 汎用: 全幅chromeの中身を本文帯に揃える */
.app-bottom-nav-list,
.app-header の内側ラッパ,
.second-header の内側ラッパ {
  max-width: var(--content-band-max-width);
  margin-inline: auto;
}
```

対象と個別の注意:

1. **`.pokemon-preview`(最優先・最も壊れやすい)**
   - `.pokemon-preview-main` に `max-width: min(var(--content-band-max-width), var(--precision-band-max-width)); margin-inline: auto;` を入れる。
   - **背景の持ち替えが必須**: 現状 `--pokemon-preview-main-background`(`--color-bg`)は内側要素が持っているため、中身を絞ると中央だけ色が変わる。`.pokemon-preview`(外枠)の `background` を `--pokemon-preview-main-background` に変え、`.pokemon-preview-main` を `background: transparent` にする。`--pokemon-preview-background`(`--color-surface`)が実際に見えている面かどうかを、変更前にスクショで確認する(`overflow:hidden` + 高さ176px固定のため、見えていない可能性がある)。
   - `--pokemon-preview-height: 176px` と内部グリッドの比率は触らない(「伸ばさない」が要件)。
2. **`.app-bottom-nav`** — バー(背景+上境界線)は全幅のまま、`.app-bottom-nav-list` を帯幅で中央寄せ。
3. **`.app-header` / `.second-header`** — 帯の背景は全幅、タブレールを帯幅で中央寄せ。
4. **`.box-content` / `.edit-layout-left` / `.edit-layout-right` / `.box-data-page .box-data-main`** — `position: fixed; left:0; right:0` はそのまま(全幅の背景とスクロール領域を保つ)。中身のグリッドが `justify-content: center` で中央に寄るので、追加の max-width は不要。
5. **`.floating-list-add-button`** — 現在 `right: var(--floating-list-controls-edge-offset)` でビューポート右端基準。広幅で本文帯から大きく離れて浮くため、帯の右端基準に変える:

   ```css
   right: max(
     var(--floating-list-controls-edge-offset),
     calc((100vw - var(--content-band-max-width)) / 2 + var(--floating-list-controls-edge-offset))
   );
   ```
6. **モーダル / ボトムシート** — `move-picker-dialog.css` 等はすでに `max-width` を持つ(例: `--move-picker-dialog-max-width: 42rem`)。**今回は触らない。** ただし `stat-adjust-sheet.css`(`position: fixed` のボトムシート)を帯幅に合わせるかは実装時に確認する。

### 3.8 基準幅より狭い側(< 402px)

本計画は上方向の設計だが、下方向の既存方針を壊さないこと。

- **タップ対象を縮めて幅に合わせない。** ボタン・ステッパーは `max-content` を下限にし、あふれる場合は横スクロールで逃がす(既存の合意事項)。
- 上限トークンは上限であって下限ではないので、360px幅では3列系が113px・2列系が168pxまで縮む。これは既存挙動と同じ。2列系はここで実数値表(6列)が最も詰まるので、360pxでの可読性を検証対象に含める(§5)。

---

## 4. 実装手順(この順で行う)

| # | 作業 | 対象 | 備考 |
|---|---|---|---|
| 1 | `@media (width <= 899px)` の上限撤廃 | `box-pokemon-preview.css:84`, `box-damage-page.css:76,107`, `box-damage-card.css:2148`, `data-page.css:244`, `team-pokemon-tab.css:169`, `team-data-tab.css:75` | ブロックを外して無条件ルールにする。**ダイアログ2件(`move-picker-dialog.css:375`, `speed-adjust-dialog.css:73`)は対の広幅定義があるか個別確認**してから判断 |
| 2 | トークン + 2本のラダーの追加 | `global.css`(`:root` の「8. サイズ」節と共通レイアウト節) | §3.2 / §3.3 / §3.4。コメントで基準412px・**上限をグリッドごとに分ける理由**・auto-fill禁止理由を明記 |
| 3 | 3列系の列数可変化 | `box-card.css:20-26` | §3.5 |
| 4 | 2列系の列数可変化 | `team-pokemon-card.css:6-17` | §3.5。`margin-inline`/`padding-inline` は現状維持 |
| 5 | チーム6枠の 2×3 → 1×6 | `team-card.css`(`.team-grid .card-team .box-grid`) | §3.6 |
| 6 | その他の固定列グリッド | `home-page.css:184`, `team-mate-card.css:96`, `team-pokemon-tab.css:132`, `matchup-panel.css:15` | セル上限 + 中央寄せ |
| 7 | 背景だけ伸ばす対応 | `box-pokemon-preview.css`, `app-bottom-nav.css`, `app-header.css`, `second-header.css`, `floating-list-controls.css` | §3.7。プレビューの背景持ち替えは単独コミットに切ると差し戻しやすい |
| 8 | 検証 | — | §5 |

**スタイルはすべて対象ごとのCSSファイルに置く**(ルート `CLAUDE.md`「スタイル定義」)。共通トークンとラダーだけ `global.css`。テンプレートの `style` 属性・新規の分散 `<style>` は追加しない。

各ステップ完了時にCoordinatorが `git commit` する(`.tmp-*` の消し忘れ確認も同時に行う)。

---

## 5. 検証(受け入れ条件)

`npm run shot` でライト/ダーク両方を撮る(`--out .tmp-shots-responsive`)。

対象幅: **360 / 390 / 412(基準) / 430 / 560 / 620 / 690 / 820 / 960 / 1220 / 1280 / 1920**
(2本のラダーの境界 420/560/690/820/960 と 620/1220 の**両方**を跨ぐように取る。境界の直前・直後の1px違いも1組は撮る)

対象ページ: `/`(ホーム)、`/box`、`/box/<id>`(育成・ダメージ・データの各タブ)、`/team`、`/team/<id>`(ポケモン・編成・データ)、`/data`、`/search`

合格条件:

1. **412px の見た目が現状と1pxも変わらない**(既存のモバイル表示を回帰させない)。これが最優先。
2. どの幅でも `.box-grid .box-card` の一辺が **130px を超えない**、かつ `.team-overview-thumb-grid` のカードの一辺が **194px を超えない**(`getBoundingClientRect()` の実測で確認。目視では判定しない)。**2つのグリッドを別々に測ること**(片方だけ測ると上限の取り違えに気づけない)。
3. 360px で3列系は3列・2列系は2列を維持し、横スクロール(`document.scrollingElement.scrollWidth > clientWidth`)が発生しない。2列系カードの6列実数値表が欠落・重なりを起こさない。
4. `/team` 一覧のチームカード6枠(3列系)は 820px 以上で1行、819px では2行3列。
5. `/team/[id]` ポケモンタブ(2列系)の6枠は **2+2+2 → 3+3 → 6** とだけ遷移し、**4+2 や 5+1 の割れ方がどの幅でも現れない**(619/620px と 1219/1220px の前後で実測)。
6. 900px 前後で**レイアウト構造が変化しない**(§2.3 の破綻が解消されている)。
7. ポケモンプレビューの内部レイアウトがどの幅でも同一(高さ176px、3カラムの比率が変わらない)。背景は画面端まで届いている。
8. コンソールエラーなし。

**既知の撮影アーティファクト**: `--clip` 対象がビューポート高さを超えると下部が写らない。グリッド全体を撮るときは `--size <幅>x3000` のように高さを十分取る(`.claude/skills/ui/references/pitfalls.md`)。

---

## 6. 実装前にユーザーへ確認する点

1. **最大列数を8(帯幅1068px)で止めるか。** それ以上の幅では左右が背景になる。「PCでも画面いっぱいにカードを並べたい」ならラダーを延長して上限を外す。
2. **ポケモンプレビューの上限 `--precision-band-max-width: 480px` の妥当性。** 基準412pxより少し余裕を持たせる想定。「基準幅から一切広げない」なら412pxにする。
3. **`/data` の使用率一覧・すばやさ早見表**(`speed-chart-table.css` が独自に 1199px / 767px のブレークポイントを持つ)を本ラダーへ統合するか、独自のまま残すか。表形式でカードグリッドとは性質が違うため、**本計画では対象外**としている。
4. ~~2列系の打ち止め列数~~ → **確定済み(2026-08-31)**: `2 → 3 → 6`(6の約数のみ。§3.4)。
5. **2列系カードの上限194pxの妥当性。** 基準幅412pxの実測値をそのまま採ったが、実数値表が載る密度の高いカードなので「もう少し大きくしたい」余地はある。この値は 3列/6列への切替幅(620px / 1220px)を直接動かすので、変えるなら早い段階で決めたい。まず194pxで撮ってから判断する。
