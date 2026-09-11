# データ系ページ(/data・/data/top-builds・すばやさ表・/ranked-teams): パフォーマンス評価と改善計画

## 調査範囲と前提

**このレポートは計測を一切行っていない。** dev server の起動、`npm run probe` / `npm run shot` /
`npm run test:perf` の実行、アプリのUI操作は禁止指示に基づき行っておらず、他の5体のadvisorが
並列で動いているため同時計測は数値を汚染する。根拠は以下の2つに限定する。

- `docs/perf/dashboard.md` に記録済みの既存実測値(2026-09-08〜09-09、dev server対象)
- 対象ファイルのコード読解(行番号付きで引用する)

数値の**大きさ**の妥当性(「このクエリが何ms掛かるか」)は計測が必要なため「要計測」と明記する。
一方、**構造上ムダな処理が実行されているか/直列か並列か**はコードから確定的に判定できるため、
そちらを報告の中心に置く。

担当範囲: `/data`(バトルデータ)・`/data/top-builds`(上位チーム)・`/data/speed-chart` と
`/speed-chart`(すばやさ早見表)・`/ranked-teams`(ランクマチーム一覧、`/data/top-builds` への
リダイレクト元)。関連して `/box/ranked`・`/box/data` は担当外だが、`src/lib/ranked-teams.ts` /
`src/lib/ranked-teams/*` / `src/lib/opgg-usage.ts` を共有しているため、共有ライブラリに起因する
問題は本レポートに含めた(ページ固有の問題には立ち入らない)。

## 現状評価(dashboardの数値)

| 優先度 | 画面/操作 | シナリオID | 目標(ms) | 実測(ms) | 超過率 |
|---|---|---|---|---|---|
| 🔴 | 上位チームの表示(`/ranked-teams`) | ranked-teams-load | 1500 | 3020 | **2.01x(全体最悪)** |
| 🟡 | 上位チームを表示(`/box/ranked`、担当外画面だが共有lib) | box-ranked-load | 1500 | 2118 | 1.41x |
| 🟡 | バトルデータを表示(`/box/data`、担当外画面だが共有lib) | box-data-load | 1500 | 1795 | 1.20x |
| 🟡 | バトルデータ(`/data`) | data-index-load | 1500 | 1676 | 1.12x |
| 🟢 | データ: すばやさ表(`/data/speed-chart`) | data-speed-chart-load | 1500 | 1488 | 0.99x(余裕ほぼ無し) |
| 🟢 | すばやさ表(`/speed-chart`) | speed-chart-load | 1500 | 1475 | 0.98x(余裕ほぼ無し) |
| 🟢 | データ: 上位チーム(`/data/top-builds`) | data-top-builds-load | 1500 | 973 | 0.65x |
| 🟢 | すばやさ表: 並び順切替 | speed-chart-sort-toggle | 300 | 216 | 0.72x |

`✅ 解消済み: opgg-usage系devサーバー詰まり(2026-09-08)`節にあるとおり、これら4画面はかつて
`OPGG_USAGE` KVの`remote: true`起因で42,000〜89,000msという異常値だったが、`remote: false`
(ローカルKVエミュレーション)化で解消済み。現在の数値はその副作用(ローカルKVが空スタートで
OP.GG使用率データが無い)を踏まえた「空データでのSSRコスト」であり、本レポートの分析もこの前提に立つ。

## 「上位チームの表示」3020ms と 「データ: 上位チーム」973ms の差の分析

同じ「上位チームを見る」操作に見えるこの2行は、**測っている経路も終点の定義も別物**であることが
シナリオコードから確定できる。

### 経路の違い: リダイレクト2段 vs 直接遷移

