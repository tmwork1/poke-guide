---
name: stabilize
description: 画面の「揺れ」(一時的なレイアウトシフト)を実測して潰すサイクルを回す。docs/stabilize/dashboard.md の優先度に従い、1回の呼び出しで1件を 計測 → 原因特定 → 修正(codexが使えれば優先)→ 再計測 → commit まで進める。ページだけでなくタブ切替・モーダル開閉・非同期データ差し込み後の揺れも `npm run probe -- --cls --mark` で測る。`/loop stabilize` で繰り返すと🔴が無くなるまで自律的に進む。「画面が揺れる」「カクつく」「一瞬ずれる」「レイアウトシフトを直して」「描画の安定性を確認して」といった依頼に使う。
---

# 描画安定性(揺れ)の計測・改善サイクル

**1回の呼び出し = 1サイクル(課題1件の 計測→原因特定→修正→再計測→commit)。** 状態は `docs/stabilize/dashboard.md`(計測結果表 + 未計測の対象)に永続化されているので、途中から再開できる。`/loop stabilize` で繰り返し起動される前提で書かれている。

**特に指示のない限り `main` で直接作業する**(専用worktree/ブランチは作らない。→ ルートの `CLAUDE.md`「作業方針」)。**各サイクルの作業が一区切りついたら Coordinator が `git commit` する**(`git push` はしない)。

## 「揺れ」の定義(このskillが潰す対象)

**表示が始まったあとに、既に見えている要素の位置・寸法が変わること。** 具体的には:

- SSR済みの内容の上に、後から非同期で解決した値(実数値・技タイプ・スプライト・アイテムアイコン)が差し込まれて周囲が押される
- 初期状態で `display: none` / `hidden` の要素が、解決後に現れて幅・高さを増やす
- 「保存中…」「登録中…」のような一時的な文言が出入りして、要素の寸法が変わる
- JSがDOMを別の場所へ移動させる(移設・並べ替え)ことで、移設元・移設先の高さが変わる
- 画像に `width`/`height` が無く、読み込み完了時に高さが確定する

**「最初は何も無く、あとから内容が入る」こと自体は揺れではない。** プレースホルダの寸法と実際の内容の寸法が違うときだけ揺れになる。

## 合否の判定基準(2つ。**どちらか一方でも外れたら不合格**)

| 指標 | 🟢 | 🟡 | 🔴 |
|---|---|---|---|
| フェーズ合計スコア(`totalAll`、`--repeat 3` の中央値) | < 0.01 | 0.01 〜 0.05 | ≥ 0.05 |
| 個別シフトの最大移動量(`dx`/`dy`/`dw`/`dh` の絶対値) | < 2px | 2 〜 4px | ≥ 4px |

**スコアだけで判定しない。** CLSは「動いた面積 × 距離」なので、技タイプバーのような小さい要素が技名を6px押す揺れは `value` が `0.00` と出る。それでも人間の目にははっきり見える。**`value` が 0 でも `dx`/`dy` が 4px 以上あれば🔴として扱う。**

`total`(入力起因を除く合計)と `totalAll`(入力起因も含む合計)のうち、**判定には `totalAll` を使う**。タップ直後の再描画は `hadRecentInput` が立って `total` から落ちるため、`total` だけ見ると操作後の揺れを丸ごと見逃す。

## 計測のしかた

`npm run probe`(`scripts/probe.mjs`)の `--cls` / `--mark` を使う。**検証用のPlaywrightスクリプトを書き起こさない**(→ ルートの `CLAUDE.md`「UIの確認・検証」)。

```bash
npm run dev                       # 別ターミナルで先に起動しておく

# 画面遷移直後の揺れ
npm run probe -- --page box/<id> --size 390x844 --theme dark --cls --repeat 3

# 遷移元を経由した実際の導線での揺れ
npm run probe -- --from box --page box/<id> --size 390x844 --theme dark --cls --repeat 3

# タブ切替・モーダル開閉など、操作後の揺れ(--mark で初期表示と切り分ける)
npm run probe -- --page team/<id> --size 390x844 --theme dark --cls \
  --mark open-modal --click "#some-trigger"
```

読み方:

