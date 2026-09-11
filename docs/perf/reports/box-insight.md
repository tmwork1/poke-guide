# /box/matchup・/box/data・/box/ranked: パフォーマンス評価と改善計画

## 調査範囲と前提

本レポートは **計測を一切行わず**、コード読解と `docs/perf/dashboard.md` の既存実測値のみに基づく。
理由: 同時に他5体のadvisorが計測を並行実行しており、dev serverへの同時アクセスは数値を汚染するため
(本セッションの制約)。dev serverの起動、`npm run probe`/`npm run shot`/`npm run test:perf` の実行、
アプリのUI操作は一切行っていない。

対象は担当範囲の3画面:
- `/box/matchup`(相性チェック): `src/pages/box/matchup.astro`, `src/lib/matchup-panel.ts`, `src/lib/team-matchup.ts`, `src/pages/api/matchup-targets.ts`
- `/box/data`(バトルデータ): `src/pages/box/data.astro`, `src/lib/battle-data-card.ts`, `battle-data-card-html.ts`, `src/components/data/BattleDataCard.astro`, `src/pages/api/opgg-usage.ts`
- `/box/ranked`(ランクマ上位チーム): `src/pages/box/ranked.astro`, `src/lib/ranked-teams.ts`, `build-similarity.ts`, `src/pages/api/ranked-teams.ts`

`src/lib/archetype.ts` / `archetypes.ts` は依頼時の担当範囲リストに含まれていたが、実際に import しているのは
`team-suggest.ts` / `damage-calc-suggest.ts` / `team-suggestions.ts`(いずれも `/team/[id]` 系)のみで、
`box/matchup.astro` / `box/data.astro` / `box/ranked.astro` のどこからも参照されていないことを `grep` で確認した
(`src/lib/archetype.ts`, `src/lib/archetypes.ts` を import しているファイル一覧より)。この2ファイルは
本レポートの対象から除外する。`build-similarity.ts` は `box/ranked.astro` のスクリプトから実際に使われている
(後述)ため対象に含めた。

## 現状評価

`docs/perf/dashboard.md` より、担当3画面の実測値(2026-09-09時点、dev環境):

| 画面/操作 | 目標(ms) | 実測(ms) | 超過率 | 優先度 |
|---|---|---|---|---|
| 相性チェックを表示(`box-matchup-load`) | 1500 | 2628 | 1.75x | 🔴 要対応 |
| バトルデータを表示(`box-data-load`) | 1500 | 1795 | 1.20x | 🟡 注意 |
| 上位チームを表示(`box-ranked-load`) | 1500 | 2118 | 1.41x | 🟡 注意 |

**dev環境の空データ問題による過小評価リスク**: `wrangler.jsonc` の `OPGG_USAGE` KVが `remote: false`
(ローカルエミュレーション、2026-09-08〜)のため、ローカルdevのKVは空スタートで、OP.GGの使用率データに
依存する3画面はすべて「実データなし」の空状態/データなし状態でしか計測されていない。特に
`相性チェックを表示` は dashboard の備考が自ら明記する通り「カード描画・空状態表示のどちらかを読み込み完了と
みなす」計測であり、後述の発見Aの通り**空状態は本来のデータ取得・計算パイプラインの大部分を丸ごとスキップする**。
したがって2628msという数値は、実データがあるケースの体感速度の**下限**にすぎない可能性が高い。
`バトルデータを表示` `上位チームを表示` も同様に「データなし」表示までの時間であり、実データ表示までの
時間ではない。

## 発見

### 発見A(最重要): `/box/matchup` の空データ計測は、実データ経路の大部分(ネットワーク waterfall もPyodide計算も)を通っていない

`matchup-panel.ts` の `run()` は次の順で処理する。

```ts
// matchup-panel.ts:462-479
let targets: MatchupTarget[];
try {
  targets = await loadMatchupTargets();          // ① /api/matchup-targets を fetch
} catch (err) { ... }
if (currentRequestId !== requestId) return;
if (targets.length === 0) {
  clearLists();
  updateMoreButton(0, false);
  setStatus('集計データがまだありません。');        // ← devはKVが空なのでここで即return
  return;
}
```

