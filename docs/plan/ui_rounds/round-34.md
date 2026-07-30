# UI改善ラウンド 34

[← 索引](../ui_plan.md)

## ラウンド34 の要件(2026-07-30 ユーザー指示第16弾)

**作業は worktree `poke-commons-ui-round-34`(ブランチ `ui/round-34`、`main` の `25e396e` から分岐)で行う。**
⚠️ `EnterWorktree` ツールは既定(`fresh`)だと `origin/main` から分岐するが、このリポジトリは `origin/main` がローカルの `main` より大幅に古い(box/team/share等のページが存在しない状態)。**このラウンドではツール版worktreeを一度削除し、`git worktree add ../poke-commons-ui-round-34 -b ui/round-34`(ローカルHEAD基準)で作り直した。** 次回以降も同じ罠に注意すること(→ `pitfalls.md` に追記予定)。

対象ファイル:
- `src/pages/box/index.astro`(ボックス画面)
- `src/components/box-id/LeftPanel.astro`(個体編集 左サイド)
- `src/components/box-id/DamageCalcSection.astro` + `src/lib/box-id/damage-calc.ts`(個体編集 ダメージカード、個体編集画面共通のうちアイテム/技の選択ボックス)
- `src/components/box-id/RightPanel.astro` + `src/lib/box-id/right-panel.ts`(個体編集 右サイド)
- `src/lib/box-id/left-panel.ts`(個体編集 左サイドの種族名/特性選択ロジック)

検証に使うフィクスチャ(→ round-32.md 一覧参照): `c8680844-dd43-42a4-bdf1-f3de11fe3267`(メガリザードンX、ダメージ計算カード4枚。**このラウンドの主な検証対象**)。

### ユーザーの言葉(原文)

> ボックス画面: お気に入りのみ表示 -> お気に入り / 並べ替えというラベルを削除し、リストボックスの文字の左側にソートアイコンを配置 / ホバー時のステータス表記から"実数値:"を削除し、性格補正はA200+, C135-のように数値の後に+/-をつける / アイテムアイコンを2倍、テラスタルアイコンを1.5倍する / 特性名は右寄せ、アイテム名は左寄せにして、中央に寄るように配置する
>
> 個体編集画面 共通: 種族名、特性、アイテム、技の選択ボックスは一度選択した状態で再クリックしても、フィルタが適用されており他の選択肢が表示されない。フィルタ結果だけ表示するのではなく、フィルタ結果を最上位に表示するようにしたい / ポケモンが選択されている状態での、特性選択ボックスの"特性を選択"という候補を削除
>
> 個体編集画面 左サイド: ポケモンアイコンを+10% / 技ボックス間の縦横スペースを等間隔にして少し詰める。その後、種族名〜テラスタイプの入力ボックス間の縦余白も、技どうしの縦余白と同じになるように詰める / 性格補正の下三角は強調表示されるが上三角が未対応 / アイテムの画像サイズを+50%して、文字は入力欄と同じ書式にする
>
> 個体編集画面 ダメージカード: アイテムアイコンのサイズを-10% / テラスタルの選択ボックスを左サイドと揃える / カード全体の削除ボタンのある最右領域に、技を追加ボタンが干渉している。最右領域をカード高さ全体に定義する / 累計結果の上にある薄い点線の横棒を削除
>
> 個体編集画面 右サイド: ヘッダーの下に横棒が二重になっているので1本に減らす / 防御側と天候の間にも横棒を挿入

（共通・ヘッダーは指示なし）

### 34-B1: 「お気に入りのみ表示」→「お気に入り」

`src/pages/box/index.astro`(893行目付近、`#favorite-filter-toggle`)の可視テキストを変更する。
```astro
<button type="button" id="favorite-filter-toggle" class="favorite-filter-toggle" data-active="false" aria-pressed="false">
	<span aria-hidden="true">★</span> お気に入りのみ表示
</button>
```
→ `お気に入り` に短縮する。`aria-pressed` で状態は伝わるので `aria-label` の追加は不要(現状どおり視覚テキストのみ変更)。

