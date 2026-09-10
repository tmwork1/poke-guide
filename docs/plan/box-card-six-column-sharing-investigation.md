# ボックスカード6列表示の共用化: 調査結果

調査日: 2026-09-11

## 結論

「ポケモンの公式絵に持ち物アイコンを右下重ねする6列のコンパクトカード」は、ボックス一覧の
`renderBoxPokemonCard()` を唯一の見た目の実装として共用すべきである。現状は2系統あり、
`team-mate-card` 系だけがアイテム影・カード外枠・画像フォールバックを別に持つため、同じ用途に
見える画面間で差が生じる。

特に、ボックス一覧の6列表示と `/data`・`/team` の圧縮済み上位チームカードは、持ち物アイコンの
影が実際に異なる。

| 系統 | アイテム画像の影 | 判定 |
|---|---|---|
| ボックスカード `.card-item-badge img` | `0 1px 2px / 40%` + `0 0 1px / 35%` | 基準にする |
| チームメイト `.team-mate-card__item img` | `0 1px 3px / 75%` + `0 0 1px / 60%` | 基準から乖離 |

根拠はそれぞれ `src/styles/owned-pokemon-card.css` と
`src/styles/team-mate-card.css` の当該セレクタである。後者は不透明度が約2倍で、ぼかしも大きい。

## 現在の6列表示の棚卸し

### すでにボックスカードを共用しているもの

| 画面・用途 | 描画経路 | 6列化 | 結果 |
|---|---|---|---|
| `/box` の圧縮表示 | `renderBoxPokemonCard()` | `.box-content.is-compact .box-grid` が6列 | 基準そのもの |
| `/team` の通常チームカード | `renderTeamMemberGrid()` → `renderBoxPokemonCard()` | `team-card.css` が820px以上で6列 | 共用済み |
| `/box/ranked` の上位チームカード | `renderTopBuildCard()` → `renderTeamMemberGrid()` → `renderBoxPokemonCard()` | 同上 | 共用済み。ここはボックス一覧とアイテム影が同一 |
| `/team/[id]` の類似上位チームカード | `renderTopBuildCard()` の既定描画 | 同上 | 共用済み |

したがって、`/box/ranked` の通常の上位チームカードとボックス一覧との間には、アイテム影の差はない。
差が見える対象は、次節の `team-mate-card` を使う「圧縮表示」である。

### 見た目が重複しているもの

| 画面・用途 | 現行コンポーネント | 相違点 | 共用化の対象 |
|---|---|---|---|
| `/data` の上位チーム圧縮表示 | `renderTeamMateSlots()` + `.team-mate-card` | 濃いアイテム影、独自の外枠・選択スタイル | 対象 |
| `/team` 一覧の圧縮チームカード | 同上 | 同上 | 対象 |
| `/team/[id]` の編成・相性・類似チーム上部レール | 同上 | 同上。選択状態・長押し等の操作を持つ | 対象。ただし操作APIは維持 |
| 個体編集パネルの所属チーム6枠 | 同上 | 同上。読み取り専用の利用箇所 | 対象 |

`team-mate-card` の呼び出し元は `src/pages/data/index.astro`、`src/pages/team/index.astro`、
`src/pages/team/[id].astro`、`src/lib/box-id/pokemon-edit-panel.ts` である。

### 同じ「6列」だがカード共用の対象外なもの

以下はポケモンのコンパクトカード一覧ではなく、情報表・候補レール・アイテム選択UIである。列数だけを
理由にボックスカードへ置き換えてはいけない。

| 対象 | 理由 |
|---|---|
| `/team/[id]` の `team-overview-thumb-grid` | より大きい2→3→6列のプレビューカードで、技・実数値3段×6列を含む |
| `team-formation-mobile__suggest-icons` | 提案候補を並べるアイコンレールであり、所持ポケモンカードではない |
| `team-item-redistribute-item-row` | 持ち物そのものを選択・重複検出する専用UI |
| ダメージ計算の技列、能力値・実数値表 | ポケモンカードではなく、計算入力または表データ |

## 共用化の実施方針

1. `team-mate-card` の「ポケモン絵 + 持ち物アイコン」部分を、ボックス圧縮表示と同じ共有コンポーネント
   （例: `CompactPokemonTile`）へ抽出する。DOM・持ち物アイコン・フォールバック・影・サイズ・余白を
   そのコンポーネントだけで定義する。
2. `/box` は同コンポーネントを圧縮表示として使う。`renderBoxPokemonCard()` の通常表示用の名前・能力値・
   技は従来どおり上位の表示モードで制御する。
3. `renderTeamMateSlots()` は選択、長押し、readonly、空き枠という操作だけを外側へ付与し、視覚部分を
   共有コンポーネントへ委譲する。`team-mate-card__item img` の独自 `filter` は削除する。
4. `/data`・`/team` の圧縮表示、`/team/[id]` の上部レール、個体編集パネルを同コンポーネントへ移行する。
   空き枠は現行どおり別要素のままにする。
5. 比較対象外の6列グリッドは変更しない。

## 受け入れ条件

- 上記の共用対象すべてで、持ち物画像の `filter` が基準値
  `drop-shadow(0 1px 2px rgb(0 0 0 / 0.4)) drop-shadow(0 0 1px rgb(0 0 0 / 0.35))`
  に一致する。
- 6枠の列数・サイズ・空き枠・選択状態・長押し操作は現状どおり維持する。
- `/box`、`/data`、`/team`、`/team/[id]` を390pxと広幅で確認し、横スクロールを発生させない。
- ボックスカードとチームカードに同じポケモン・持ち物を置いた比較で、アイテム影・右下位置・占有率が
  同一であることをブラウザの `getComputedStyle()` とスクリーンショットで確認する。