```ts
// matchup-panel.ts:485
const [typesMap, moveDetails, typeChart] = await Promise.all([loadTypesMap(), loadMoveDetailMap(), loadTypeChart()]);
```

**機序**: `loadMatchupTargets()`(①、`/api/matchup-targets` へのfetch)と、タイプ/技マスタ3種の取得(②、
`loadTypesMap()`→`/master-data/autocomplete/pokemon.json`、`loadMoveDetailMap()`→
`/master-data/detail/moves.json`(103KB)、`loadTypeChart()`→`/master-data/detail/type-chart.json`)は、
**①が完了してから②を開始する直列waterfall**になっている(並列化されていない)。
devのようにKVが空で `targets.length === 0` の場合、②のフェッチは**一度も発行されない**
(474-479行の早期returnで抜ける)。つまり dashboard の2628msは①のfetch1本だけの値であり、
実データがある本番では②の追加ラウンドトリップが必ず乗る。

さらに実データがある場合、カード表示後(`renderMatchupList()`, 524行)に以下が続く。

```ts
// matchup-panel.ts:531-533
registerOfflineCache();
try {
  await initEngine();               // Pyodideランタイム初回起動(未キャッシュ時 約3〜6MB、dashboard S2参照)
```

```ts
// matchup-panel.ts:550-600 (抜粋)
for (let i = 0; i < visibleTargets.length; i += 1) {   // MATCHUP_TOP_N = 30 件(team-matchup.ts:45)
  if (directionScores[i] !== undefined) continue;
  await new Promise((resolve) => window.setTimeout(resolve, 0));  // 1件ごとにyield
  ...
  const directionResult = await calculateDirection(activeDirection);  // calcMaxDamageMatrix() 呼び出し
  ...
}
```

**カード自体は `renderMatchupList()`(524行、`initEngine()` 呼び出しより前)で表示されるため、
「カード描画」を終点とする現在の計測ロジック(`box.perf.spec.ts:98`
`#box-matchup-list:not([aria-busy]) .team-matchup-card` )は、実データがあっても①→②のfetch完了時点で
満たされ、Pyodide起動と30件の逐次計算は計測対象の**外側**で進行する。**これは実装側の意図どおり**で、
`run()` 内のコメント「対象カードを先に描画し、Pyodideの準備・計算結果は後追いで反映する」(459-460行)が
明記する設計意図であり、尊重すべき挙動である。

したがって空データ計測(2628ms)と実データ計測の差分は、厳密には次の2つに分解できる:

1. **計測値に乗る差分**: ②のfetch(typesMap/moveDetail/typeChart)1往復ぶん。静的JSONで軽量だが、
   waterfallになっているぶん並列化の余地がある(対策は後述)。
2. **計測値に乗らないが実際のユーザー体験には効く差分**: カードは灰色(`data-state="pending"`)のまま表示され、
   実際に有利/不利の色が付く(意味のある情報になる)のは `initEngine()` 完了+最大30回の
   `calcMaxDamageMatrix()` 逐次呼び出し完了後。ここが本番の初回訪問(Pyodide未キャッシュ、
   dashboard S2実測: wasm 2,991,722B + stdlib 2,306,344B + jpoke wheel 約967KB)でどれだけ掛かるかは
   **現在いかなる計測でも一切捉えられていない**。空データのdevでは`initEngine()`自体が呼ばれないため
   (474-479行の早期returnで抜けるため)、コード読解だけでは秒数を断定できない(要計測、後述)。

**影響範囲**: `/box/matchup` の🔴評価そのものの信頼性。現状の2628msが「要対応」なら、実データ経路は
それ以上に悪化している可能性が高く、逆に②の並列化だけで改善したように見えても「色が付くまで」の
体感は変わらない、という測定と対策のズレが起きうる。

