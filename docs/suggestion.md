# サジェスト機構

本書は、画面上で「候補」「人気」「おすすめ」として提示する仕組みを、目的とデータ経路ごとに整理したものです。ここでいうサジェストには、入力補完、集計済みの人気順、現在の編成から計算する推薦を含めます。単にデータを一覧表示するだけのページ内検索は、候補を自動提示しないため対象外です。

## 全体像

```text
マスターデータ(JSON) ──> 入力補完（種族・技・特性・持ち物）

owned_pokemon / ranked_team_members / opponent_notes
  └─ 日次集計 refresh_popular_builds()
       └─ suggestions テーブル ──> 人気の育成 / 人気の計算 / 対面候補の技

ranked_teams + アプリ内 teams
  └─ リクエスト時の SQL RPC ──> チーム編成のおすすめ

OP.GG 使用率 KV ──> 個体編集時の技・持ち物・特性の並び替え
```

`suggestions` は汎用の公開・集計済みテーブルです。読み出しは `GET /api/suggestions?kind=…&subject_key=…` に統一され、公開 RLS を使うため個人の個体データを直接返しません。`kind` が用途、`subject_key` が種族名や「種族名|レギュレーション」、型キーを表します。

## 1. 入力補完

### 対象要素

- 個体編集 `/box/[id]` の種族、持ち物、特性、技
- 同画面の種族選択ダイアログ
- 旧ダメージ計算 PoC など、同じマスターデータを読む入力画面

### 経路と挙動

1. `scripts/build-master-data/build.mjs` が jpoke を入力として `public/master-data/autocomplete/{pokemon,moves,abilities,items}.json` を生成する。
2. 個体編集では `src/lib/owned-pokemon-form.ts` の `loadAutocomplete()` が4 JSONを並列に取得し、対応する `<datalist>` に `option` を投入する。
3. ブラウザ標準の datalist が入力値に合う候補を出す。`attachKanaTypeAhead()` を付けた持ち物・技入力では、かな表記も含めて候補を絞る。
4. 種族の候補は、ページに埋め込んだレギュレーション別使用率があればその使用率順、なければマスターの順で並べる。技は選択した種族の習得技を優先して表示し、入力語との前方一致・部分一致も並び順に反映する。

この系統は「入力可能な値の発見」を支援するもので、ユーザーの匿名データを集計する `suggestions` テーブルは利用しません。

主な実装: `src/lib/owned-pokemon-form.ts`, `src/lib/box-id/left-panel.ts`, `src/lib/box-id/shared-core.ts`, `src/components/box-id/SpeciesSelectDialog.astro`。

## 2. 個体編集の「人気」サジェスト

### 対象要素

`/box/[id]` の性格・持ち物・テラスタイプ・特性・技の選択 UI です。候補を別の値へ自動変更せず、候補リストの順序と採用率表示で選択を補助します。

### 取得優先順位

| 要素 | 第1候補 | フォールバック | 集計キー |
| --- | --- | --- | --- |
| 性格 | `suggestions` の `popular_nature` | なし | 種族 → レギュレーション横断 |
| テラスタイプ | `popular_tera` | なし | 同上 |
| 持ち物 | OP.GG 使用率 | `popular_item` | 種族 → レギュレーション横断 |
| 特性 | OP.GG 使用率 | `popular_ability` | 種族 → レギュレーション横断 |
| 技 | OP.GG 使用率 | `popular_move_archetype` → `popular_move` | 型・レギュレーション → 型横断 → 種族・レギュレーション → 種族横断 |

種族、レギュレーション、性格・努力値・持ち物・技から算出した型（`archetype`）が変わるたび、200 ms のデバウンス後に再取得します。技だけは同じ種族でも型によって候補が変わるため、より具体的な型キーを先に試します。取得できない・候補が空の場合は、その経路を表示せず通常の候補順を保ちます。

OP.GG は Worker KV に保存したシーズン別使用率を `GET /api/opgg-usage` から読みます。最新の利用可能なシーズンを優先し、メガシンカ形態はベース種族のデータに解決します。

主な実装: `src/lib/box-id/left-panel.ts`, `src/pages/api/suggestions.ts`, `src/pages/api/opgg-usage.ts`, `src/lib/opgg-usage.ts`。

## 3. 個体編集の「人気の計算」

### 対象要素

`/box/[id]` のダメージ計算セクションにある「人気の計算」です。現在の個体について、よく登録される相手・向き（攻撃/防御）・技・相手の代表的な型を最大6件表示します。

### 選定と適用

