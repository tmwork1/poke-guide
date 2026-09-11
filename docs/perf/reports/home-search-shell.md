# ホーム・検索・共有ページ・共通シェル: パフォーマンス評価と改善計画

## 調査範囲と前提

**このレポートは計測を一切行っていない。** dev serverの起動、`npm run probe` / `npm run shot` /
`npm run test:perf` の実行、アプリのUI操作は禁止指示に基づき行っていない(他の5体のadvisorが並列で
動いており、同時計測は数値を汚染するため)。根拠は以下の2つに限定する。

- `docs/perf/dashboard.md` に記録済みの既存実測値(2026-09-08〜09-09、dev server対象)
- 対象ファイルのコード読解(行番号付きで引用する)

数値の**大きさ**(「このリクエストが何ms掛かるか」)は計測が必要なため「要計測」と明記する。
一方、**構造上ムダな処理・二重処理が存在するか、直列か並列か**はコードから確定的に判定できるため、
そちらを報告の中心に置く。gzipサイズなど一部の数値は、リポジトリ内の該当ファイルをローカルで
`gzip`にかけて求めた静的なバイト数であり、実際のネットワーク計測ではない(区別して明記する)。

担当範囲: `/`(ホーム)・`/search`(検索)・`/share/[slug]`(共有ページ)と、この3画面を含む全画面が
使う共通シェル(`AppLayout.astro`・`AppHeader.astro`・`AppBottomNav.astro`・`global.css`・
Webフォント一式)。

## 現状評価(dashboardの数値)

| 優先度 | 分類 | 画面/操作 | 目標(ms) | 実測(ms) | 超過率 | 備考 |
|---|---|---|---|---|---|---|
| 🔴 要対応 | interaction | 検索: 実行して結果を表示 | 800 | 1450 | **1.81x** | 実行のたびに searches/events テーブルへログが1件追加される |
| 🟢 達成 | page-load | ホーム | 1500 | 1220 | 0.81x | |
| 🟢 達成 | page-load | 共有ページを表示 | 1500 | 1010 | 0.67x | SSRのみで完結する読み取り専用ページ |
| 🟢 達成 | page-load | 検索 | 1500 | 852 | 0.57x | |

🔴の「検索: 実行して結果を表示」だけが担当範囲内で唯一の要対応項目であり、備考にある
「searches/eventsテーブルへのログ書き込み」が本当に結果表示をブロックしているかを最優先で検証した
(結論: ブロックしている。発見A参照)。ホーム・共有ページ・検索の3つのpage-loadはいずれも🟢達成だが、
「ほぼ静的な画面がなぜ1000ms前後かかるのか」を共通シェルのコストという観点で掘り下げた
(次節・発見B〜発見Dで具体的な機序を示す)。

## 全画面共通シェルのコスト分析(「床」の仮説の検証)

依頼にあった「ホーム1220ms・共有ページ1010msは共通シェルの床を示している」という仮説について、
まずページ固有のコストを消去法で洗い出した。

- **ホーム(`src/pages/index.astro`)**: `<script>`を持たない。クライアントJSは`AppLayout.astro`が
  読み込む`setupSelectOnFocus()`と`setupItemIconFallback()`のみで、いずれも軽量なイベントリスナー
  登録に過ぎない。SVGアイコンはすべてインライン(`<svg>`直書き)で画像リクエストが無い。
  `OptionalHomeComponent`は`import.meta.env.DEV`のときだけ動的import(index.astro:13-15)されるが
  devでも軽量なデバッグ表示。
- **共有ページ(`src/pages/share/[slug].astro`)**: クライアントJS・Pyodideを一切使わない
  (`stats.ts`冒頭コメントで明記)。SSRで実数値計算まで完結する。
- **検索(`src/pages/search/index.astro`)**: 初期表示はフォームのSSRのみで、検索実行までは
  ネットワークI/Oが発生しない。

つまり3画面とも**ページ固有のロジックはほぼゼロ**で、実測値の大半は「AppLayout経由で全ページが
共通に払っているコスト」だと考えられる。コードから確認できた共通コストの内訳が発見B・発見Cで、
実際にどれだけの時間に変換されるかは計測が必要(確度の低い仮説の節を参照)。

## 発見

### 発見A(最重要・🔴要対応に直結): `/api/search`のログ書き込みが検索結果の返却を直列にブロックしている

`src/pages/api/search.ts`の`POST`ハンドラを行番号で追うと、検索結果自体はDB非依存で早々に確定するが、
レスポンスを返す前に2回のSupabase `insert`を逐次`await`していることが分かる。