**対策案**:
- ①`loadMatchupTargets()`と②`loadTypesMap()/loadMoveDetailMap()/loadTypeChart()`を
  `Promise.all` で並列化する(matchup-panel.ts 462-485行の再構成)。実装コストは小さいが、
  ②はtargets空判定より前に発行されることになるので、空データ時にも常にfetchが走るようになる
  (静的JSONなので実害は小さいと見るが、要検証)。
- devローカルKVへ本番相当のOP.GG使用率サンプルを投入し、実データ経路(waterfall解消の効果、
  Pyodide初回起動込みの「色が付くまで」の時間)を計測できるようにする(後述TODO)。

**推定効果**: ①→②の直列を解消すると、②のラウンドトリップぶん(静的JSON、devでは数十〜百数十ms程度と
推測されるが未計測)を短縮できる。「色が付くまで」の体験改善には別途Pyodide起動時間の実データ計測が必要。

### 発見B: `/api/ranked-teams` が毎リクエストでシーズン一覧の全件検証クエリを追加発行しており、`/box/ranked` の自動継続読み込みがこれを10〜20回/シーズン増幅する

```ts
// src/pages/api/ranked-teams.ts:25-37
try {
  const supabase = await getSupabasePublicClient();
  const seasons = await listRankedSeasons(supabase);           // ← 毎回、season一覧を全件取得
  if (season !== ALL_SEASONS_PARAM && !seasons.some((entry) => entry.season === season)) {
    return badRequest('存在しないシーズンです');
  }
  const page = season === ALL_SEASONS_PARAM
    ? (...)
    : (limit === undefined
      ? { teams: await listRankedTeamsBySeason(season, supabase), hasMore: false }
      : await listRankedTeamsBySeason(season, supabase, { limit, offset }));   // ← 本題のチーム取得
```

`listRankedSeasons()`(`ranked-teams.ts:105-121`)は `ranked_teams` テーブルの `season, season_number` を
**全件** SELECTしてJS側で重複排除する、`LIMIT` なしのクエリ。これが「指定シーズンが実在するか」を
確認するためだけに、本題の `listRankedTeamsBySeason()` の**前に直列で**毎回実行されている。

一方 `box/ranked.astro` はSSR時点で既に検証済みのシーズンしかクライアントへ渡していない。

```ts
// src/pages/box/ranked.astro:30-37
if (pokemon) {
  try {
    rankedSeasons = await listRankedSeasons(await getSupabasePublicClient());
    rankedSeason = resolveDefaultSeason(rankedSeasons);
  } catch (error) { ... }
}
```

さらにクライアント側の `loadRankedBuilds()` は、1バッチ(`RANKED_TEAMS_PAGE_SIZE = 24` 件、
`ranked-teams-validation.ts:5`)取得ごとに `hasMore` が `true` である限り、ユーザー操作なしで
`requestAnimationFrame` を使って**シーズンの全チームを自動的に取得し続ける**。

```ts
// src/pages/box/ranked.astro:227-233
} finally {
  if (rankedLoadingGeneration === generation) rankedLoadingGeneration = null;
  if (generation === rankedLoadGeneration && hasMoreRankedTeams && loadedNextBatch) {
    // 24件ごとに描画機会を作ってから、残りをユーザー操作なしで取得する。
    window.requestAnimationFrame(() => void loadRankedBuilds());
  }
}
```

**機序**: `docs/ranker/*.json`(ランクマ抽出パイプラインの出力サンプル)を確認したところ、
シーズンあたりのチーム数は223〜528件(`s1`: 528件, `s2`: 223件, `s3`: 291件, `s4`: 223件)。
24件/バッチで割ると **1シーズンあたり10〜22回のAPI呼び出し**が自動発火し、そのたびに
`listRankedSeasons()`(全件スキャン)が余分に直列実行される。このクエリはSSRで検証済みの情報を
毎回再取得しているだけで、`box/ranked.astro` のこの呼び出し元に対しては結果を使っていない
(存在確認のみ)。