- 現在の型キーの `popular_damage_calc_archetype` を先に読み、なければ種族キーの `popular_damage_calc_species` を使う。
- 既に画面に追加済みの「向き・相手・技」と同じ候補は除外する。
- フォーム変更・クリックを 300 ms でまとめて再読込する。応答の世代番号で古い非同期応答を捨てる。
- カードを押すと、候補をダメージ計算行として追加する。候補がないときはセクション自体を隠す。

集計では `opponent_notes` を基に、同一の個体が同じ計算を複数登録しても1票にします。相手の性格・特性・持ち物・テラスタイプ・努力値は各候補内で最頻の値を代表値として入れます。

主な実装: `src/lib/box-id/damage-suggest.ts`, `src/lib/damage-calc-suggest.ts`, `src/components/box-id/DamageCalcSection.astro`, `migrations/020_damage_calc_suggestions.sql`。

## 4. チーム編成のおすすめ

### 対象要素

`/team/[id]` の「おすすめ」カードと、モバイル編成バーの候補アイコンです。ログイン中のユーザーが現在画面上で選んでいるメンバー ID を基に、追加に向くポケモンと代表的な型を提示します。

### リクエスト時の2段階選定

1. `GET /api/team-suggestions?member_ids=…` が、選択中メンバーの種族との共起を `team_partner_species_stats` で評価する。共起情報がなければ全体使用率 `combined_species_usage` にフォールバックする。
2. 上位12種族について `team_partner_archetype_stats` を読み、既存メンバーとの組み合わせで最も適した型を選ぶ。型のスコアは、全体採用率・現在の種族との共起・現在の型との共起をサンプル数に応じて混合する。
3. 既存の同一図鑑番号は候補から除外する。持ち物が重複する型は可能なら次点を選び、避けられない場合は重複を表示する。

クライアントは編成変更後 700 ms で取得し、同じメンバー集合への再リクエストを抑止します。リクエスト ID と描画 ID で競合を防ぎ、候補カードから既存個体を編成に入れるか、新規個体を作成して入れられます。メガシンカ候補の含有はトグルで切り替えます。

この仕組みは `suggestions` テーブルを直接読む事前集計ではなく、現在の編成を入力にするためリクエスト時の SQL RPC を使います。

主な実装: `src/pages/team/[id].astro`, `src/pages/api/team-suggestions.ts`, `src/lib/team-suggest.ts`, `migrations/016_team_partner_suggestions.sql`, `migrations/021_combined_suggestion_pool.sql`。

## 5. 対面候補

チームの相性・ダメージ計算で使う「人気ポケモン」候補は `GET /api/matchup-targets` が提供します。`combined_species_usage` の全体使用率上位 N 種族に、`popular_move` の採用技を結合します。呼び出し側はこの候補から実際に計算に使用する相手と攻撃技を選びます。

主な実装: `src/pages/api/matchup-targets.ts`, `src/lib/team-matchup.ts`。

## 集計データの生成・公開条件

日次 cron は `src/worker.ts` から `refresh_popular_builds()` を呼びます。この入口は、種族別の人気育成、型別の人気技、人気ダメージ計算を順に更新します。

- 母集団: 収集拒否期限中でない `owned_pokemon` と、取得済みの `ranked_team_members`。両者は1個体1票で扱う。
- スコープ: 上位チーム由来のデータはレギュレーション別と全体の両方を作る。個人の個体は全体のみ。
- k 匿名性: 各キーのサンプル数が既定値5未満なら行を作らず、条件を下回った古い行も削除する。
- 上位件数: 性格・持ち物・テラス・特性は既定5件、技は既定20件、ダメージ計算は既定12件まで。
- API: `GET /api/suggestions` は `kind` を必須とし、`subject_key` と `limit` で絞り込む。結果には5分のブラウザキャッシュと共有キャッシュの指定がある。

個票・ユーザー ID・未集計の入力はこの API から返さない。匿名集計を拒否した個体は、更新時点から次回集計の対象外です。

主な実装: `src/worker.ts`, `src/pages/api/suggestions.ts`, `migrations/023_popular_ability.sql`, `migrations/019_archetype_popular_move.sql`, `migrations/020_damage_calc_suggestions.sql`。

## 変更時の確認箇所

- 新しい人気項目を増やす場合は、集計 SQL、`kind`/`subject_key` の設計、API 利用側、空データ時の非表示を一組として追加する。
- レギュレーションを追加する場合は、種族キーの `種族名|レギュレーション` と横断キーへのフォールバックを維持する。
- チーム推薦のスコアリングを変える場合は、純粋関数である `src/lib/team-suggest.ts` のテストと API の候補除外条件を合わせて確認する。
- 候補をクリックして値を変える UI では、既存の候補と重複しないこと、古い非同期応答で画面を上書きしないこと、候補ゼロで空枠を残さないことを確認する。
