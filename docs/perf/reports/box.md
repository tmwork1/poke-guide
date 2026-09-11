# /box・/box/[id]: パフォーマンス評価と改善計画

## 調査範囲と前提

本レポートは **計測を一切行わず**、コード読解と `docs/perf/dashboard.md` の既存実測値のみに基づく。理由: 他の5体のadvisorが同一リポジトリで並列に動作しており、dev serverへの同時アクセスは計測値を汚染するため(依頼側の制約)。

対象は `/box`(一覧)と `/box/[id]`(個体編集)、および両者が共有する `src/lib/box-id/*`・`src/lib/owned-pokemon*`・関連API(`src/pages/api/owned-pokemon.ts`, `owned-pokemon/[id].ts`)。読んだ主なファイルは以下の節で行番号付きで示す。

推測と事実は明確に分ける。コードで確認した事実には `ファイルパス:行番号` を付す。因果(「これがdashboardのこの数値の主因である」という主張)は、計測で裏付けられていない限り必ず「要計測」と明記する。

## 現状評価

`docs/perf/dashboard.md` から本画面に関連する行を引用する(2026-09-09時点、dev server対象、本番との絶対値比較は不可)。

| 優先度 | 画面/操作 | 目標(ms) | 実測(ms) | 超過率 | 備考 |
|---|---|---|---|---|---|
| 🟡 注意 | ボックス一覧を表示 | 1500 | 2035 | 1.36x | |
| 🟡 注意 | もちもの選択の自動保存 | 1200 | 1461 | 1.22x | 700msデバウンス+PUT往復の合算値 |
| 🟡 注意 | もちもの保存のPUT往復 | 500 | 505 | 1.01x | デバウンスを含まない、PUTのネットワーク往復のみ |
| 🟢 達成 | 個体詳細を表示 | 5000 | 1369 | 0.27x | 目標はPyodide前提の緩い値(実際には育成タブはPyodideを読まない、S2参照) |

**「ボックス一覧を表示」シナリオの終点定義に注意が要る。** `tests/perf/scenarios/box.perf.spec.ts:36-47` は `#owned-pokemon-list a[href^='/box/']`、つまり**最初の1枚のカードリンクがDOMに現れた時点**を終点にしている。これは `renderList()`(`src/pages/box/index.astro:339`)が最初のバッチの先頭要素を`appendChild`した瞬間であり、48件全部の描画完了でも画像の読み込み完了でもない。したがって2035msの大半は「ページ遷移〜JSモジュール評価〜`/api/owned-pokemon`の初回応答〜最初の`renderCard()`呼び出し」に集約されると考えられる(発見D参照)。後述の発見C(全件再描画)は、このシナリオが捉えている区間には現れない別の問題として区別して扱う。

「もちもの保存のPUT往復 505ms」は目標500msとの差がわずか5msだが、`docs/plan/damage-calc-selection-perf.md` のラウンド3時点で「さらに縮めるならAPIハンドラとDB書き込みの内訳を取る必要がある」と持ち越しになっていた項目である。本レポートの発見Bがその内訳(サーバー側で実際に何が起きているか)を提供する。

## 発見

### 発見A(最重要・box/[id]限定・未修正): `damage-calc.ts` の全カード再計算がyield対策を持たず、`/damage-calc` の`matchup-card.ts`で修正済みの同型バグが再現している

**機序。** `/box/[id]` のダメージ計算カード(相手ビルドの「行」、ユーザーが複数追加できる)は、Pyodideエンジンの初期化が完了した瞬間に一括で再計算される。

```ts
// src/lib/box-id/damage-calc.ts:3506-3514
function combinedDamageEngineProgress(progress: EngineProgress): void {
	renderEngineStatus(progress);
	if (progress.status === "ready") {
		void recalcStats();
		for (const row of rows) {
			void recalcRow(row);
		}
	}
}
```

同じパターンが `registerDamageCalcBridge` 経由で他モジュールから呼べる一括再計算にもある。

```ts
// src/lib/box-id/damage-calc.ts:879-883
recalcAllRows: () => {
	rows.forEach((row) => {
		void recalcRow(row);
	});
},
```