- `[load] 0.08 (4件, 0ms〜)` — フェーズごとの合計と件数。`--mark` を打った数だけフェーズが増える
- `0.07 @ 1348ms [load] div.edit-layout-training dx=0 dy=-52.6 dw=0 dh=52.6` — **押された側**のセレクタと動いた量。`startTime` から「何の完了に引きずられたか」を推測する
- その下の `+ ...` 行は**同じシフトで動いた他の要素**。**押した側(縮んだ/伸びた要素)はたいていここに出る**ので、先頭行だけ見て犯人を決めない
- `--repeat 3` を付けると中央値も出る。**判定は必ず `--repeat 3` の中央値で行う**(dev serverの初回コンパイルで1回目だけ極端に悪く出る)

### `--no-js` で「SSRの寸法」と「JS適用後の寸法」を突き合わせる

```bash
# 同じ --rect を JS無効/有効で2回叩いて見比べる
npm run probe -- --page box/<id> --size 390x844 --theme dark --no-js --rect ".pokemon-preview" --rect "ol.pokemon-preview-moves"
npm run probe -- --page box/<id> --size 390x844 --theme dark         --rect ".pokemon-preview" --rect "ol.pokemon-preview-moves"
```

これで揺れを3つに切り分けられる。**原因の切り分けはここから始める。**

| `--no-js` のCLS | 最終レイアウト(JS有無の比較) | 何が起きているか |
|---|---|---|
| 0 | 一致する | **JSが一度描き直しているだけ。** SSRの寸法は正しい。SSR済みの値と同じなら書き換えない作りにするのが筋 |
| 0 | 違う | JSが最終形を作っている。SSR側にその寸法を先に確保させる(パターンC/E) |
| 0でない | — | CSS・画像・フォント側の問題(パターンD/G/H)。JSは無関係 |

**ただし「JSが描き直しているだけ」の大半は、アプリのJSではなく Vite の dev client。**
Astro dev はCSSを `<style>` で埋め込むが、JS起動後に dev client がその中身を全部入れ替え、
ページが一度リフローする(本番ビルドでは起きない)。`--watch "head"` を付けて
`style childList "-1" → "+1"` が一斉に並ぶ時刻の直後にシフトが立っていたら、**それは偽物**。
詳しくは `references/fix-patterns.md` の冒頭。**この確認を飛ばすと存在しないバグを追うことになる。**

```bash
npm run probe -- --page box/<id> --size 390x844 --theme dark --cls --watch "head"
```

### `--block <部分文字列>` で「その通信が来なかったら」を測る

原因の候補が外部リソース(Webフォント・外部画像)なら、**それを落として測り直すのが一番早い**。
シフトが消えればその通信が原因だと断定できる。

```bash
# Webフォントの差し替えが原因かを確かめる
npm run probe -- --page data/speed-chart --size 390x844 --theme dark --cls --repeat 3   --block fonts.gstatic.com --block fonts.googleapis.com
```

**「テキストが dx だけ 4〜7px 動く」「遅れて届くデータが無い静的なページでも起きる」**なら
まずWebフォントを疑う(2026-09-10 にほぼ全ページで観測。→ `docs/stabilize/dashboard.md`)。

### `--watch <sel>` で「誰が動かしたか」を出す

`--cls` は「どの要素が動いたか」までしか分からない。`--watch <sel>` を付けると、その要素の内側で
起きたDOM変更(テキスト・属性・子要素の増減)が時刻付きで並ぶので、シフトの時刻と突き合わせれば
書き換えた張本人が分かる。**シフトの時刻に該当要素内のDOM変更が無ければ、原因は外側**
(祖先のクラス変更・CSSの入れ替え・フォント)にある。

**⚠️ `--click` 等の操作オプションは `/box/[id]` `/team/[id]` の自動保存を誘発して実データを壊しうる。** 操作系を使うときは `.claude/skills/ui/references/pitfalls.md`「自動保存があるので、検証クリックがデータを壊す」を読み、保存が走らないと確認済みの要素に限ること。

**⚠️ dev serverは認証をバイパスする。** 未ログイン/ゲストでの揺れを見るときは `npm run preview` を使うか `--guest` を付ける。

## 役割分担

| 役 | 担当 | やること | やってはいけないこと |
|---|---|---|---|
| Coordinator(メイン) | — | 計測、優先度判断、原因の切り分け、委任、diff検証、再計測、commit | 大きな実装を自分で丸抱えする |
| 調査担当 | codex優先(`--sandbox read-only`) | 揺れの発生源の特定 | ファイル編集・git操作 |
| 実装者 | codex優先 | 修正の実装 | 担当外ファイルの編集、**git commit/push**、**画面をクリックする検証** |

**委譲するかどうかは規模で判断する。** 原因が既知で1ファイル・数行に閉じる修正はCoordinatorが直接直してよい(→ `.claude/skills/codex/SKILL.md` の判断基準)。**計測はCoordinatorが自分で行う**(委任先に計測させると、自動保存事故のリスクと結果の信頼性の両方で割に合わない)。

