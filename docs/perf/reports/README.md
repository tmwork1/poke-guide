# 全画面パフォーマンス評価: 統合サマリ(2026-09-11)

`/damage-calc` で行った評価・改善計画(`docs/plan/damage-calc-selection-perf.md`)の対象を**残る全画面**へ広げ、
5体のadvisorが並列に調査した結果をまとめたもの。

## 進捗

- **調査(2026-09-11)**: 完了。各画面の「発見」は本ファイル以下と個別報告書にある。
- **フェーズ0(計測網の整備)**: **完了(2026-09-11)**。下の「フェーズ0 完了」節を参照。
- **フェーズ1以降(実装)**: **未着手**。次に何をやるかは「次のセッションへの引き継ぎ」節にまとめてある。

## 統合バックログ(2026-09-26 整理)

本ファイルのフェーズ1〜3と [navigation-rerender.md](navigation-rerender.md) の「残りの提案」を、
コードの現状と dashboard の現在値で突き合わせて1本の優先順に並べ直したもの。**着手順はこの表を正とする**
(下の「推奨する着手順」「次のセッションへの引き継ぎ」は経緯として残す)。

優先度の付け方: ①dashboard で 🟡 の計測行に効くもの → ②小コスト・低リスクの単発修正 → ③中コストの構造改善。
方針相談が要るものは実装対象から外して末尾に置いた。

| 順 | 状態 | 対象 | 内容 | 出典 | コスト |
|---|---|---|---|---|---|
| 1 | 未着手 | `/box/[id]?tab=damage`(🟡 6290ms/1.26x) | 相手カード全行の再計算に `yieldToBrowser()` を挟む | 横断課題6 / box.md 発見A | 小 |
| 2 | 未着手 | `/api/search`(🟡 871ms/1.09x) | `searches`・`events` のログinsertをレスポンスの前提から外す(`waitUntil` があれば使う、無ければ `Promise.all`) | 横断課題4 / home-search-shell.md 発見A | 小 |
| 3 | 未着手 | `/box/ranked`(🟡 1759ms/1.17x) | `/api/ranked-teams` の `listRankedSeasons()` 重複検証を解消 | 横断課題5 / box-insight.md 発見B | 小〜中 |
| 4 | 未着手 | 各所 | 小粒まとめ: `/ranked-teams` リダイレクト1段化(P10)/`share/[slug]`・`MobilePokemonPreview` を `pokemon-core.json` へ/`pokemon.json` preload のオプトイン化(P9)/ランクステッパー `refresh()` の同値スキップ(P12)/未使用 `renderRankedTeamCard` の削除 | フェーズ1・2 / P9・P10・P12 | 小 |
| 5 | 未着手 | `/box/data`・`/box/matchup`・`/box/ranked` | 非表示の編集パネル `pokemon-edit-panel.ts` を遅延 import | P1 | 中 |
| 6 | 未着手 | 共通(bfcache) | リビジョンを「所持ポケモン」「チーム」に分ける | P11 | 小 |
| 7 | 未着手 | `/box/[id]` | 種族値・実数値セルを SSR で出す | P7 | 小〜中 |
| 8 | 未着手 | `/team/[id]` | 類似チームの類似度計算をサーバー側で行い上位N件だけ返すAPI | P2 / 横断課題2 | 中〜大 |

実装対象から外したもの(着手前に方針相談): P3〜P6 の SSR 寄せ(表示モデル共有の設計が先)、P8(効果1往復分・`needsResave` 経路)、
フェーズ3 の全項目(自動継続読み込みの共通設計、`updateOwnedPokemon()` 並列化、`getSupabasePublicClient()` メモ化、
ゲストサジェストのサーバー集計化、Pyodide の Web Worker 化)、`@font-face` 378個の削減(寄与度が未計測)。

対応済みで表から落としたもの: `team-mate-card.ts` の250ms遅延(ダブルタップ未使用の呼び出し元では遅延しない。枠選択は 🟢 111ms/64ms)、
`/team/[id]` 類似チームの遅延取得(`76a141a6`)。すばやさ表SSRの `Promise.all` 化は、manifest → list の依存があり並列化できないため取り下げ。