`recalcRow()`(`src/lib/box-id/damage-calc.ts:1671-1754`)は各行につき以下を`Promise.all`で並行実行する。

```ts
// src/lib/box-id/damage-calc.ts:1703-1718
const [seqResult, statsResult, chargedRepeatResults] = await Promise.all([
	calcLethalSequence(attackerSpec, defenderSpec, safeAttacks, options),
	calcStats(defenderSpec),
	Promise.all(chargedAttackIndexes.map((index) => { ... })),
]);
```

`calcLethalSequence`/`calcStats`(`src/lib/pyodide-engine.ts:1475`, `:1432-1448`)は`async function`だが、内部で実際にI/Oを待つ`await`は無く、`callEngineJsonFn()`という**完全に同期的な関数**を呼んでいるだけである。

```ts
// src/lib/pyodide-engine.ts:1349-1362
function callEngineJsonFn<T>(fn: () => string): T {
	let resultJson: string;
	try {
		resultJson = fn();          // ← Pyodide(Wasm)への同期呼び出し。ここが重い
	} catch (err) { ... }
	return JSON.parse(resultJson) as T;
}
```

つまり`await calcLethalSequence(...)`は「マイクロタスクを1つ挟むだけ」で、ブラウザに描画の機会を返さない。`damage-calc.ts`全体を検索したが `yieldToBrowser`(`setTimeout(resolve, 0)`でマクロタスク境界を作る関数)は**1箇所も存在しない**。

これは `docs/plan/damage-calc-selection-perf.md` の「発見A」(`/damage-calc`の`matchup-card.ts`で2026-09-11に特定・修正済み: `Promise.all(cards.map(async...))`がyield対策を無効化する)と**全く同型のバグ**である。相違点は、`/damage-calc`側は`Promise.all(cards.map(async...))`、こちらは`for (const row of rows) { void recalcRow(row) }`という違いだけで、「複数カード分の同期Pyodide計算がブラウザに制御を返さないまま連続実行される」という結果は同じになる(`void`で投げているためawaitしていないだけで、各`recalcRow`呼び出しが生成するマイクロタスク連鎖はイベントループの同じフェーズ内で消化されうる)。

**発生タイミング。** `combinedDamageEngineProgress`の`"ready"`分岐が発火するのは、①URLに`?tab=damage`が付いていて初期表示からダメージタブを開いた場合(`damage-calc.ts:3522-3525`)、②育成タブからダメージタブへ切り替える`pointerdown`を最初に受けた場合(`damage-calc.ts:3526-3532`、2026-09-09ラウンド2 S2で追加された遅延読み込み)のいずれか。いずれの経路でも、既に保存済みの相手カードが複数枚あるユーザーがダメージタブを開くたびに、**保存済み行数ぶんの同期Pyodide計算が一つの長いタスクとして走る**可能性が高い。

**影響範囲。** `/box/[id]`のダメージ計算カードを複数枚保存しているユーザー(耐久調整・複数対面の検討をする実利用者ほど該当しやすい)。カード枚数が多いほど、また1枚あたりの技列(`safeAttacks`)が長いほど悪化する。

**根拠との対応。** dashboardには`/box/[id]`のダメージタブ初期化を捉えるシナリオが無い(「個体詳細を表示」は育成タブの実数値算出まで、「ダメージ計算画面を初回表示」は別画面`/damage-calc`)。そのためこの問題は**現状の計測網で不可視**になっている(計測ギャップ、後述TODO参照)。

**対策案。** `/damage-calc`の`matchup-card.ts`で採用した対策(`for...of`ループ + 各行の計算後に`yieldToBrowser()`)を移植する。`combinedDamageEngineProgress`と`recalcAllRows`の両方を、`rows.forEach(row => void recalcRow(row))`ではなく`for (const row of rows) { await recalcRow(row); await yieldToBrowser(); }`相当に変更する。`recalcRow`自体は1行完結の関数なので、呼び出し元をasyncループに変えるだけで済み、`recalcRow`のシグネチャ変更は不要。