### 34-B2: 「並べ替え」ラベル削除 + ソートアイコンをselectの左側に配置

`src/pages/box/index.astro`(893〜900行目、`.toolbar-sort`):
```astro
<div class="toolbar-item toolbar-sort">
	<label class="field-label" for="sort-select">並べ替え</label>
	<select id="sort-select" class="field-control">
```
- `<label>` を削除(DOM削除でよい。並べ替えの意味は残るアイコンで伝える。`aria-label="並べ替え"` を `<select>` に付けてラベル削除によるアクセシビリティ低下を防ぐこと)。
- ソートアイコン(⇅や矢印のSVG)を検索欄と同じ手法(`.search-input-wrap .search-icon` の `position:absolute; left:...; pointer-events:none` + `input`側`padding-left`)で `<select>` の左に重ねる。`<select>` はネイティブ矢印(`appearance:none` + カスタム矢印、global.css)を右に持つ想定なので、左paddingだけ追加すればよい。アイコンはこのプロジェクトにある並べ替え/ソート系の既存アイコンが無ければ新規SVG(既存の検索アイコンと同じ線画トーン、`stroke-width 2.2`)を1つ起こす。

### 34-B3: ホバー時のステータス表記の書式変更

`src/pages/box/index.astro` の `buildStatSummary` / `applyCardTooltip`(1069〜1084行目付近)。
```js
function buildStatSummary(statValueEls) {
	...
	return STAT_LABELS.map((label, i) => {
		const mark = valueEl.dataset.mod === "up" ? "▲" : valueEl.dataset.mod === "down" ? "▼" : "";
		return `${label}${valueEl.textContent}${mark}`;
	}).join(" ");
}
function applyCardTooltip(card, statValueEls, memo) {
	const lines = [];
	const statSummary = buildStatSummary(statValueEls);
	if (statSummary) lines.push(`実数値: ${statSummary}`);
	...
}
```
- `applyCardTooltip`: `実数値: ${statSummary}` の `実数値: ` プレフィックスを削除し、`statSummary` の行をそのまま push する。
- `buildStatSummary`: `mark` を `"▲"/"▼"` から `"+"/"-"` に変更する。ラベル→値→記号の順は変えない(結果 `A200+` `C135-` になる、ユーザー例と一致)。
- 区切りは既存どおり半角スペース `.join(" ")` のままでよい(ユーザー文中の「A200+, C135-」のカンマは例示の区切りであり、出力フォーマットの指定ではないと判断)。

### 34-B4: アイテムアイコン2倍・テラスタルアイコン1.5倍

`src/pages/box/index.astro` の `<style is:global>` 内(628行目付近 `.card-item-badge`、462行目付近 `.card-tera-badge`。ラウンド32 32-B5で両方20pxに統一済み)。
- `.card-item-badge { width/height: 20px }` → **40px**(2倍)
- `.card-tera-badge { width/height: 20px }` → **30px**(1.5倍)
- `.card-badge-row` の `top: 60px` 固定値・狭幅(480px以下)側の16px/16px上書き(838〜851行目)は、拡大後に `.card-actions` や `.card-art` と重ならないか実測して調整すること(32-B2/32-B5のコメントに実測手順の前例あり)。デスクトップ(1920px)を主対象にしつつ、狭幅側も破綻しないか確認する。

### 34-B5: 特性名は右寄せ・アイテム名は左寄せ(中央に寄る配置)

`src/pages/box/index.astro`(674〜675行目、`.card-item-row` 内):
```css
.box-grid .card-pokemon .card-ability-name { text-align: left; }
.box-grid .card-pokemon .card-item-name { text-align: right; }
```
現在は特性=左寄せ・アイテム=右寄せ(外側に開く配置)。これを **入れ替えて** 特性=右寄せ・アイテム=左寄せにする(2つのテキストが行の中央の隙間に寄る配置になる)。

---