## 前提と限界(読む前に必ず)

- **個別報告書の「発見」はすべてコード読解に基づく**(調査時は新規計測を行っていない。並列調査中に
  同一のdev serverを叩くと数値が汚染されるため)。構造的な指摘としては引き続き有効。
- **ただし、調査時に引用した実測値はもう古い。** フェーズ0で計測網を直した結果、当時の🔴の大半が
  計測側の問題だったと判明した(次節)。**本ファイルより下に出てくる `2628ms` `3020ms` のような
  調査時の数値は、すべて「当時の壊れた計測値」として読むこと。** 現在値は必ず
  `docs/perf/dashboard.md` の表で確認する。

## ⚠️ 2026-09-11 追記: 優先順位の前提が崩れた(フェーズ0の結果)

フェーズ0で**計測ウォームアップ**(`tests/perf/lib/perf-global-setup.ts`)を導入し、全シナリオを
同一条件で通し計測し直した結果、**本レポート群が根拠にしていた🔴の大半は、astro dev サーバーが
冷えた状態で計測されたことによる見かけ上の問題だった**ことが分かった。

| 画面/操作 | 調査時(冷えたdev) | ウォームアップ後 |
|---|---|---|
| 上位チームの表示 | 3020ms / 2.01x 🔴 | **308ms / 0.21x** 🟢 |
| 相性チェックを表示 | 2628ms / 1.75x 🔴 | **450ms / 0.30x** 🟢 |
| 検索: 実行して結果を表示 | 1450ms / 1.81x 🔴 | **882ms / 1.10x** 🟡 |
| チームメモ編集と自動保存 | 1430ms / 1.79x 🔴 | **815ms / 1.02x** 🟡 |
| もちもの保存のPUT往復 | 505ms / 1.01x 🟡 | **91ms / 0.18x** 🟢 |

**したがって下記「推奨する着手順」のフェーズ1〜3の順序は、もう当てにできない。** 各報告書の
「発見」そのもの(コードを読んで確認した構造的な問題)は引き続き有効だが、その**深刻度の見積もりは
ほぼすべて過大**だった可能性が高い。実装に着手する前に、その画面の現在値を表で確認すること。

一方、計測網を直してはじめて見えるようになった実在の課題もある。最新の順位は下記
「フェーズ0後の優先順位」を参照すること。

### フェーズ0 完了(2026-09-11)

横断課題1「計測網の穴」は全て埋めた。最終状態は 31シナリオ・87試行を同一条件で通し計測できており、
**🔴 は1件も残っていない**。

埋めた穴:

1. **ウォームアップ** (`tests/perf/lib/perf-global-setup.ts`) — 計測18ルートを事前に一巡する。
   これが無いと冷えたdevの初回コンパイルが最初のシナリオにだけ乗り、同じシナリオが2035ms↔453msと4倍ぶれた。
2. **終点定義の修正** — `データ: 上位チーム` はSSR済みの空コンテナで終わっていた。カード描画または
   明示的な空状態を終点に変更。
3. **未計測区間のシナリオ追加** — ダメージ表の初回表示、ボックス一覧の全件読み込み、編成タブ/もちもの入替の
   枠タップ、データタブの2分割(初回24件/全件完了)、チームメモPUT往復の切り出し。
4. **`/box/ranked` が計測不能だった問題** — `setRankedStatus()` がSSRの `<p id="ranked-data-status">` を
   作り直す際にidを引き継いでおらず、クライアント側で状態が一度でも更新されるとDOMからidが消えていた。
   終点に永久に到達せず3試行中2試行が120秒タイムアウトしていた。idを引き継ぐよう修正(`src/pages/box/ranked.astro`)。
