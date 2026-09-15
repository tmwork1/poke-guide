# すばやさ早見表: 母集団をOP.GG統計のみで再構成する

2026-09-15 ユーザー指示。現状の早見表は情報量が多すぎるため、母集団と表示条件を
「該当シーズンのOP.GG使用率統計」だけで決め直す。既存の
`docs/plan/completed/pages/speed-chart.md`(P1〜P3)を上書きする方針変更であり、
`docs/plan/completed/すばやさ早見表_シーズン別集計調査.md` が残した「シーズン別集計」の
宿題に対する回答でもある(Supabase側の集計をseason粒度に作り直すのではなく、
**元からseason粒度を持つOP.GG統計に一本化する**ことで解決する)。

## 決定事項(ユーザー確認済み)

1. **早見表を構成する情報はOP.GG統計のみとする。** Supabaseの `suggestions`(持ち物・技・
   性格の採用率)と `combined_species_usage()`(種族使用率)は、この画面では使わない。
   両テーブル/RPC自体は他画面(`api/team-suggestions.ts`・`api/move-adoption.ts`・
   `box/[id]`)が使い続けるので削除しない。
2. **表示する母集団は、該当シーズンの使用率上位 N 体(既定100)。**
3. **メガフォルムは、基本フォルムがtop Nに入っていれば無条件で同伴させる。**
   メガフォルム自身はtop Nの枠をカウントしない(top Nは基本フォルムだけで数える)。
4. **行内のポケモンは使用率順(=OP.GGの順位の昇順)に左から並べる。**
5. **すばやさ計算で考慮する特性・もちもの・わざは、そのシーズンの種族別採用率が
   閾値(既定20%)以上のものだけ。** 特性も対象に含める(OP.GGは `abilities` を持つため、
   Supabase時代に特性を除外していた理由が消える)。
6. **振り方(最速/準速/無振り/最遅)の表示条件**。すべて種族別のOP.GG統計から判定する。
   閾値は既定20%(パラメータ化する)。
   - 最速 : S努力値32の合計率 ≥ T **かつ** S上昇性格の合計率 ≥ T
   - 準速 : S努力値32の合計率 ≥ T **かつ** S無補正性格の合計率 ≥ T
   - 無振り: S努力値0の合計率 ≥ T **かつ** S無補正性格の合計率 ≥ T
   - 最遅 : S努力値0の合計率 ≥ T **かつ** S下降性格の合計率 ≥ T
   - **どの条件も満たさない種族は「無振り」だけを表示する**(top Nに入っているのに
     表から丸ごと消える種族を作らないためのフォールバック)。
   - 複数条件を満たす場合はすべて表示する(最速と準速が両方出るのは正常)。
7. **シーズンの参照先**
   - 個体編集の「すばやさ調整」モーダル(`?embed=1`): 常に**現シーズン**
     (KVマニフェストの `currentSeasonId`)。
   - データページの「すばやさ」タブ: **URLで指定されたシーズン**。
   - **データタブのシーズン「すべて」は廃止する。** 両者の仕組みを共通化する。
8. **閾値・件数はすべてパラメータ化**して後から調整できるようにする(既存の
   `src/config/speed-chart.json` に集約する。手で編集する唯一のファイルという位置づけを維持)。

## 前提として確認済みの事実(実装前の調査結果)

- `<version>:season:<dir>:list` KVキー1本に、そのシーズンの**全種族の**
  `moves/items/abilities/natures/evs`(各行に `rank`・`usageRate`)が入っている
  (`scripts/opgg/fetch-champions-usage.mjs` の list 生成箇所)。SSRはKV 1読みで足りる。
- OP.GGの努力値は**0〜32スケールでそのまま格納されている**(`api/opgg-usage-evs.ts` の
  コメントに実測の記録あり)。S32/S0の判定がそのまま書ける。
- **同時分布は取れない。** OP.GGの「努力値」欄と「性格補正」欄は独立した周辺分布なので、
  上の条件は書かれたとおりの独立判定になる(「S32かつS上昇性格である型の率」では判定できない)。