**推定効果。** `/damage-calc`での実測(`docs/plan/damage-calc-selection-perf.md`)では、5行(team選択相当)で最大フレームギャップが981ms→267ms(約73%短縮)。`/box/[id]`のダメージカードも複数枚保存可能な設計のため、同等の改善が見込める。ただし行数の実分布は未調査(要計測)。

---

### 発見B(重要): `updateOwnedPokemon()`が毎回「archetype分類」のためのDB往復をUPDATE本体の前に直列で挟んでいる

**機序。** もちもの選択などの自動保存は`saveNow()`(`src/lib/box-id/pokemon-edit-panel.ts:1274-1315`)から`updateOwnedPokemon(ownedPokemonId, payload)`(`src/lib/data/pokemon-repo.ts:148-166`)を呼び、`PUT /api/owned-pokemon/:id`(`src/pages/api/owned-pokemon/[id].ts:41-73`)を経由してサーバー側の`updateOwnedPokemon()`(`src/lib/owned-pokemon.ts:290-327`)に到達する。

```ts
// src/lib/owned-pokemon.ts:290-300
export async function updateOwnedPokemon(
  userId: string,
  id: string,
  input: OwnedPokemonRequestBody,
  supabase: SupabaseClient,
): Promise<OwnedPokemonResult<OwnedPokemonRecord | null>> {
  // PUTは「全項目を毎回送る」置換契約(このファイル冒頭のコメント参照)のため、
  // 差分判定はせず毎回無条件で再計算する。
  const archetypeId = await resolveArchetypeId(input, supabase);
  const { data, error } = await supabase
    .from('owned_pokemon')
    .update({ ... })
```

`resolveArchetypeId()`(`src/lib/owned-pokemon.ts:122-142`)は`classifyArchetype()`(純関数、DB非依存)の後に`findOrCreateArchetype(key, supabase)`(`src/lib/archetypes.ts:36-74`)を呼ぶ。この関数は

```ts
// src/lib/archetypes.ts:40-59
const { data: existing, error: selectError } = await matchKey(
	supabase.from('archetypes').select('id'),
	key,
).maybeSingle();
...
if (existing) return { ok: true, data: existing.id as string };
const { data: inserted, error: insertError } = await supabase
	.from('archetypes')
	.insert({ ... })
```

**Supabaseへの独立したSELECT(既存なら1回、新規keyならさらにINSERT)を発行してから初めて`owned_pokemon`の本体UPDATEに進む。** つまり1回のPUTで最低でも「archetypesのSELECT」→「owned_pokemonのUPDATE」の**2回の順番待ちDB往復**が発生し、種族・持ち物が過去に一度も出現していない新規keyの場合はさらに INSERT が挟まって3往復になる。

加えて、`PUT`ハンドラは`getSessionUser()`(`src/pages/api/owned-pokemon/[id].ts:42`)を先に`await`しており、これも内部で`supabase.auth.getUser()`(`src/lib/user-session.ts:73`)というSupabaseへの独立したネットワーク往復を行う。archetype分類は`userId`にもセッションにも依存しない(リクエストボディの`species_name`/`item_name`等だけで決まる)にもかかわらず、現状は認証確認 → archetype解決 → 本体UPDATE の3段が**完全に直列**になっている。

**影響範囲。** `owned_pokemon`への全PUT(もちもの選択・育成パネルの入力自動保存・ダメージカードの`scheduleRowSave`等、`updateOwnedPokemon`を通る経路すべて)。ローカルSupabase(devサーバー)でもこの直列構造は変わらず、「もちもの保存のPUT往復 505ms(目標500ms、超過率1.01x)」の内訳の一部として説明できる。

**対策案。** `archetypesのSELECT/INSERT`は`userId`を必要としないため、`getSessionUser()`の`await`と並行して(`Promise.all`で)先に走らせられる。具体的には`PUT`ハンドラで「ボディのパースと`classifyArchetype()`」を`getSessionUser()`と並列化し、`resolveArchetypeId`の実行を早める(サーバー側での往復回数そのものは変わらないが、認証確認の往復と重なる分だけ**体感の直列時間**を1往復ぶん削れる)。より根本的には、`species_name`/`item_name`が直前の保存値と変わっていない場合(もちもの選択以外のフィールド変更、例えば技構成だけの編集)はarchetype再計算自体が不要なはずだが、PUTが「全項目置換」契約でサーバー側に直前値を持たないため、差分判定には追加のSELECTが要る。差分判定を足すとSELECTが1回増えて往復が悪化する可能性があるため、**並列化のほうが safe な第一手**。