```
94   for (const c of categories) {
95     const { hits, hitCount: categoryHitCount } = searchCategory(c, query); // ここで結果は確定(バンドル済みJSONのfilterのみ)
...
100  let sessionHash: string;
101  try {
102    sessionHash = await computeSessionHash(sessionId, secret, getUtcDateString()); // crypto.subtle、軽量
...
111  const supabase = await getSupabaseAdminClient();
...
119  const { error } = await supabase.from('searches').insert({...});   // ★DB往復その1(await)
...
130  const { error: eventError } = await supabase.from('events').insert({...}); // ★DB往復その2(await)
...
141  return jsonResponse({ data: { query, category: category ?? null, hitCount, results } }, 200); // ここでやっと返却
```

- `searchCategory()`(45-53行目)はビルド時にバンドルされた`autocomplete/*.json`(`pokemon.json`
  `moves.json`等、22-25行目でstatic import)を`Array.prototype.filter`で舐めるだけの同期処理で、
  検索結果自体は94-98行目の時点で完成している。
- しかし`searches`テーブルへの`insert`(119行目)と`events`テーブルへの`insert`(130行目)は
  **互いに依存関係が無い(別テーブルへの独立した書き込み)にもかかわらず`Promise.all`ではなく
  逐次`await`**になっており、さらにこの2回のDB往復が完了するまでレスポンス自体を返していない。
  コメント(113-118行目)は「記録が失敗してもレスポンス(results)は返す」という**エラー時の
  フォールバック**についてのみ言及しており、**成功時にレスポンスを待たせている**という速度面の
  トレードオフには触れていない。
- 参考値: 同じdevローカルSupabase相手の単発PUT往復の実測は「もちもの保存のPUT往復」505ms
  (dashboard該当行)。性質の異なる操作の単純外挿はできないが、同種のDB(ローカルSupabase)への
  書き込みが2回逐次する構造であることと、検索本体の計算(インメモリfilter)がボトルネックになり
  得ないことを踏まえると、実測1450msの大部分がこの2回のinsertに費やされているという仮説は
  妥当性が高い(**正確な内訳は要計測** — 「もちもの保存のPUT往復」のように区間を切り出した
  シナリオが検索には無い)。

**影響範囲**: 検索を1回実行するたびに、ユーザーが結果を見るまでの体感速度がDB書き込み2回ぶん
劣化する。検索は「入力→300msデバウンス→この往復」という経路(search/index.astro:234-242の
`scheduleSearch`)なので、連続入力のたびに同じコストが積み重なる。

**対策案**:
1. (小・低リスク) 2つの`insert`を`Promise.all`で並列化するだけでも往復1回ぶんは短縮できる。
2. (中・要設計検証) レスポンスを`results`確定時点(98行目相当)で即座に返し、`searches`/`events`への
   書き込みはレスポンス返却後にバックグラウンドで継続する。Cloudflare Workers環境
   (`@astrojs/cloudflare`アダプタ、`wrangler.jsonc`の`main: ./src/worker.ts`)では、レスポンスを
   返した後もI/Oを完走させるには`ExecutionContext.waitUntil()`が必要になる可能性が高い
   (Workersの仕様上、`waitUntil`に登録しないバックグラウンドPromiseはレスポンス送出後に
   ランタイムに打ち切られ得る)。現状このリポジトリには`waitUntil`の使用例が無く
   (`grep -r waitUntil src`が0件)、`src/config/env.ts`は`cloudflare:workers`の`env`のみを
   直接importする方式のため、`ExecutionContext`(`ctx`)をどう取得するかは新規に確立が必要
   ("astro:middleware"の`context.locals.runtime.ctx`経由が定石だが、このリポジトリでの動作は
   未検証)。**実装時は「レスポンスは速くなったが実はsearches/eventsに行が記録されなくなった」
   という静かな退行を作らないよう、実装後にDBへの記録が継続していることを別途確認すること。**

同型の「結果確定後に2回の逐次insertをしてから返す」構造は`src/pages/api/events.ts`
(69-84行目、ただしこちらは主目的がログ記録自体なので待つのが正しい)や
`src/pages/api/damage-calcs.ts`(担当外)にも見られる。検索だけが「ログは副次的」と明言しつつ
実装は待っているという、コメントと実装の不一致がある点が本件の核心。

### 発見B: 共通Webフォント一式(378個の`@font-face`、結合gzip約110KB)が3画面すべてでrender-blockingとして読み込まれる

