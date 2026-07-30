# 新しいページを1枚足すとき、このプロジェクトのどこを触るか

**既存ページを読んで真似るのが最短。** 一覧なら `src/pages/box/index.astro`、編集画面なら `src/pages/box/[id].astro`、公開閲覧なら `src/pages/share/[slug].astro` が手本。ここには**真似るだけでは分からない規約と、実際に踏んだ落とし穴**だけを書く。

構成: Astro 7(SSR / Cloudflare アダプタ)+ Supabase(Postgres)。UI文言はすべて日本語。

---

## 1. ページ本体(`src/pages/`)

- ファイルベースルーティング。`src/pages/team/index.astro` → `/team`、`[id].astro` → `/team/:id`。
- **SSRするページには `export const prerender = false;` が要る**(フロントマターの先頭に書く)。既存ページはすべてこれを付けている。
- `AppLayout` でラップする。props とスロットは `src/layouts/AppLayout.astro` 冒頭のコメントが正:
  - props: `title`(トップバー見出しと `<title>` 兼用。`| Poke-Commons` は自動付加) / `description` / `current` / `bodyClass` / `backHref` / `backLabel` / `chrome`(`"app"` | `"public"`)
  - スロット: `topbar-status`(タイトル右の状態表示) / `topbar-actions`(右側の操作) / `head` / デフォルト(本文)
  - **アカウント表示・サイドバー・トップバーはレイアウトが描く。ページ側で書かない。**
  - 第三者向けの公開ページは `chrome="public"`(サイドバーとログイン情報を出さない。ラウンド13の対応)
- ログイン必須のページは `Astro.locals.user`(`src/middleware.ts` が全リクエストでセット)を見て、無ければ自分でログイン導線を出すか `Astro.redirect` する。**ミドルウェアは強制リダイレクトをしない設計**なので、保護はページ側の責任。

### レイアウトの語彙(`docs/plan/ui_rounds/00-foundation.md` が唯一の正)
- **カード** = 可算・追加削除できるコレクション要素。`.card` + 用途別修飾子。浮いた箱。
- **パネル** = 画面端まで伸びる帯。`.panel` + `.panel-left` / `.panel-right` / `.panel-top`。角丸・外側marginなし。
- **「タイル」という語は使わない**(既存の `.add-card-tile` だけ例外)。
- 帯の中身の可読幅は `.panel-content { max-width: 1080px }`(左寄せ)。**操作系(ツールバー・カードグリッド)は全幅、読む対象(表・本文・一覧)は1080px** が確定仕様。
- **提案・実装で座標や幅を決めるときは 1080px の内側に収まることを確認する。** パネル外の余白は使えない。
- 数値グリッドの本体値のフォントサイズは「ページ内の階層」で決める(揃えない)。→ `00-foundation.md`「タイポグラフィ原則」の2つの表のどれに当たるか判断して選ぶ。
- 配色トークン: primary `#27acd9` / success `#409f89` / danger `#f8705b` / risky `#c9820f`。**新色は作らない。** ボタンは「ボーダー同色の塗り → ホバーで白地に反転」。
- 共通トークン・共通クラスは `src/styles/global.css`。**新規ページのために `global.css` を編集するのは、既存クラスに影響しない追加のみ**。既存クラスの値を変えると全ページが動く。

### 画面が複数領域を持つときのファイル分割(`box/[id].astro` の反省)

`box/[id].astro` は左サイド・ダメージ計算・右サイドの3領域を1ファイルに詰め込んだ結果、8,500行超・関数124個に肥大化し、`ui` skillの「同じファイルを2体に触らせない」規則のせいで3領域がずっと直列実行にしかならなくなった(詳細は `docs/plan/ui_parallelization.md`)。さらに悪いことに、領域の境界は `--- 右サイド ---` のようなコメントだけで、実行時は `if (form) { ... }` という1つのクロージャスコープを3領域が共有していた。**この失敗を新規ページで繰り返さない。**

- **分割を検討する条件**(いずれか1つでも当てはまれば検討する):
  - 1画面に見た目上・機能上独立した2つ以上の領域がある(例: 「左パネル」「中央カード」「右パネル」のような明確な区画)
  - ワイヤーフレームの区画が別々の関心事を持つ(一方を触っても他方の見た目・動作に影響しない)
  - 将来の `ui` 改善ラウンドで、領域ごとに別々の指摘が同時に来ることが予想される(`box/[id].astro` のラウンド31は左8件・ダメージ計算6件・右4件が同時に来た)