**推定効果。** ローカルSupabase相手でも往復1回分(実測比較対象が無いため定量値は「要計測」)。本番相当のレイテンシ(リージョンをまたぐSupabase)ではさらに効果が大きくなると推測される(要計測)。

---

### 発見C(box一覧・大量保有時のみ顕在化・未修正): `renderList()`がページング取得のたびに一覧全体を`innerHTML = ""`で破棄して再構築する

**機序。** `/box`の一覧取得は48件ずつのページングで、取得後に毎回`renderList()`を呼ぶ。

```ts
// src/pages/box/index.astro:339-355
function renderList(): void {
	const filtered = allPokemon.filter((p) => matchesSearch(p, searchInput.value.trim()));
	const sorted = sortPokemon(filtered);
	listRoot.innerHTML = "";
	...
	for (const p of sorted) {
		listRoot.appendChild(renderCard(p));
	}
}
```

`loadList()`は`hasMorePokemon`が真である限り、1フレーム後に次の48件を取得し続ける自己再帰になっている。

```ts
// src/pages/box/index.astro:397-404
} finally {
	loadingMore = false;
	if (hasMorePokemon && loadedNextBatch) {
		// 描画を1フレーム譲り、48件ずつ画面へ追加しながら次の取得を始める。
		window.requestAnimationFrame(() => void loadList());
	}
}
```

そして`loadList()`の末尾は毎回`renderList()`を呼ぶため、**保有数が48件を超えるユーザーでは、2バッチ目の取得完了時に既に描画済みの48件を含めて`innerHTML = ""`で全部破棄し、96件を最初から作り直す**。3バッチ目なら144件、n件保有なら合計の描画作業量は48+96+144+…という**O(件数²)**になる。

`renderCard()`が呼ぶ`renderBoxPokemonCard()`(`src/lib/owned-pokemon-card.ts:140-266`)は1枚につき、`<a>`直下に複数の`createElement`(artwork/itemBadge/body/nameRow/movesGrid等、最大10要素超)を組み立て、かつ`applyCardArtwork()`・`applyItemBadge()`・技タイプ色の反映・`calculateActualStats()`によるtitleツールチップ計算という**非同期チェーンを1枚につき最大3系統**開始する。`innerHTML = ""`で古い`<img>`を破棄しても、新しい`<img>`にはブラウザのHTTPキャッシュ/ディスクキャッシュが効く可能性が高くネットワーク再取得そのものは軽いと考えられるが、DOM生成・decode・レイアウトのやり直しコストは確実に重複して発生する。

**この問題が今のdashboard値(2035ms)に直接現れていない理由。** `box.perf.spec.ts:36-47`の終点は「最初の1枚のカードリンクがDOMに現れた瞬間」であり、これは1バッチ目の`renderList()`内の最初の`appendChild`で満たされる。2バッチ目以降の全件再構築はこの終点より**後**に走るため、現在の計測はこの問題を捉えていない。

**影響範囲。** 保有数が48件を超えるユーザー(サービスの性質上、育成データを継続的に貯める用途のため上位ユーザーほど該当しやすい)。初回表示後もバックグラウンドで断続的にメインスレッドが再描画に食われ続け、その間の検索入力・並べ替え操作・スクロールの反応が鈍る体感につながり得る(要計測)。またdashboardに載っていない「一覧が完全に静止するまでの時間」という観点そのものが欠落している。