`src/layouts/AppLayout.astro:2`の`import '../styles/global.css';`は全ページ共通。その`global.css`は
冒頭で以下を`@import`している。

```css
4  @import './webfont-m-plus-rounded-1c.css';       /* 340,244 bytes, 378個の@font-face */
7  @import './webfont-m-plus-rounded-1c-core.css';  /* 19,664 bytes, 3個の@font-face(preload対象) */
8  @import './app-header.css';                       /* 11,206 bytes */
```

`webfont-m-plus-rounded-1c.css`は`grep -c "@font-face"`で378件確認でき、400/500/700の3ウェイト分
各126ファイルに分割された`unicode-range`指定を持つ(フルセットのフォールバック用)。`unicode-range`
指定により実際のwoff2バイナリの取得は使用文字のサブセットに限定されるが、**CSSの宣言テキスト自体は
全ページで一律にダウンロード・パースされる**(ブラウザは`@font-face`を含む全CSSをCSSOM構築のために
読む必要があり、`unicode-range`は「どのファイルを取得するか」を絞るだけで「CSSを読むかどうか」は
絞らない)。

ローカルで`global.css` + `webfont-m-plus-rounded-1c.css` + `webfont-m-plus-rounded-1c-core.css` +
`app-header.css`を結合して計測したところ(**静的なファイルサイズ計算であり、ネットワーク計測ではない**):

| | 生サイズ | gzip |
|---|---|---|
| 4ファイル結合 | 415,777 bytes | 110,646 bytes |
| うち`webfont-m-plus-rounded-1c.css`単体 | 340,244 bytes | 91,339 bytes |

`unicode-range`の16進コードポイント列は繰り返しパターンが薄く、gzipの効きが悪い
(340KB→91KB、圧縮率73%程度。一般的なテキストCSSなら80〜90%超が普通)。Viteは`@import`をビルド時
(および`astro dev`の変換時)にインライン化するため、実運用でもおおむね1本のスタイルシートとして
配信されると考えられる。

**影響範囲**: `app-header.css`はホーム画面でのみマークアップ(`.app-header`)が存在し、
検索・共有ページにはこのクラスに対応する要素が無いにもかかわらず、両画面ともこのCSSを含む
バンドルを読み込む(検索・共有ページ固有の無駄という意味では発見Cに近いが、`app-header.css`単体は
11KBと小さいため主眼は置かない)。フォント一式(`webfont-m-plus-rounded-1c.css`)は3画面はもちろん
全画面共通の負荷であり、「床」の最大の物理的な内訳候補である。

**対策案**: 本レポートでは実装しないが、方向性として2つある。(a) `unicode-range`の粒度を粗くして
`@font-face`の件数自体を減らす(フォント生成スクリプト`scripts/fonts/download-webfont.mjs`側の
変更が必要、影響範囲が全画面に及ぶため要合意)。(b) この340KBのCSSが実際に初回描画・CSSOM構築の
ボトルネックになっているかをPerformance Observer等で計測してから着手判断する(**推定効果は
「要計測」**。gzip後110KBという数字は大きく見えるが、実際のCSS parse時間がユーザー体感に効くほど
大きいかはブラウザのCSSパーサ実装依存で、コード読解だけでは断定できない)。

### 発見C: ホーム・検索・共有ページはいずれも`pokemon.json`マスタデータの中身を必要としないが、AppLayoutが無条件でpreloadしている

`src/layouts/AppLayout.astro:38`:

```html
<link rel="preload" as="fetch" href="/master-data/autocomplete/pokemon.json" />
```

このpreloadを説明するコメント(33-37行目)は「**`/box`の実測**で、146KBのJSONが届くまで`<img>`の
srcを決められない」ことを根拠にしており、box系画面(クライアントJSがポケモン名からスプライトURLを
動的に組み立てる画面)向けの最適化であることが明記されている。しかし`AppLayout`はこのリンクを
`chrome`や`current`の値によらず**全ページ**の`<head>`に出力する。

担当3画面での消費状況を確認した:

- **ホーム**: ナビゲーションアイコンはすべてインラインSVGで、ポケモン画像を動的に組み立てる
  クライアントJSが存在しない。
- **検索**: `src/pages/search/index.astro`は`pokemon-master-data.ts`を一切importしていない
  (`grep`で確認済み。`docs/file-map.md`の「lib: pokemon-master-data.ts, kana.ts」という記載は
  実装とズレている)。検索結果は名前のみのテキスト表示で、画像を出さない設計であることが
  ページ冒頭のコメント(3-6行目)に明記されている。`kana.ts`も同様に未importで、実際の一致判定は
  `api/search.ts:46`の単純な`record.name.includes(query)`のみ(正規化・かな変換なし)。
