# 上位構築(`/ranked-teams`)

**⚠️ 廃止(2026-08-14)**: このページ(独立ルート `/ranked-teams`)はユーザー指示により廃止した。同等機能は `/data` の「上位チーム」タブ(`/data?tab=top-builds`)に統合済み(`docs/plan/pages/data.md`)。旧URLは `/data?tab=top-builds` への301リダイレクトのみが残る(`src/pages/ranked-teams/index.astro`)。構築内容(特性・アイテム・技)検索と件数バッジは統合先に移植していない(ユーザー承認済みの機能差)。ホーム画面の「上位チーム」カードも `/data?tab=top-builds` を指す(`docs/plan/pages/home.md`)。以下は廃止前の記録として残す。

`new-page` skill の状態保存先。**このファイルが仕様・設計・受け入れ基準・実施結果の唯一の正。**

ワイヤーフレーム: `docs/ui_proposal/上位構築.png`(唯一。このページに関係する他の提案図は無い)

## フェーズ表

| フェーズ | 内容 | 状態 |
|---|---|---|
| P1 | 仕様を固める | ✅ 完了(2026-08-06) |
| P2 | 設計レビュー(sonnet1体) | ✅ 完了(2026-08-06) |
| P3 | 計画書に記録する | ✅ 完了(2026-08-06) |
| P4 | 実装(Codex CLIへ委譲) | ✅ 完了(2026-08-06) |
| P5 | 受け入れ検証(Coordinator自身) | ✅ 完了(2026-08-06。29件中28件pass、#6のみコード確認) |
| P6 | 引き渡し・commit | ✅ 完了(2026-08-06) |

---

## P1. 仕様(2026-08-06 確定)

### このページが答える問い

**「直近シーズンのランクバトル上位入賞者は、どの6体をどう組み合わせて勝ったのか」** — 特定の種族を軸にした構築を探し、その構築記事へ飛ぶための入り口。

### 前提: データはすべて既存。**マイグレーションは不要**

`migrations/010_ranked_teams.sql` / `011_ranked_teams_in_suggestions.sql` で導入済みの `ranked_teams` / `ranked_team_members` をそのまま読むだけ。新テーブル・新列・新インデックスは一切作らない。

ローカルDBの実測(2026-08-06、Coordinatorが `psql` 相当のクエリで確認):

| 項目 | 実測値 |
|---|---|
| `ranked_teams` 件数 | **1041**(M-1: 527 / M-2: 223 / M-3: 291) |
| `rule` の種類 | `シングル` のみ(全1041件) |
| `article_url` / `trainer_name` | **全1041件で非NULL**(「記事が無いチーム」は現状存在しない) |
| `rating` | 1041件中1040件が非NULL(1911.018〜2815.572) |
| `ranked_team_members` 件数 | 6241(1040チームが6体、**1チームだけ1体**) |
| 記事ホスト | pokesol.app 374 / note.com 113 / x.com 109 / yakkun.com 26 / 他は数件ずつの個人ブログ |
| 詳細列の充足率 | `item_name` 6210 / `move_names` 4753 / `nature` 3800 / `ability` 3666 / `evs` 3382 / `tera_type` **0** |
| `species_key` | 全6241体で解決済み(メガは「メガゲンガー」等のアプリ語彙。`011` のコメント記載どおり) |

**「1チームだけメンバーが1体」という欠損データが実在する。** 6体前提でレイアウトを組むと崩れるため、**カードは常に6枠を描画し、欠けたスロットは空枠として見せる**(`/team` 一覧カードの `.card-team-thumb` と同じ扱い)。

### ルーティング

| 項目 | 値 |
|---|---|
| URL | `/ranked-teams` |
| ファイル | `src/pages/ranked-teams/index.astro` |
| レンダリング | SSR(`export const prerender = false;`) |
| 認証 | **不要**(ユーザー確定、2026-08-06)。`ranked_teams` は `user_id` を持たない公開参照データで、`010` が `anon` に `SELECT` を GRANT 済み。未ログインでもそのまま閲覧できる |
| `AppLayout` | `chrome` 既定(`"app"`。サイドバーを出す)、`current="ranked-teams"` |

### ナビゲーション

`src/components/AppSidebar.astro` の `SECTIONS`「育成」セクション、**`trend`(トレンド、`disabled: true` のまま)の直下**に新規行を追加する(ユーザー指示「トレンドの下」)。

```ts
{ key: "trend", label: "トレンド", icon: "trending-up", disabled: true },
{ key: "ranked-teams", label: "上位構築", href: "/ranked-teams", icon: "trophy" },  // 追加
```

- `trend` は**準備中のまま触らない**(このページとは別物)。
- アイコン `trophy` は `ICONS` に新規追加する。既存4種(`home` / `users` / `trending-up` / `zap` / `code`)に上位入賞を表す図像が無いため。**規約どおりlucide風のインラインSVGを自前定義**し、外部ライブラリは使わない。
- `AppSidebar.astro` と `src/layouts/AppLayout.astro` の **両方**の `current` union 型に `"ranked-teams"` を足す(片方だけだと型エラー)。

### スコープ内

1. ツールバー(`.panel.panel-top.panel-toolbar`): 件数バッジ / 種族名検索 / シーズン絞り込み。
2. 上位構築カードの縦積み一覧。1カード = 1チーム。
3. カードヘッダー行: `N位` / トレーナー名 / 記事リンク(外部リンク、別タブ)。
4. カード本体・左: **6枠固定**のポケモン公式絵 + 持ち物アイコン重畳。
5. カード本体・右: **構築詳細の空プレースホルダー**(下記)。
6. 「もっと見る」による追加描画。
7. 状態表示: 読み込み中 / エラー / 0件(検索ヒットなし)。

### スコープ外(今回作らない。将来やるならここから)

- **選出パターン・立ち回り・構築の改善点の実データ表示**(ユーザー確定: 将来取得するのでスペースだけ確保)。
- **既にDBにある性格・特性・技・努力値の表示**(ユーザー確定「空のプレースホルダーのみ」)。データはあるが今回は出さない。**このスコープ外は設計レビューで蒸し返さないこと。**
- チーム詳細ページ(`/ranked-teams/[id]`)。今回は一覧1枚のみ。
- 「この構築を自分のチームにコピー」等の書き込み導線。**このページは完全に読み取り専用**(POST/PUT/PATCH/DELETE を一切作らない)。
- `rule` による絞り込み(現データが `シングル` のみのため選択肢が1つしかない)。
- レーティングやトレーナー名での並べ替え(順位昇順に固定)。
- テラスタイプの表示(現データは全件NULL。チャンピオンズにテラスタルが無いため)。

### 確定した仕様の詳細

#### 検索(ユーザー確定: **ポケモン種族名**)

- 対象は各メンバーの `species_key`(「メガゲンガー」)**と** `species_name`(「ゲンガー」)の両方。メガ表記でも素の種族名でも引けるようにする。
- 既存の `kanaIncludes`(`src/lib/kana.ts`)を使い、ひらがな/カタカナの差を吸収する(`/box` `/team` と同じ規格)。
- **空白区切りの複数語は AND**。ただし `/box` `/team` の「1つの文字列に対するAND」ではなく、**「語ごとに、チーム内のいずれかのメンバーが一致する」**とする(「ゲンガー ハラバリー」で両方入りの構築を引ける、というのがこのページで唯一意味のある解釈のため)。
- トレーナー名・記事タイトルは検索対象にしない(ユーザー確定)。

#### シーズン絞り込み・件数(ユーザー確定: **最新シーズン既定 + 追加読み込み**)

- 選択肢は DB の `season` を `season_number` 降順で並べたもの(**ハードコードしない**。`REGULATIONS` をハードコードしないのと同じ方針)。「すべて」は置かない ─ シーズンが違う構築を混ぜて順位で並べても意味が無いため。
- 既定 = `season_number` が最大のシーズン(現状 `M-3`)。
- 表示は**順位昇順**(1位が先頭)。
- **初期描画50件**、「もっと見る」1回につき +50件。
- データ取得は**シーズン単位で1回**(`GET /api/ranked-teams?season=M-3` が当該シーズン全件を返す)。検索・「もっと見る」は**取得済み配列に対するクライアント処理**で完結させ、追加のfetchを発生させない(`/box` `/team` の「1回取得してクライアントでフィルタ」を踏襲)。シーズンを切り替えたときだけ再fetchし、取得済みシーズンはメモリにキャッシュする。
- 検索語を変えたら表示件数は50件にリセットする。

#### カードの構造(ワイヤーフレーム準拠)

```
┌─ .card.card-ranked-team ────────────────────────────────────┐
│ [N位] トレーナー名  レート  <a>記事タイトル↗</a>            │  ← ヘッダー行
├────────────────────────────────┬────────────────────────────┤
│ [絵][絵][絵][絵][絵][絵]        │ 選出パターン    準備中     │  ← 本体(2カラム)
│  ↑6枠固定・持ち物アイコン重畳   │ 立ち回り        準備中     │
│                                 │ 構築の改善点    準備中     │
└────────────────────────────────┴────────────────────────────┘
```

- ワイヤーフレームの2枚目の空カードは「一覧が続く」ことの図示であり、**別種の領域ではない**(同じカードの繰り返し)。
- ヘッダー行の `N位` は `.badge.tnum`。レートは `rating` が NULL なら要素ごと出さない。
- 記事リンクは `<a href={article_url} target="_blank" rel="noopener noreferrer">`。表示文字列は `article_title`(NULLなら `article_host`、それもNULLなら「構築記事」)。**ページ全体を `<a>` で包まない**(カード内にリンクがあるため入れ子リンクになる)。
- 右カラムは `選出パターン` / `立ち回り` / `構築の改善点` の3行の見出し + それぞれ「準備中」の `.badge.badge-muted`。**将来データが入ったときに見出しはそのまま使えて、値だけ差し替わる形にする。**
- 右カラムの幅は固定にせず、1024px未満では左カラムの下へ回り込ませる(縦積み)。

#### 配色・寸法

`src/styles/global.css` の既存トークン・既存クラスのみを使う。**新しい色トークンは作らない。** ワイヤーフレームの水色/オレンジはプロジェクトテーマ(primary `#27acd9` ほか)に読み替える。`global.css` は**編集しない**(このページのために既存クラスの値を変えない)。

- カード = `.card` + `.card-ranked-team`(`00-foundation.md`「カード = 可算・追加削除できるコレクション要素」に合致)。
- ツールバー = `.panel.panel-top.panel-toolbar`(`/team` `/box` と同一のマークアップ規格。モバイル用ハンバーガー `#app-sidebar-toggle` の複製を含む)。
- 検索欄は**可視ラベルを置かず** `placeholder` + `aria-label`(`00-foundation.md`「フォーム原則」)。シーズンselectも同様。
- カード一覧は `.panel-content`(1080px)を使わず**全幅**(`00-foundation.md`「操作系・カードグリッドは全幅」)。

### ファイル分割案

`box/[id].astro`(8,500行1ファイル)の反省を踏まえ、**最初から分ける**。ただしこのページの領域は「ツールバー + カード一覧」の実質1領域なので、`speed-chart` のように領域別 `.astro` へは割らず、**「ページ = オーケストレーター / カード生成ロジック = 素のESモジュール」**の2分割にする。

| ファイル | 役割 | 新規/既存 |
|---|---|---|
| `src/pages/ranked-teams/index.astro` | オーケストレーター。SSRでシーズン一覧と既定シーズンを解決し、ツールバーのマークアップ・CSS・配線スクリプトを持つ | 新規 |
| `src/lib/ranked-teams/card.ts` | 1チーム分のカードDOMを組み立てる純粋なDOMビルダー(`renderRankedTeamCard`)。`document.createElement` 系はすべてここ | 新規 |
| `src/lib/ranked-teams.ts` | Supabaseクエリ層(`listRankedSeasons` / `listRankedTeamsBySeason`) | 新規 |
| `src/lib/ranked-teams-validation.ts` | **純粋関数のみ**(`normalizeSeasonParam` / `resolveDefaultSeason` / `matchesSpeciesSearch` / `parseLimit`)。ユニットテスト対象 | 新規 |
| `src/pages/api/ranked-teams.ts` | `GET` のみ。シーズン1つ分のチーム一覧を返す | 新規 |
| `tests/ranked-teams-validation.test.ts` | 上記純粋関数のユニットテスト | 新規 |
| `src/components/AppSidebar.astro` | `trophy` アイコン追加 + `ranked-teams` 行追加 + `current` 型拡張 | 既存(追記のみ) |
| `src/layouts/AppLayout.astro` | `current` 型拡張 | 既存(1行) |

**カードDOMは `card.ts` に閉じる。** `index.astro` の `<script>` は「取得・絞り込み・件数管理・イベント配線」だけを持ち、DOM組み立てには関与しない。`is:global` の CSS は `.ranked-team-list` 配下に限定したセレクタで書く(JS生成要素にscoped styleが効かないため。`ui/references/pitfalls.md`)。

### API契約

```
GET /api/ranked-teams?season=<season>
```

- **認証なし・CSRFチェックなし・レート制限なし。** GETかつ公開参照データのみを返すため(`010` が `anon` に SELECT を GRANT している範囲そのもの)。`GET` 以外は `methodNotAllowed()`。
- `season` 未指定/未知の値 → 400(`badRequest`)。**既定シーズンへのフォールバックはAPIではやらない**(どのシーズンを見ているのかが曖昧になるため。既定の解決はページ側の責務)。
- クエリは `getSupabasePublicClient()` を使う(**`getSupabaseAdminClient()` は使わない**。RLSをバイパスする必要がなく、公開ポリシーで足りるため)。
- 生のSupabaseクエリはAPIファイルに書かず `src/lib/ranked-teams.ts` に委譲する(`stack.md` §3 の確定方針)。
- レスポンス(`rule` は現状シングル固定だが、将来の判別のため返す):

```jsonc
{
  "season": "M-3",
  "teams": [
    {
      "id": "uuid",
      "rank": 1,
      "rating": 2615.671,          // null あり
      "rule": "シングル",
      "trainerName": "SV",         // null あり
      "articleUrl": "https://…",   // null あり
      "articleTitle": "s3 最終1位…", // null あり
      "articleHost": "ka-cr.hatenablog.com", // null あり
      "members": [                 // slot昇順。0〜6要素(6未満のチームが実在する)
        { "slot": 1, "speciesKey": "メガゲンガー", "speciesName": "ゲンガー",
          "formName": null, "itemName": "ゲンガナイト" }
      ]
    }
  ]
}
```

**`nature` / `ability` / `move_names` / `evs` / `tera_type` / `type1` / `type2` / `category` / `dex_no` / `form_no` は返さない。** 今回のスコープでは表示せず、ペイロードを膨らませるだけのため(将来スコープ外項目を実装するときに追加する)。

### 受け入れ基準

| # | 基準(実測できる形) |
|---|---|
| 1 | `npm run build` が成功する |
| 2 | `npm test` が全件passし、**テスト件数が着手前より増えている**(`tests/ranked-teams-validation.test.ts` が新規に存在する) |
| 3 | `migrations/` にファイルが追加されていない(`git status` で確認) |
| 4 | サイドバー「育成」セクションに「上位構築」が**トレンドの直下**に表示され、クリックで `/ranked-teams` へ遷移する。「トレンド」は準備中バッジのまま |
| 5 | `/ranked-teams` を開くと `.app-sidebar-link[data-active="true"]` が「上位構築」に付く |
| 6 | **未ログイン状態**で `/ranked-teams` を開いてもカード一覧が描画される(ログイン導線に差し替わらない) |
| 7 | 初期表示のシーズンselectの選択値が `M-3`(= `season_number` 最大)である |
| 8 | シーズンselectの選択肢が3つ(M-3 / M-2 / M-1)で、**新しい順**に並んでいる。「すべて」は無い |
| 9 | 初期表示のカード枚数が **50** である(`document.querySelectorAll('.card-ranked-team').length === 50`) |
| 10 | 「もっと見る」を1回押すとカード枚数が **100** になる |
| 11 | M-3 の全291件を出し切ると「もっと見る」ボタンが消える(または `hidden` になる) |
| 12 | 先頭カードのヘッダーに「1位」・トレーナー名「SV」・記事リンクが表示され、リンクが `target="_blank"` かつ `rel` に `noopener` を含む |
| 13 | どのカードもポケモン枠が**必ず6枠**(`.ranked-team-thumb` が6個)。メンバー1体だけのチームでも6枠 |
| 14 | 各カード右側に「選出パターン」「立ち回り」「構築の改善点」の3見出しと「準備中」表示がある |
| 15 | 検索欄に「ゲンガー」と入れると、表示される全カードがゲンガー系(`species_key` または `species_name` に一致)を含む |
| 16 | 検索欄に「げんがー」(ひらがな)と入れても #15 と同じ件数になる(`kanaIncludes` が効いている) |
| 17 | 検索欄に「ゲンガー ハラバリー」と入れると、表示される全カードが**両方**を含む |
| 18 | 検索語を変えると表示件数が50件にリセットされる |
| 19 | ヒット0件のとき「条件に一致する構築がありません」の空状態が出る(カードは0枚) |
| 20 | シーズンを M-1 に切り替えるとカードが再描画され、先頭が M-1 の1位になる |
| 21 | `GET /api/ranked-teams?season=M-3` が 200 で `teams.length === 291` を返す |
| 22 | `GET /api/ranked-teams?season=zzz` と `season` 未指定がいずれも 400 を返す |
| 23 | `POST /api/ranked-teams` が 405 を返す |
| 24 | API レスポンスに `nature` / `ability` / `move_names` / `evs` が含まれない |
| 25 | 1920×1080 のライト/ダーク両テーマでスクリーンショットを撮り、横スクロールバーが出ず、カードが `--color-surface-alt` 系のテーマ色で描画されている(ワイヤーフレームの水色をそのまま使っていない) |
| 26 | 1280px 幅でカード右カラムが左カラムの下に回り込み、内容が切れない |
| 27 | 既存ページ `/box` `/box/[id]` `/team` `/speed-chart` に回帰が無い(表示・コンソールエラーなし) |
| 28 | `src/styles/global.css` が変更されていない |
| 29 | DBに書き込みが発生していない(`ranked_teams` / `ranked_team_members` の件数が着手前と同じ 1041 / 6241) |

---

## 設計レビュー(2026-08-06)

**実施者: Coordinator 自身**(このセッションではサブエージェント起動が禁止されていたため、P1の下調べと同じくCoordinatorが直接行った)。観点は skill が定める3つ(データモデル/API・情報設計/導線・プレイヤー視点)。

### 採用した指摘

- **R-1 公式絵50枚×6体=300枚の同時取得はページを殺す**: 【問題】`/team` 一覧を素直に真似ると `officialArtworkUrl`(official-artwork、1枚あたり数百KB)を初期表示だけで300枚、「もっと見る」後に600枚取りに行く。`/team` はチーム数が高々数十なので成立していたが、このページの母数(291〜527)では桁が違う。`loading="lazy"` は、`/team` 由来の「初期 `display:none` → onload で表示」方式と併用すると**display:none の要素は交差判定が起きず遅延読み込みが機能しない**ため救いにならない。 → 【対応】**このページは `spriteUrl`(ドット絵、1枚あたり数KB)を使う**と確定。先例は `/speed-chart`(`src/lib/speed-chart/chart-table.ts:1202`、多数行を一度に並べる同じ状況で `spriteUrl` を採用済み)。6体を横一列に並べるワイヤーフレームのサイズ感ともドット絵の方が合う。
- **R-2 `species_key` NULL への耐性が無い**: 【問題】画像解決を `species_key` 一本にすると、再seedで NULL が混ざった瞬間に絵が全部消える(`011` のコメントの「実測6241体すべて解決」は**そのときの実測値**であって制約ではない。`species_key` に NOT NULL は無い)。 → 【対応】画像・表示名とも **`species_key` → 無ければ `species_name` にフォールバック**する。検索も両方を対象にする(P1で確定済み)。
- **R-3 `rating` は数値ではなく文字列で返ってくる**: 【問題】`numeric(10,3)` は Supabase/pg が精度欠落を避けるため **string** で返す(Coordinatorの実測: `"rating": "2615.671"`)。`toFixed()` を呼ぶと落ちる。 → 【対応】lib層(`src/lib/ranked-teams.ts`)で `Number()` 変換し、**APIは `number | null` を返す**契約にする。表示は整数(`Math.round`)。
- **R-4 押せないカードが hover で持ち上がる**: 【問題】`.card`(global.css)は hover で `translateY(-2px)` + `--shadow-md` する。このページのカードは**全体がリンクではない**(中の記事リンクだけが押せる)ため、持ち上がると「カードを押せば記事に飛べる」と誤読される。 → 【対応】`.card-ranked-team` で hover の `transform` / `box-shadow` を基底値に打ち消す。**`global.css` の `.card` 自体は触らない**(全ページに波及するため)。
- **R-5 キー入力ごとに300要素を作り直す**: 【問題】検索欄の `input` で毎回 `innerHTML=""` → 50カード(= 画像300要素)を再生成すると入力が詰まる。`/team` は数十カードなので問題化しなかった。 → 【対応】検索入力に **150ms の debounce** を入れる。シーズン変更・「もっと見る」は即時でよい。
- **R-6 `slot` は 1〜6 が揃っている保証が無い**: 【問題】メンバー1体のみのチームが実在し、その1体の `slot` が 1 とは限らない。配列の添字で描画すると穴が詰まって表示位置がずれる。 → 【対応】`/team` 一覧と同じく **`slot` をキーにした Map を作り、1〜6 を走査**して埋める。空きスロットは空枠(スロット番号を薄く表示)。
- **R-7 記事タイトルが長く、ホストが分からないと踏むのが怖い**: 【問題】`article_title` は「s3 最終1位　全開示サイクル - 負即切断ガルクレセ」のように長い。外部サイトへ飛ばすのに遷移先ドメインが見えないのは、`x.com` / `blog.naver.com` / 個人ブログが混在するこのデータでは不親切。 → 【対応】リンク文字列は `article_title` の**1行省略 + `title` 属性に全文**、その直後に `article_host` を `.badge.badge-muted` で小さく添える。

### 却下した指摘(理由つき。再提起しないこと)

- **`?season=` を URL に反映し共有可能にする**(`/speed-chart` の `?reg=` と同様): 有用だが今回の問いには不要で、`history.replaceState` の配線が増える。**スコープ外(将来)**へ。
- **チーム詳細ページ `/ranked-teams/[id]` を同時に作る**: P1のスコープ外として明記済み。一覧1枚で問いに答えられる。
- **既にDBにある性格・特性・技・努力値を右カラムに出す**: **ユーザーがP1で「空のプレースホルダーのみ」と明示的に選択した。** 設計側の判断で覆さない。
- **`rule` の絞り込みUI**: 現データが `シングル` 一択で、選択肢が1つのセレクトは操作の錯覚を生むだけ。データが増えたときに追加する。
- **API にレート制限・CSRF チェックを付ける**: GET かつ公開参照データのみで、`010` が `anon` に GRANT している範囲そのものを返す。副作用が無いため不要(`stack.md` §3 の定型は書き込みAPI向け)。

---

## 確定した設計(2026-08-06)

### データモデル

**変更なし。マイグレーションを追加しない。** 既存の `ranked_teams` / `ranked_team_members` を読むのみ。

### 実装の順序と依存

| 順序 | 担当 | 対象ファイル | 依存 |
|---|---|---|---|
| 1 | 基盤 | `src/lib/ranked-teams.ts` / `src/lib/ranked-teams-validation.ts` / `tests/ranked-teams-validation.test.ts` | なし |
| 2 | API | `src/pages/api/ranked-teams.ts` | 1(型) |
| 2 | ページ | `src/pages/ranked-teams/index.astro` / `src/lib/ranked-teams/card.ts` | 1(型) |
| 3 | ナビ・結線 | `src/components/AppSidebar.astro` / `src/layouts/AppLayout.astro` | 2 |

**1体の実装者に順序どおり通しでやらせる**(層をまたぐ依存が強く、型の擦り合わせコストの方が並列化の利得を上回るため)。

### 型(基盤が確定させ、以降のファイルが import する)

```ts
// src/lib/ranked-teams.ts
export interface RankedTeamMember {
  slot: number;              // 1〜6
  speciesKey: string | null; // 'メガゲンガー'(アプリ語彙)
  speciesName: string;       // 'ゲンガー'
  formName: string | null;
  itemName: string | null;
}
export interface RankedTeam {
  id: string;
  rank: number;
  rating: number | null;     // ← lib層で Number() 済み(R-3)
  rule: string;
  trainerName: string | null;
  articleUrl: string | null;
  articleTitle: string | null;
  articleHost: string | null;
  members: RankedTeamMember[];  // slot昇順。0〜6要素
}
export interface RankedSeason { season: string; seasonNumber: number; }

export async function listRankedSeasons(supabase: SupabaseClient): Promise<RankedSeason[]>;      // seasonNumber降順
export async function listRankedTeamsBySeason(season: string, supabase: SupabaseClient): Promise<RankedTeam[]>;  // rank昇順
```

```ts
// src/lib/ranked-teams-validation.ts(純粋関数のみ。DB/ネットワークに触らない)
export function normalizeSeasonParam(value: unknown): string | null;   // 空白trim・空文字→null
export function resolveDefaultSeason(seasons: RankedSeason[]): string | null;  // seasonNumber最大
export function matchesSpeciesSearch(
  members: ReadonlyArray<{ speciesKey: string | null; speciesName: string }>,
  term: string,
): boolean;   // 空白区切り複数語AND。各語につき「いずれかのメンバーが一致」。kanaIncludes使用
export const RANKED_TEAMS_PAGE_SIZE = 50;
```

```ts
// src/lib/ranked-teams/card.ts(ブラウザ専用。DOM組み立てだけを持つ)
export function renderRankedTeamCard(team: RankedTeam, imageIdMap: Map<string, number>, itemSpriteMap: Map<string, string>): HTMLElement;
```

### 画面

- `AppLayout` は **`hideTopbar={true}`**(`/box` `/team` `/speed-chart` と同じセカンドトップバー方式。ワイヤーフレームにページタイトル帯が無いことにも合う)。ページ側の責務としてハンバーガー `id="app-sidebar-toggle"` の同一マークアップをツールバー先頭に複製する(`AppLayout.astro` の `hideTopbar` コメント参照)。
- ツールバー(`.panel.panel-top.panel-toolbar`)の並び: ハンバーガー / 件数バッジ(`.badge.tnum`) / 種族名検索(虫眼鏡アイコン + `placeholder="ポケモン名"` + `aria-label="検索"`) / シーズンselect(`aria-label="シーズン"`)。可視 `<label>` は置かない(`00-foundation.md` フォーム原則)。
- カード一覧は全幅(`.panel-content` を使わない)。カードは縦1列(ワイヤーフレームどおり横長カード)。
- 「もっと見る」は一覧末尾中央の `.btn-ghost`。全件表示済みなら `hidden`。
- CSS: JS生成要素にはAstroのscoped styleが効かないため `<style is:global>` を使い、**すべてのセレクタを `.ranked-team-list` 配下に限定**する(`ui/references/pitfalls.md`)。ツールバーなど静的マークアップ側は通常の scoped `<style>` でよい。
- `[hidden]` を使う要素で `display: flex`/`inline-flex` を当てる場合は `…[hidden] { display: none; }` を明示(既知の詳細度の罠)。

## 実施結果(2026-08-06)

実装は **Codex CLI(`codex exec`)** に委譲し、Coordinator が全件を自分で実測検証した。**マイグレーションは予定どおり0件。**

### 受け入れ基準の判定

| # | 基準 | 結果 | 確認方法・実測値 |
|---|---|---|---|
| 1 | `npm run build` 成功 | ✅ | `[build] Complete!`(修正反映後に再実行) |
| 2 | `npm test` 全件pass・件数増 | ✅ | **543件 → 555件**、fail 0。新規 `tests/ranked-teams-validation.test.ts` 単体で 12件pass |
| 3 | `migrations/` に追加なし | ✅ | `git status --short migrations/` が空 |
| 4 | ナビ「トレンド」の直下に「上位構築」 | ✅ | DOM実測: `trend@index3`(disabled=true、準備中バッジ維持)/ `ranked-teams@index4`(href=`/ranked-teams`) |
| 5 | アクティブ表示 | ✅ | `.app-sidebar-link[data-active="true"]` のラベル = 「上位構築」 |
| 6 | 未ログインで一覧が描画される | ⚠️ **コード確認のみ** | **dev環境では実測不可**: `src/lib/user-session.ts:60` が `import.meta.env.DEV` のとき常に `DEV_SESSION_USER`(dev@localhost)を返すため、Cookie無しのブラウザコンテキストでもログイン済みになる。代わりにコードで確認 — `src/pages/ranked-teams/index.astro` と `src/pages/api/ranked-teams.ts` はいずれも `Astro.locals.user` / `getSessionUser` の参照が **0件**(grep実測)で、ログイン分岐自体が存在しない |
| 7 | 既定シーズン = M-3 | ✅ | `#ranked-team-season` の `value` = `M-3` |
| 8 | 選択肢が新しい順3件・「すべて」なし | ✅ | `["M-3","M-2","M-1"]` |
| 9 | 初期50件 | ✅ | `.card-ranked-team` = **50枚** |
| 10 | 「もっと見る」1回で100件 | ✅ | **100枚** |
| 11 | 全件でボタンが消える | ✅ | 5回押下で **291枚**、`#ranked-team-load-more`.hidden = true |
| 12 | 先頭カードのヘッダー | ✅ | `1位` / `SV` / `レート 2616` / href=`https://ka-cr.hatenablog.com/…` / `target="_blank"` / `rel="noopener noreferrer"` |
| 13 | 常に6枠 | ✅ | 全カードの `.ranked-team-thumb` 数の集合 = `{6}` |
| 13b | メンバー1体のチームでも6枠 | ✅ | 実データの欠損チーム(**M-1 106位・なつもん**、メンバー1体)で `thumbs=6, empties=5` |
| 14 | 詳細プレースホルダー3行 | ✅ | dt = `["選出パターン","立ち回り","構築の改善点"]`、dd = `["準備中"]`(全行同一) |
| 15 | 種族名検索 | ✅ | 「ゲンガー」→ 31件、表示31枚すべてにゲンガー系を含む |
| 16 | かな差の吸収 | ✅ | 「げんがー」→ **31件**(カタカナ時と一致) |
| 17 | 複数語AND | ✅ | 「ゲンガー ハラバリー」→ 2件、両方を含むことをDOMで確認 |
| 18 | 検索語変更で50件にリセット | ✅ | 291枚表示状態から検索クリア → **50枚** |
| 19 | 0件の空状態 | ✅ | カード0枚 + 「条件に一致する構築がありません」表示 |
| 20 | シーズン切替 | ✅ | M-1 → 先頭 `1位`、件数バッジ `527件` |
| 21 | `?season=M-3` が291件 | ✅ | `teams.length = 291`、`rating` が `number` 型(2615.671) |
| 22 | 不正/未指定シーズンが400 | ✅ | `season=zzz` → 400、`season` 未指定 → 400 |
| 23 | POST が405 | ✅ | 同一Originの POST → **405**。Origin無しの POST は Astro 組み込みの CSRF Origin検査が先に働き **403**(いずれも拒否。仕様どおり) |
| 24 | 詳細列を返さない | ✅ | レスポンスに `nature` / `ability` / `move_names` / `evs` / `tera_type` は**0件**。member のキーは `slot, speciesKey, speciesName, formName, itemName` のみ |
| 25 | 1920px ライト/ダークで横スクロールなし | ✅ | `scrollWidth 1920 = clientWidth 1920`。両テーマのスクリーンショットをCoordinatorが目視。カードは `--color-surface-alt` 系のテーマ色(ワイヤーフレームの水色は不使用)。スプライト画像 **300/300** 読み込み成功 |
| 26 | 1280pxで右カラムが下に回り込む | ✅ | 実測: `members bottom=289` / `details top=289`(縦積み成立)、`scrollWidth 1280 = clientWidth 1280` |
| 27 | 既存ページに回帰なし | ✅ | `/box` `/team` `/speed-chart` を1920ライト/ダークで撮影・目視。コンソールエラー0件 |
| 28 | `global.css` 未変更 | ✅ | `git status --short src/styles/global.css` が空 |
| 29 | DBが元のまま | ✅ | `ranked_teams` = **1041**、`ranked_team_members` = **6241**(着手前と同値) |

**判定: 29件中28件をpass、1件(#6)は dev環境の制約でコード確認のみ。**

### 検証で見つけて直した欠陥(Coordinator が修正)

- **D-1 エラー文字色のコントラスト不足**: `#ranked-team-error` が `--color-danger` を文字色に使っていた。`global.css` のコメントが明記するとおり、ライトモードで `--color-danger` をそのまま文字色にするとコントラストが足りない(`/team` の `#error-message` は `--color-danger-strong` を使っている)。→ `--color-danger-strong` に変更。
- **D-2 記事タイトルとホストの二重表示**: `article_title` が NULL のときリンク文字列が `article_host` にフォールバックするため、直後のホストバッジと同じ文字列が2回並んでいた(M-3 6位「www.youtube.com ↗ www.youtube.com」で実発生)。→ ラベルとホストが同一ならホストバッジを出さないようにし、再撮影で解消を確認。

### 実装中に見つかったバグ(このページとは別の実バグ)

なし。

### スコープ外に落としたもの(将来やるなら何から)

1. **構築詳細の実データ表示**(選出パターン・立ち回り・構築の改善点)。ユーザーが将来取得予定。`.ranked-team-details` の3行の `dd` に値を差し込むだけで済む形にしてある。
2. **既にDBにある性格・特性・技・努力値の表示**(充足率: 技4753/6241・性格3800・特性3666・努力値3382)。API の `TEAM_SELECT` に列を足し、`RankedTeamMember` を拡張すれば出せる。**1が入るまでは右カラムが空なので、先にこちらを入れる選択もある。**
3. `?season=` の URL 反映(`/speed-chart` の `?reg=` と同じ `history.replaceState` 方式)。構築のシェアに効く。
4. チーム詳細ページ `/ranked-teams/[id]`。
5. `rule` による絞り込み(データが `シングル` 以外を持ったら)。

### 引き渡し

受け入れ基準を満たしたので `new-page` の担当は終了。**見た目の磨き込みが要るなら `ui` skill に引き渡せる。**