### 34-C1: 種族名・特性・アイテム・技の選択ボックスの再クリック時フィルタ問題

対象: `src/components/box-id/LeftPanel.astro` の以下3つ(いずれも `<input type="text" list="...">` によるネイティブ datalist)。
- `#species-name`(`list="pokemon-list"`)
- `#item`(`list="item-list"`)
- `#move-1`〜`#move-4`(`list="move-list"`)

**原因(診断)**: これらはブラウザネイティブの `<input>` + `<datalist>` で、Chromium系は「現在の入力値を含まない `<option>` を候補から除外(非表示)する」独自フィルタを持つ。値が確定済み(=候補の1つと完全一致)の状態で再度クリック/フォーカスしても、ブラウザは現在値でフィルタをかけ直すため、他の選択肢がほぼ隠れる(候補が1件しか残らないことが多い)。これは **CSSやDOM順の変更では制御できないブラウザ既定動作**であり、`<option>` の並び替えだけでは解決しない。

**方針(実装者が判断・検証すること)**: 「クリックしたら全件見えるが、現在値に近いものが上に来る」を成立させるには、ネイティブ datalist のフィルタ機構を迂回する仕掛けが要る。参考実装方針(採用必須ではない。実測して破綻しない方法を選ぶこと):
- `focus`(または `mousedown`)時に、現在値を一時変数に退避してから `input.value = ""` にし、ブラウザに全件を表示させる。`<datalist>` 内の `<option>` の並び順を、退避した現在値に近い順(完全一致→前方一致→部分一致→残り)に事前ソートしておけば、「フィルタ結果が実質的に最上位に来る」体裁になる。
- `blur` 時、ユーザーが新しい値を選ばず元の値のままなら退避値を書き戻す(誤って値を消したままにしない)。
- 技(`#move-1`〜`#move-4`)は既存の `learnset` 優先ソート(`left-panel.ts` 146行目付近 `ordered = [...learnset, ...allMoveNames.filter(...)]`)と両立させること(学習技を候補の上位に保ったまま、現在値一致もさらに優先させる)。
- この項目は見た目ではなく**操作性の不具合**なので、スクリーンショットではなく実際にクリック→再クリックの挙動を確認すること(Playwrightで `input.click()` 相当の操作を行い、表示される `<option>` の件数・順序を検証する、または手動確認内容を報告に残す)。

「特性」(`#ability`、ネイティブ `<select>`)はこの datalist フィルタ問題の対象外(`<select>` はクリックで常に全 `<option>` が見える)だが、ユーザー文中に含まれているため、34-C2(下記)の対応で扱う。

### 34-C2: ポケモン選択済み時、特性選択ボックスから「特性を選択」候補を消す

`src/lib/box-id/left-panel.ts` の特性候補再構築ロジック(312〜357行目付近、コメント「保存済みの値が新しい候補に無い場合のフォールバック先を…候補の先頭(abilities[0])にする」)を確認する。
- 現状、種族が確定していない・特性候補が引けない場合のプレースホルダーとして `<option>特性を選択</option>` 相当が残っている(または `<select id="ability">` の初期 `<option>` がSSR側でプレースホルダー的に見える)場合がある。**ポケモン(種族)が選択されている状態でのみ**、この「特性を選択」相当のプレースホルダー候補を候補配列から除外すること(種族未選択状態でのプレースホルダー自体は今回のスコープ外、UXレビュアーが別途指摘しない限り触らない)。
- `LeftPanel.astro` 169〜171行目の SSR 初期値 `<option value={pokemon.ability_name ?? ""}>{pokemon.ability_name || "特性"}</option>` も、`pokemon.ability_name` が既にある(=個体が保存済み)ケースではプレースホルダー文言が出ないことを確認する。

---

### 34-L1: ポケモンアイコン+10%

