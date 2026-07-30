# UI改善ラウンド 35

[← 索引](../ui_plan.md)

## ラウンド35 の要件(2026-07-30 ユーザー指示第17弾)

**ラウンド34と同じworktree `poke-commons-ui-round-34`(ブランチ `ui/round-34`)で続けて作業する。** ラウンド34がまだ`main`にコミット/マージされていないため、新規worktreeを切ると34の変更が入らない。今回の指示は34の変更(アイテム/テラスアイコン拡大、特性/アイテムの左右寄せ等)を前提にしているため、同じworktreeで継続するのが正しい。

### ユーザーの言葉(原文)

> ボックス画面: アイテムアイコンを-10%, テラスタルアイコンを-20%。アイテムアイコンのあるY位置に、アイテムとテラスタルのアイコンを横並びに配置して、ニックネーム領域と干渉しないようにする / 特性は左半分、アイテムは右半分の領域でそれぞれ中央揃え配置 / 技の背景色を少し濃くする
>
> 個体編集画面 左サイド: アイテムアイコン+10% / 努力値の"残りxx"の中心位置をスピンボックスの中心と揃える
>
> 個体編集画面 ダメージカード: 個別の技カードの結果表示を囲うフレームを削除
>
> 個体編集画面 右サイド: 攻撃側・防御側のUIの文字サイズを少しだけ大きくする

(共通・ヘッダーは指示なし)

### 35-B1: アイテムアイコン-10%・テラスタルアイコン-20%、横並び配置

`src/pages/box/index.astro`(465〜490行目、`.card-badge-row`/`.card-item-badge`/`.card-tera-badge`。ラウンド34 34-B4で item=40px/tera=30px に拡大済み)。
- `.card-item-badge`: 40px → **36px**(40×0.9)
- `.card-tera-badge`: 30px → **24px**(30×0.8)
- `.card-badge-row`(465〜474行目)の `flex-direction: column`(アイテム上・テラス下の縦積み)を **`row`**(横並び)に変更する。現在は `top: 60px` で縦に積むぶん高さが伸び(アイテム40px+gap+テラス30px=約73px、top:60pxを足すと下端が約133px相当まで達する)、カード名(「ニックネーム領域」=`.card-body`/`.card-name`)に近づきすぎる/重なる懸念があった。横並びにすることで縦の専有幅が最大アイコン高さ(36px)だけになり、`top: 60px` はそのまま維持してよい(Y位置は変えず、並び方だけ変える、というユーザー指示どおり)。
- `gap: 0.2rem` は横方向の間隔として維持でよいか実測して確認する。
- 変更後、実測(`getBoundingClientRect()`)で `.card-badge-row` の下端が `.card-body`(名前行)の上端と重ならないこと、`.card-actions`(右上のボタン)と重ならないことを確認する。狭幅(480px以下)側の個別上書き(現在16px/16px、830行目付近)も同じ横並びに揃え、同様に重なりが無いか確認する。

### 35-B2: 特性は左半分・アイテムは右半分でそれぞれ中央揃え

`src/pages/box/index.astro`(674〜675行目付近、`.card-item-row` 内。ラウンド34 34-B5で右寄せ/左寄せに入れ替えたばかり)。
```css
.box-grid .card-pokemon .card-ability-name { text-align: right; } /* 34-B5で設定 */
.box-grid .card-pokemon .card-item-name { text-align: left; }     /* 34-B5で設定 */
```
🔴 **これは34-B5の具体的な値を上書きするもの(方向性は継続、寄せ方だけ変える)。** 「特性名は右寄せ・アイテム名は左寄せで中央に寄る配置」(34-B5)から「特性は左半分の中で中央揃え・アイテムは右半分の中で中央揃え」(35-B2)へ変更する。両方とも `text-align: center` にする(`.card-ability-name`/`.card-item-name` は既にそれぞれ左右の列に`flex:1 1 0`で分かれているため、`text-align:center`だけで各半分の中央に来る)。34-B5のコメントは「35-B2により中央揃えに変更」と追記して経緯を残すこと(削除しない)。

### 35-B3: 技の背景色を少し濃くする

`src/pages/box/index.astro` の `applyMoveChipTypeColors`(1210〜1221行目付近):
```js
el.style.background = `color-mix(in srgb, ${color} 10%, transparent)`;
```
現在 `10%` になっている混色比率を少し上げる(「少し濃く」なので大幅な変更ではない。12〜14%程度から試すこと)。
⚠️ **ラウンド21(21-B3)のコメントに「15〜20%では一部タイプがダークモードで`--color-text-muted`とのコントラストがWCAG AA(4.5:1)を割ることを計算で確認したため10%を採用した」という記録がある。** 濃くする値を決めたら、**19タイプ全てについてライト・ダーク両方で `.card-move-chip` の文字色(`--color-text-muted`)とのコントラスト比を計算し直し、どのタイプもAAを下回らないことを確認してから確定すること**(pitfalls.mdの「コントラストは計算して確かめる」を踏襲)。割るタイプがあれば、そのタイプだけ据え置く、あるいは比率を少し下げるなど調整する。

