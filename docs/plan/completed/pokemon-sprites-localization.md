# ポケモンのドット絵のローカル化(2026-08-06)

## 背景

`src/lib/pokemon-master-data.ts` の `spriteUrl()` は
`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{imageId}.png`
を実行時に直接参照していた。ユーザーからの問い(「外部参照のほうがパフォーマンスメリットがある?」)を
受けて実測したところ、**パフォーマンス上のメリットは無い**と判明したためローカル化する。

### 実測(2026-08-06)

| 項目 | 実測値 |
|---|---|
| `Cache-Control` | **`max-age=300`(5分)** |
| 初回(Fastly MISS, japaneast edge) | TLS確立まで 266ms / TTFB 416ms |
| 2回目(HIT) | TTFB 40ms |
| ドット絵1枚 | 543〜1291 bytes(5枚サンプル、平均891B) |
| 公式絵1枚 | 118,057〜203,385 bytes(5枚サンプル) |

判明したこと:

1. **ブラウザキャッシュが5分しかない。** `/ranked-teams` は初期表示で300枚のドット絵を並べるため、
   5分後の再訪で300本の条件付きリクエスト(304)が発生する。自前配信なら0本にできる。
2. **画像が1KB前後しかないので、コストは転送量ではなく接続と往復。** 外部オリジンのため
   DNS+TCP+TLSを別途張る必要があり、初回に266msかかっている。同一オリジンなら既存の
   HTTP/2接続に相乗りできてこれが消える。
3. **「CDNの共有キャッシュが効く」は現在成立しない。** Chrome 86以降・Firefox・Safari は
   HTTPキャッシュをトップレベルサイト単位で分割(cache partitioning)しているため、
   他サイトが同じ画像を取得済みでも再取得になる。
4. 容量は約1.2MB(891B × 1284)で、**既にコミット済みの `public/item-icons/`(3.7MB)の
   3分の1以下**。当初「規模が大きい」と見立てたが実測で外れた。

## スコープ

### スコープ内
- `spriteUrl()`(ドット絵)のローカル化

### スコープ外(理由つき)
- ~~**`officialArtworkUrl()`(公式絵)は外部参照のまま。** 実測118〜203KB/枚 × 1284件 ≒ **180MB** で、
  gitにもCloudflare Workers assetsにも現実的に載らない。ドット絵とは3桁違う。~~
  → **2026-08-06 同日、ユーザー指示によりスコープに含めた。下の「追補」を参照。**
  原画をそのまま置かず320pxに縮小+WebP変換することで19.66MBに収めた。
- **アイテム画像・タイプ画像**は既にローカル化済み(`public/item-icons/` `public/type-icons/`)。今回は対象外。
- 画像フォーマットの変換(WebP/AVIF化)。PNGのまま扱う。1KB前後なので変換の利得が小さく、
  PokeAPIの原画と1対1で対応しなくなると差分確認が難しくなる。

## 方針

### 1. 事前生成してコミットする(build時ダウンロードはしない)

`public/item-icons/`(260ファイル)・`public/type-icons/`(38ファイル)と同じ「生成済み画像を
事前コミットする」方式に揃える。

**build時に生成しない理由**: `npm run build` のたびにGitHubへ1284リクエストを飛ばすことになり、
遅いうえレート制限で落ちる。`public/master-data/`(gitignore + build時生成)はローカルの
`vendor/jpoke` から作るのでネットワークに依存しないが、こちらは事情が違う。

### 2. 対象のimageId

`public/master-data/autocomplete/pokemon.json` の `imageId`(**ユニーク1284件** / エントリ1290件)。
`detail/pokemon.json` は `imageId` を持たないので、こちらが唯一の供給元。

⚠️ `public/master-data/` は gitignore 対象で `npm run build:master-data` が生成する。
**マスタデータを再生成してフォルムが増えたら、このスクリプトも再実行が必要。**

### 3. キャッシュヘッダ

`public/_headers` を新設し、ローカル配信の画像に長期キャッシュを設定する
(wrangler 4.113.0 が `_headers` を処理することをバンドル内の `HEADERS_FILENAME` で確認済み)。