`src/components/box-id/LeftPanel.astro` 721行目 `.species-sprite-img { width: 144px; height: 144px; }` → **158px**(144×1.1=158.4を四捨五入)。
- 🔴 **これはラウンド32(32-L1)でユーザーが明示した「ポケモンアイコンサイズ変更はなし」を撤回する。** 今回はユーザーが再度明示的に拡大を指示しているため。
- `.species-icon-box`(708〜714行目、現状160×160px)は画像より一回り大きい箱(左右上下8px余白)として設計されている。158pxに対して160px箱では余白が1pxしか残らないため、箱側も比例して拡大するか(例: 176px、片側9px余白)、実測して周囲の要素(`.top-block-icon-corner` 等)と重ならないことを確認したうえで調整すること。

### 34-L2: 技ボックス間の縦横スペースを等間隔化・詰める → 種族名〜テラスタイプの縦余白も揃える

現状(`LeftPanel.astro`):
- `#edit-form .field-grid`(782〜787行目、`.move-fields-grid` と `.field-grid-single` の共通基底): `gap: 0.4rem 0.6rem`(**技ボックスの行間6.4px・列間9.6pxで不揃い**)
- `.top-block-fields`(744〜749行目、種族名/ニックネーム/特性/性格readoutの2×2グリッド): `gap: 0.75rem 0.6rem`(行間12px)
- `.top-block`(735行目): `margin-bottom: 0.75rem`(12px、種族名ブロックと持ち物/テラス行の間)

**手順どおり2段階で行うこと**:
1. まず技ボックス(`.move-fields-grid` が継承する `.field-grid` の gap)の**縦横を同じ値**にし、かつ現状より**少し詰める**。例: `gap: 0.4rem 0.4rem`(行間・列間とも6.4px)。ただし `.field-grid-single`(持ち物/テラス)も同じ基底クラスを共有するため、`.move-fields-grid` 側だけを個別に上書きするか、`.field-grid-single` 側にも同じ値を適用してよいか確認すること(持ち物/テラスは1行しかないため row-gap は実質無関係、column-gapのみ影響)。
2. 次に、**種族名〜テラスタイプの縦余白**(`.top-block-fields` の row-gap 0.75rem、`.top-block` の margin-bottom 0.75rem)を、手順1で決めた技どうしの縦gap値と**同じ値**に詰める。
- 「少し詰める」の具体的な目標値はユーザー指示に数値が無いため、実装者が試作→実測→スクリーンショット目視で窮屈になりすぎないか判断すること(12px下限のテキストや24×24pxの性格補正ボタンとの衝突が起きないか確認)。
- ⚠️ ラウンド31(31-L6/31-L7)・ラウンド32(32-L4)は逆方向(間隔を広げる)の指示だったため、**このラウンドで方向を反転させる**。round-31.md/round-32.mdの該当判断を撤回する旨を実施結果に明記すること。

### 34-L3: 性格補正の上三角(▲)の強調表示が効いていない

`LeftPanel.astro` 608〜623行目:
```css
.stat-nature-up[aria-pressed="true"]::before {
	border-bottom-color: var(--stat-up);
	filter: drop-shadow(1px 0 0 var(--color-danger-strong)) ... ;
}
.stat-nature-down[aria-pressed="true"]::before {
	border-top-color: var(--stat-down);
	filter: drop-shadow(1px 0 0 var(--color-primary-strong)) ... ;
}
```
**診断(実測済み)**: ライトモードで `--stat-up` の実色(`box/[id].astro` `.edit-shell` で定義、`#c9432c`)と縁取り色 `--color-danger-strong`(`#b23a26`)がほぼ同系色すぎて縁取りが塗りに埋没し、視覚的に「強調が効いていない」ように見える(下降側は `--stat-down`(`#1d6fd1`)と縁取り `--color-primary-strong`(`#1a7ea1`)の対比の方が(偶然)見分けやすく、結果的に非対称に見える)。`.tmp-shots` の `box-c8680844...-light-stattable.png` で実際にAの▲(縁取り無しに見える)とCの▼(縁取りありに見える)の差を確認済み。
**対応**: ラウンド32(32-L6)「縁取りは塗りと同系色にする」という設計意図は維持しつつ、上昇側だけ塗り色とのコントラストが不足しているため、上昇側の縁取り色を同系統でももう少し明度差のある色に替える(新色を極力作らず、既存トークンの中から選ぶ。無ければ最小限の新規追加もやむなしだが、まず既存トークンで解決を試みること)。ダークモード側(624〜644行目、`--color-danger-soft` を使う分岐)は既に非対称対応がされているので、そのロジックとの整合も確認すること。
修正後は `--scale 4` 程度の拡大クロップで、ライト・ダーク両方、A(上昇)・C(下降)双方の縁取りが目視で確認できることを確認する。