**影響範囲**: 直接測定されている「上位チームを表示」(最初の1バッチ完了まで)の2118msにも
`listRankedSeasons()` 1回ぶんが直列で乗っている。加えて、自動継続する残り9〜21バッチ分の
待ち時間・DB負荷は現在のシナリオでは一切計測されていない(後述「計測シナリオの不足」)。
シーズンを切り替えるたびにこの全量再取得が最初からやり直しになる点も同様。

**対策案**:
- `season`・`limit`・`offset` すべて指定された呼び出しでは `listRankedSeasons()` による存在検証を省略する
  (SSR側で既に検証済みの前提を信頼する)か、リクエストスコープで結果をキャッシュする。
- このAPIは `box/ranked.astro` 以外(`/ranked-teams`, `/data/top-builds` 等)からも呼ばれている可能性があるため、
  変更前に他の呼び出し元の存在確認要件を洗い出す必要がある(未調査、要確認)。

**推定効果**: 1バッチあたりDBラウンドトリップを2回→1回に削減。自動継続読み込みが走る画面では
合計で10〜22回ぶんの冗長クエリが消える計算になる。ただし最初の1バッチの体感速度への寄与は
「DBラウンドトリップ1回ぶん」なので、目標未達(2118ms/1500ms)を単独で解消する規模ではない。

### 発見C(設計意図の確認・要計測): `/box/matchup` のPyodide逐次計算ループは damage-calc調査で見つかった `Promise.all(map)` バグを踏んでいない

`docs/plan/damage-calc-selection-perf.md` の「発見A」は `matchup-card.ts` の `cards.map(async...)` が
`Promise.all` によってyieldを無効化する、という問題だった。`matchup-panel.ts` の該当ループ
(550-600行、上に抜粋)は最初から `for (let i = 0; ...)` の逐次forループで、各イテレーションの先頭で
`await new Promise((resolve) => window.setTimeout(resolve, 0))` を挟んでおり、**同種の不具合は存在しない**。

また `calcMaxDamageMatrix()` を対象1件ずつ(バッチ化せず)呼んでいるのは意図的な設計である。

```ts
// pyodide-engine.ts:1543-1554
/**
 * 攻撃側 × 防御側の総当たりで、各組の「最大ダメージ1発」を一度に計算する。
 * ...
 * `initEngine()` が完了(ready)している必要がある。1回の呼び出しで作られる Battle は
 * 攻撃側 × 防御側の数だけになるので、進捗表示を出したい場合は呼び出し側で
 * 防御側(または攻撃側)を分割して複数回呼ぶこと。
 */
```

このdocstringの指示どおり `matchup-panel.ts` は対象を1件ずつに分割して呼び出しており、
「進捗を段階的に見せる」設計意図を尊重した実装になっている。バッチ化(例: 5件ずつまとめて呼ぶ)は
Pyodideの関数呼び出し・`toPy()`マーシャリングのオーバーヘッドを減らせる可能性がある一方、
この設計意図(進捗の細かさ)とトレードオフになるため、**変更するなら意図的な選択として行うべきで、
数値的な根拠(FFIオーバーヘッドが支配的かどうか)を先に取る必要がある(要計測)**。

MATCHUP_TOP_N=30件という初期表示件数(`team-matchup.ts:45`)自体が、1回の表示で発生する
Pyodide呼び出し回数の上限を決めている。この合計所要時間(Pyodide初回起動込み)は
発見Aの通り現状どの計測にも現れていない。

### 発見D(軽微): `/box/data` `/box/ranked` のSSRは概ね妥当な設計で、大きな無駄は見つからなかった

- `box/data.astro`(33-45行)はシーズン一覧取得後、各シーズンの `getOpggUsagePokemon()` を
  `Promise.all` で**並列**に取得しており(逐次ループではない)、シーズン数が少ない
  (現行+直近程度)前提では妥当な設計。