---

### 35-L1: アイテムアイコン+10%

`src/components/box-id/LeftPanel.astro`(1348行目付近、`.item-image-badge`。ラウンド34 34-L4で20px→30pxに拡大済み)。
- `.item-image-badge`: 30px → **33px**(30×1.1)。共有トークン `--icon-size-sm` は変更しない(このバッジだけの固定値上書き、これまでと同じやり方)。
- 拡大後、隣接する `.item-name-display` の `max-width` や `.top-block-icon-corner` との重なりが無いか実測すること(前ラウンドと同じ確認手順)。

### 35-L2: 努力値の「残りN」をスピンボックス(努力値数値入力)の中心に揃える

`LeftPanel.astro`(300〜324行目のマークアップ、458〜496行目のCSS)。
- グリッド列構成(`.stat-table-header`/`.stat-row` 共通): `grid-template-columns: 5rem 2.6rem minmax(0, 1fr) 3.2rem 3.4rem`。4列目(3.2rem)が努力値の数値入力(「スピンボックス」、`<input type="number">`)の列。
- 現状 `.stat-table-header-ev-remaining`(この列単独のヘッダ、「残り18」表示)は `text-align: right`(490〜492行目)。これは**ラウンド23(23-L5)/ラウンド24(24-L4)で意図的に決めた値**(「残りNの右端=努力値数値列の右端」に揃える設計、コメントに経緯あり)。
🔴 **今回のユーザー指示によりこれを撤回し、`text-align: center` に変更する。** 実際の数値入力(`.stat-row` 4列目のinput、23-L5「ステータス関連の数値をすべて中央揃え」によりtext-align:centerのはず)の中心と、ヘッダ「残りN」の中心が一致するようにする。
- 変更後、`getBoundingClientRect()` で入力欄の中心x座標と「残りN」テキストの中心x座標を実測し、一致することを確認する。

---

### 35-D1: 個別の技カードの結果表示を囲うフレームを削除

`src/components/box-id/DamageCalcSection.astro`(1377〜1405行目、`#opponent-notes-section .damage-column-result`)。
- このセレクタは共有クラス `.severity-bar`(`src/styles/global.css` 966〜973行目)を基底に持ち、`border-radius`・`padding`・`border-left: 4px solid`・`background` による「枠(フレーム)」を描画している(ラウンド26 26-D2で背景色は固定灰色に上書き済みだが、枠自体は残っている)。
- **`global.css` の `.severity-bar` 自体は編集しないこと**(`.damage-row-total-result`(累計結果、こちらは今回対象外)や他ページも参照する共有クラス)。
- 代わりに `#opponent-notes-section .damage-column-result`(ページscoped、既存の上書きセレクタ)に `background: none; border-left: none; padding: 0;`(または同等)を追加し、この個別結果表示だけを平文的な見た目(枠なし)にする。`border-radius` も枠の一部として無効化するか検討する(背景が無ければ視覚的影響は無いはずだが、念のため確認する)。
- **`margin: var(--space-3) 0`(`.severity-bar` 由来)は枠ではなく行間の余白なので、消してよいか実測して判断すること**(消すと技カード最下段のレイアウトが詰まりすぎないか確認する)。
- 太字の判定文言(`.damage-result-verdict`)・詳細数値(`.damage-result-detail`)のフォントサイズ・太さは変更しない(枠だけを取り除く)。
- 累計結果側(`.damage-row-total-result`、909〜930行目)は**このラウンドの対象外**、変更しないこと。

### 35-R1: 攻撃側・防御側UIの文字サイズを少しだけ大きくする

`DamageCalcSection.astro` の `#damage-detail-panel-body` 系スタイルのうち、**攻撃側・防御側セクション(`.damage-detail-side` 配下)に限定**して対象にする(天候・フィールド行は対象外)。現状の主なfont-size(実測・grep済み):
- `.damage-detail-side-heading-row .damage-detail-section-heading`(見出し文字、1593行目付近): `0.75rem`
- ランク入力・状態異常・テラスタル等のチップ/トグルボタン類(`.damage-detail-chip-row` 配下のボタン、`.damage-detail-rank-input` 等): 複数箇所に `0.76rem`〜`0.82rem` 程度が散在(この節に集約している値をgrepして洗い出すこと)

