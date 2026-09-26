<!-- 2026-09-26 codex(gpt-5.6-terra)による計測。docs/perf/reports/README.md「方針相談の結果」から参照 -->

# @font-face の初期表示への寄与(2026-09-26)

調査・計測を完了しました。アプリ本体・CSSは変更していません。commit / push も行っていません。

## 結論

削減に値します。特にモバイル回線では、378個の `@font-face` を含む共通CSSが初期描画の明確な関門です。

ただし、今回の `astro preview` は圧縮配信しないため、Fast 3Gの絶対時間差は本番より大きく出ています。実運用で優先すべき順序は次です。

1. 378宣言のフルフォールバックCSSを共通クリティカルCSSから分離し、初期描画後に非同期取得する
2. 全ページで400/500/700の3ウェイトをpreloadしている状態を見直す
3. 必要なら378分割の粒度を粗くする
4. コアサブセット拡充は見送る
5. `font-display` はすでに `swap` なので、変更の優先度は低い

## 読み込み経路

- `AppLayout.astro` が全ページ共通で `global.css` を読み込む
- `global.css` から以下をimport
  - `webfont-m-plus-rounded-1c.css`: 378宣言、340,244B、gzip 92,787B
  - `webfont-m-plus-rounded-1c-core.css`: 3宣言、19,664B、gzip 3,006B
- 本番ビルドではこれらが `AppLayout.*.css` に結合され、381個の `@font-face` を含む
  - 既存dist: 352,003B、gzip 100,710B
- フルセットは400/500/700それぞれ126個の `unicode-range` 分割
- コアCSSは同じファミリー・ウェイトで後に定義されるため、重複文字にはコアサブセットが優先される
- `webfont-core-preload.ts` により400/500/700のコアwoff2を全ページでpreload
  - 216,316B + 218,516B + 231,676B = 666,508B
- 代表3ページでは、通常の126分割woff2は取得されず、preloadされたコア3本だけが取得された

つまり、`unicode-range` はwoff2リクエストの抑制には効いていますが、378宣言を含むCSSの転送・パースは抑制しません。また、コア3ウェイトを常時preloadするため、初回訪問では約667KBのフォント転送が確定します。

## 計測条件

- 既存の本番成果物を `npx astro preview --port 4322` で配信
- 各条件5回、毎回新規ブラウザコンテキスト
- ビューポート: 1920×1080
- 通常回線と以下のモバイル相当を比較
  - CPU 4倍遅延
  - 1.6Mbps down
  - 750Kbps up
  - RTT 150ms
- 条件:
  - 現状
  - `AppLayout.D62VxCu7.css` の読み込みを遮断
- フォントpreloadは残したため、遮断条件でも約667KBのコアwoff2は取得
- `npm run build` は末尾の共通ルールに従い実行していない
- 使用したdistは18:35生成。共有フォントCSSは現行と同じだが、`/data/speed-chart` はその後のページ固有変更前

### 無制限回線・中央値

| ページ | FCP 現状→CSSなし | LCP 現状→CSSなし | load 現状→CSSなし |
|---|---:|---:|---:|
| `/` | 104→92ms | 104→92ms | 92.6→55.1ms |
| `/box` | 112→112ms | 180→176ms | 147.6→136.6ms |
| `/data/speed-chart` | 120→136ms | 120→136ms | 117.1→131.0ms |

高速なローカル回線では差は測定揺らぎの範囲で、最大でも数十msでした。

### Fast 3G＋4x CPU・中央値

| ページ | FCP 現状→CSSなし | LCP 現状→CSSなし | load 現状→CSSなし |
|---|---:|---:|---:|
| `/` | 5688→728ms | 5688→728ms | 5687→796ms |
| `/box` | 7684→940ms | 7896→6032ms | 7710→5838ms |
| `/data/speed-chart` | 6724→1088ms | 6724→1088ms | 6731→2283ms |

previewでは `AppLayout` CSSがgzipされず352KB転送されるため、この数秒差を本番値として扱うことはできません。本番相当gzipならCSS部分は約101KBで、1.6Mbpsにおける転送下限は単純計算で約0.5秒です。ただし、約667KBのpreloadフォントとの帯域競合があるため、実際の影響は転送下限より大きくなる可能性があります。

フォント関連転送量は次のとおりです。

| 条件 | preview実測 | 本番圧縮時の概算 |
|---|---:|---:|
| 現状 | 約1,020KB | 約768KB |
| CSS遮断・preload残存 | 約667KB | 約667KB |
| 差 | 約352KB | 約101KB |

## CLS・字幅リスク

今回の現状条件では、全ページ・全回でCLS中央値は0でした。遅い条件では巨大なCSSがFCPを止め、その間にコアフォントも取得されるため、フォント交換が初回描画前に終わりやすいことが理由と考えられます。

したがって、CSSを非同期化すると新しいリスクが生じます。

- フォールバックフォントで先に描画される
- 後からM PLUS Rounded 1cへ交換される
- 字幅差による折り返し、ボタン幅、カード高の変化がCLSになる

非同期化を実装する際は、実装後に同じFast 3G条件でCLSを再計測すべきです。必要ならフォールバック側のメトリクス調整や、初期画面で使う文字・ウェイトだけを小さなクリティカルセットとして残す方法が適しています。

## 追加したprobeオプション

- `--vitals`
  - `--timing` の分かりやすい別名
  - FCP、LCP、load、Navigation Timing、通信量を収集
- `--throttle`
  - Fast 3G相当＋CPU 4倍遅延
- `--resource-pattern <部分文字列>`
  - URLが一致するリソースの件数、転送量、展開後サイズを個別集計
  - 複数指定可能
- 既存の `--block`、`--repeat` と組み合わせて比較可能

例:

```sh
npm run probe -- \
  --base http://127.0.0.1:4322 \
  --page home \
  --vitals \
  --throttle \
  --repeat 5 \
  --resource-pattern AppLayout \
  --resource-pattern /fonts/
```

## 変更ファイル

- [scripts/probe.mjs](C:/Users/tmtmp/Documents/pokemon/poke-guide/scripts/probe.mjs)
- [scripts/lib/page-session.mjs](C:/Users/tmtmp/Documents/pokemon/poke-guide/scripts/lib/page-session.mjs)

変更内容はスロットリング、`--vitals`、URLパターン別通信量集計、および冒頭コメントへの利用方法追記です。

## 検証

- `node --check scripts/probe.mjs`: 成功
- `node --check scripts/lib/page-session.mjs`: 成功
- `npm run probe -- --help`: 成功
- previewでの全18条件、各5回: HTTP 200
- `git diff --check`: 問題なし
- 日本語文字化け確認: 問題なし
- 一時ファイル: 削除済み
- dev server: `http://localhost:4321` で再起動済み
- `npx astro check`: `@astrojs/check` 未導入のためインストール確認で停止
- `npx tsc --noEmit`: TypeScriptコンパイラ未導入のため実行不能
- 関連する専用単体テストは存在しないため未実施