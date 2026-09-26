# 画面遷移後の無駄な再描画: 調査結果と残りの提案(2026-09-26)

全画面を5グループ(box / team / damage-calc+search / data系+ホーム / 共通シェル)に分けて並列に調査し、
「ページ遷移(フルロード・bfcache復帰・戻る/進む)の後に、同じ内容をもう一度描き直している箇所」を洗い出した。
小〜中規模で安全に直せるものは `76a141a6` で修正済み。このファイルは**修正済みの範囲と、見送った提案**をまとめる。

## 前提と限界

- アプリは MPA(ClientRouter / View Transitions 不使用)。遷移はすべてフルロードか bfcache 復帰。
- 所見はコード読解 + `npm run probe`(`--watch` / `--eval` / `--cls`)の実測に基づく。`--watch` はHTMLパース中の
  初回挿入も記録するので、「JSによる作り直し」と見分けるにはコード上の呼び出し経路と合わせて読む必要がある。
- **bfcache 復帰は probe で測れない**(自動化 Chromium は bfcache が無効で、戻る操作が常にフルロードになる)。
  `src/lib/shared/reload-on-bfcache-restore.ts` の挙動は `tests/reload-on-bfcache-restore.test.ts` で確認している。
  実機での確認は手動で行う。
- 所見の重さは「DOM作り直しの回数」と「APIの本数」で見積もった。`docs/perf/dashboard.md` の計測シナリオで
  体感時間への効き目は測っていない。着手前に対象シナリオの現在値を確認すること。

## 修正済み(`76a141a6`)

| 画面 | 内容 |
|---|---|
| 共通(bfcache) | 復帰のたびに一覧を再取得・全再描画していたのを、離れている間に所持ポケモン/チームが書き込まれた場合だけに限定(localStorage のリビジョンを repo の書き込み経路で更新) |
| `/team/[id]` | 初期ロードで概要6枠+3タブのチーム枠を同内容で再構築していたのを、メンバーの署名が変わったときだけに。おすすめ/類似チームを表示中のタブの分だけ取得(非表示のまま `/api/ranked-teams` を5〜8回叩いていた)。メンバー0体では取得しない |
| `/team` | 25件目以降の自動継続読み込みで全カードを作り直していたのを追記に |
| `/damage-calc` | 初期デフォルト相手の設定イベントで対面カードを700ms後に同内容で再構築/相手レール60件を連続2回生成/`?team=` で仮カード→本カードの二重描画、を各1回に |
| `/speed-chart?owned=` | 初期化中の同期イベントで表全体を2回構築していたのを1回に |
| `/box/data`・`/box/matchup`・`/box/ranked` | 非表示の編集フォームが `/api/*` を7本叩いていたのを、設定モーダルを最初に開くまで遅延 |
| 各所 | 表示密度トグル・並び順トグル・モバイルタブ・ダメ計コントロールの同値属性/SVG再代入をスキップ |
| API | 認証必須APIが middleware と handler で `getSessionUser()`(本番は Supabase `auth.getUser()`)を2回呼んでいたのを `locals.user` に集約 |

## 残りの提案

優先度は「効果の大きさ × 着手のしやすさ」で付けた。README の「推奨する着手順」と重なるものはその旨を書いた。

| # | 優先 | 画面 | 提案 | コスト | 主なリスク |
|---|---|---|---|---|---|
| P1 | 高 | `/box/data`・`/box/matchup`・`/box/ranked` | 非表示の編集パネルのモジュール自体を遅延 import する | 中 | 他モジュールのブリッジ登録順 |
| P2 | 高 | `/team/[id]` | 類似チームの類似度計算をサーバー側で行い上位N件だけ返す | 中〜大 | APIの新設、キャッシュ方針 |
| P3 | 中 | `/data/speed-chart`・`/speed-chart` | 速度表の行を SSR する | 中 | SSR/クライアントの表示モデル二重管理 |
| P4 | 中 | `/data/top-builds` | 初期シーズンの24件を SSR する | 中 | APIのCDNキャッシュとの兼ね合い |
| P5 | 中 | `/team/[id]` | 概要6枠を SSR で実カードとして出す | 中 | カードDOMの二重管理 |
| P6 | 中 | `/team` | 最初の24件を SSR する | 中 | 同上 |
| P7 | 中 | `/box/[id]` | 種族値・実数値セルを SSR で計算して出す | 小〜中 | 性格未確定時の計算式の二重管理 |
| P8 | 低 | `/box/[id]?tab=damage` | SSR済みの相手カードを捨てて再取得している経路を見直す | 中 | `needsResave` の自動補正経路 |
| P9 | 低 | 全ページ | `pokemon.json` の preload を必要なページだけにする | 小 | アイコン表示遅延の再発 |
| P10 | 低 | `/ranked-teams` | リダイレクトを1段にする | 小 | なし |
| P11 | 低 | 共通(bfcache) | リビジョンを「所持ポケモン」「チーム」に分ける | 小 | 書き込み経路の付け漏れ |
| P12 | 低 | `/damage-calc` | ランクステッパーの `refresh()` も同値なら書かない | 小 | なし |

