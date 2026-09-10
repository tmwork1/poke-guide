# ボックスカード6列表示の共用化: 調査結果と実施計画

調査日: 2026-09-11 / 方針確定: 2026-09-11

## 結論

「ポケモンの絵に持ち物アイコンを右下重ねする6列のコンパクトタイル」は、`team-mate-card` 系を
共有コンポーネントへ抽出して1本にまとめる。`/box` の圧縮表示はDOMを変更せず、CSS(影)と
画像取得方式だけを共有側の基準に合わせる。

差分は「影」だけではない。**表示している画像そのものが違う**点が最大の乖離である。

| 系統 | ポケモン画像の一次URL | 失敗時 | 持ち物画像の影 |
|---|---|---|---|
| ボックスカード (`applyCardArtwork`) | `championSpriteMediumUrl` (192px) | `artwork.hidden = true`(非表示) | `0 1px 2px/0.4` + `0 0 1px/0.35` |
| チームメイト (各ページの `applySprite`) | `championSpriteIconUrl` (icon WebP) | 頭文字テキスト | `0 1px 3px/0.75` + `0 0 1px/0.6` |

根拠は `src/lib/owned-pokemon-card.ts` の `applyCardArtwork()` / `applyItemBadge()`、
`src/styles/owned-pokemon-card.css:325`、`src/styles/team-mate-card.css:89`、および
`src/pages/data/index.astro` ほかの `applySprite()`。

持ち物バッジの幾何(右下・44%正方形)は既に一致しているため、揃える必要があるのは
**画像の取得方式**と**`filter` の影**の2点である。

### 確定した方針

1. **ポケモン画像は icon WebP 側(team-mate方式)に統一する。**
   `championSpriteIconUrl` → `championSpriteUrl` → `officialArtworkUrl` → 頭文字テキスト。
   `/box` の圧縮表示もこの取得方式へ寄せる(現行の192px版から変わる)。
2. **持ち物アイコンの影はボックスカードの薄い値を基準にする。**
   `drop-shadow(0 1px 2px rgb(0 0 0 / 0.4)) drop-shadow(0 0 1px rgb(0 0 0 / 0.35))`。
3. **`/box` は共有コンポーネントへ移行しない。CSSと画像取得だけ追従する。**
4. **`applySprite` / `applyItemIcon` の4重複を先に一本化する。**
5. **持ち物再分配モーダルのメンバー6枠も共通化対象に含め、ロック表示は維持する。**

## 現在の6列表示の棚卸し

### すでにボックスカードを共用しているもの

| 画面・用途 | 描画経路 | 6列化 | 結果 |
|---|---|---|---|
| `/box` の圧縮表示 | `renderBoxPokemonCard()` | `.box-content.is-compact .box-grid` が6列 | 影は基準そのもの。画像のみ要変更 |
| `/team` の通常チームカード | `renderTeamMemberGrid()` → `renderBoxPokemonCard()` | `team-card.css` が820px以上で6列 | 共用済み |
| `/box/ranked` の上位チームカード | `renderTopBuildCard()` → `renderTeamMemberGrid()` → `renderBoxPokemonCard()` | 同上 | 共用済み。ボックス一覧とアイテム影が同一 |
| `/team/[id]` の類似上位チームカード | `renderTopBuildCard()` の既定描画 | 同上 | 共用済み |

したがって `/box/ranked` の通常の上位チームカードとボックス一覧の間に影の差はない。
差が見える対象は、次節の `team-mate-card` を使う「圧縮表示」である。

### 見た目が重複しているもの(共通化の対象)

| 画面・用途 | 呼び出し元 | 相違点 | 備考 |
|---|---|---|---|
| `/data` の上位チーム圧縮表示 | `src/pages/data/index.astro` | 濃いアイテム影、独自の外枠・選択スタイル | — |
| `/team` 一覧の圧縮チームカード | `src/pages/team/index.astro` | 同上 | — |
| `/team/[id]` の編成・相性・類似チーム上部レール | `src/pages/team/[id].astro` | 同上。選択状態・長押し等の操作を持つ | 操作APIは維持 |
| `/team/[id]` の持ち物再分配モーダルのメンバー6枠 | `src/pages/team/[id].astro` `renderRedistributionMembers()` | 同上。`showItem: false` で描画後に `.is-locked` とロックバッジを後付け | **対象に含める。ロック表示は維持** |
| 個体編集パネルの所属チーム6枠 | `src/lib/box-id/pokemon-edit-panel.ts` | 同上。読み取り専用 | `.is-current` 装飾を維持 |

### 同じ「6列」だが共用の対象外なもの

以下はポケモンのコンパクトタイル一覧ではなく、情報表・候補レール・アイテム選択UIである。
列数だけを理由に置き換えてはいけない。

| 対象 | 理由 |
|---|---|
| `/team/[id]` の `team-overview-thumb-grid` | より大きい2→3→6列のプレビューカードで、技・実数値3段×6列を含む |
| `team-formation-mobile__suggest-icons` | 提案候補を並べるアイコンレールであり、所持ポケモンカードではない |
| `team-item-redistribute-item-row` | 持ち物そのものを選択・重複検出する専用UI(同モーダルのメンバー行とは別物) |
| ダメージ計算の技列、能力値・実数値表 | ポケモンカードではなく、計算入力または表データ |