- `box/ranked.astro` は24件ごとに `requestAnimationFrame` を挟んでおり(230行のコメントが明記)、
  `/data` のS1改善(IntersectionObserverでの遅延描画)と同じ「メインスレッドを固めない」意図を
  既に満たしている。発見Bの冗長クエリを除けば、バッチングの粒度・yield戦略自体に問題はない。
- `battle-data-card-html.ts` はSSRとクライアント遅延描画([/data] S1)で共有するレンダラーとして
  設計どおり機能しており(`BattleDataCard.astro` のコメントで明記)、二重実装は見当たらない。

## 計測シナリオの不足

`tests/perf/scenarios/box.perf.spec.ts` を確認した。依頼文にあった「`/box/data`・`/box/ranked` には
シナリオが無い可能性が高い」という前提は**誤り**で、実際には3画面ともpage-loadシナリオが存在する
(`box-data-load` 70-82行、`box-matchup-load` 84-101行、`box-ranked-load` 103-119行)。
一方で以下は未カバー:

1. **実データ経路そのもの**: devのローカルKVが常に空のため、`box-matchup-load` / `box-data-load` /
   `box-ranked-load(の一部)` はすべて「データなし」表示までの時間しか測れていない。
   本番相当のOP.GGサンプルデータをローカルKVへ投入する仕組みがない限り、発見Aで指摘した
   「色が付くまでの本当の体感速度」は原理的に計測できない。
2. `/box/matchup` の「さらに表示」ボタン(`#box-matchup-more`、追加30件のロード)のinteractionシナリオなし。
3. `/box/matchup` の攻/守タブ切替(`.matchup-direction-tab`、`setDirection()`が`run()`を再実行)の
   interactionシナリオなし。
4. `/box/matchup` の相性カードクリックによる技ポップオーバー表示(`openMovePopover()`)のinteractionシナリオなし。
5. `/box/ranked` のシーズン切替・検索・密度切替(`RankedTeamsSearchHeader`)のinteractionシナリオなし。
6. `/box/ranked` の自動継続読み込みが完全に完了する(`hasMoreRankedTeams === false`)までの
   合計時間・合計リクエスト数を捉えるシナリオなし(現状は最初の1バッチ完了までしか測っていない)。
7. `/box/data` のゲスト(未ログイン)モードでのクライアント側fetch経路
   (`/api/opgg-usage?species=...&category=all`)が計測対象になっていない
   (`box.perf.spec.ts` は全シナリオがログイン済み `ownedPokemonId` 経由)。

## 優先順位付きTODO

1. **[小] `matchup-panel.ts`: `loadMatchupTargets()` と `loadTypesMap()/loadMoveDetailMap()/loadTypeChart()` を並列化する(発見A対策①)。**
   - リスク: 低。ただし空データ時にも②のfetchが常に発行されるようになる(静的JSONなので実害は
     小さいと見立てるが未検証)。`targets.length === 0` の早期returnとの整合(②の結果を握りつぶす形になる)を
     壊さないよう注意。
   - 検証方法: `npm run test:perf` で `box-matchup-load` を再計測(devは空データのままなので、
     短縮幅は「②のfetch1本ぶん」程度に限られる点を認識した上で比較する)。Resource Timingで
     waterfallの段数が1段減ったことを確認する。

2. **[中] devのローカルKVへ本番相当のOP.GG使用率サンプルデータを投入する仕組みを用意する。**
   - `scripts/opgg/fetch-champions-usage.mjs` の出力スキーマ(`opgg-usage.ts` の
     `OpggUsageSeasonManifest`/`OpggUsageList`/`OpggUsagePokemon` 型)に合わせたシードスクリプトが必要。
   - これがない限り、発見Aで指摘した「実データ時のPyodide初回起動+30件逐次計算がどれだけ掛かるか」
     を数値で確定できず、🔴評価の実態が過小評価か妥当かの判断ができない。
   - リスク: 中(KVスキーマの理解・シードデータの継続メンテコスト)。
   - 検証方法: シード後に `npm run test:perf` を実行し、`box-matchup-load`/`box-data-load`/
     `box-ranked-load` が空状態ではなく実データ描画で完了することを確認する。