- **分割の形**: `<Region>.astro`(テンプレート、SSRデータをpropsで受け取る)+ `<region>.ts`(その領域専用のロジックだけを`export`する素のESモジュール)。ページ本体はオーケストレーター(SSR取得 + コンポーネント呼び出し)に徹する。
- **共有コア関数を早期に特定する。** `box/[id].astro` の反省点は「領域をまたいで呼ばれる関数が後から絡み合って密結合した」こと。設計の時点で「この関数(状態)は複数領域から呼ばれる」と分かっているものは、最初から `shared-core.ts`(または `<name>-shared.ts`)に置き、各領域は暗黙のクロージャ参照ではなく明示的な `import`/`export` 経由で呼ぶ。共有コアが操作する状態(行データ・選択状態など)も、どちらの領域が所有するか・引数で渡すかモジュール内で保持するかを設計段階で決める。
- **Astroの scoped `<style>` は `document.createElement()` で動的生成した要素に効かない**(既知の制約。`ui/references/pitfalls.md` 参照)。JS生成要素のスタイルは `is:global` に頼らざるを得ない。**ファイルを分割しても、`is:global` は名前のとおりスコープを持たないため、複数ファイルに分かれた `is:global` ブロックは「後に読み込まれた定義が同詳細度で勝つ」という適用順序に依存する。** 分割時は `@layer` で明示的にレイヤーを分けるか、セレクタの詳細度をファイルの読み込み順に依存しない十分な高さ(`.<region-root-class> .foo` のように領域ルートで絞る等)で書き、順序が変わっても壊れないようにする。
- **この観点は `new-page` skillのP1(仕様を固める)またはP2(設計レビュー)の時点で検討し、ファイル分割案を仕様に含める。** 実装(P4)に入ってから割るのではなく、`<slug>.md` に「確定した設計」として分割案を書いた状態でP4のエージェントに渡す。

---

## 2. ナビゲーションに載せる(**忘れやすい。載せないと誰も到達できない**)

`src/components/AppSidebar.astro` の `SECTIONS` に項目がある。**チーム・トレンドは既に `disabled: true` + 「準備中」バッジで置かれている**ので、新規作成時は「行を足す」のではなく**`disabled` を外して `href` を与える**。

```ts
{ key: "team", label: "チーム", icon: "users", disabled: true },   // 変更前
{ key: "team", label: "チーム", href: "/team", icon: "users" },    // 変更後
```

**あわせて2ファイルの `current` の union 型を広げる**(片方だけ直すと型エラーになる):
- `src/components/AppSidebar.astro` の `interface Props { current?: "box" | "dev" }`
- `src/layouts/AppLayout.astro` の `interface Props` の `current`

アイコンは外部ライブラリを使わず、`AppSidebar.astro` の `ICONS` にlucide風のインラインSVGを自前定義する規約。既存の4つ(`home` / `users` / `trending-up` / `code`)で足りるなら追加しない。

---

## 3. API(`src/pages/api/`)

1ファイル1エンドポイント。`export const prerender = false;` が必須。**書く順番が既存全ルートで揃っているので踏襲する**:

```ts
export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const user = await getSessionUser(request, cookies);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);   // 1. 認証
  if (!isSameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);  // 2. 簡易CSRF
  const rate = someRateLimiter.check(user.id);                       // 3. レート制限
  if (!rate.allowed) return jsonResponse({ error: 'Too many requests' }, 429);
  const body = await readJsonBody<unknown>(request);                 // 4. ボディ読み(64K上限)
  if (body.response) return body.response;
  const parsed = validateXxxRequestBody(body.data);                  // 5. 検証(lib側)
  ...
  const supabase = await getSupabaseAdminClient();                   // 6. クエリはlibへ委譲
  const result = await createXxx(user.id, parsed.value, supabase);
}
```

- ヘルパーは `src/pages/api/_shared.ts`: `jsonResponse` / `methodNotAllowed` / `badRequest` / `readJsonBody` / `isSameOrigin` / `isValidUuid`。**自前でResponseを組まない。**
- **APIファイルに生のSupabaseクエリを書かない。** 全クエリを `src/lib/<name>.ts` に委譲するのが確定方針(`src/lib/owned-pokemon.ts` 冒頭のコメント参照。**`user_id` フィルタ漏れによる他人データ露出を防ぐため**)。
- **`getSupabaseAdminClient()` は service_role で RLS をバイパスする。** つまり**lib層が自分で `user_id` で絞らないと他人のデータが返る**。RLSは保険であって防御の主体ではない。新しいlib関数を書くときは、第1引数を `userId` にして必ず `.eq('user_id', userId)` を通す既存の形に揃える。
- 更新APIの契約に注意: `PUT /api/owned-pokemon/:id` は**全項目上書き**。同種のAPIを新設するなら、部分更新なのか全項目上書きなのかを `<slug>.md` に明記する。

