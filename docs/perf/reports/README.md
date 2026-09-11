# 全画面パフォーマンス評価: 統合サマリ(2026-09-11)

`/damage-calc` で行った評価・改善計画(`docs/plan/damage-calc-selection-perf.md`)の対象を**残る全画面**へ広げ、
5体のadvisorが並列に調査した結果をまとめたもの。**この時点では実装は一切行っていない。**

## 前提と限界(読む前に必ず)

- **すべてコード読解 + `docs/perf/dashboard.md` の既存実測値に基づく。** 今回は新規の計測を行っていない
  (並列調査中に同一のdev serverを叩くと数値が汚染されるため)。数値を伴う主張は既存の実測値の引用か、
  各報告書の「確度の低い仮説」に分類してある。
- したがって**本サマリの優先順位は「見込み」であり、実装前に個別の計測で裏を取る前提**で読むこと。
  特に下記「横断課題1」のとおり、現在の計測網にはいくつも穴があり、複数の🔴/🟡評価が実態を過小評価している。

## 個別報告書

| 報告書 | 担当画面 | dashboard上の最悪行 |
|---|---|---|
| [box.md](box.md) | `/box`・`/box/[id]` | 🟡 ボックス一覧を表示 2035ms/1.36x |
| [box-insight.md](box-insight.md) | `/box/matchup`・`/box/data`・`/box/ranked` | 🔴 相性チェックを表示 2628ms/1.75x |
| [team.md](team.md) | `/team`・`/team/[id]` | 🔴 チームメモ編集と自動保存 1430ms/1.79x |
| [data.md](data.md) | `/data`・`/data/top-builds`・すばやさ表・`/ranked-teams` | 🔴 上位チームの表示 3020ms/2.01x |
| [home-search-shell.md](home-search-shell.md) | `/`・`/search`・`/share/[slug]`・全画面共通シェル | 🔴 検索: 実行して結果を表示 1450ms/1.81x |

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

### フェーズ0: 計測網の穴を埋める(実装より先)
横断課題1。特に(a)devのローカルKVへ本番相当のOP.GG使用率データを投入する仕組み、
(b)終点定義が甘いシナリオの修正(top-builds・box一覧)、(c)未計測区間のシナリオ追加。
**これを飛ばすと、以降の改善の効果を数値で示せない。**

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
- `/team/[id]` の `loadSimilarBuilds()` をデータタブ表示時まで遅延(横断課題2)
- `/api/ranked-teams` の `listRankedSeasons` 重複解消(横断課題5)
- `/api/search` のログ書き込みを `waitUntil` でバックグラウンド化(横断課題4)

### フェーズ3: 着手前にユーザーと方針相談が必要なもの
- 自動継続読み込み + リスト全体再構築の共通設計見直し(横断課題2)
- `updateOwnedPokemon()` の認証/archetype並列化(**未認証リクエストで `archetypes` テーブルへの書き込みが誘発され得るため、レートリミット・origin検証との順序を含む再設計が必要**)
- `getSupabasePublicClient()` のリクエストスコープメモ化(全ページ・全APIに影響)
- ゲストサジェスト計算のサーバー集計化(スキーマ変更を伴う可能性)
- Pyodideの Web Worker 化(`docs/plan/damage-calc-selection-perf.md` TODO7 から継続)

## 目標値そのものの見直し候補

- 「チームメモ編集と自動保存」目標800ms/実測1430ms は、**700msのデバウンスを含んだ合算値**。
  box側の「もちもの選択の自動保存」で既に採用済みの分解方法論(合算 + PUT往復のみ、の2行に分ける)を
  当てはめると、実質のPUT往復は約730msで、目標値自体を見直す余地がある(team.md TODO7)。