### 34-L4: アイテム画像+50%、文字は入力欄と同じ書式に

`LeftPanel.astro`:
- `.item-image-badge`(1348〜1355行目): `width/height: var(--icon-size-sm)`(20px)→ **30px**(+50%)。共有トークン `--icon-size-sm` 自体は変更禁止(他の20px規格アイコンに影響するため)。このバッジだけ固定値30pxで上書きする(ラウンド31 31-L2で一度固定値24pxにした前例と同じやり方)。
- `.item-name-display`(1194〜1197行目): 現状 `font-size: 0.94rem; font-weight: 600;`。
  🔴 **`font-weight: 600` はラウンド32(32-U-C1、統一感レビュアーの裁定)で「/boxカードの`.card-item-name`(600)に合わせた」ものだが、今回のユーザー指示「文字は入力欄と同じ書式にする」によりこれを撤回する。** 入力欄(`#edit-form .top-block-fields .field > input.field-control` 等、769行目 `font-size: 0.94rem`)は `font: inherit` ベースで太字指定を持たない(通常のnormal/400)。`.item-name-display` の `font-weight` を入力欄と同じ通常太さに戻す(`font-size: 0.94rem` は既に一致しているため変更不要)。
  - 画像拡大(20→30px)に伴い、隣接する `.item-name-display` の `max-width: 8.05em` や `.top-block-icon-corner`(幅119px)との重なりが無いか実測確認すること(1179〜1183行目のコメントに実測手順の前例あり)。

---

### 34-D1: アイテムアイコンのサイズを-10%

`DamageCalcSection.astro` 686〜694行目 `.damage-item-badge { width/height: 37px }` → **33px**(37×0.9=33.3を四捨五入)。`.damage-sprite-box`(96px固定)基準の絶対配置(`bottom:-4px; right:-4px`)なので、縮小してもカード高さには影響しない。

### 34-D2: テラスタルの選択ボックスを左サイドと揃える

現状の構造差(実測・スクリーンショット比較済み):
- 左サイド(`LeftPanel.astro`): 持ち物入力欄とテラス選択ボタン(`.tera-dropdown-button`)が **横並び2列**(`.field-grid` 2列グリッド、同じ幅)。
- ダメージカード(`DamageCalcSection.astro`/`damage-calc.ts`、`.damage-row-build` 内): 名前/特性/持ち物/テラスの4項目が**縦積み1列**(それぞれ独立したフル幅の行、`.damage-row-build-fields`)。テラス`<select>`自体のスタイル(アイコン+左揃えテキスト、483〜525行目)は既に左サイドの `.tera-dropdown-button` と同じ設計思想(31-D4b/32-D2で意図的に踏襲済み)。
- **「左サイドと揃える」の具体的な対象は指示文だけでは一意に決まらない**(列構成を2列化するのか、枠線・高さ・フォントなど見た目のトークンを揃えるだけでよいのか)。実装者は次の手順で判断すること:
  1. `box-c8680844-dd43-42a4-bdf1-f3de11fe3267` の左サイドとダメージカードのテラス欄をそれぞれ `--clip` で切り出し、幅・高さ・border-radius・font-sizeを実測して比較する。
  2. 明確な数値差(2px以上等)があれば、ダメージカード側を左サイドの値に揃える(左サイド側は変更しない、ダメージカードが担当ファイル)。
  3. 差が無い/僅少であれば、列構成(2列化)を検討するかはUXへの影響が大きいため、**実装せず「ユーザー判断待ち」として計画書に積み残す**(スコープが広がりすぎる場合は無理に着手しない)。