### 層の分け方
| 層 | 場所 | 役割 |
|---|---|---|
| ルート | `src/pages/api/<name>.ts` | 認証・CSRF・レート制限・HTTPの形だけ |
| 検証 | `src/lib/<name>-validation.ts` | 入力の型・範囲チェック。**純粋関数にする**(ユニットテストの対象) |
| クエリ | `src/lib/<name>.ts` | Supabaseへのアクセス。`user_id` 絞り込みの責任を持つ |
| 共通 | `src/lib/validation-primitives.ts` | 文字列長・数値範囲などの部品。まずここを見る |

---

## 4. マイグレーション(`migrations/`)

- `NNN_説明.sql` の連番。**適用済みのファイルは絶対に編集しない**(追加のみ)。現在 `001`〜`006` まで存在。
- 実行は `npm run migrate`(`scripts/db/run-migrations.mjs`)。
- **RLSポリシーを書いたら必ず `GRANT` も書く。** ポリシーだけではPostgresのテーブル権限が付かず、権限の時点で弾かれる死んだ設定になる(`003_grant_table_privileges.sql` と `005` のコメントに実機で踏んだ記録がある)。
  - service_role: 書き込みAPIが使うので **必須**
  - authenticated: 本人限定のCRUDを付ける(将来クライアントSDK経路を開けるための保険)
  - anon: **公開閲覧が仕様に入っている場合のみ。** 非公開データには一切GRANTしない
- 本人限定テーブルの定型は `005_owned_pokemon_rls.sql` をそのまま雛形にする(`ENABLE ROW LEVEL SECURITY` + select/insert/update/delete の4ポリシー + GRANT 2行)。
- 公開共有を伴う場合は `006_owned_pokemon_sharing.sql` が雛形(`is_public` 列 + anon向けSELECTポリシー + `GRANT SELECT ... TO anon`)。
- **マイグレーションが要らないなら書かない。** 既存の `jsonb` 列の中身を拡張するだけで済むケースが実際にあった(ダメージ計算の `field.attacks[]` 追加はマイグレーション不要だった)。

---

## 5. テスト

| 種別 | 場所 | 実行 |
|---|---|---|
| ユニット | `tests/*.test.ts` | `npm test`(`node --test`) |
| DB結合 | `tests/db/*.test.ts` | 同上(接続情報が要る) |
| E2E | `tests/e2e/*.spec.ts` | `npm run test:e2e`(事前に自動で `npm run build`) |

- **新規ページには最低限、バリデーション関数のユニットテストを足す。** テストが1件も増えていない新規ページは未完成扱い(SKILL.md の P5)。
- ユニットテストは純粋関数だけを対象にする(既存の `owned-pokemon-validation.test.ts` が手本)。DBやネットワークを叩かない。
- **既存件数は必ず増える方向にしか動かさない。** 実行して「215件 → NNN件」のように報告する。

---

## 6. ビルドと開発

- `npm run build` = マスターデータ生成 + `astro build`。**`npx astro build` 単独はマスターデータ生成を飛ばす**ので、`public/master-data/` を触ったなら `npm run build` を使う。
- 開発サーバー: `npm run dev` → http://localhost:4321。dev ユーザーは `npm run seed-dev-user`。
- マスターデータは `public/master-data/` 配下(`scripts/build-master-data/build.mjs` が生成)。ポケモンの画像IDは `autocomplete/pokemon.json` の `imageId`(`dexNo` ではない。メガ・キョダイ・リージョンで画像が変わる)。
- **データファイル名・フィールド名を指示や提案に書くときは、実際に開いて実在を確認する。** 「`detail/pokemon.json` から `imageId` を引く」が実データと不整合だった実例がある(実体は `autocomplete/` 側)。

## 7. ダメージ計算に触るなら

- **`vendor/jpoke` のソースを読む前に `.claude/skills/jpoke/` の知識ベースを読む。** 無い論点を調べてソースを読んだら、その回のうちに出典つきで書き戻す。
- アプリが実行しているのは `vendor/jpoke`(**v0.2.0固定**)。`../jpoke` は上流で先に進んでいるので、食い違ったら `vendor/jpoke` が正。
- Pyodideの初期化は数十秒〜数分かかる。**ダメージ計算を必要としないページでPyodideを読み込まない。**
- 育成ルール(**IV=31固定 / 努力値0〜32スケール / Lv50固定 / 合計上限66・入力制限なし**)は仕様。バグとして直さない。