**対策案。** 新規バッチ取得時は「差分の48件だけを`appendChild`する」形に変える。ただし現状の`renderList()`はフィルタ・ソートを**毎回全件に対して再適用**する設計(検索語入力や並べ替え変更時は全体再構築が必須)なので、「新規データ追加時の追記」と「検索・並べ替え変更時の全体再構築」を分岐させる必要がある。並べ替えが`updated_at`降順(既定)の場合は新規取得分が常に末尾に来るとは限らない(更新順ソートのため新着個体が先頭に来ることもある)点に注意。安全な最小対応は「新規バッチ取得後は現在の検索語が空、かつソートが規定の`updated_at`降順のときのみ差分追記、それ以外は現状どおり全件再構築」のような限定的な最適化になる。

**推定効果。** 保有数依存。48件のユーザーには効果なし、200件のユーザーなら再構築量が約4分の1(48+96+144+192 → 48×4)に減る計算(要検証)。

---

### 発見D(軽微〜中・box一覧限定・未修正): `species-dex.ts`の静的importが、既定オフの並べ替え機能のために148KBのマスターデータを`/box`のJSバンドルへ毎回同梱している

**機序。** `/box`のクライアントスクリプトは並べ替え(番号順・タイプ順)のために`resolveDexNo`/`resolveSpeciesTypes`を使う。

```ts
// src/pages/box/index.astro:157
import { resolveDexNo, resolveSpeciesTypes } from "../../lib/species-dex";
```

```ts
// src/lib/species-dex.ts:15
import pokemonList from '../../public/master-data/autocomplete/pokemon.json';
```

`public/master-data/autocomplete/pokemon.json`は148.2KB(実測: `ls -la`)。この`import`は**トップレベルの静的import**であり、Vite/Astroのビルド時にJSモジュールとしてインライン化され、`species-dex.ts`をimportするモジュール(=`/box`のページスクリプト)のJSバンドルの一部として、**並べ替えを一度も使わないユーザーにも毎回転送・パース・評価**される。しかも`/box`の既定の並べ替えは`updated_at`(更新順、`src/pages/box/index.astro:66`のoption順で先頭、`sortSelect.value`の初期値)であり、`resolveDexNo`/`resolveSpeciesTypes`はユーザーが明示的に「番号順」または「タイプ順」に切り替えない限り一度も呼ばれない(`sortPokemon()`, `src/pages/box/index.astro:285-319`)。

これは`docs/perf/dashboard.md`の「2026-09-09 ラウンド2 S1/S2」で修正された「使っていない画面のためにマスターデータを先読みしている」パターン(`/data`の235件全件SSR、`/box/[id]`育成タブでのPyodide先読み)と**同種の無駄**である。ただし対象が148KBと比較的小さい点、影響ページが`/box`一覧に限られる点でS1/S2ほど劇的ではない。

なお同じ`pokemon.json`を静的importしている箇所は他にもある(`src/lib/battle-data-card.ts:7`, `src/lib/opgg-usage.ts:3`)。これらは`/box/data`・`/data`向けであり本レポートの対象外だが、同じ問題が複数箇所に存在する可能性を示す傍証として記録する。一方`pokemon-master-data.ts`の`loadBaseStatsMap`/`loadMoveTypeMap`(`owned-pokemon-card.ts:4,51-52`が使用)は`fetch()`ベースの非同期ロードで、カード自体を待たせない設計になっている(`owned-pokemon-card.ts:48-50`のコメントに明記)。この非同期パターンと対照的に、`species-dex.ts`だけが静的importという別方式になっている。

**根拠(未確認・要計測)。** 静的importされたJSONがdev/本番いずれのビルドでも同じチャンクに実際にバンドルされているか、Astroの自動コード分割で並べ替え未使用時に遅延ロードされていないか、という**実際のバンドル結果**は本調査(コード読解のみ)では確認できていない。Viteの静的import解析上は分割の余地が薄い(top-levelのconst importは基本的に同一チャンクに含まれる)と考えられるが、断定はしない。

**影響範囲。** `/box`一覧の初回スクリプト評価コスト・転送量。前述のとおり、この画面の測定シナリオは「最初のカードが出た瞬間」を終点にしており、JSモジュール評価はその前段(スクリプト実行〜`loadList()`呼び出し)に位置するため、**理論上はdashboardの2035msに含まれ得る**。ただし寄与度は未計測。