`.damage-detail-side` 配下の各font-sizeを一律ではなく、**それぞれ現在値から少し(0.02〜0.05rem程度)引き上げる**。12px下限を割らないこと、天候/フィールド側(`.damage-detail-field-row` 系)の値とは無関係に据え置くこと(このラウンドの対象は攻撃側・防御側のみ)。変更後、`--scale 2`程度のスクリーンショットで折り返し・はみ出しが起きていないか確認する。

## 維持すべき点(壊さないこと)

- **12px下限**(20-G3)・**アイコン規格20px**(共有トークン `--icon-size-sm` は変更しない。35-B1/35-L1は個別要素の固定値上書きで対応)。
- **`global.css` は編集しない**(35-D1、`.severity-bar` は共有クラス)。
- **育成ルール(IV=31固定 / 努力値0〜32スケール / Lv50固定)は仕様。**
- 技チップの背景色(35-B3)は**19タイプ全てのコントラスト再計算をしてから確定する**こと。

## この指示で撤回・上書きされる過去の判断

- **34-B5(特性右寄せ・アイテム左寄せ)を35-B2で上書き**(それぞれの半分の中央揃えに変更。方向性=「中央に寄せる」は継続、具体的な寄せ方だけを変更)。
- **23-L5/24-L4(「残りN」を意図的に右寄せのまま据え置く判断)を35-L2で撤回**(スピンボックスの中心に揃える)。

## ラウンド35 の実施結果(2026-07-30)

3体のsonnetサブエージェントに実装させ(左サイド担当は1回目がAgent委任のみで実装0件だったため再実行)、Coordinatorが実測・スクリーンショット・build・テストで検証した。**全7件、実装・検証済み。**

### 実施済み

| 項目 | 対象 | 結果 |
|---|---|---|
| 35-B1 | `src/pages/box/index.astro` | `.card-badge-row`をcolumn→rowに変更、アイテム40→36px(-10%)・テラス30→24px(-20%)。実測でカード名・アクションボタンと重ならないことを確認(1920px/480px/390px幅) |
| 35-B2 | 同上 | 特性名・アイテム名をそれぞれの半分内で`text-align: center`に変更(34-B5を上書き) |
| 35-B3 | 同上 | 技チップ背景のcolor-mix比率を10%→**11%**に変更。19タイプ全てのWCAG AAコントラストを計算し直し、限界値(でんき11.42%・こおり11.49%)を踏まえて11%を採用(ライト最悪4.81:1・ダーク最悪4.55:1、いずれもAA達成) |
| 35-L1 | `src/components/box-id/LeftPanel.astro` | `.item-image-badge` 30→33px(+10%)。重なりなしを実測確認 |
| 35-L2 | 同上 | `.stat-table-header-ev-remaining`を`text-align: right`→`center`に変更(23-L5/24-L4を撤回)。実測差1.6px(既存ヘッダpadding由来の構造的な差、視覚的には無視できるレベル) |
| 35-D1 | `src/components/box-id/DamageCalcSection.astro` | `#opponent-notes-section .damage-column-result`の`.severity-bar`由来の枠(background/border-left/padding)を打ち消し、個別結果表示を枠なしに。累計結果側は変更なし |
| 35-R1 | 同上 | `.damage-detail-side`配下(見出し/ランク/状態異常/チップ類)のfont-sizeを0.75rem→0.78rem等に引き上げ。天候・フィールド側は据え置き |

**Coordinator最終検証**: `npx astro build`成功・`npm test`298件全pass・`git stash list`空(2エージェントが検証中に`git stash`を使ったが、いずれも`stash pop`で復元しstash listは空)・フィクスチャ4件(species_name)が基準どおりであることを確認。

### 積み残し

- なし。

### 運用上の教訓

- 🔴 **左サイド担当エージェントの1回目の実行が、実際にはファイルを一切編集せず、ネストしたAgent呼び出しをテキストとして返しただけだった**(`tool_uses: 0`)。Coordinatorが`git diff --stat`で変更行数を確認し、対象のCSS値(`.item-image-badge`のwidth、`.stat-table-header-ev-remaining`のtext-align)が実際には変わっていないことを発見して再実行した。**「エージェントが完了報告を返した」ことは「実装した」ことの証明にならない。** `pitfalls.md`に追記すること。
- 🔴 **2体のエージェントが検証中に`git stash`を使った**(既に「使わないこと」と実装者テンプレートに明記済みのルール違反)。いずれも直後に`stash pop`で復元し実害は無かったが、再発している。