5. **ローカルKVへの実データ相当の投入** (`scripts/opgg/seed-local-usage.mjs`) — 件数・カテゴリ数・行数を
   本番に合わせた合成データ235件を約4秒で投入する。これで `/data`・`/box/data`・`/box/matchup` が
   dev でも実データ経路を通るようになった(相性チェック 450ms→634ms、バトルデータ 322ms→623ms)。
6. **計測が反映されない罠** — RTKフックが `playwright test` を書き換えてレポーターを差し替えるため、
   `npx playwright test` 直叩きだと全部PASSしても表に何も書かれない。`npm run test:perf` を使う
   (`docs/perf/dashboard.md` に明記済み)。
7. **使い捨てデータの消し残し** — テスト本体がタイムアウトすると `finally` も期限切れの時計で走るため
   削除が完走せず、実際にチーム10件が残って `/team` 一覧の計測値を汚した。独自タイムアウトを持つ
   `afterAll` を最後の砦として追加。

**残る注意点**: 1回の実行内の3試行はばらつきが小さい(例: box-ranked-load 1718/1778/1820)が、
**実行をまたぐと同じシナリオが2倍動いたことが1度あった**(box-ranked-load が別実行で3548ms)。
その後の再実行では1629〜1687msで安定して再現したため編集直後の一過性の外れ値と判断したが、
**改善の前後比較は必ず同じセッション内で連続して測ること。**

### フェーズ0後の優先順位(2026-09-11時点)

| 優先 | 画面/操作 | 実測 | 対応する発見 |
|---|---|---|---|
| 1 | ダメージ表を初回表示 | 6290ms / 1.26x 🟡 | box.md 発見A(横断課題6のyield漏れ) |
| 2 | 上位チームを表示 (`/box/ranked`) | 1759ms / 1.17x 🟡 | box-insight.md 発見B・横断課題2 |
| 3 | 編成タブの枠を選択 | 396ms / 1.32x 🟡 | team.md 発見A(250msの無条件クリック遅延) |
| 4 | もちもの入替の枠を選択 | 364ms / 1.21x 🟡 | 同上 |
| 5 | 検索: 実行して結果を表示 | 871ms / 1.09x 🟡 | home-search-shell.md 発見A |

3・4は同一の修正(`team-mate-card.ts` の250ms遅延除去)で両方とも解消する見込みで、
コストが最も小さく原因も特定済み。着手するならここから。

## 個別報告書

各報告書の「調査時の最悪行」は**フェーズ0で計測網を直す前の値**で、現在は下表のとおり全て改善して
見える。数値が動いたのは実装を変えたからではなく、**計測が正しくなったから**である点に注意
(唯一の例外は `/box/ranked` で、idを引き継ぐ実装修正を入れてはじめて計測可能になった)。

| 報告書 | 担当画面 | 調査時の最悪行(壊れた計測値) | 現在 |
|---|---|---|---|
| [box.md](box.md) | `/box`・`/box/[id]` | ボックス一覧を表示 2035ms/1.36x | 🟢 313ms |
| [box-insight.md](box-insight.md) | `/box/matchup`・`/box/data`・`/box/ranked` | 相性チェックを表示 2628ms/1.75x | 🟢 634ms(実データ経路) |
| [team.md](team.md) | `/team`・`/team/[id]` | チームメモ編集と自動保存 1430ms/1.79x | 🟢 869ms(目標を1200msへ改訂) |
| [data.md](data.md) | `/data`・`/data/top-builds`・すばやさ表・`/ranked-teams` | 上位チームの表示 3020ms/2.01x | 🟢 521ms |
| [home-search-shell.md](home-search-shell.md) | `/`・`/search`・`/share/[slug]`・全画面共通シェル | 検索: 実行して結果を表示 1450ms/1.81x | 🟡 871ms/1.09x |
| [navigation-rerender.md](navigation-rerender.md) | 全画面(遷移後の無駄な再描画、2026-09-26) | — | 一部修正済み(`76a141a6`)、残りは同ファイルの「残りの提案」 |

---

## 横断課題(複数の報告書が独立に同じ問題へ到達したもの)