**対策案。** 「番号順」「タイプ順」を選んだときだけ`await import('../../lib/species-dex')`で動的importする(`sortPokemon()`内、`sort === 'dex_no' || sort === 'type'`の分岐で遅延解決)。もしくは`species-dex.ts`自体を`pokemon-master-data.ts`と同じ`fetch()`ベースの非同期ロードに書き換える(`resolveDexNo`/`resolveSpeciesTypes`の呼び出し元は`team-validation.ts`からは意図的に使わせない設計(`species-dex.ts:11-12`のコメント)なので、影響範囲は`/box`一覧・チーム編成の並べ替え関連に限定されると考えられるが、全呼び出し元の洗い出しは未実施)。

**推定効果。** 148KB分の転送・パース・評価コストを、並べ替えを使わない大多数のページビューから除去できる。定量的な体感時間への寄与は要計測。

---

### 発見E(中・box/[id]・未修正): `/box/[id]`のSSRが、種族選択ダイアログの並び順にしか使わないOPGG KVの読み取りをページ応答全体の前提条件にしている

**機序。**

```ts
// src/pages/box/[id].astro:40-56
const opggRankedSpeciesNamesPromise = (async () => {
	try {
		const manifest = await getOpggUsageManifest(env.OPGG_USAGE);
		const currentSeason = sortOpggSeasons(manifest)[0];
		const seasonList = currentSeason
			? await getOpggUsageList(env.OPGG_USAGE, currentSeason)
			: null;
		return seasonList?.pokemon.map((entry) => entry.name) ?? [];
	} catch (err) { ... return []; }
})();
...
// src/pages/box/[id].astro:75
const opggRankedSpeciesNames = await opggRankedSpeciesNamesPromise;
```

`getOwnedPokemon()`(個体本体の取得)とは並行して開始されるが、75行目で**個体本体の取得結果と合流する前にawaitされ**、その後のJSX描画(76行目以降)全体がこの完了を待つ。取得内容は`PokemonSettingsModalHost`(`:142`)経由で種族選択ダイアログの並び順にのみ使われ、ダイアログを開かない限り一度も参照されない。

処理自体は`getOpggUsageManifest`→(現在シーズンが判れば)`getOpggUsageList`という**2回の直列KV読み取り**(`src/lib/opgg-usage.ts`)で、シーズン一覧を先に読まないと対象シーズンのファイル名が決まらないため、この直列性自体は構造上の制約と考えられる(並列化の余地は薄い)。

**根拠(未確認・要計測)。** dashboardの「個体詳細を表示」1369msは目標5000msに対し余裕があり、現時点でこの直列KV読み取りが体感を悪化させているとは言えない。またdashboard自身の注記(「2026-09-08: `OPGG_USAGE`を`remote: false`に変更、ローカルKVは空スタート」)のとおり、**ローカルdevでは空KVからの即時応答になっているため、この経路のコストがdev計測にはほぼ現れない**。本番のCloudflare KV相手ならレイテンシが乗る可能性があるが、本番での実測データは無い。

**影響範囲。** `/box/[id]`のSSR応答時間(本番のみ、要計測)。種族選択ダイアログを一度も開かない大半のページビューでも毎回このKV往復を待つ。

**対策案。** OPGGランキングの取得をSSRの必須経路から外し、①クライアント側で種族選択ダイアログを開いた瞬間に`fetch`する、または②SSRの`Astro.response`を`opggRankedSpeciesNamesPromise`の完了を待たずに返し、ダイアログ側コンポーネントに「並び順は後から差し替わり得る」設計を許容する(既定順=更新日時順や五十音順などのフォールバックを先に出す)。後者はUXレビューが要る(並び順が一瞬変わって見える可能性)。

**推定効果。** 本番のKVレイテンシ次第(要計測)。現状ローカルdevでは効果を確認できない。

## 優先順位付きTODO