- **共有ページ**: `championSpriteUrl`/`officialArtworkUrl`の解決はAstroフロントマター
  (SSR、share/[slug].astro:118-120)で完結しており、`pokemon-master-data.ts`のfetch系関数
  (`loadPokemonMasterList`等)は一切importしていない(URL組み立て関数のみimport、118-119行目)。

**影響範囲**: 3画面とも、このpreloadで始まる146KBのfetchは開始されるが、結果を消費するコードが
存在しない。ネットワーク帯域とJSONパース(`fetch().then(res => res.json())`まで実行されないため
パース自体は起きないが、`fetch`のレスポンスボディはダウンロードされる)を無駄に消費している。
なお`<link rel="preload">`は仕様上ページの`load`イベントを必ずしもブロックしないため、
「床」への寄与が「帯域の無駄」なのか「`load`完了そのものを遅らせているか」は**要計測**。

**対策案**: `AppLayout`に`preloadPokemonMaster?: boolean`のようなオプトインpropsを追加し、
実際に`pokemon-master-data.ts`のfetch系関数を呼ぶページ(`/box`系・`/team`系・`/damage-calc`・
`/speed-chart`・`/data`系)だけで明示的に有効化する。ホーム・検索・共有ページはデフォルトで
無効にする。小コストだが、対象ページの洗い出し漏れ(有効化を忘れる)のリスクがあるため、
変更後は各ページで`npm run probe`の`--eval`等を使い、意図通りに出し分けられているかの確認が要る
(本レポートでは実施しない)。

### 発見D: ホームページで`app-header.css`が二重に読み込まれている(`?url`インポート + `global.css`の`@import`)

`src/pages/index.astro`は次の2行を持つ。

```ts
6  import homePageStylesheet from '../styles/home-page.css?url';
7  import appHeaderStylesheet from '../styles/app-header.css?url';
```

```astro
22  <link slot="head" rel="stylesheet" href={homePageStylesheet} />
23  <link slot="head" rel="stylesheet" href={appHeaderStylesheet} />
```

`?url`サフィックスはViteに対して「この CSS を通常のCSSモジュールとしてバンドルに混ぜ込まず、
独立したアセットファイルとしてURLを返す」よう指示するものである。一方`global.css:8`は
`@import './app-header.css';`という**CSSレベルの**importで、`AppLayout.astro:2`経由で
全ページに常に含まれる。つまりホームページでは、`app-header.css`の内容が

1. `global.css`にインライン化された内容として(全ページ共通のスタイルシート内)
2. `appHeaderStylesheet`という独立したアセットURLとして(`index.astro`だけの明示的な`<link>`)

の**2経路で二重に配信される**。`grep`で`src/pages`全体を確認したところ、`app-header.css`を
importしている他の5画面(`team/[id].astro` `team/index.astro` `damage-calc/index.astro`
`speed-chart/index.astro` `box/index.astro` `data/index.astro`)はすべて`?url`を使わない通常の
副作用import(`import '../../styles/app-header.css';`)であり、これはViteのモジュール解決上
`global.css`が引き込む同一ファイルと同一モジュールとして扱われるため実質的な重複配信には
ならない(Vite/Rollupは解決済みパスが同じCSSモジュールを1回だけ出力する)。**`?url`を使っている
のはホームページの2箇所だけ**であり、この非対称性自体がコードから確認できる事実である。

**影響範囲**: ホームページのみ。`?url`は独立アセットとして扱われるため、通常の重複排除の対象外に
なり、`app-header.css`相当の内容(11.2KB、gzip後は発見Bの結合測定に含まれるため未分離)が
もう一往復分、余計なHTTPリクエストとして発生している可能性が高い(**実際のネットワークタブでの
二重リクエストの有無自体は計測していないため、影響の大きさは要計測**。ただしコード構造上
`?url`が「独立ファイルとして出力される」ことはVite/Astroの既知の仕様であり、二重配信が起きる
可能性が高いという判断はコードのみで下せる)。