独立した5体が別々のコードを読んで**同じ構造の問題に別々に行き着いた**ものは、個別の画面課題より根が深い。
実装の順序を決めるうえでは、こちらを先に読むべき。

### 横断課題1: 計測網の穴 — 複数の🔴/🟡が実態を測れていない

**最重要。これを先に埋めないと、以降のどの改善も効果を検証できない。**

| 穴 | 指摘元 | 内容 |
|---|---|---|
| dev環境のKVが空 | box-insight, data, box | 相性チェックの2628msは `targets.length === 0` の**早期return経路**を測った値で、実データ時の「Pyodide初回起動 + 30件の逐次計算」は**いかなる既存計測にも現れていない**。`/data` の正規化処理(235件×5カテゴリ)、`/box/[id]` SSRのOPGG読み取りも同様に実質ゼロとして計上されている |
| 計測の終点が甘い | data, box, team | 「データ: 上位チーム」973ms は SSR直後に必ず存在する「読み込み中…」の空コンテナ `.top-builds-list` が見えた時点で終了しており、**チームカード描画を待っていない**。「ボックス一覧を表示」2035ms も最初の1枚出現までで、一覧が静止するまでを測っていない |
| 同名に見える行が別物 | data | 「上位チームの表示」3020ms と「データ: 上位チーム」973ms の3倍差は、**経路(2段リダイレクトの有無)と終点定義の違い**で、行をまたいで比較できない |
| 未計測の区間 | box, team, box-insight | `/box/[id]` のダメージタブ初期表示・タブ切替、自動継続読み込みの完了まで、タブ切替全般に計測シナリオが無い |

なお、当初 `/box/data`・`/box/ranked` にシナリオが無いと想定していたが、`tests/perf/scenarios/box.perf.spec.ts` に
3画面ともpage-loadシナリオが存在することが確認された(page-loadはあるが、interactionが無い)。

### 横断課題2: 「hasMoreな限り全件を自動先読み + リスト全体を再構築」パターンが4画面に重複

- `/team/[id]`: 「データ」タブを**開いていなくても**マウント時に `loadSimilarBuilds()` が起動し、`ranked_teams` を
  24件ずつ**40回超**逐次フェッチする(team.md 発見C)
- `/box/ranked`: 24件ごとの自動継続読み込みが、1バッチごとに `/api/ranked-teams` を叩く(box-insight.md 発見B)
- `/team` 一覧の `loadList()`、`/team/[id]` の `loadAllOwnedPokemon()`(team.md 発見B/D)
- `/box` 一覧の `renderList()` は48件バッチごとに `innerHTML=""` で全破棄・再構築(box.md 発見C)

いずれも(a)前バッチ完了を待つ**逐次**フェッチなのでRTTに線形比例、(b)毎回リスト全体を作り直すので
**O(N²)のDOM構築**、という同じ2つの欠点を持つ。1画面ずつ場当たり的に直すより、**共通の設計方針
(差分追記 + 必要時まで取りに行かない)を決めてから横展開する**のが妥当。

### 横断課題3: SSRで「使わないデータ」を取りに行っている / 直列awaitしている

- `data/index.astro` は `isTopBuilds` に関わらず**両タブ分**を毎回取得して片方を捨てる(data.md 発見A)
- `/ranked-teams` → `/data?tab=top-builds` → `/data/top-builds` の**2段リダイレクト**で、上記の無駄打ちを2回踏む(data.md 発見B)
- すばやさ表は独立した2〜3本のSupabase往復を**直列await**(data.md 発見D)。この2画面は 0.99x/0.98x と**最も余裕が無く**、わずかな退行で🟡へ落ちる
- `AppLayout.astro` が146KBの `pokemon.json` を**全ページ無条件preload**するが、ホーム・検索・共有はこれを消費するJSを持たない(home-search-shell.md 発見C)
- `share/[slug].astro` が1.6MBの `detail/pokemon.json` を丸ごとstatic importして `baseStats` だけ使う(215.6KBの `pokemon-core.json` で足りる)(home-search-shell.md 発見E)。**同じ問題が `MobilePokemonPreview.astro`(box/[id])にもある**
- `/box/[id]` のSSRが種族選択ダイアログ専用のOPGG KV読み取り(直列2回)をページ応答の前提にしている(box.md 発見E)