`max-age` は **30日**。`immutable` や1年にしない理由は、ファイル名にコンテンツハッシュが
入っておらず、上流の画像が差し替わった際に再生成してもURLが変わらないため。30日あれば
リピート訪問の大半でリクエスト0本になり、5分との比較では利得をほぼ取り切れる。

### 4. 欠損時の挙動

`applySprite()`(`src/lib/box-id/shared-core.ts:195`)は `onerror` で頭文字バッジに
フォールバックするので、ローカルに無い画像があっても壊れない。
一方 `src/lib/ranked-teams/card.ts` と `src/lib/speed-chart/*` は `onerror` を持たない。
**生成スクリプトで取得できなかったimageIdを必ず報告させ、カバー率100%を確認する。**
100%にならない場合は、その時点で `onerror` フォールバックの追加を検討する。

## 変更するファイル

| ファイル | 変更 |
|---|---|
| `scripts/pokemon-sprites/generate_pokemon_sprites.py` | 新規。ドット絵をDLして `public/pokemon-sprites/` に置く |
| `public/pokemon-sprites/*.png` | 新規(生成物、コミットする) |
| `public/_headers` | 新規。ローカル画像の長期キャッシュ |
| `src/lib/pokemon-master-data.ts` | `spriteUrl()` の返り値を `/pokemon-sprites/{imageId}.png` に |
| `package.json` | `generate:pokemon-sprites` を追加 |

**`officialArtworkUrl()` は変更しない。**

## 受け入れ基準

1. `public/pokemon-sprites/` に、`autocomplete/pokemon.json` のユニークimageId **1284件すべて**の
   PNGが存在する(取得できないIDがあれば件数とIDを記録する)
2. 生成物の合計容量が **2MB以下**
3. `spriteUrl(10038)` が `/pokemon-sprites/10038.png` を返す(メガゲンガー=フォルム専用ID)
4. `officialArtworkUrl()` は従来どおり `raw.githubusercontent.com` を返す(未変更)
5. `npm run build` 成功
6. `npm test` 全件pass(件数が減っていない)
7. `/ranked-teams` の初期表示300枚が**すべて同一オリジン**(`localhost:4321`)から配信され、
   `raw.githubusercontent.com` へのドット絵リクエストが**0件**
8. `/ranked-teams` のドット絵が壊れていない(broken imageが0件)
9. `/box` `/speed-chart` `/team` でドット絵が従来どおり表示される(回帰なし)
10. `public/_headers` がビルド成果物に出力され、実際に `Cache-Control` が適用される
11. DBを変更していない

## 実施結果(2026-08-06)

| # | 基準 | 結果 | 実測 |
|---|---|---|---|
| 1 | 1284件すべて存在 | ✅ | 生成スクリプト出力「カバー率: 1284/1284 (100.0%) / 欠損なし」。上流404は0件 |
| 2 | 合計2MB以下 | ✅ | **1.36 MB** / 1284ファイル |
| 3 | `spriteUrl(10038)` → ローカルパス | ✅ | ユニットテストで `/pokemon-sprites/10034.png` を検証。画面上でもメガゲンガーのフォルム専用絵を確認 |
| 4 | `officialArtworkUrl()` は未変更 | ✅ | 既存テスト2件がそのままpass。`/box` `/team` で外部公式絵リクエストが継続して発生(8件 / 5件) |
| 5 | `npm run build` | ✅ | Complete(Server built in 1m 24s) |
| 6 | `npm test` 全件pass | ✅ | **555 → 557件**、fail 0(spriteUrlのローカル化回帰1件 + カバー率回帰1件を追加) |
| 7 | 外部ドット絵リクエスト0件 | ✅ | `/ranked-teams` ローカル341 / 外部**0**、`/speed-chart` ローカル419 / 外部**0**、`/box` `/team` も外部0 |
| 8 | 画像割れ0件 | ✅ | 4ページすべてで `complete && naturalWidth===0` の `<img>` が0件、consoleエラーも0件 |
| 9 | 既存ページの回帰なし | ✅ | `/box` `/speed-chart` `/team` を実測。スクリーンショット(light/dark)も目視確認 |
| 10 | `_headers` が実際に効く | ✅ | `wrangler dev`(4.113.0)で「Parsed 4 valid header rules.」、`/pokemon-sprites/10038.png` `/item-icons/leftovers.png` `/type-icons/1.png` すべて `Cache-Control: public, max-age=2592000` |
| 11 | DB無変更 | ✅ | `/api/ranked-teams` で M-1 527 / M-2 223 / M-3 291 = 計1041(従来どおり) |