- **OP.GGにメガ専用のページは無い**(`config/opgg-champions-pokemon-map.json` にメガのslugは
  0件。`opgg-usage.ts` の `resolveOpggSpeciesName` が基本フォルムへ畳む)。決定3はこの制約に対する回答。
- **使用率の数値(%)は種族単位では公開されていない。順位だけが取れる。**
  tierページ(`https://op.gg/ja/pokemon-champions/tier`)の埋め込みJSONに
  `seasons[].formats[].rankings[] = {rank, key, name, pokemon:{..., isMegaEvolutionBasePokemon, base_key}}`
  があり、2026-09-15時点で262件・現シーズンは `m-6`。
  現行の取得スクリプトは**この順位を保存していない**(`slugs()` のHTML出現順に依存)。
  → fetcherに順位の永続化を足す(下記タスク1)。
- 現行のシーズンセレクタは**ハリボテ**(`SPEED_CHART_SEASON_FACADE`、M-5止まりでm-6に未追随)。
  実データ化でこの静的テーブルは削除される。
- `src/pages/speed-chart/index.astro` と `src/pages/data/speed-chart.astro` はSSRロジックが
  ほぼ丸ごと重複コピーになっている。決定7の「仕組みを共通化」はここも含む。

## 実装タスク

### 1. 取得スクリプトに「使用率順位」を持たせる

- `scripts/opgg/fetch-champions-usage.mjs`: tierペイロードの
  `seasons[].formats[single].rankings[]` をパースし、slug(= `key`)→ `rank` の対応を得る。
  `:list` の各要素と、マニフェストの `season.pokemon[]` に `rank` を持たせる
  (`{slug, name, rank}`)。取得対象slugの順序もこの順位に従わせる(`--limit` が
  「上位n体」の意味になる)。
- `scripts/opgg/seed-local-usage.mjs`(合成シード)も同じ形に合わせる。ローカル検証は
  こちらを使う(本番相当の実データは日次GitHub Actionsが投入する)。
- `src/lib/opgg-usage.ts`: 型(`OpggUsageSeason.pokemon` / `OpggUsageList.pokemon`)に
  `rank` を追加。**`rank` を持たない旧データでも落ちないこと**(未定義なら配列順を順位として
  扱うフォールバック)。

### 2. 純粋関数(`src/lib/speed-chart.ts`)

DOM・Node APIに依存しない既存方針を維持する。追加する関数(名前は提案):

- `sumSpeedEvRate(evs, evValue)` — `evs` 行のうち `values.speed === evValue` のものの
  `usageRate` 合計(OP.GGの `usageRate` は42.5のようなパーセント数値、configは0.2のような
  比率で持つので変換する)。`values.speed` が null の行は除外する。
- `sumNatureEffectRate(natures, effect)` — `NATURE_STAT_MODIFIERS` から
  up/neutral/down を機械的に判定して合計率を出す(性格名をハードコードしない。
  既存 `getNatureSpeedEffect` を使う)。
- `decideSpeedSpreads(single, thresholds)` — 決定6の4条件を判定して
  `SpeedSpreadKind[]` を返す。空なら `['none']`(フォールバック)。
- `isAdoptedByOpggRate(rows, name, threshold)` — 決定5の採用率判定(items/moves/abilities
  共通)。該当行が無ければ false。
- `buildOpggSpeedChartPopulation(...)` — シーズンのランキング(上位N)・
  `pokemon-core.json`・`speed-modifier-learnset.json`・`mega-stones.json` から
  `SpeedChartForm[]` を組む。メガは決定3のとおり基本フォルムの順位を継承し、
  同順位内では基本フォルム→メガの順に並ぶようにする。
- `buildSpeedChartRows(...)` — 既存の行組み立てを、上記の判定結果を受け取る形へ変更する。