## `/box` を共有コンポーネント化しない理由

`src/styles/box-page.css:72-79` に既に記録があるとおり、`renderTeamMateSlots` は6枠固定・
スロット番号ベースの設計で、ページングされる可変長の `/box` 一覧には使えない。加えて:

- `/box` の密度切替は `.box-content.is-compact` のクラス付け替えのみで、展開/圧縮でDOMは同一。
  別コンポーネントへ差し替えると、切替のたびに一覧全体の再描画が必要になる。
- 圧縮表示のカードも `<a>` リンク + `data-astro-prefetch` + 削除ボタン + 長押し削除モードを持つ。
  これらを共有タイル側へ再実装するのは、見た目の統一という目的に対して過大なリグレッション risk。

よって `/box` は `renderBoxPokemonCard()` のまま据え置き、変更は次の2点に限る。

- `applyCardArtwork()` の一次URLを `championSpriteMediumUrl` から icon WebP 方式へ寄せる
  (共通化した `applySprite` を使う)。
- 影は既に基準値のため変更なし。

## 実施手順

### フェーズ1: 画像適用関数の一本化(先に単独で実施・commit)

1. `applySprite` / `applyItemIcon` の実装を共通モジュール(例: `src/lib/compact-pokemon-sprite.ts`)へ
   1本だけ置く。フォールバック順は icon WebP → championSprite → officialArtwork → 頭文字テキスト。
2. 呼び出し元4箇所を差し替える。
   `src/pages/data/index.astro`、`src/pages/team/index.astro`、`src/pages/team/[id].astro`、
   `src/lib/box-id/pokemon-edit-panel.ts`。
   `team/[id].astro` は `applySprite(imgEl, fallbackEl, name, "icon")` のように第4引数で
   バリアントを渡している箇所があるため、共通化後もそのバリアント指定を保つ。
3. `owned-pokemon-card.ts` の `applyCardArtwork()` を同モジュール経由に寄せ、`/box` の画像も
   icon WebP 起点にする。ただし `artwork.hidden` によるラッパー非表示という現行の
   フォールバック挙動は変えない(ボックスカードは頭文字テキストを持たない)。
4. 初期非表示の扱いを共通モジュール内で1つに決める。現行 `team-mate-card.ts` は
   `img.style.display = "none"`、`shared-core` 系は `hidden` 属性のみで戻す契約であり、
   混在させると復帰しない。共通モジュールが自分で隠して自分で戻す形に閉じること。

### フェーズ2: コンパクトタイルの抽出

5. `team-mate-card` の「ポケモン絵 + 持ち物アイコン」部分を共有コンポーネント
   (例: `CompactPokemonTile`)へ抽出する。DOM・持ち物アイコン・フォールバック・影・サイズ・
   余白をそのコンポーネントだけで定義する。
6. `renderTeamMateSlots()` は選択・長押し・readonly・空き枠という操作だけを外側へ付与し、
   視覚部分を共有コンポーネントへ委譲する。`team-mate-card__item img` の独自 `filter` は削除し、
   基準値へ揃える。
7. `/data`・`/team` の圧縮表示、`/team/[id]` の上部レール、再分配モーダルのメンバー6枠、
   個体編集パネルを同コンポーネントへ移行する。空き枠は現行どおり別要素のままにする。
8. 再分配モーダルの後付け装飾が動き続けるよう、`data-slot` 属性・`.team-mate-card` クラス名・
   子要素の重なり順を維持する(`team-item-redistribute-dialog.css:110-119` が
   `.team-mate-card` の枠を消す前提になっている)。`showItem: false` も維持。
9. 比較対象外の6列グリッドは変更しない。

## 受け入れ条件

- 共用対象すべてで、持ち物画像の `filter` が基準値
  `drop-shadow(0 1px 2px rgb(0 0 0 / 0.4)) drop-shadow(0 0 1px rgb(0 0 0 / 0.35))` に一致する。
- 共用対象すべてと `/box` 圧縮表示で、ポケモン画像の一次URLが `championSpriteIconUrl` である。
- 6枠の列数・サイズ・空き枠・選択状態・長押し操作は現状どおり維持する。
- 再分配モーダルで持ち物が重複する枠に、従来どおりロックバッジと `.is-locked` の枠が出る。
- 個体編集パネルの所属チーム6枠で、表示中の個体の枠(`.is-current`)が従来どおり示される。
- 画像取得に失敗したときのフォールバックが、共用対象では頭文字テキスト、`/box` では非表示、
  という現行の使い分けのまま動く。
- `/box`、`/data`、`/team`、`/team/[id]` を390pxと広幅で確認し、横スクロールを発生させない。
- ボックスカードとチームタイルに同じポケモン・持ち物を置いた比較で、アイテム影・右下位置・
  占有率が同一であることを `npm run probe -- --style` と `npm run shot` で確認する。