- `ranked-teams-load`(3020ms)は `tests/perf/scenarios/team-ranked.perf.spec.ts:97` で
  `timeLoadUntilLoadingHidden(page, "/ranked-teams", "#top-builds-loading")` を呼ぶ。
  `page.goto("/ranked-teams")` はブラウザから見ると次のリダイレクト連鎖をすべて内包する。
  1. `GET /ranked-teams` → `src/pages/ranked-teams/index.astro:1-3` が `Astro.redirect('/data?tab=top-builds', 301)` を即返す(このファイル自体はDB/KVアクセスなし)。
  2. `GET /data?tab=top-builds` → `src/pages/data/index.astro` が `prerender=false` でフルSSR実行。`isTopBuilds`(30-41行目)は `Astro.props.activeTab` 由来だが、`/data` に直接来た場合は `undefined` なので `isTopBuilds=false` になる。43-45行目の `if (!isTopBuilds && tab==='top-builds') return Astro.redirect('/data/top-builds')` で再度リダイレクトする。**ただしこの判定に到達する前に、27-30行目の `await listRankedSeasons(await getSupabasePublicClient())` が実行済み**(Supabaseへの1クエリ)。この結果は即座に捨てられる。
  3. `GET /data/top-builds` → `src/pages/data/top-builds.astro` が `DataPage` (`data/index.astro`) を `activeTab="top-builds"` で呼び、今度は `isTopBuilds=true` になるため最後まで実行される。
  4. 最終ページのクライアントスクリプト(`data/index.astro` 末尾の `<script>`、320行目付近)が `selectSeason()` → `loadPage()` で `fetch('/api/ranked-teams?...')` を実行し、これが解決してから `#top-builds-loading` が `hidden=true` になる。

  つまり `ranked-teams-load` は **3回のHTTP往復(301→302相当→200)+ そのうち1回は丸ごと捨てる
  SSR(Supabaseクエリ込み)+ 最終ページでのAPI往復完了** までを1つの数値に含んでいる。

- `data-top-builds-load`(973ms)は `tests/perf/scenarios/home-data.perf.spec.ts:78-88` で
  `timeNav(page, "/data/top-builds", ".top-builds-list")` を呼ぶ。`/data/top-builds` へ直接
  遷移するためリダイレクトは無く、上記③のSSRを1回行うのみ。

### 終点の違い: SSR済みコンテナ vs クライアント取得完了

さらに終点の定義がそもそも別の状態を指している。

- `data-top-builds-load` の待機対象 `.top-builds-list` は `data/index.astro:145`
  `<main class="top-builds-list" ...>` で、`isTopBuilds` 分岐に入った時点で**SSRが必ず出力する
  要素**(中身は `<p id="top-builds-loading">読み込み中…</p>` のまま)。`timeNav()` は
  `tests/perf/lib/perf.ts:39-51` の実装どおり文字列セレクタを渡すと `waitForSelector(..., {state:"visible"})`
  で終わるため、**チームカードが1件も描画されていない「読み込み中…」表示の時点**で計測が終わる。
- `ranked-teams-load` の待機対象は `#top-builds-loading` が `hidden === true` になった時点
  (`team-ranked.perf.spec.ts:17-22` の `timeLoadUntilLoadingHidden`)。`data/index.astro` の
  クライアントスクリプトでは `loading.hidden = true` は `selectSeason()` の `finally` 節
  (`api/ranked-teams` フェッチ完了後)でしか立たない。つまり**実際にチームが表示される時点**を計測している。

### 結論

3倍の差は「速いページと遅いページ」の比較ではなく、**(a) 直接遷移1回 vs リダイレクト2回込みの3遷移、
(b) SSRコンテナの出現 vs クライアント取得完了、という2つの異なる軸が両方とも不利な方向に重なった
比較**である。実際に「上位チームが見える」までの体感速度を表しているのは `ranked-teams-load` の
ほうであり、`data-top-builds-load` は名前に反して「まだ何も表示されていない状態」を指している
(`.top-builds-list` 自体は空の器で、`#speed-chart-rows` と同じ構図。dashboardの
「行が1件以上描画されるまでを計測する」という speed-chart 側の既存の教訓が top-builds 側には
まだ適用されていない)。**どちらの数値も「間違い」ではないが、比較に使うべきではなく、
`data-top-builds-load` は改善目標としては実態を過小評価している。**

## 発見

### 発見A(最重要): `data/index.astro` は表示しないタブのデータも毎回SSRで取得している

`src/pages/data/index.astro` は `/data`(バトルデータタブ)と `/data/top-builds`(上位チームタブ)の
両方を1つのファイルで扱うが、**どちらのタブを描画するかに関わらず両タブ分のデータ取得を実行する**。