### 横断課題4: 付随書き込みがレスポンスをブロックしている

- `/api/search`: 検索結果はインメモリfilterで確定済みなのに、`searches`・`events` への2回のinsertを
  **逐次await**してからレスポンスを返す(home-search-shell.md 発見A)。dashboard備考の仮説が**コードで裏付けられた**
- `PUT /api/owned-pokemon/:id`: archetype分類のための独立DB往復を本体UPDATEの前に直列で挟み、
  認証往復とも直列(box.md 発見B)。「もちもの保存のPUT往復505ms」の内訳の答え

### 横断課題5: `/api/ranked-teams` の `listRankedSeasons()` 重複 — 3本の報告書が独立に指摘

毎リクエストで全件スキャンのシーズン検証が余分に走る。横断課題2の自動継続読み込みがこれを10〜40倍に増幅する。
(box-insight.md 発見B / data.md 発見C / team.md)

### 横断課題6: Pyodide同期呼び出しのyield漏れ — `/damage-calc` で直したバグの同型が box に残存

`box-id/damage-calc.ts` の `combinedDamageEngineProgress()`(3506-3514行)と `recalcAllRows`(879-883行)は、
エンジン準備完了時に保存済み相手カード全行を `yieldToBrowser()` なしで再計算する。`calcLethalSequence`/`calcStats` は
実体が完全同期のPyodide呼び出し(`pyodide-engine.ts:1349-1362`)なので、2026-09-11に `matchup-card.ts` で
修正したlongtaskバグと**同じ構造がそのまま残っている**(box.md 発見A)。

一方 `matchup-panel.ts`(相性チェック)は最初から `for` 逐次 + 都度yieldで、このバグを踏んでいない(box-insight.md 発見C)。

### 共通シェルの「床」

ホーム1220ms・共有ページ1010ms はどちらもほぼ静的な画面で、**全画面共通シェルのコストの床**を示している可能性が高い。
その最大の物理的内訳候補が、`global.css` がrender-blockingで読み込む**378個の `@font-face`(結合gzip約110KB)**
(home-search-shell.md 発見B)。ただし体感速度への寄与度は**要計測**。

---

## 推奨する着手順(見込み)

### ~~フェーズ0: 計測網の穴を埋める(実装より先)~~ — **完了(2026-09-11)**
横断課題1。詳細と結果は上の「フェーズ0 完了」節を参照。

### フェーズ1: 小コスト・低リスクで効く単発修正
| 対象 | 出典 | コスト |
|---|---|---|
| `/ranked-teams` のリダイレクト先を `/data/top-builds` へ(1ホップ削減) | data.md TODO1 | 小(1行) |
| `team-mate-card.ts` の250msクリック遅延を除去(3箇所は `onSlotDoubleTap` と `onSlotLongPress` が同一処理の重複で、機能損失なし) | team.md TODO1 | 小 |
| `/api/search` の2つのinsertを `Promise.all` 化 | home-search-shell.md TODO1 | 小 |
| `box-id/damage-calc.ts` に `yieldToBrowser()` を追加(横断課題6) | box.md TODO1 | 小 |
| ホームの `app-header.css` 二重読み込み解消 | home-search-shell.md TODO4 | 小 |
| `share/[slug].astro` を `pokemon-core.json` へ差し替え | home-search-shell.md TODO5 | 小 |
| 未使用 `renderRankedTeamCard` の削除 | data.md TODO6 | 小 |

### フェーズ2: 中コスト・構造的な改善
- `data/index.astro` のタブ別データ取得の出し分け(横断課題3)
- すばやさ表SSRの `Promise.all` 化(余裕が最も無い2画面)
- `AppLayout.astro` のpreloadをオプトイン化
- ~~`/team/[id]` の `loadSimilarBuilds()` をデータタブ表示時まで遅延(横断課題2)~~ → **対応済み(2026-09-26, `76a141a6`)**。タブを開いたときのコストは残る([navigation-rerender.md](navigation-rerender.md) P2)
- `/api/ranked-teams` の `listRankedSeasons` 重複解消(横断課題5)
- `/api/search` のログ書き込みを `waitUntil` でバックグラウンド化(横断課題4)