**対策案**: `index.astro`の`appHeaderStylesheet`の`?url`インポート・`<link>`を削除し、他5画面と
同じ通常importに揃える(あるいは`app-header.css`が`global.css`側で既に全ページに配られている
ことを踏まえ、`index.astro`側のimportごと削除する)。小コスト・低リスク(スタイル自体は
`global.css`経由で引き続き適用されるため見た目の変化は無いはず)。`home-page.css`側の`?url`は
他画面に同名ファイルの重複が無いため、この二重配信問題は起きていない(パターンの不統一という
点のみ残るが、性能上の実害は無い)。

### 発見E: 共有ページが`detail/pokemon.json`(1.6MB、79%が不要なlearnset)を丸ごとSSR用にstatic importしている

`src/pages/share/[slug].astro:13`:

```ts
import pokemonDetailRaw from '../../../public/master-data/detail/pokemon.json';
```

このファイルから実際に使っているのは`baseStats`のみ(46-48行目の`baseStatsMap`構築)。
`public/master-data/detail/pokemon.json`は1.6MB(`ls -la`実測)で、`src/lib/pokemon-master-data.ts`
の116-117行目のコメントが明記する通り「learnsetが全体の約79%を占める」ため、既にlearnsetを除いた
軽量版`detail/pokemon-core.json`(215.6KB、同じく実測)が用意されている
(2026-09-09ラウンド2 S3、dashboard記載)。`PokemonCoreDetailEntry`型(pokemon-master-data.ts:105-110)
は`name` `types` `baseStats` `abilities`を持ち、共有ページが必要とする`baseStats`を含む。

同型の実装ミスが担当外だが`MobilePokemonPreview.astro:5`にも存在し
(`import pokemonDetailRaw from '../../../public/master-data/detail/pokemon.json';`)、
S3の修正が横展開されずに取りこぼされたことがコードから読み取れる
(`src/lib/archetype-data.server.ts:1-3`のコメントが「1.6MBをクライアントバンドルに含めると
危険」という教訓を明記しているのとは対照的に、こちらはサーバー専用の場所での「不要なデータ量」
という別種の無駄)。

**影響範囲**: `wrangler.jsonc`の`main`は`./src/worker.ts`で、`@astrojs/cloudflare`アダプタは
既定でルート単位に分割されない単一のWorkerスクリプトとしてビルドする。このため、
`share/[slug].astro`がstatic importする1.6MBのJSONオブジェクトリテラルは、ビルド後の単一Worker
バンドルに焼き込まれ、Worker isolateのコールドスタート時にパースされるコストになる
(**本番のみの影響で、dev serverのVite SSRはモジュール単位の遅延コンパイルのため、この影響は
`docs/perf/dashboard.md`のdev計測値には出ない**)。共有ページ単体のdev実測(1010ms, 0.67x)は
既に目標達成しており、この修正でdevの数値が大きく動くとは考えにくい。効果が見込めるのは
**本番のコールドスタート**(要計測、devでは再現不可)。

**対策案**: `import pokemonDetailRaw from '.../detail/pokemon.json'` を
`.../detail/pokemon-core.json`に差し替える(1.6MB→215.6KB、約87%削減)。小コスト・低リスク
(型・フィールドの互換性は上記の通り確認済み)。`MobilePokemonPreview.astro`も同様に直せるが
担当外のため本TODOには含めない(ユーザーへの申し送り事項として記載)。

### 発見(参考・対象外であることの確認): `app-header-swipe.ts`・`SecondHeader.astro`は3画面とも未使用

タスク説明で共通シェルの調査対象として挙げられていた`src/lib/app-header-swipe.ts`(10.8KB)と
`SecondHeader.astro`について、`grep`で全ページを確認したところ、これらを実際にimportしているのは
`team/[id].astro` `data/index.astro` `box/index.astro` `team/index.astro` `damage-calc/index.astro`
`speed-chart/index.astro` `data/speed-chart.astro` `MobilePokemonPreview.astro`のみで、
ホーム・検索・共有ページのいずれからも参照されていない。Astro/Viteはページごとに実際にimportされた
スクリプト・コンポーネントだけをバンドルするため、この2つは担当3画面の初期コストには含まれていない
ことをコードで確認した(誤った仮説を追わないための記録)。

## 優先順位付きTODO