### 34-D3: 削除ボタンのある最右領域と「技を追加」ボタンの干渉

現状(`DamageCalcSection.astro`):
- `.damage-row-columns-wrap`(1065〜1078行目)と `.damage-row-total-result`(909〜930行目)は `max-width: calc(100% - 40px)` で右端40pxを削除ボタン用に空けている。
- しかし **`.damage-add-column-slot`(「+ 技を追加」ボタン、1113〜1117行目)には同じ `max-width` 制約が無い**ため、技列側の右端40pxの空き領域まで幅いっぱいに広がり、右下固定の `.damage-row-delete-button`(1003〜1011行目、`position:absolute; bottom; right`)と視覚的に重なる/干渉する。
- **対応**: `.damage-add-column-slot` にも `.damage-row-columns-wrap` / `.damage-row-total-result` と同じ `max-width: calc(100% - 40px)` を適用し、右側40pxの領域を技列・累計結果・追加ボタンのすべてで共通して避けるようにする。
- ユーザーの「最右領域をカード高さ全体に定義する」という表現は、右端40px幅の帯を**カードの特定要素(累計結果など)だけでなく、技列領域の全高さにわたって一貫して確保する**という意図と解釈する(削除ボタン自体はabsolute配置のままでよい)。実装後、技列が1枚・3枚(上限)いずれの場合も、「+技を追加」ボタンや技カードが削除ボタンの当たり判定に重ならないことを実測・目視確認する。

### 34-D4: 累計結果の上の点線を削除

`DamageCalcSection.astro` 888〜891行目:
```css
#opponent-notes-section .damage-row-total {
	margin-top: 0;
	padding-top: 0.25rem;
	border-top: 1px dashed var(--color-border);
}
```
`border-top: 1px dashed var(--color-border);` を削除する。線を消したことで技列と累計結果の間の余白が不自然に詰まって見える/空きすぎる場合は `padding-top` を実測のうえ微調整してよい(線の削除自体が要件、余白の再設計は最小限に留める)。

---

### 34-R1: ヘッダー下の二重線を1本に

**診断(実測・スクリーンショットで確認済み)**: 右パネル(`.damage-detail-panel-body`)の中身は、技列カードを選択すると次の順でDOM生成される(`right-panel.ts` 604〜751行目):
1. `.damage-detail-selection-heading`(「[自分アイコン]→[相手アイコン] 技名」の見出し行。`DamageCalcSection.astro` 1970〜1978行目で `border-bottom: 1px solid var(--color-border); margin: 0 0 0.7rem; padding-bottom: 0.7rem;`)
2. `.damage-detail-sides`(攻撃側/防御側を包むラッパー。同ファイル1637〜1651行目で `margin-top: 1rem; padding-top: 0.6rem; border-top: 1px solid var(--color-border);`)

この2つの罫線(1の `border-bottom` と 2の `border-top`)が、見出し直後というほぼ同じ位置に**連続して2本**表示される(`.tmp-shots` の `box-c8680844...-light-rightpanel.png` で実際に2本の横線を確認済み)。旧来の `.damage-detail-panel-header`(閉じるボタンのみ、1600px以上では`display:none`)の罫線とは別物なので注意。

**対応**: `#damage-detail-panel-body .damage-detail-sides` の `border-top: 1px solid var(--color-border);` を削除し、`.damage-detail-selection-heading` 側の `border-bottom` 1本だけを残す(見出しの直下に区切りがある方が自然なため)。`.damage-detail-sides` の `margin-top: 1rem; padding-top: 0.6rem;` は線を消した後の余白として過大にならないか実測して調整すること(線1本分の視覚的な高さが消えるため、詰めすぎない範囲で少し縮めてよい)。
⚠️ `.damage-detail-side + .damage-detail-side`(1662〜1667行目、攻撃側→防御側の区切り線)は**このラウンドの対象外**、変更しない。