### フェーズ3: 着手前にユーザーと方針相談が必要なもの
- 自動継続読み込み + リスト全体再構築の共通設計見直し(横断課題2)
- `updateOwnedPokemon()` の認証/archetype並列化(**未認証リクエストで `archetypes` テーブルへの書き込みが誘発され得るため、レートリミット・origin検証との順序を含む再設計が必要**)
- `getSupabasePublicClient()` のリクエストスコープメモ化(全ページ・全APIに影響)
- ゲストサジェスト計算のサーバー集計化(スキーマ変更を伴う可能性)
- Pyodideの Web Worker 化(`docs/plan/damage-calc-selection-perf.md` TODO7 から継続)

## 目標値そのものの見直し候補

- ~~「チームメモ編集と自動保存」目標800ms~~ → **対応済み(2026-09-11)**。PUT往復だけを切り出して測った
  ところ138msで、旧目標800msの超過分はほぼ全て700msのデバウンス待ちだった。box側と同じ根拠で
  目標を1200msへ改訂した(`tests/perf/scenarios/team-ranked.perf.spec.ts`)。

---

## 次のセッションへの引き継ぎ(2026-09-11 時点)

**このセクションだけ読めば作業を再開できるように書いてある。**

### いまどこまで終わっているか

フェーズ0(計測網の整備)まで完了し、commitも済んでいる(`a88bc04` が最後)。ワーキングツリーはクリーン。
**フェーズ1以降の実装には一切手をつけていない。**

### 次にやること(優先順)

上の「フェーズ0後の優先順位」の表がそのまま着手順。**3・4(`src/lib/team-mate-card.ts` の250ms無条件
クリック遅延の除去)は1つの修正で2行とも解消する見込みで、コストが最も小さく原因も特定済みなので
ここから始めるのが妥当。**

### 計測するときの必須事項(ここを外すと今日と同じ穴に落ちる)

1. **`npm run test:perf` を使う。** `npx playwright test --config=playwright.perf.config.ts` の直叩きと
   `--reporter=list` の指定は禁止。RTKフックが `playwright test` を書き換えてレポーターを差し替えるため、
   **テストが全部PASSしても `docs/perf/results/` にも dashboard の表にも何も書き込まれない**(警告も出ない)。
   一部だけ流すなら `npm run test:perf -- -g "<test名>"`。詳細は `docs/perf/dashboard.md` の「再計測のしかた」。
2. **改善の前後比較は同一セッション内で連続して測る。** 1回の実行内の3試行はばらつきが小さいが、
   実行をまたぐと同じシナリオが2倍動いた実例がある(box-ranked-load が別実行で3548ms → 再実行では
   1629〜1687msで安定再現)。
3. **ローカルKVが空なら先に `node scripts/opgg/seed-local-usage.mjs` を実行する。** これをしないと
   `/data`・`/box/data`・`/box/matchup` が空状態しか描画せず、実データ経路のコストが計測に出ない。
   投入は約4秒、dev server の再起動は不要。消すときは `--clear`。
4. **既存ユーザーデータを操作しない。** 検証クリックが自動保存を誘発して個体データを破壊した事故がある。
   使い捨てデータを作って操作し、必ず後始末する(`tests/perf/scenarios/box.perf.spec.ts` の作法に倣う)。
   テスト本体がタイムアウトすると `finally` の削除も完走しないため、`afterAll` の回収も併せて用意する。

### 委任先

実装の委任先は codex が第一候補だが、**2026-09-11時点で codex は使用量上限に達しており、復帰は2026-09-15**。
それまでは Agent tool(sonnet/fable)へフォールバックする。commit は Coordinator 自身が行う。