- 27-30行目: `rankedSeasons = await listRankedSeasons(await getSupabasePublicClient())` ──
  上位チームのシーズン一覧(Supabase `ranked_teams` テーブルへの1クエリ)。この結果は
  120-127行目 `{isTopBuilds && (<RankedTeamsSearchHeader seasons={rankedSeasons} .../>)}` でしか
  使われない。**`!isTopBuilds`(バトルデータタブ)のときはこのクエリ結果を一切使わずに捨てている。**
- 62行目: `const battleDataList = seasonEntry ? await getOpggUsageBattleDataList(env.OPGG_USAGE, seasonEntry) : [];`
  ── これは `isTopBuilds` の値を見ずに常に実行される。`getOpggUsageBattleDataList`
  (`src/lib/opgg-usage.ts:180-187`)は内部で `getOpggUsageList` を呼び、KVから取得した全シーズン分の
  ポケモン一覧(本番実装では235件規模、`docs/perf/dashboard.md` の「S1」参照)に対して
  `normalizeSpeciesName` と `normalizeSingleFormatData`(`opgg-usage.ts:135-146`、abilities/natures/items/moves/teammates
  の5配列すべてに `normalizeTermName`/`normalizeSpeciesName` を適用)を**全件に**掛ける。
  64-88行目でさらに `masterByName` の `Map` 構築とentries配列組み立てが続く。
  この結果は 98-176行目の `{!isTopBuilds && (...)}` ブロックでしか使われず、
  **`isTopBuilds`(上位チームタブ、つまり `/data/top-builds` への直接アクセスを含む全アクセス)では
  一切描画に使われずに捨てられる。**

つまり `/data` へのアクセスは上位チームのシーズン一覧を、`/data/top-builds` へのアクセス
(このリダイレクト連鎖の最終ステップを含む)はバトルデータ全件の取得・正規化を、**どちらも
無条件に、使わないと分かっていて実行している。**

**影響範囲**: `data-index-load`(1676ms, 1.12x)・`data-top-builds-load`(973ms, 0.65x)の両方、
および発見Bで説明する `ranked-teams-load`(3020ms)の中間リダイレクトホップ。

**対策案**: `isTopBuilds` の判定(41行目)を最上部近くに引き上げ、`listRankedSeasons` の呼び出しは
`isTopBuilds` のときだけ、`getOpggUsageBattleDataList`(および付随するentries組み立て)は
`!isTopBuilds` のときだけ実行するよう条件分岐する。現状すでに `isTopBuilds` 自体は
`Astro.props.activeTab`(SSR時に確定済み)から導出できるため、実装上の制約はない。

**推定効果**: KV読み取り(`getOpggUsageBattleDataList`)は `cacheTtl: OPGG_USAGE_CACHE_TTL`(3600秒、
`opgg-usage.ts:14`)によりCloudflare KVのエッジキャッシュが効くため、繰り返しアクセスでのコストは
比較的小さいと推測される(要計測)。一方 `listRankedSeasons` はSupabaseへの生クエリでキャッシュが
無く、**`/data`(バトルデータタブ)側の無駄打ちを消すことの効果はより大きいと見込む**(要計測で確認)。
正規化処理(235件×5カテゴリの文字列正規化)のCPUコストも本番データ投入後は無視できない可能性がある
(ローカルKVは空のため現状のdev計測には現れていない = **要計測、本番相当データでの検証が必要**)。

### 発見B: `/ranked-teams` は2段リダイレクトで、中間ホップが不要なSSR(Supabaseクエリ込み)を実行する

`src/pages/ranked-teams/index.astro:1-3` は `/data?tab=top-builds` へ301リダイレクトするだけの
薄いファイルだが、リダイレクト先の `data/index.astro` は `?tab=top-builds` だけでは
`isTopBuilds=true` にならない(`Astro.props.activeTab` はpropsでしか渡らず、`/data` への直接
アクセスでは常に `undefined`)。そのため `data/index.astro` の43-45行目のガードに到達するまで
`isTopBuilds=false` のパスを一度実行し、そこで発見Aの「バトルデータタブ側の無駄打ち」
(`listRankedSeasons`)を実行してから `/data/top-builds` へ302相当のリダイレクトを返す。

**根本原因はリダイレクト先が `/data/top-builds` 自体ではなく `/data?tab=top-builds` になっている
こと。** `ranked-teams/index.astro:2` を `/data/top-builds` へ直接301すれば、中間の
`/data?tab=top-builds` ホップとそこでの無駄なSupabaseクエリを両方消せる。