### 34-R2: 防御側と天候の間に横棒を挿入

現状、`contentWrap`(`.damage-detail-panel-body-inner`)内のDOM順は「選択見出し → `.damage-detail-sides`(攻撃側+防御側) → `weatherRow`(天候、`.damage-detail-field-row`) → `terrainRow`(フィールド)」(`right-panel.ts` 730〜918行目)。`.damage-detail-sides` の直後に来る `weatherRow` との間には現在**区切り線が無い**。

**対応**: `DamageCalcSection.astro` の is:global スタイルに、次のセレクタを追加する(`.damage-detail-side + .damage-detail-side` の書き方に倣う):
```css
#damage-detail-panel-body .damage-detail-sides + .damage-detail-field-row {
	border-top: 1px solid var(--color-border);
	padding-top: 0.7rem; /* .damage-detail-side + .damage-detail-side と同じ値に揃える */
	margin-top: ...; /* 実測して他の区切りと同じ間隔になるよう調整 */
}
```
`.damage-detail-field-row` クラスは天候・フィールド両方が共有するが、隣接セレクタ `+` により `.damage-detail-sides` の直後に来る**最初の1つ(天候行)にだけ**適用される(フィールド行には付かない。ユーザー指示も「防御側と天候の間」に限定しているため、フィールド行の前には線を追加しない)。
🔴 ラウンド32(32-R3)「横棒は色付けしない」を踏襲し、この新設の線も無彩色 `var(--color-border)` のみを使う(色を付けない)。

---

## 維持すべき点(壊さないこと)

- **育成ルール(IV=31固定 / 努力値0〜32スケール / Lv50固定)は仕様。**
- **12px下限**(20-G3)・**アイコン規格20px**(28-L1〜L6、共有トークン `--icon-size-sm` 自体は変更しない。34-B4/34-L4は個別要素だけの固定値上書きで対応する)。
- **横棒(区切り線)は色付けしない**(32-R3)。34-R2の新設線も無彩色。
- 34-D2は範囲が曖昧なため、実測して差が無ければ無理に列構成を変えず「ユーザー判断待ち」に回してよい。

## この指示で撤回・反転される過去の判断

- **32-L1「ポケモンアイコンサイズ変更はなし」を撤回**(34-L1、ユーザーが再度明示的に拡大を指示)。
- **32-U-C1(統一感レビュアー裁定、item-name-displayをfont-weight:600に統一)を部分撤回**(34-L4、「入力欄と同じ書式」指示により通常太さへ戻す)。
- **31-L6/31-L7・32-L4(左サイドの縦間隔を広げる一連の判断)を反転**(34-L2、詰める方向へ変更)。

## ラウンド34 の実施結果(2026-07-30)

4体のsonnetサブエージェントに1ファイルずつ割り当てて並列実装させ、Coordinatorが実測・スクリーンショット目視で検証した。**全16件、実装・検証済み。**

### 実施済み