## 手順

### P0. 現状を把握する(毎回最初に行う)

`docs/stabilize/dashboard.md` を読む。

- 計測結果表が無い、または最終計測日時が直近のコード変更より明らかに古い → 対象を計測し直す
- 「未計測の対象」節を確認する。**未計測は🟡相当として扱う**(測っていない=未知のリスク)
- ユーザーが対象画面を指定していればそれを最優先にする

`npm run dev` が起動していなければ先に起動する(`npx astro dev status` で確認)。

### P1. 計測対象のカバレッジを確認する

`references/targets.md` の一覧と `docs/stabilize/dashboard.md` の表を突き合わせる。**新しく追加されたページ・タブ・モーダルが一覧に無ければ、まず `references/targets.md` に追記する。** 測る対象になっていないものは改善サイクルに乗らない。

### P2. 対応する課題を選ぶ

- ユーザーが対象を指定していればそれ
- 指定がなければ優先度順: **未計測 > 🔴 > 🟡**。同順位が複数あれば移動量(px)が大きい順
- 全て🟢・未計測なしなら、ユーザーに完了を報告してループを止める

### P3. 原因を特定する

`--cls` が出した犯人セレクタから、そのDOMを作っている箇所を辿る。**`references/fix-patterns.md` の原因パターン表に当てはまるかをまず確認する**(既知パターンなら調査を省略してよい)。

未知の原因は codex(`--sandbox read-only`)に委託する(`references/agent-prompts.md`「調査担当テンプレート」)。

### P4. 修正する

`references/agent-prompts.md`「実装者テンプレート」で委譲する(codex優先)。指示に必ず含める:

- 計測結果そのもの(犯人セレクタ・移動量・発生タイミング)と、`references/fix-patterns.md` の該当パターン
- **「git commit / git push は絶対にしない」**
- **「`npm run dev` の画面をクリック・入力する検証は絶対にしない」**(自動保存でデータが壊れる)
- スタイルは `src/styles/` の対象別CSSに書く(ルート `CLAUDE.md`「スタイル定義」)
- 見た目を変えないこと。**揺れを消すために要素を小さくしたり、タップ領域を縮めたりしない**

### P5. 再計測して検証する

- P4の修正後、**修正前と同じコマンド**で計測し直す(`--repeat 3`)
- スコアと移動量の両方が改善したことを確認する。改善しなければP3に戻る
- **他の画面に回帰が出ていないか**、少なくとも同じCSS/コンポーネントを共有する対象を測り直す
- `npx astro build` を通す
- 見た目が変わっていないことを `npm run shot` で確認する(修正前後の比較)

### P6. dashboard を更新して commit する

`docs/stabilize/dashboard.md` の該当行を更新(実測値・判定・最終計測日・note)し、**Coordinator が `git commit` する**(`git push` はしない)。

- `.tmp-*` の消し忘れが無いか確認して削除する(ルート `CLAUDE.md`「一時ファイルの運用」)
- **そのcommitに、このセッション以外(他セッション由来)の未コミット変更を巻き込まない**(`git status` で担当外ファイルの差分が無いか必ず確認する)

## ループの終了条件

以下のいずれかで `ScheduleWakeup` に `stop: true` を渡してループを終える(`/loop stabilize` で起動されている場合)。

1. 未計測の対象が0件、かつ🔴が0件になった(🟡以下を追うかはユーザーの判断に委ねてよい)
2. 残る揺れがブラウザ・外部依存(フォント読み込み等)で、アプリ側では消せないと判明した(dashboardのnoteに理由を残す)
3. P2/P4でユーザーへの確認が必要になり、回答待ちで進められない

**1件直すごとに一度止まってユーザーに報告してよい。**

## 参照

- `docs/stabilize/dashboard.md` — 状態(計測結果表・未計測の対象)。**唯一の状態保存先**
- `references/targets.md` — 計測対象の一覧(画面・タブ・モーダル)と、それぞれのprobeコマンド
- `references/fix-patterns.md` — 揺れの原因パターンと定石の直し方
- `references/agent-prompts.md` — 調査担当・実装者への委任テンプレート
- `.claude/skills/codex/SKILL.md` — サブエージェント委譲の手順
- `.claude/skills/ui/references/pitfalls.md` — 実際に踏んだ罠(自動保存によるデータ事故・Playwright・CSS/DOMの罠)