**影響範囲**: `ranked-teams-load`(3020ms、🔴最優先)。この中間ホップの往復自体
(ネットワーク的には同一オリジン内なので軽いはずだが、SupabaseクエリとSSRレンダリングのフルコストを
1回分丸ごと課している)。

**対策案**: `src/pages/ranked-teams/index.astro:2` の `return Astro.redirect('/data?tab=top-builds', 301);`
を `return Astro.redirect('/data/top-builds', 301);` に変更する。`data/index.astro:43-45` の
`?tab=top-builds` → `/data/top-builds` リダイレクトは、URLを直接打ち込むケース向けに残してよいが、
`/ranked-teams` からの遷移ではもう経由しなくなる。

**推定効果**: 3回のHTTP往復のうち1回(中間ホップ)と、そこで実行されるSupabaseクエリ1回を完全に消せる。
発見Aの修正と合わせれば、リダイレクト連鎖は「301 → SSRフルレンダリング(必要な分だけ)」の2ホップまで
圧縮できる。実測での短縮幅は要計測。

### 発見C: `/api/ranked-teams` はシーズン一覧を毎回検証用に再取得している

`src/pages/api/ranked-teams.ts:27-30` は、リクエストされた `season` パラメータの妥当性を確認するために
`const seasons = await listRankedSeasons(supabase); if (season !== ALL_SEASONS_PARAM && !seasons.some(...))`
を実行している。この関数は `data/index.astro:30`(SSR側)でも呼ばれており、`/data/top-builds` の
初回表示だけで**同一種類のクエリ(`ranked_teams` テーブルの `season, season_number` 列挙)が
SSRとクライアントfetchの両方で計2回**発生する。`/ranked-teams` 経由(発見Bの修正前)ではさらに
中間ホップ分が加わり最大3回になる。

**影響範囲**: `ranked-teams-load`・`data-top-builds-load` の両方。特に `data-top-builds-load` は
このAPI往復の完了を待たない計測(前掲の分析参照)のため数値には出ないが、`ranked-teams-load`の
体感速度には直接効いている。

**対策案**: 「シーズンが存在するか」の検証は、`listRankedTeamsBySeason`/`listAllRankedTeams` の
クエリ自体が0件を返すことでも実質的に代替できる(現状「0件」と「存在しないシーズン」を
別エラーとして区別したい設計意図があるなら、コメントで明記されていないため要確認)。
最小の変更なら、SSRが既に取得済みの `rankedSeasons` をクライアントに埋め込み(`toJsonScriptContent`
パターンは `speed-chart` 系で既に使われている)、初回の `selectSeason()` 呼び出し時はSSR結果を
再利用してAPI側の検証コストをサーバ側だけに一本化する方法もあるが、これはAPIの責務分割に関わる
設計判断であり実装コストは中程度。

**推定効果**: Supabaseクエリ1回分(数十〜数百ms、要計測)の削減。

### 発見D: すばやさ早見表のSSRは独立した2〜3つのSupabase往復を直列に実行している

`src/pages/speed-chart/index.astro` と `src/pages/data/speed-chart.astro`(ほぼ同一構造、コメントで
「SSRロジック・ChartTable本体を共有」と明記)はいずれも、以下の互いに独立したSupabaseアクセスを
**すべて`await`で直列に**実行している。

1. `?owned=` 指定時のみ: 41-42行目(`speed-chart/index.astro`。`data/speed-chart.astro` は31-32行目)
   `const adminClient = await getSupabaseAdminClient(); const result = await getOwnedPokemon(user.id, ownedId, adminClient);`
2. 96行目(`data/speed-chart.astro` は70行目)
   `const publicClient = await getSupabasePublicClient();` → `suggestions` テーブルへの
   `popular_item`/`popular_move`/`popular_nature` クエリ(採用率データ)。
3. 148行目(`data/speed-chart.astro` は114行目)
   `const publicClient = await getSupabasePublicClient();` → RPC `combined_species_usage()` への
   1〜複数回のクエリ(種族使用率データ、コメントに「実測295行」とあり通常はページング不要)。

これら3つは互いに独立したデータ(所有個体 / 採用率 / 種族使用率)で、後段が前段の結果を参照する
依存関係は無い。コード上は単に上から順に書かれているために直列になっているだけで、
`Promise.all` にまとめる設計上の障害は見当たらない。