削除・置換されるもの: `AdoptionRateData` とその一族(`isAdoptedByRate`・
`isAdoptionRateFilterActive`・`isMinSpreadAdopted`)、`speciesAdoptionRate` /
`minSpreadAdoptionRate` 設定、`SpeciesUsageCounts` ベースの使用率順ソートは
順位(rank)ベースへ置換。

**維持するもの**(消さないこと): `applySpeedMultiplier` / `applySpeedRank` /
`applySpeedModifier`、`SPEED_SPREADS`、`getEffectiveSpeedModifiers` と
`findUnknownDisabledModifierNames`(`disabled` 設定とそのテスト)、`hiddenEntries` /
`hiddenPokemon` の採否、行内の「族(種族値)+配分+倍率ごとに1行」というグループ構成、
実測幅による「+N件」足切り、右カラム「この個体」(`owned-panel.ts`)の全機能。

### 3. 設定ファイル(`src/config/speed-chart.json`)

```jsonc
{
  "population": { "topN": 100 },
  "adoptionRate": { "threshold": 0.2, "appliesTo": ["items", "moves", "abilities"] },
  "spreadConditions": { "evRateThreshold": 0.2, "natureRateThreshold": 0.2 }
}
```

- `adoptionRate.enabled` / `minSampleSize` は、OP.GG統計にサンプル数が無いため廃止する
  (k-匿名性はOP.GG側の集計に委ねる)。`_readme` は現行と同じ流儀で書き直す。
- `speciesAdoptionRate`・`minSpreadAdoptionRate` は削除(topNと決定6が置き換える)。
- `disabled`・`hiddenEntries`・`hiddenPokemon` はそのまま残す。

### 4. SSRとページ

- `src/pages/speed-chart/index.astro` と `src/pages/data/speed-chart.astro` の
  重複したSSRを共通モジュール(例 `src/lib/speed-chart/ssr.ts`)へ切り出す。
- SSRの処理: シーズンを決める(モーダル=`currentSeasonId` / データタブ=`?season=`、
  未指定や不正値は現シーズン)→ `getOpggUsageList` で1読み → top N と決定3のメガを解決 →
  **決定5・6の判定までSSRで済ませ、コンパクトな結果だけを埋め込む**
  (全種族の全カテゴリ生データをページに埋めない。ペイロード肥大を避ける)。
- Supabaseクエリ(`suggestions` / `combined_species_usage`)はこの2ページから削除。
- シーズン選択肢はKVマニフェスト(`sortOpggSeasons`)から作る。`SPEED_CHART_SEASON_FACADE` と
  「すべて」の選択肢、`?reg=` パラメータは廃止。**シーズン変更はページ遷移**
  (`?season=<id>`)で行う(母集団がサーバ側データになったため、クライアント再計算では
  シーズンを切り替えられない)。旧 `?reg=` URLは無視して現シーズンにフォールバックする。
- `src/lib/speed-chart-validation.ts` の `resolveSpeedChartRegulation` をシーズン解決へ置換。
- KVにデータが無い場合(ローカル未投入・取得失敗)は、現行と同じく**空状態を表示して
  500にしない**。

### 5. テスト

- `tests/speed-chart.test.ts` を新仕様に更新する。決定6の4条件それぞれの境界
  (閾値ちょうど / 1つだけ満たす / どれも満たさずフォールバックで無振りのみ)、
  決定3(基本フォルムがtop Nに入るときだけメガが出る・メガは枠を消費しない)、
  決定4(順位昇順)、決定5(閾値未満の特性・持ち物・技が出ない)を最低限カバーする。
- `disabled` の実在チェックテストは維持する。

## 検証

- ローカルKVへ `node scripts/opgg/seed-local-usage.mjs` で合成データを投入してから
  `npm run dev` → `npm run shot` / `npm run probe` で実測する
  (OP.GGの実データはローカルKVに入っていないことがある。memoryの
  「opgg-usage dev server stall」の副作用)。
- 行数が「多すぎる」を解消できているかは実測で確認する(修正前後のスクリーンショット比較)。