| # | 内容 | 対応する発見 | 推定コスト | リスク | 検証方法 |
|---|---|---|---|---|---|
| 1 | `/api/search`の`searches`/`events`への2つの`insert`を`Promise.all`で並列化する | A(段階1) | 小 | 低。書き込み順序に依存関係が無いことは確認済み | `npm run test:perf`で`search-execute`シナリオを再計測し、1450msから短縮されたか確認。往復1回ぶん(数百ms)の短縮を期待 |
| 2 | `/api/search`のレスポンスを検索結果確定時点で即座に返し、ログ書き込みは`waitUntil`等でバックグラウンド化する | A(段階2・本質対応) | 中 | 中。Cloudflare Workersでの`ExecutionContext`取得パターンが未確立。誤ると`searches`/`events`への記録が静かに欠落する退行を作る | `test:perf`でのレスポンス速度改善に加え、実装後にローカルSupabaseの`searches`/`events`テーブルに行が実際に記録され続けていることを別途確認 |
| 3 | `AppLayout.astro`の`pokemon.json` preloadをオプトインpropsにし、ホーム・検索・共有ページでは発行しない | C | 小 | 中。対象ページの洗い出し漏れで有効化を忘れると、その画面のスプライト初期表示が(壊れずに)遅くなる | 各ページで`npm run probe --eval`等を使い、`/master-data/autocomplete/pokemon.json`へのリクエストがホーム・検索・共有ページで発生しないこと、box等では引き続き発生することを確認 |
| 4 | ホームページの`app-header.css` `?url`二重読み込みを解消する(他5画面と同じ通常importに揃えるか、importごと削除) | D | 小 | 低。見た目の変化は無いはず | ホームページのスクリーンショット比較(`npm run shot`)で見た目が変わらないことを確認しつつ、`app-header.css`相当のネットワークリクエストが1回に減ったことを確認 |
| 5 | `share/[slug].astro`の`detail/pokemon.json`importを`detail/pokemon-core.json`に差し替える | E | 小 | 低。使用フィールド(`baseStats`)は両方に存在することを型定義で確認済み | 共有ページの実数値表示(能力値グリッド)が変更前後で完全一致することを確認。可能なら本番デプロイ後にWorkerのコールドスタート時間を計測 |
| 6(申し送り) | `MobilePokemonPreview.astro`(担当外・box/[id]画面)も同じ`detail/pokemon.json`import問題を持つ | E | 小 | 低 | box担当のadvisor/実装セッションへ引き継ぐ |

## 確度の低い仮説(計測で確かめるべきもの)

- **本番環境でのSupabase `auth.getUser()`の往復コスト**: `src/middleware.ts:15`は全リクエストで
  `getSessionUser()`を呼ぶが、`src/lib/user-session.ts:66-70`の通り`import.meta.env.DEV`が真の
  間は`DEV_SESSION_USER`を即座に返すショートカットがあり、`docs/perf/dashboard.md`の数値は
  すべてdev server計測のためこのコストを含まない。本番では`@supabase/ssr`の`getUser()`が
  Auth serverへの再検証(ネットワーク往復)を伴う可能性があり、ログイン中ユーザーの全ページ
  読み込み(ホームはもちろん、共有ページの`chrome="public"`でもmiddleware自体は必ず通る)で
  発生し得る。dev serverでは原理的に再現できないため、本番相当の計測が必要。
- **Webフォント一式(発見B)のCSSOM構築コストが実際に初回描画のボトルネックになっているか**:
  gzip後110KBという数字自体は大きいが、CSSパース速度はブラウザ実装に強く依存し、コード読解だけでは
  「体感速度への寄与度」を数値化できない。Performance Observerでのスタイル計算時間の実測が必要。
- **`pokemon.json`→`pokemon-core.json`差し替え(発見E)による本番Workerコールドスタート改善幅**:
  コールドスタート自体がdev serverでは再現不可能な現象のため、本番デプロイ後の計測が必須。
- **`/api/search`の2つの`insert`のうちどちらがより時間を要しているか**: 「もちもの保存のPUT往復」
  のように区間を切り出した計測シナリオが検索には存在しないため、`searches`単体・`events`単体の
  内訳は不明(発見Aの対策1実装後、必要なら追加のシナリオ整備を検討する価値がある)。
- **preload(発見C)がページの`load`完了そのものを遅延させているか**: `<link rel="preload">`は
  仕様上`load`イベントを必須でブロックしないため、無駄なリクエストが「帯域の無駄」に留まるのか
  「計測上のタイムアウト/所要時間そのものを押し上げているのか」はブラウザの実装挙動に依存し、
  実測でしか切り分けられない。
- **`app-header.css`の`?url`二重配信(発見D)の実バイト・往復コスト**: 二重配信が起きること自体は
  Viteの仕様から高い確度で言えるが、実際にNetworkパネルで2本のリクエストが飛んでいるかは
  未確認(ブラウザでのUI操作を伴う確認が今回の制約で行えなかったため)。