**影響範囲**: `data-speed-chart-load`(1488ms, 0.99x)・`speed-chart-load`(1475ms, 0.98x)。
**この2行は dashboard の全24行中もっとも目標に近く、余裕がほぼ無い**(0.99x/0.98x)。
既存コメントが「行が1件以上描画されるまでを計測する」と明記しているとおり、この計測は
`ChartTable.astro` → `chart-table.ts` によるクライアント側の行組み立て(発見Fで後述)の完了も
含んでいるため、SSR側のこの直列往復はページロード全体のごく一部かもしれないが、**目標に対する
余白がゼロに近いページでは、わずかな直列コストの削減がそのまま🟡転落の回避に直結する**。

**対策案**: 2(採用率)と3(種族使用率)は独立しているため `Promise.all([...])` で並列化できる。
1(所有個体取得)は `?owned=` 指定時のみ実行されるパスであり、これも2・3と独立しているため
3つ全体を `Promise.all` にまとめられる可能性が高い(admin clientとpublic clientが別物である点だけ
要確認)。

**推定効果**: 直列3往復 → 並列1往復ぶんの待ち時間に短縮。ローカルSupabase相手の実測が無いため
短縮幅は要計測だが、`docs/plan/damage-calc-selection-perf.md` の「もちもの保存のPUT往復が505ms」の
実測値から類推すると、Supabase 1往復あたり数百ms規模になっている可能性があり、2往復分を並列化
できれば無視できない短縮が見込める(要計測)。

### 発見E: Supabaseクライアントをリクエストごとに使い回さず、呼び出しのたびに新規生成している

`src/lib/supabase.ts` の `getSupabasePublicClient()`(29-40行目)・`getSupabaseAdminClient()`
(5-25行目)はどちらも呼び出しのたびに `await import('@supabase/supabase-js')` と `createClient(...)`
を実行する、メモ化の無い実装。発見Dで挙げたとおり `speed-chart` 系ページは同一リクエスト内で
`getSupabasePublicClient()` を**2回**(採用率クエリ用・種族使用率クエリ用)呼んでおり、
`?owned=`指定時はさらに `getSupabaseAdminClient()` も加わる。`data/index.astro` も
`getSupabasePublicClient()` を27-30行目とは別に(top-buildsタブのクライアントスクリプトからは
呼ばないが)SSR内で複数回呼ぶ経路がある。

`createClient()` 自体はネットワークアクセスを伴わないため1回あたりのコストは小さいと推測されるが
(要計測)、動的importと初期化オブジェクトの構築が発見Dの2〜3並列化後も残り続ける点は、
「並列化してもクライアント生成は別々」という設計の歪みとして記録しておく。

**対策案**: リクエストスコープ(Astro.locals等)で1リクエスト1インスタンスにメモ化する。
Cloudflare Workers環境での実装パターンはプロジェクト内の他のリクエストスコープ処理
(`Astro.locals.user` 等)を参考にできる。

**推定効果**: 低〜中(要計測)。発見Dの並列化とセットで着手するのが効率的。

### 発見F(確度中、コスト小): `ranked-teams/card.ts` に未使用のエクスポート関数が残っている

`src/lib/ranked-teams/card.ts:67-166` の `renderRankedTeamCard(team, imageIdMap, moveTypeMap)`
(約100行)は `export` されているが、`grep` で確認した限りプロジェクト内のどこからもimportされていない
(`src/lib/ranked-teams/search-header.ts` は同ファイルの `renderTopBuildCard` を使っており、
`renderRankedTeamCard` とは別の関数)。本番ビルドのtree-shakingで大半は除去される可能性が高いため
実害は限定的だが、確認できていない(要計測/要ビルド出力確認)。

**対策案**: 使われていないことを確認のうえ削除する。実装コストは小さいが、本レポートの制約上
削除自体は実施しない(実装はTODO化してCoordinator/実装セッションに委ねる)。

## 優先順位付きTODO