1. **`damage-calc.ts`の全カード再計算にyield対策を追加する(発見A)。** `combinedDamageEngineProgress`(`damage-calc.ts:3506-3514`)と`recalcAllRows`(`damage-calc.ts:879-883`)の`rows.forEach/for`ループを、`/damage-calc`の`matchup-card.ts`と同じ「逐次`for...of` + 各行後に`yieldToBrowser()`」へ変更する。
   - 推定コスト: 小(既存の`recalcRow`単体はそのまま、呼び出し元ループのみ変更)。
   - リスク: 低。ただし`recalcRow`内で参照される`row`の状態(削除された行等)が非同期化により変わる可能性はゼロではないため、行削除と同時に走った場合の挙動確認は要る。
   - 検証方法: `npm run probe --eval`でPerformance Observerのlongtask + rAFフレームギャップを実測(`docs/plan/damage-calc-selection-perf.md`と同じ手法)。相手カードを複数枚(3〜6枚)保存した個体でダメージタブを開き、修正前後を比較する。

2. **`/box/[id]`のダメージタブ初期表示・タブ切替を計測網に追加する(発見Aの計測ギャップ埋め)。** `tests/perf/scenarios/box.perf.spec.ts`に、複数の相手カードを持つ個体で「ダメージタブへの切替」または「`?tab=damage`初期表示」を計測するシナリオを追加する。
   - 推定コスト: 中(テストデータとして複数カードを持つ使い捨て個体の用意が要る)。
   - リスク: 低。
   - 検証方法: シナリオ追加自体が検証。目標タイムはinteractionのAPI呼び出しなし版(300ms)を基準に、Pyodideエンジンが既に初期化済みの状態での再計算時間として設定する。

3. **`updateOwnedPokemon()`のarchetype解決を`getSessionUser()`と並列化する(発見B)。** `PUT /api/owned-pokemon/:id`ハンドラで、認証確認と`resolveArchetypeId()`を`Promise.all`で同時に走らせる形に再構成する。
   - 推定コスト: 中(`owned-pokemon.ts`の関数分割、`[id].ts`のハンドラ再構成、`tests/db/owned-pokemon-lib.test.ts`への影響確認)。
   - リスク: 中。認証失敗時にarchetype解決の結果を捨てる経路が増える(無駄なDB書き込みにはならないが、認証前にPOSTボディの内容でDBへSELECT/INSERTを打つことになるため、未認証ユーザーからの大量リクエストでarchetypesテーブルへの書き込みが誘発され得る点は設計上要検討。同一originチェック・レートリミットとの順序を含め再設計が要る)。
   - 検証方法: `box.perf.spec.ts`の`box-item-select-autosave-request`(PUT往復505ms)を再計測。

4. **`box/index.astro`の`loadList()`を差分追記方式に変更する(発見C)。** 新規バッチ取得時、検索語が空かつソートが既定(`updated_at`降順)の場合に限り、`renderList()`全体再構築の代わりに新規取得分だけ`appendChild`する。
   - 推定コスト: 中(既存の全件再構築ロジックとの分岐、ソート変更・検索変更時の挙動を壊さないための回帰確認)。
   - リスク: 中。ソート・フィルタの一貫性を壊すと表示順が狂う。
   - 検証方法: 48件超の所持データを持つ使い捨てアカウント(要準備)で、2バッチ目以降のDOM操作回数・メインスレッド占有時間を`npm run probe --eval`のPerformance Observerで比較。併せて`box.perf.spec.ts`に「一覧が完全に静止するまでの時間」を捉えるシナリオを追加する(現状のシナリオは最初の1枚出現までしか見ていない)。

5. **`species-dex.ts`のimportを遅延化する(発見D)。** `box/index.astro`側で`resolveDexNo`/`resolveSpeciesTypes`を`sortPokemon()`内の動的importに変更するか、`species-dex.ts`自体を`pokemon-master-data.ts`と同じ`fetch()`ベースに書き換える。
   - 推定コスト: 小(動的import化のみなら小、`fetch()`化は他の呼び出し元(`team`関連)への影響確認が要るため中)。
   - リスク: 低〜中(`species-dex.ts`は同期APIとして設計されている箇所(`team-validation.ts`が意図的に使わない設計だが、他の同期呼び出し元が無いか要確認)があれば非同期化で影響が出る)。
   - 検証方法: 本番ビルド後の`/box`のJSチャンクサイズ比較(`npm run build`後の`dist`)、および`npm run probe --timing`でのスクリプト評価時間比較。