### 実装中に判明したこと

- **`_headers` の出力先は `dist/_headers` ではなく `dist/client/_headers`。** ルート直下の
  `wrangler.jsonc` は `assets.directory: "./dist"` だが、Astroのcloudflareアダプタが
  `dist/server/wrangler.json` を生成して `"../client"` に書き換えている。当初 `dist/_headers` を
  探して見つからず、配信されないと誤認した。アダプタ自身の `/_astro/*`(immutable)ルールと
  自動でマージされる。
- **`tests/pokemon-master-data.test.ts` の `spriteUrl` テストが外部URLを直接assertしていた**ため、
  切り替えで2件failした。ローカルパスの期待値に更新済み。
- **`public/master-data/` は gitignore + build時生成なので、ドット絵だけ取り残される事故が起きうる。**
  マスタデータを再生成してフォルムが増えたときに `npm run generate:pokemon-sprites` を忘れると、
  同一オリジン参照になった今は404=画像割れに直結する(外部参照時代は上流に画像があれば表示できた)。
  検知用に「全imageIdに対応するPNGが存在する」テストを追加した。

### スコープ外に落としたもの(将来やるなら何から)

1. **公式絵(`officialArtworkUrl`)のローカル化。** 180MB規模なので、やるなら
   「使用頻度の高い種族だけ」「WebP変換して縮小」等の前処理とセットで別途検討する。
   現状 `/box` `/team` は1画面あたり5〜8枚しか出さないため、体感上の優先度は低い。
2. `_headers` の `max-age` を `immutable` に引き上げる。ファイル名にコンテンツハッシュを
   付ける仕組み(`{imageId}-{hash}.png`)を入れてからでないと安全にできない。
3. ドット絵のWebP/AVIF化。1KB前後なので利得が小さく、PokeAPIの原画との1対1対応が崩れる。

---

# 追補: 公式絵のローカル化(2026-08-06)

上のドット絵ローカル化の直後、「アプリ内では公式絵も使っているが、これもダウンロードすべきか」
というユーザーの問いを受けて実測し、**縮小+WebP変換した上でローカル化する**方針をユーザーが選択した。

## 実測(2026-08-06)

公式絵の原画は **475x475 / 平均145.8KB**(サンプル10件)。1284件そのままなら **178.6MB**。
一方、アプリが実際に表示しているサイズは原画よりはるかに小さい。

| ページ | 公式絵の枚数 | 転送量 | CSS表示サイズ | 原画 |
|---|---|---|---|---|
| `/box` | 8枚 | **943 KB** | 115×115 | 475×475 |
| `/team` | 5枚 | 640 KB | 72×72 | 475×475 |
| `/pokemon/[name]` | 1枚 | 149 KB | 160×160 | 475×475 |

判明したこと:

1. **表示サイズに対して原画が過剰。** `/box` は `src/pages/index.astro` がリダイレクトする
   サイトの実質的な入り口で、そこで115px表示のために約1MBを落としていた。
2. **ドット絵をローカル化した結果、`/box` と `/team` が外部オリジンに接続する理由は公式絵だけになり、
   コスパがむしろ悪化していた。** 5〜8枚のためにDNS+TCP+TLS(初回266ms)を張る状態。
3. 変換後の見積もり(サンプル10件):

   | 方式 | 1枚 | 1284件 |
   |---|---|---|
   | 原画 PNG 475px | 145.8 KB | 178.6 MB |
   | 192px WebP | 10.0 KB | 12.5 MB |
   | 256px WebP | 14.0 KB | 17.6 MB |
   | **320px WebP (q82)** | **18.0 KB** | **22.6 MB** |
   | 384px WebP | 22.2 KB | 27.8 MB |