| # | 内容 | 対象発見 | 推定コスト | リスク | 検証方法 |
|---|---|---|---|---|---|
| 1 | `ranked-teams/index.astro` のリダイレクト先を `/data?tab=top-builds` → `/data/top-builds` に変更 | B | 小(1行) | 低。`data/index.astro:43-45` の `?tab=top-builds` ガードは後方互換のため残す | `npm run test:perf -- -g ranked-teams` で `ranked-teams-load` の再計測。301の遷移先をcurlで確認 |
| 2 | `data/index.astro` で `isTopBuilds` 判定を早期化し、`listRankedSeasons`(バトルデータタブ)と `getOpggUsageBattleDataList`+entries組み立て(上位チームタブ)を使うタブのときだけ実行 | A | 小〜中。分岐の入れ替えのみで、SSR出力(HTML)自体は変えない | 中。`requestedSeason` 由来のリダイレクト判定(57行目)とのタイミング依存を崩さないよう注意 | `npm run test:perf -- -g "data-index-load|data-top-builds-load"`。両タブのHTML出力が変更前後で一致することをdiffで確認(見た目を変えない変更のため) |
| 3 | `speed-chart/index.astro` と `data/speed-chart.astro` の、採用率クエリ・種族使用率クエリ(・`?owned=`時の所有個体取得)を `Promise.all` で並列化 | D, E | 小〜中。2ファイルとも同じ変更が必要(コード重複に注意、共通化も検討価値あり) | 中。`try/catch` を個別に持つ現行設計(片方が失敗してももう片方は出す)を `Promise.allSettled` 等で維持する必要がある | `npm run test:perf -- -g speed-chart`。エラー時のフォールバック(空状態)が変更後も機能することを確認 |
| 4 | `/api/ranked-teams` の `listRankedSeasons` 検証を見直す(SSR結果の再利用、またはクエリ自体の結果で代替) | C | 中。API側の責務・エラーメッセージ設計に関わる | 中。「存在しないシーズン」エラーの意味が変わらないことを確認する必要がある | `tests/ranked-teams-validation.test.ts` 等の既存テストが通ること、不正な `season` パラメータで従来どおり400が返ることを確認 |
| 5 | `getSupabasePublicClient()`/`getSupabaseAdminClient()` をリクエストスコープでメモ化 | E | 中。Cloudflare Workers環境でのリクエストスコープ設計が必要 | 中〜高。全ページ・全APIが経由する共通基盤のため影響範囲が広い。まず影響調査してから着手 | 主要ページ・API群の回帰テストを一式実行。`npm run test:perf` 全体で退行が無いことを確認 |
| 6 | `ranked-teams/card.ts` の未使用 `renderRankedTeamCard` を削除 | F | 小(削除のみ) | 低 | `grep` で参照が無いことを再確認してから削除。既存テストが通ることを確認 |

TODO 1〜4は本レポートの担当範囲(データ系ページ)に閉じた変更。5は影響範囲が全ページに及ぶため、
着手前に他のadvisorの発見(特にSupabaseアクセスの多い画面)と合わせて優先度を再検討することを推奨する。

## 確度の低い仮説(計測で確かめるべきもの)

- **発見Aの「正規化処理(235件×5カテゴリ)」のCPUコストの大きさ。** ローカルKVは空スタート
  (`✅ 解消済み`節の副作用)のため、現状のdev計測にはこの処理のコストが実質ゼロとして現れている。
  本番相当のOP.GGデータをKVに投入した状態(またはstaging環境)での計測が必要。
- **発見D・Eの並列化・メモ化による短縮幅。** ローカルSupabaseへの1往復のコストが不明なため、
  `Promise.all` 化がミリ秒単位でどれだけ効くかは推測の域を出ない。
  `docs/plan/damage-calc-selection-perf.md` の「もちもの保存のPUT往復505ms」はDB書き込みを伴う
  別操作の実測値であり、読み取り専用クエリのコストとして直接流用できない。
- **発見Fの実害。** 本番ビルド(`astro build`)後のバンドルに `renderRankedTeamCard` が
  実際に残っているかは未確認(tree-shakingで消える可能性が高い)。
- **`/box/ranked`(box-ranked-load, 2118ms, 1.41x)・`/box/data`(box-data-load, 1795ms, 1.20x)への
  発見A〜Eの波及効果。** これらは担当外画面だが `ranked-teams.ts`/`opgg-usage.ts` を共有するため、
  発見Eのメモ化などは間接的に改善する可能性がある。担当画面ではないため深掘りしていない。