6. **`/box/[id]`のOPGGランキング取得をSSR必須経路から外す(発見E)。** 種族選択ダイアログを開いたタイミングでのクライアント取得に切り替える、またはSSR応答を待たせない設計に変更する。
   - 推定コスト: 中(ダイアログ側の初期順序フォールバック設計、UXレビューが要る)。
   - リスク: 中(並び順が一瞬変わって見える可能性、要UXレビュー)。
   - 検証方法: 本番相当のOPGG_USAGE KV(`remote: true`または本番デプロイ)でのSSR応答時間比較。**ローカルdevでは空KVのため効果が測定できない点に注意**(この制約自体をdashboardの計測手法の限界として記録しておく)。

## 確度の低い仮説(計測で確かめるべきもの)

- **発見Dが実際に「ボックス一覧を表示」2035msの内訳としてどの程度を占めるか。** 静的importされたJSONが実際にどのチャンクに含まれ、初回スクリプト評価のどの段階で評価されるかは未計測。ネットワークウォーターフォール・Coverageタブ等での確認が要る。
- **48枚のカードが要求する画像(icon WebP + medium WebP、持ち物アイコン含め最大3枚/カード)が、dev serverの同時接続数上限で直列化し、初回体感を遅らせている可能性。** ただし`box.perf.spec.ts`の終点(最初のカードリンク出現)には影響しないため、仮に事実でも現在のdashboard値の説明にはならない。「一覧が完全に静止するまでの時間」を計測すれば見える可能性がある。
- **`card-delete-mode.ts`が48件超のカードそれぞれに長押し用リスナーを登録するコスト。** 軽微と判断したが未計測。
- **発見Bの並列化による実際の短縮幅。** ローカルSupabase・本番Supabaseそれぞれでの実測が要る。往復1回ぶんが具体的に何msかはコード読解だけでは分からない。
- **発見Cの体感への影響が「何件保有から」問題になるか。** 48件・96件・200件それぞれでの実機プロファイルが要る。
- **発見Eのローカル/本番差。** ローカルdevのOPGG_USAGE KVが空である前提(`docs/perf/dashboard.md`の既知の副作用)により、この発見は本番環境でしか検証できない。

## 設計意図コメントの尊重(見つかったもの)

- `owned-pokemon-card.ts:48-50`: 「カードはこれらを待たず同期的に返し、解決後に画像・titleを個別に流し込む」設計は**意図的**であり、変更対象ではない(発見Dの対策でもこの非同期パターン自体は壊さない)。
- `damage-calc.ts:3486-3488`: 「カードは先に描画し、エンジン完了時に`combinedDamageEngineProgress()`が結果だけを更新する」という設計も維持する。発見Aの対策(yield挿入)はこの「先に描画」という意図を壊さず、再計算そのものを分割するだけである。
- `bulk-adjust-solver.ts`冒頭の大量のコメント(性質1〜7)が示すとおり、耐久調整ソルバーは既に深く最適化済み(単調性・支配関係によるメモ化・ギャロップ+二分探索・`sequentialOnly`によるPyodide呼び出し半減・`YIELD_EVERY_N_CALLS`によるキャンセル応答性確保)。本レポートでは追加の指摘をしていない。なお「耐久調整」ボタン自体は`.stat-adjust-actions { display: none }`により現在ユーザーに見えていない(`docs/perf/dashboard.md`のS2参照)ため、この機能への投資は現状優先度が低い。
- `owned-pokemon.ts`冒頭のコメント: 「他人のデータへの唯一の砦」として`user_id`フィルタを徹底する設計。発見Bの対策(archetype解決の並列化)を実装する際も、この安全設計(INSERT時の`user_id`は必ずサーバー側で決定する等)を壊さないよう、認証確認自体を省略するのではなく**認証結果を待つ前にarchetype計算だけを並行開始する**(認証失敗時はarchetype計算の結果を使わずに401を返す)よう限定すること。
