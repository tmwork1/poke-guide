# ローカル開発環境

ローカル開発環境の設定は `.env.local` に書いてある(gitignore対象、`.env.example` をコピーして使う)。ローカルSupabaseの接続情報などはここを見る。

# 作業方針

**作業が一区切りついたら、Coordinator(メインセッション)が自分で `git commit` する。** ユーザーに毎回確認する必要はない。コミット前に対象差分を確認し、他作業の未コミット変更は含めない。`git push` はユーザーから明示的な依頼がある場合のみ行う。
**特に指示のない限り、`main` ブランチで直接作業する。** ラウンド/フェーズごとに専用worktree・ブランチを作る運用はデフォルトでは行わない。

ユーザーがそのタスクに限って「worktreeを分けて」「今回はcommitしないで」等の指示をした場合は、そちらが優先する。

## 画面幅(レスポンシブ非対応)

**レスポンシブ設計は行わない。アプリは `--app-max-width`(412px)を上限とし、広い画面では412px幅の帯を中央配置する**(2026-09-16に全面移行)。412px未満は幅に追従させる。

- しきい値が412px以上の `@media` 幅クエリ(`min-width: 548px` や `max-width: 480px` など)を新規に書かない。412pxで常に真なら無条件のベーススタイルに、常に偽なら書かない。412px未満向け(`max-width: 359px` 等)と `(hover: hover)` 等の幅以外のクエリは使ってよい。
- `position: fixed` の要素は `left/right: var(--app-band-inset)` で帯に揃える(ダイアログのバックドロップだけは全画面)。JSで位置を出すときは `src/lib/app-band.ts` の `getAppBandRect` / `clampToAppBand` を使い、`window.innerWidth` を直接使わない。
- 帯幅を意味する `100vw` は `var(--app-band-width)` を使う。

## 画像アセット

**アプリで使う画像(ポケモン公式絵・立ち絵、アイテム、タイプ/テラスタルタイプ、UI)の一次ソースは [tmwork1/poke-sprites](https://github.com/tmwork1/poke-sprites) に集約している。** poke-guide 側は `npm run sync-sprites` で同期するだけとし、画像を取得・加工するスクリプトをこのリポジトリに追加しない(過去にあった生成スクリプト4種はすべて poke-sprites へ移した)。

- 同期先は `public/pokemon-artwork/`、`public/pokemon-champion-sprites/{icon,medium}/`、`public/item-icons/`、`public/type-icons/{,tera}/`、`public/ui-icons/`。すべて WebP で、同期スクリプトがディレクトリごと作り直すため手で置いたファイルは消える。
- poke-sprites のファイル名は和名、poke-guide 側は imageId / typeId。対応付けは `public/master-data/autocomplete/pokemon.json` を正とし、`scripts/sync-sprites.mjs` が変換する。
- 立ち絵は原寸(320px)を置かず、`icon`(96px)と `medium`(192px)の派生だけを持つ。画像が無いときの退避先は公式絵 → 頭文字バッジ。
- **実行時に外部サイトの画像を参照しない**(CSPの `img-src` は `'self' data:` のみ)。新しい画像が要るときは poke-sprites 側に追加してから同期する。
- 新しいポケモン/アイテムを master-data に足したら `npm run sync-sprites` を実行する。画像が無いものは警告が出るので、poke-sprites 側の追加漏れはそこで分かる。

## スタイル定義

画面・コンポーネント固有のスタイルは、`owned-pokemon-card.css` や `box-page.css` のように対象ごとの CSS ファイルへ集約することを必須とする。開発者が見た目を調整しやすいよう、テンプレート内の `style` 属性、コンポーネント内の分散した `<style>`、および同一対象のスタイルを複数ファイルへ無秩序に分ける実装は行わない。共有スタイルのみ `global.css` 等の共通スタイルシートに置く。

## 長押しとPCでの代替操作

長押しには3系統あり、PCでの扱いを分ける。

- **モード/遷移系**(カード長押しで削除モード、カード長押しで個体編集へ、枠長押しで解除など): **右クリック(`contextmenu`)を長押しと同じハンドラに繋ぐことを必須とする。** 右クリックはPCでの副次アクションの標準作法で、遅延コストがなくタッチ側にも影響しない。実装は `card-delete-mode.ts`・`team-mate-card.ts`・`team/[id].astro` の `attachLongPressNavigate` を参照。
- **リピート系**(`press-and-hold.ts` の ± ボタン)・**値トグル系**(ev-stepper / pokemon-edit-panel の値ボタン長押しで 0⇔32): 右クリックもダブルクリックも割り当てない。長押しはマウスでもそのまま効き、クリックでピッカーが開くなど別の到達手段が既にある。

**ダブルクリック(ダブルタップ)を新たに増やさない。** ダブルクリックを取るには単発クリックの確定を遅らせる必要があり、最頻操作であるタップの体感を必ず悪化させる(`team-mate-card.ts` の250ms遅延が実例)。また `+` ボタンのダブルクリックは「+2」が自然で、リピート系とは意味が衝突する。

長押し系の動作は `pointerdown` ベースで実装し、タッチ判定で分岐しない(マウスでも長押しが効く状態を保つ)。

## UIの確認・検証

**ブラウザでの確認は既存のCLIを使い、検証用のPlaywrightスクリプトを毎回書き起こさない。**

- `npm run shot` (`scripts/shot.mjs`) — 撮る。スクリーンショット・拡大クロップ・密度検証
- `npm run probe` (`scripts/probe.mjs`) — 測る・触る。`--rect`(位置/サイズ)・`--style`(computed style)・`--overflow`(はみ出しの犯人)・`--text`/`--html`/`--count`・`--eval`、および `--click`/`--fill`/`--press`/`--hover`/`--scroll` で操作してからの実測

どちらも `npm run dev` が起動していることが前提で、dev serverのURL検出・Pyodide初期化待ち・dev toolbar非表示・console error収集は実装済み。**足りない観点が出たら使い捨てスクリプトを書かず、この2本にオプションを足す**(共通処理は `scripts/lib/page-session.mjs`)。詳細は各ファイル冒頭のコメントと `.claude/skills/ui/references/pitfalls.md` の「Playwright」節。

## 一時ファイルの運用

デバッグ・検証用の一時ファイル(スクレイピングHTML・検証用スクリーンショット・使い捨てスクリプト等)は、ルート直下に `.tmp-` prefixで作成する(`.gitignore` の `/.tmp-*` で除外済み)。**commit前に、Coordinatorは `.tmp-*` の消し忘れがないか確認し削除する**(「作った本人が消す」運用は過去に徹底されず肥大化した実績があるため、個人の裁量に委ねない)。

## 背景

過去に、別セッションの `git commit` が作業途中の変更を丸ごと巻き込んだ事故があり、対策としてworktree分離を必須化したこともあったが、ユーザーの明示指示により**このリスクを承知の上でworktree分離をデフォルトから外し**、main直接作業+作業後commitの方針に戻した。複数セッションが同時に同じリポジトリで作業する予定があるときは、その都度ユーザーと相談してworktreeを分ける(`git worktree add ../<dir> -b <branch>`)。

サブエージェント(Implementor等)は引き続き `git commit` / `git push` を行わない。commitはCoordinator自身が行う。