3. **[小〜中] `/api/ranked-teams`: `limit`/`offset` 付きの呼び出しでは `listRankedSeasons()` によるシーズン存在検証を省略またはキャッシュする(発見B対策)。**
   - リスク: 中。このAPIの他の呼び出し元(`/ranked-teams`, `/data/top-builds` 等、未調査)が
     存在検証の副作用(不正シーズンで400を返す挙動)に依存していないか確認が必要。
   - 検証方法: 変更前後でSupabaseへのクエリ回数(ログ or EXPLAIN)を比較。存在しないシーズンを
     指定した場合の挙動(400を維持するか、0件応答に変えるか)を明示的にテストする。

4. **[大・着手前にユーザー相談] `/box/ranked` の自動継続読み込み(全件先読み)の設計を見直すかどうかを検討する。**
   - 現状は「取得済み分にしか検索フィルタが効かない」制約から全件を前のめりに取得する設計になっている
     とみられる(要確認)。`/data` のS1改善(先頭だけSSR+IntersectionObserverで遅延挿入)とは
     逆方向(サーバー全件を先に取りに行く)の設計なので、単純に横展開はできない。
   - 対応する場合は、TODO 6(計測シナリオ整備)を先に行い、自動継続読み込みの総所要時間・総リクエスト数を
     可視化してから着手すること。

5. **[小] 計測シナリオの拡充(上記「計測シナリオの不足」1〜7)。特に1(実データ経路)と6(自動継続読み込みの完了までの計測)を優先する。**
   - リスク: 低。既存の `perfScenario`/`timeNav`/`timeAction` の枠組みをそのまま使える。
   - 検証方法: 追加したシナリオが `docs/perf/dashboard.md` に正しく反映されることを確認する。

## 確度の低い仮説(計測で確かめるべきもの)

- **Pyodide初回起動+MATCHUP_TOP_N=30件分の逐次 `calcMaxDamageMatrix()` の合計所要時間**
  (実データ・Pyodide未キャッシュの初回訪問を想定)。発見Aの核心だが、TODO 2(devへの実データ投入)なしには測れない。
- **`/master-data/detail/moves.json`(103KB)等の静的JSON取得が、Cloudflareのエッジで
  `Cache-Control: s-maxage` どおりキャッシュされているか。** コード上に `caches.default.put/match` の
  明示的な呼び出しは見当たらず(`src/pages/api/_shared.ts` の `jsonResponse` はヘッダーを設定するのみ)、
  Workers/Pages Functionsのデフォルト挙動に委ねられている可能性がある。本番のレスポンスヘッダー
  (`CF-Cache-Status`)を見ないと判断できない。
- **`calcMaxDamageMatrix()` を対象1件ずつではなく複数件まとめて呼んだ場合のFFI/マーシャリングオーバーヘッド削減効果**
  (発見C)。Pyodideの `toPy()` 呼び出しコストが支配的かどうかは未計測で、支配的でなければバッチ化の
  効果は薄く、進捗表示の粒度を犠牲にするだけになる。
- **`/box/ranked` の自動継続読み込みが、低速回線(RTTが長い環境)でどれだけの追加総待ち時間になるか。**
  10〜22回のAPI呼び出しは並列ではなく前のバッチの完了を待って次を発火する構造(`loadRankedBuilds()`が
  自身の完了後に`requestAnimationFrame`で再帰する)なので、RTTに比例して線形に伸びる。
- **`applySprite()`(`matchup-panel.ts:141-173`)の2段フォールバック
  (`championSpriteMediumUrl`失敗→`championSpriteUrl`→`officialArtworkUrl`)が30カード分でどの程度
  発生しているか。** アプリ全体で使われている既存パターンであり本画面固有の新規課題ではないと見て
  優先度は低く見積もったが、実測はしていない。