## 確定した方針

**320px WebP (quality=82)。** 最大表示が `/pokemon/[name]` と `/share/[slug]` の160pxなので、
Retina(2倍)を見込んで320pxを下限とした。q75まで落とすと2.5MB削れるが、公式絵は写実的な
イラストで圧縮劣化が出やすいため画質を優先した。

`og:image` / `twitter:image` のような**絶対URLを要求する用途は無い**ことを確認済み
(`artworkUrl` の用途は `pokemon/[name].astro:529` と `share/[slug].astro:201` の通常の `<img>` のみ)。
そのためルート相対パスで問題ない。

## 変更したファイル

| ファイル | 変更 |
|---|---|
| `scripts/pokemon-artwork/generate_pokemon_artwork.py` | 新規。公式絵をDL→320px縮小→WebP変換 |
| `public/pokemon-artwork/*.webp` | 新規(生成物、コミットする) |
| `public/_headers` | `/pokemon-artwork/*` に30日キャッシュを追加 |
| `src/lib/pokemon-master-data.ts` | `officialArtworkUrl()` を `/pokemon-artwork/{imageId}.webp` に |
| `package.json` | `generate:pokemon-artwork` を追加 |
| `tests/pokemon-master-data.test.ts` | 期待値更新 + 拡張子取り違え防止 + 公式絵のカバー率回帰 |

## 実施結果

| # | 基準 | 結果 | 実測 |
|---|---|---|---|
| 1 | 1284件すべて存在 | ✅ | 「カバー率: 1284/1284 (100.0%) / 欠損なし」 |
| 2 | 見積もり(22.6MB)以内 | ✅ | **19.66 MB / 15.7 KB per 枚**(見積もりを下回った) |
| 3 | 外部リクエスト0件 | ✅ | `/box` `/team` `/ranked-teams` `/speed-chart` `/pokemon/[name]` の**全ページで `raw.githubusercontent.com` へのリクエスト0件**。これでアプリ全体が外部画像ホストから独立した |
| 4 | 転送量の削減 | ✅ | 公式絵1枚あたり **118 KB → 16 KB**(約1/7)。`/box` は 943KB → 260KB |
| 5 | 復号後の解像度 | ✅ | ブラウザ実測で 320x320(表示は72〜160pxなのでRetinaでも足りる) |
| 6 | 画質 | ✅ | 背景合成後のPSNR **35.0〜41.8 dB**(サンプル10件)。**アルファチャンネルは完全一致(無劣化)** |
| 7 | 画像割れ / consoleエラー | ✅ | 5ページすべて0件 |
| 8 | `npm run build` | ✅ | Complete |
| 9 | `npm test` | ✅ | **557 → 559件**、fail 0 |
| 10 | 目視確認 | ✅ | `/box`(115px)と `/pokemon/ガブリアス`(160px)をlight/darkで確認。圧縮由来の劣化は視認できず |

### 実装中に判明したこと

- **PSNRを素朴に測ると14.7dBという異常値が出る。** 原因は**完全透過ピクセルのRGB値**で、
  WebPはそこに元と違う値を格納するが画面上は一切見えない。
  背景に合成してから比較すると35.0〜41.8 dBになる。今後この手の計測をするときは必ず合成後に測ること。
- **`workerd.exe` が `dist/` を掴んだままだと `astro build` が `EPERM` で落ちる。**
  `wrangler dev` を使った後は `taskkill //F //IM workerd.exe` で確実に落としてから
  ビルドすること(`Ctrl-C` 相当の停止だけでは残ることがある)。

### スコープ外に落としたもの

1. `_headers` の `max-age` を `immutable` にする(ファイル名にコンテンツハッシュを付けるのが先)。
2. PNGフォールバック。持つと容量が倍以上になり意味が薄れる。現行ブラウザのWebP対応状況では不要と判断。
3. AVIF化。WebPよりさらに小さくなる可能性はあるが、変換コストと対応状況を踏まえ今回は見送り。