| 項目 | 対象 | 結果 |
|---|---|---|
| 34-B1〜B5 | `src/pages/box/index.astro` | お気に入りラベル短縮/並べ替えラベル削除+アイコン左配置/ホバー表記`実数値:`削除+`A200+`形式化/アイテム40px・テラス30px(2倍・1.5倍)/特性右寄せ・アイテム左寄せ(中央寄せ)。実測: アイテム/テラスバッジと`.card-actions`のクリアランス4.45px、名前テキストとの水平クリアランス10.7〜41.2px(重なりなし) |
| 34-C1 | `src/lib/box-id/left-panel.ts` | 種族名/持ち物/技の`<input list=datalist>`を、focus/mousedown時に現在値を退避→入力を空にして全候補表示→現在値に近い順(完全一致→前方一致→部分一致→残り)に事前ソートする方式で実装。Playwrightで候補が1290/270/716件(=全件)表示されること、学習技優先順が壊れていないことを確認 |
| 34-C2 | `src/lib/box-id/left-panel.ts` | 種族選択済み時、特性候補から「特性を選択」プレースホルダーを除外 |
| 34-L1 | `src/components/box-id/LeftPanel.astro` | `.species-sprite-img` 144→158px、`.species-icon-box` 160→176px。実測でコーナー列と重ならないことを確認(32-L1「変更なし」を撤回) |
| 34-L2 | 同上 | `.field-grid` gap 0.4rem 0.6rem→0.4rem 0.4rem(技間を等間隔化・詰め)、`.top-block-fields` row-gap・`.top-block` margin-bottomを0.75rem→0.4remに詰め、技どうしの間隔と統一(31-L6/31-L7・32-L4を反転) |
| 34-L3 | 同上 | 上昇(▲)の縁取り色を`--color-danger-strong`→`--color-danger-soft`に変更(塗りとの輝度コントラスト約1.23:1→約4.25:1)。ライト/ダーク両方でA(上昇)・C(下降)双方の縁取りを目視確認 |
| 34-L4 | 同上 | `.item-image-badge` 20→30px(+50%)、`.item-name-display` font-weight 600→400(32-U-C1を部分撤回) |
| 34-D1〜D4 | `src/components/box-id/DamageCalcSection.astro` | アイテムアイコン37→33px(-10%)/テラス選択欄を左サイドの寸法(min-height 2.35rem・font-size 0.94rem・line-height snug)に実測して統一/`.damage-add-column-slot`に`max-width: calc(100% - 40px)`を追加し削除ボタン領域との干渉解消/累計結果上の`border-top dashed`を削除 |
| 34-R1〜R2 | `src/components/box-id/DamageCalcSection.astro`(`#damage-detail-panel-body`系) | `.damage-detail-sides`の`border-top`を削除し見出し側`border-bottom`の1本に統一/`.damage-detail-sides + .damage-detail-field-row`に区切り線を新設(防御側→天候の間、天候行のみに適用)。1920px常時表示・1280pxオーバーレイ双方で確認 |

**Coordinator最終検証**:
- `npx astro build` 成功(exit 0、エラーなし)。
- `npm test` 298件全pass。
- `git status --short` は上記4ファイルのみ(担当外ファイルへの越境なし、`RightPanel.astro`/`right-panel.ts`はDOM順が既に正しく無編集)。
- `git stash list` は空(実装中に1エージェントが誤って`git stash`→`stash pop`した経緯があったが、worktree/DBとも状態は健全)。
- フィクスチャ`c8680844-...`の`owned_pokemon`本体・`opponent_notes`4件を`GET`で基準値(pitfalls.md記載)と突き合わせ、完全一致を確認(1エージェントが技列の追加/削除検証中に1件消してしまったが、事前に控えた値で復元済みだった)。
- 🔴 **`POST /api/owned-pokemon`で作成した検証用個体(コラッタ1体・ピカチュウ2体)がDELETEされずDBに残っていた**(34-C1のdatalist検証で作成されたもの)。エージェントの「クリーンアップ済み」報告を鵜呑みにせず、Coordinatorが`GET /api/owned-pokemon`で一覧を突き合わせて発見し、3件とも`DELETE`で削除して4体構成に復元した。**「エージェントのクリーンアップ報告は検証の代わりにならない」の実例をまた1件積んだ**(pitfalls.md「エージェントの『復元しました』報告は検証の代わりにならない」と同型)。

### 積み残し

- なし(全16件実装・検証済み。優先度A/B相当の指摘は残っていない)。

### 次のセッションへの引き継ぎ

- worktree `poke-commons-ui-round-34` はマージ・削除せず残してある。**マージ判断はユーザーに委ねる。**
- `pitfalls.md`に今回の教訓2件を追記済み: 「`EnterWorktree`ツールの既定は`origin/main`から分岐する」「エージェントの『クリーンアップ済み』報告も検証の代わりにならない」。