### P1: 非表示の編集パネルのモジュール自体を遅延 import する(高)

`76a141a6` で遅延したのは `/api/*` の7本だけで、`pokemon-edit-panel.ts` のモジュール本体はまだ3画面とも即時に評価される。
実測(`/box/data?pokemon=<id>`)では、フォームが非表示のまま次のマスターデータ取得とDOM書き込みが走っていた。

- `/master-data/autocomplete/{pokemon,moves,items,abilities,mega-stones,regulations}.json`
- `/master-data/detail/{pokemon-core,moves,type-chart}.json`、`/master-data/pyodide/wheel-manifest.json`
- `recalcStats()` による実数値セルへの書き込み(非表示の `#stat-hp` 等)
- `evPresetBadges.load()` の `/api/opgg-usage-evs`(今回の遅延対象外で1本残っている)

**提案**: `PokemonSettingsModalHost.astro` で `showForm=false` のときは、`PokemonEditPanel` の `<script>` を静的 import ではなく
最初の `box-settings:open` で `import()` する形にする。モーダル側(`stat-adjustment-dialog.ts`・`item-select-dialog.ts`・
`tera-select-dialog.ts`)は `pokemon-edit-panel.ts` の export(`getItemSuggestionRatio` 等)をプル型で読むので、
遅延 import 後に読めれば足りる。`registerPokemonEditPanelBridge` を前提に初期化しているモジュールがないかは着手前に確認する。

### P2: 類似チームの類似度計算をサーバー側で行う(高)

`/team/[id]` の類似チームは、ランク入りチームを24件ずつ全ページ(実測5〜8回)取得し、ページが届くたびに全件の類似度を
計算し直して一覧全体を作り直す。今回の修正で「データタブを開くまで取得しない」ようにはしたが、開いたときの
コストは変わっていない。追記描画にできないのは、後続ページの結果で順位が入れ替わるため(類似度降順を保てない)。

**提案**: `member_ids`(または種族名の配列)を受け取り、類似度上位N件だけを返すAPIを作る。クライアントは1往復・1回描画になる。
README 横断課題2(自動先読み + 全体再構築)・横断課題5(`listRankedSeasons()` の重複)の増幅要因も同時に消える。

### P3〜P6: 「読み込み中」→ クライアント描画を SSR に寄せる(中)

いずれも SSR 時点でデータを持っている(または持てる)のに、HTML は空コンテナと「読み込み中」だけを返し、
クライアントのfetch後に一覧を一括生成している。JS無効時は0件表示になる。

| # | 画面 | 現状 | 根拠 |
|---|---|---|---|
| P3 | 速度表 | `loadSpeedChartSsr()` で `chart.rows` を取得済みなのに、`ChartTable.astro` は空の `#speed-chart-rows-body` を出し、クライアントがマスターデータ3本を待って136行+ミニマップを生成 | `src/components/speed-chart/ChartTable.astro`、`src/lib/speed-chart/chart-table.ts` の `renderRows()` |
| P4 | 上位チーム | SSR はシーズン一覧のみ。`selectSeason()` → `/api/ranked-teams` → 24カードを `replaceChildren`。その後も画像・技タイプ色を非同期で流し込む | `src/pages/data/index.astro` |
| P5 | チーム詳細 | SSR はチームを取得済みなのに概要グリッドに空き枠6個を出し、初期化で `renderOverviewGrid()` が作り直す | `src/pages/team/[id].astro` |
| P6 | チーム一覧 | SSR は空の `#team-list`。`loadList()` → `/api/teams` → 全カード生成 | `src/pages/team/index.astro` |

**共通の設計方針**: カードの表示モデル(何をどう表示するか)を純粋関数に切り出し、Astro 側とクライアント側で共有する。
クライアントは初期化時に SSR 済みの DOM を「採用」してイベントを付けるだけにし、再構築はユーザー操作
(検索・並び替え・密度切替・シーズン変更・追加読み込み)のときだけ行う。4画面を個別に直すより、
1画面(P3 が最も独立していて検証しやすい)で型を作ってから横展開するのがよい。

画面ごとの注意:

- P3: ハイライト・所有個体セル・横スクロール・ミニマップが生成済みDOMを前提にしている。`?owned=` のときの所有個体行は
  クライアントでしか決まらないので、そこだけ後から差し込む。
- P4: `/api/ranked-teams` には長いCDNキャッシュが付いている。SSR で DB を直接読むとページ側のTTFBとキャッシュ方針が変わる。
  表示密度は localStorage 由来なので、SSR の既定(展開)と保存値(圧縮)が食い違う場合の初期反映も要る。
- P5・P6: 長押し・右クリック(CLAUDE.md「長押しとPCでの代替操作」)・共有画像ボタンのイベントを SSR DOM に付け直す必要がある。

### P7: `/box/[id]` の種族値・実数値を SSR で出す(中)

`PokemonEditPanel.astro` は `#base-{key}` / `#stat-{key}` を常に `-` で出し、`pokemon-core.json` のfetch後に
`recalcStats()` が値を入れる。種族・努力値・性格はSSR時点で確定しており、`calcHpStat` / `calcOtherStat`(`src/lib/stats.ts`)は
Pyodide不要の純粋関数なので、フロントマターで種族値を読めばSSRで出し切れる。
注意: 性格未確定(`editNatureUp/Down` が null)のときの扱いをクライアントと同じにすること。
`pokemon-core.json`(約216KB)をフロントマターで import するとSSRバンドルに入るので、サイズの影響を確認する
(README 横断課題3の「`detail/pokemon.json` 丸ごと import」と同じ論点)。

### P8: `/box/[id]?tab=damage` の SSR 相手カードの扱い(低)

`?tab=damage` で開くと、`DamageCalcSection.astro` が `listOpponentNotes()` の結果を簡易カードとしてSSRするが、
`damage-calc.ts` の `fetchAndRenderRows()` は無条件に `/api/opponent-notes` を取り直し、`innerHTML = ""` で消してから
構造の違う本カードを作る。SSR カードは「JS無効時のフォールバック」という意図なので、捨てること自体は設計どおり。
**提案**: SSR で取得済みのノートを JSON として埋め込み、初回だけは再fetchせずそこから `noteToRowState` → `renderRow` する。
ただし `noteToRowState` には `needsResave` による自動補正保存があるので、SSR データでも同じ正規化を通すこと。
効果は1往復分で、ダメージ表の初回表示(dashboard で 🟡)の支配項はPyodide側なので、優先度は低い。

### P9: `pokemon.json` の preload を必要なページだけにする(低)

README フェーズ2「`AppLayout.astro` のpreloadをオプトイン化」と同じ。今回の実測でも、ホーム(`/`)は
`/master-data/autocomplete/pokemon.json`(152KB)を preload するのにこれを使うJSを持たなかった。
`/box` では preload 済みレスポンスが後続fetchでキャッシュ利用されており、アイコン表示を早める意図どおり効いている。
`AppLayout` に `preloadPokemonMaster` のような prop を足し、初期描画で使うページだけ有効にする。

### P10: `/ranked-teams` のリダイレクトを1段にする(低)

README フェーズ1(data.md TODO1)と同じで、まだ未対応。`src/pages/ranked-teams/index.astro` のリダイレクト先が
`/data?tab=top-builds` のため、さらに `/data/top-builds` へ飛ぶ2段になっている。リダイレクト先を `/data/top-builds` にする。

### P11: bfcache 用リビジョンを種類別に分ける(低)

今回のリビジョンは所持ポケモンとチームで共通なので、チームを編集してから `/box` に戻っても `/box` が再取得する
(逆も同様)。影響は「変更がないのに1回取り直す」だけで表示は正しい。分けるなら `bumpUserDataRevision("owned" | "team")` とし、
`reloadOnBfcacheRestore` に監視する種類を渡す。チームのカードは所持ポケモンの内容も表示するので、
`/team` 系は両方を監視すること。

なお、次の書き込みは意図してリビジョンを更新していない(一覧の表示に影響しないため)。

- `PATCH /api/owned-pokemon/:id`(`collection_opt_out` の切替のみ、`pokemon-edit-panel.ts`)
- `/api/opponent-notes` の作成・更新・削除(`box-id/damage-calc.ts`)

一覧に表示する項目を増やしてこれらが影響するようになったら、更新対象に加える。

### P12: ダメ計のランクステッパーの同値書き込み(低)

`control-panel.ts` の `render()` は同値の属性・`src` を書かないようにしたが、`createRankStepper()` 内の `refresh()` は
まだ全変更イベントで値を書き直している。影響は軽微。

## 参照

- 統合ロードマップ: [README.md](README.md)(横断課題2・3・5 が本ファイルの P2・P3〜P6・P9 と関係する)
- 計測: [../dashboard.md](../dashboard.md)
