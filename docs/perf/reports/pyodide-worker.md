<!-- 2026-09-26 codex(gpt-5.6-terra, read-only)による設計調査。docs/perf/reports/README.md「方針相談の結果」から参照 -->

# Pyodide / jpoke Web Worker 化 設計調査報告

## 1. 結論

推奨は「部分的にやる」です。

- Web Worker 化には、計算中のメインスレッド停止を根本的に解消する価値がある。
- 一方、現在の指標「ダメージ表を初回表示 6202ms」を 5000ms 未満にする主施策としては弱い。
- 6202ms の大部分は、コード上では「3秒待ってから始めるプリフェッチ」と Pyodide 初期化が占めている可能性が高い。Worker に移しても初期化そのものは短縮されない。
- まずエンジン API を真正の非同期 RPC にできる境界へ整理し、そのうえで `/damage-calc` と `/box/[id]` の計算を Worker に移すのが妥当。
- 6202ms の改善は、Worker 化とは別に「ダメージタブ初期表示時は3秒待たずに初期化開始」を検討すべきである。

Worker 化の目的は「初回表示時間の大幅短縮」ではなく、「計算量が増えても UI を固めないこと」と位置づけるのが正確である。

---

## 2. 調査範囲

以下を確認した。

- `docs/plan/damage-calc-selection-perf.md`
- `docs/perf/reports/README.md`
- `docs/perf/dashboard.md`
- `src/lib/pyodide-engine.ts`
- `pyodide-engine.ts` の値 import および関数呼び出しを `src/**/*.ts`、`src/**/*.astro` から検索
- `/damage-calc`
- `/box/[id]` のダメージ表、ダメージ詳細パネル、一括耐久調整
- `/box/matchup`
- `/team/[id]` の相性タブ
- すばやさ表示を含む `matchup-card.ts`
- PoC、E2E ハーネス
- `public/_headers`
- `src/lib/security-headers.ts`
- `src/middleware.ts`
- `astro.config.mjs`
- wheel マニフェストと Service Worker

ファイル編集、Git 操作、保存を伴うブラウザ操作は行っていない。

---

## 3. 現在のエンジン構成

### 3.1 初期化の流れ

`initEngine()` はモジュール単位のシングルトンであり、最初の呼び出しだけが以下を実行する。

1. jsDelivr から `pyodide.js` を動的な `<script>` 要素でロード
2. `loadPyodide()` を実行
3. `micropip` をロード
4. jpoke wheel をインストール
5. `BOOTSTRAP_PYTHON` を `runPythonAsync()` で実行
6. Python 側の計算関数を `pyodide.globals.get()` で取得

現実装は `window` と `document` に依存するため、そのまま Worker に移すことはできない。特に `loadScriptOnce()` は DOM 専用であり、Worker 用ブートストラップへの置換が必要である。

jpoke wheel はハードコードではなく、ビルド生成物である次のマニフェストを静的 import している。

```json
{
  "filename": "jpoke-0.6.0-0dd868e87df-py3-none-any.whl"
}
```

実ファイルは約 1,004,215 bytes である。

既存資料に記録された初回転送量は次のとおり。

| アセット | サイズ |
|---|---:|
| `pyodide.asm.wasm` | 2,991,722 B |
| `python_stdlib.zip` | 2,306,344 B |
| `pyodide.js` | 5,960 B |
| jpoke wheel | 約 1.0 MB |
| 合計 | 約 6.3 MB |

`public/pyodide-sw.js` は Pyodide CDN と `/master-data/pyodide/` を cache-first で保持する。したがって、この転送コストは主に新規ブラウザの初回で発生する。

### 3.2 公開関数一覧

「回数」は本番コード上の静的な直接呼び出し箇所数である。ループによる実行回数とは異なる。PoC・E2E は別記した。

| 公開関数 | 宣言上の性質 | 実際の性質 | 主な本番呼び出し元・静的回数 |
|---|---|---|---|
| `getEngineProgress()` | 同期 | 同期、状態取得のみ | 本番 0。E2E ハーネス 1 |
| `registerOfflineCache()` | 同期 | SW 登録を開始し、完了は待たない | `damage-calc.ts` 1、`matchup-card.ts` 1、`matchup-panel.ts` 1。PoC 1 |
| `scheduleEnginePrefetch()` | 同期 | 3秒以上待ってからコールバックを起動 | `box-id/damage-calc.ts` 1 |
| `initEngine()` | `Promise` | 初期化処理は非同期。内部にネットワーク、Wasm 初期化、Python 実行あり | `damage-calc.ts` 1、`bulk-adjust.ts` 1、`matchup-card.ts` 1、`matchup-panel.ts` 1。PoC 1、E2E 1 |
| `isEngineReady()` | 同期 | 同期、状態判定のみ | `damage-calc.ts` 3。PoC 2、E2E 1 |
| `isEngineFatal()` | 同期 | 同期、状態判定のみ | `matchup-panel.ts` 2、`bulk-adjust.ts` から注入 1 |
| `resetEngine()` | `async` | Pyodide 全体を破棄扱いにして再初期化 | `matchup-panel.ts` 1、`bulk-adjust.ts` から注入 1 |
| `calcDamages()` | `async` | **計算本体は同期** | `matchup-card.ts` 2。PoC 1、E2E 1 |
| `calcStats()` | `async` | **計算本体は同期** | `damage-calc.ts` 1、`matchup-card.ts` 4。E2E 1 |
| `calcLethalSequence()` | `async` | **計算本体は同期** | `damage-calc.ts` 2、`bulk-adjust.ts` からソルバーへ注入 1。E2E 1 |
| `calcMaxDamageMatrix()` | `async` | **計算本体は同期** | `matchup-panel.ts` 2 |

型の export は多数あるが、Worker 化の実行境界に影響する公開操作は上記で網羅できる。

### 3.3 画面別の利用関係

| 画面・機能 | 経路 | 使用 API |
|---|---|---|
| `/damage-calc` | `pages/damage-calc/index.astro` → `damage-calc-page/matchup-card.ts` | `initEngine`、`calcDamages`、`calcStats` |
| `/box/[id]` ダメージ表 | `box-id/damage-calc.ts` | `initEngine`、`calcStats`、`calcLethalSequence` |
| `/box/[id]` ダメージ詳細パネル | `damage-detail-panel.ts` → `damage-calc.ts` の再計算ブリッジ | 直接 import はせず、最終的に上記 API を利用 |
| `/box/[id]` 一括耐久調整 | `bulk-adjust.ts` → `bulk-adjust-solver.ts` | `initEngine`、`calcLethalSequence`、`isEngineFatal`、`resetEngine` |
| `/box/matchup` | `pages/box/matchup.astro` → `matchup-panel.ts` | `initEngine`、`calcMaxDamageMatrix`、fatal/reset |
| `/team/[id]` 相性タブ | `pages/team/[id].astro` → 同じ `matchup-panel.ts` | 同上 |
| `/damage-calc` すばやさ欄 | `matchup-card.ts` | `calcStats` |
| PoC | `pages/damage-calc-poc/index.astro` | `initEngine`、`calcDamages` |
| E2E ハーネス | `pages/e2e-test-harness/index.astro` | 主要 API を `window.__pyodideEngine__` に公開 |

育成パネルの通常の実数値表示は現在純 JavaScript 化されており、`pokemon-edit-panel.ts` の `recalcStats()` は Pyodide 呼び出しではない。この部分は Worker 移行対象ではない。

---

## 4. メインスレッドを塞いでいる箇所

### 4.1 計算 API

`calcDamages()`、`calcStats()`、`calcLethalSequence()`、`calcMaxDamageMatrix()` はすべて `async function` だが、内部では次の処理を同期的に行う。

- `pyodide.toPy()`
- Python 関数プロキシの呼び出し
- Python 側の Battle 構築・計算
- `json.dumps()`
- JavaScript 側の `JSON.parse()`
- PyProxy の `destroy()`
- Python 側の `gc.collect()`

計算本体までに `await` がないため、呼び出し側で `await calc...()` と書いてもブラウザへ制御は戻らない。Promise は同期計算が終了した後に解決されるだけである。

特に重い箇所は次のとおり。

- `/damage-calc`
  - 技ごとの `calcDamages()`
  - 防御側 HP や双方のすばやさを求める `calcStats()`
- `/box/[id]`
  - 各相手カード・技列の `calcLethalSequence()`
  - `calcLethalSequence()` と `calcStats()` の `Promise.all`
  - `Promise.all` でも両方がメインスレッド上で同期実行されるため、CPU 並列化にはならない
- 一括耐久調整
  - 候補探索中に繰り返す `calcLethalSequence()`
  - コメント上、3発の技列で1回約20msという既存実測がある
- `/box/matchup`・`/team/[id]`
  - チーム×対戦相手の総当たりを Python 内部で行う `calcMaxDamageMatrix()`

`matchup-card.ts` と `matchup-panel.ts` にはマクロタスクへの yield があるため、複数計算の間には描画機会がある。しかし、個々の Pyodide 呼び出し中は依然として停止する。

### 4.2 初期化処理

初期化にも二種類ある。

- ネットワーク待ち
  - `pyodide.js`
  - Wasm
  - Python 標準ライブラリ
  - `micropip`
  - wheel
- CPU・Wasm 実行
  - Wasm インスタンス生成
  - Python ランタイム初期化
  - wheel の展開・インストール
  - `import jpoke`
  - `BOOTSTRAP_PYTHON`
  - Python 関数プロキシ取得

ネットワーク待ち自体はメインスレッドを占有しない。一方、Wasm のコンパイル・インスタンス生成、Python パッケージの展開・import、ブートストラップ Python の実行にはメインスレッド上の CPU 時間が含まれる。

Worker 化すると、この CPU 停止は Worker 側へ移る。ただし初期化完了時刻そのものが早くなるわけではない。

---

## 5. 6202ms の内訳推定

ダッシュボードのシナリオは以下の条件である。

- `/box/[id]?tab=damage`
- 保存済み相手カード3枚
- 累計ダメージの数値表示まで
- ページ内の Pyodide は未初期化
- 初期化は表示3秒後のプリフェッチから開始
- 現在値 6202ms、目標 5000ms

コードと既存記録からの概算は以下になる。

| 区間 | 推定 |
|---|---:|
| `scheduleEnginePrefetch()` の最低待機 | 約3000ms |
| Pyodide + micropip + wheel + jpoke import + bootstrap | 約2000～2600ms |
| 3カードの初回計算、DOM反映、その他待機 | 約600～1200ms |
| 合計 | 約5600～6800ms |

根拠は次のとおり。

- プリフェッチには固定の `ENGINE_PREFETCH_FLOOR_MS = 3000` がある。
- 致命エラー後の `resetEngine()` は既存コメントで約2.4秒とされている。キャッシュ済みでも再初期化にこの程度かかる事例がある。
- ダッシュボードの 6202ms から固定待機3秒を引くと残りは約3.2秒であり、2秒台の初期化＋カード計算と整合する。
- 既存資料も「残りの支配項は Pyodide 初期化」と結論づけている。

厳密な User Timing 計測点は現在エンジン内にないため、ダウンロード・`loadPyodide`・`micropip`・wheel・bootstrap・初回計算を個別に断定することはできない。

dev server は稼働していたが、このシナリオの再現には保存済み相手カードを持つ対象個体が必要である。保存操作禁止の条件下で安全に同一条件を再構築できないため、新しいブラウザ実測値は採っていない。

---

## 6. Worker 化の設計案

## 6.1 責務分割

### Worker 側へ移すもの

- Pyodide のロード
- Pyodide インスタンス
- `micropip` ロード
- jpoke wheel のインストール
- `BOOTSTRAP_PYTHON`
- Python 関数プロキシ
- 次の計算処理
  - `calcDamages`
  - `calcStats`
  - `calcLethalSequence`
  - `calcMaxDamageMatrix`
- fatal Wasm エラーの判定
- Worker 内エンジンのリセット・再初期化
- 初期化段階の進捗通知

### メインスレッドに残すもの

- DOM 更新
- 入力値から `PokemonSpec` 等を組み立てる処理
- 計算結果の表示整形
- Service Worker 登録
- `scheduleEnginePrefetch()` の開始方針
- 画面単位の `currentRequestId`
- Worker RPC の pending Promise 管理
- タイムアウト、古い結果の破棄
- Worker 障害時の UI 表示
- Worker の再生成

`PokemonSpec`、`FieldSpec`、結果型などの純粋な型は、DOM 非依存の protocol/type ファイルへ分離するのが望ましい。

## 6.2 推奨ファイル構成

例:

```text
src/lib/damage-engine/
├─ types.ts
├─ protocol.ts
├─ client.ts
├─ worker.ts
├─ pyodide-runtime.ts
└─ legacy-main-thread.ts
```

- `types.ts`: 既存の公開型
- `protocol.ts`: RPC メッセージ型
- `client.ts`: 現在の `pyodide-engine.ts` と互換の Promise API
- `worker.ts`: Worker のメッセージループ
- `pyodide-runtime.ts`: Pyodide 初期化と Python 呼び出し
- `legacy-main-thread.ts`: 段階移行・限定フォールバック用

最終的には既存 import を大きく変えないよう、`pyodide-engine.ts` を client facade として残す案が安全である。

## 6.3 RPC 形式

リクエスト例:

```ts
type EngineRequest =
  | { kind: "init"; id: number }
  | { kind: "calcDamages"; id: number; payload: CalcDamagesArgs }
  | { kind: "calcStats"; id: number; payload: PokemonSpec }
  | { kind: "calcLethalSequence"; id: number; payload: CalcLethalSequenceArgs }
  | { kind: "calcMaxDamageMatrix"; id: number; payload: CalcMaxDamageMatrixArgs }
  | { kind: "cancel"; id: number }
  | { kind: "reset"; id: number };
```

応答例:

```ts
type EngineResponse =
  | { kind: "progress"; stage: InitStage; message: string }
  | { kind: "result"; id: number; result: unknown }
  | { kind: "error"; id: number; error: SerializedError }
  | { kind: "cancelled"; id: number }
  | { kind: "fatal"; error: SerializedError };
```

Worker クライアントは `Map<number, {resolve, reject}>` を持ち、単調増加する RPC ID を割り当てる。

### 画面の request ID との関係

RPC ID と画面の `currentRequestId` は役割が異なるため分離する。

- RPC ID: Worker 応答を個々の Promise に対応づける。
- 画面 request ID: 一連の画面更新がまだ最新かを判断する。

既存の次の判定は維持できる。

```ts
if (currentRequestId !== requestId) return;
```

Worker 応答後、DOM 反映前に同じ判定を行えばよい。Worker 化によってこの方式が不要になるわけではない。

## 6.4 キャンセル

重要な制限として、Pyodide の同期計算中は Worker 自身も `cancel` メッセージを処理できない。

したがって通常キャンセルで可能なのは次の範囲である。

- 未着手キューから除外
- 計算終了後の結果を破棄
- 複数チャンク間で中止
- メイン側で Promise を `AbortError` として終了

実行中の長い Python 呼び出しを直ちに止めるには `worker.terminate()` が必要だが、Pyodide、wheel、キャッシュ済み Python 状態をすべて失い、再初期化が必要になる。そのため通常操作では推奨しない。

`calcMaxDamageMatrix()` のような大きい処理で真の中断性が必要なら、攻撃側または防御側を小さなチャンクに分け、チャンク間でキャンセルを確認する設計が必要である。

## 6.5 進捗通知

現在のメッセージ段階をそのまま Worker から通知できる。

- Pyodide ランタイムをロード中
- micropip をロード中
- jpoke wheel をインストール中
- jpoke 計算ヘルパーを準備中
- ready
- error
- restarting

追加するなら、内部段階を安定した enum にする。

```ts
type InitStage =
  | "idle"
  | "runtime-script"
  | "runtime"
  | "micropip"
  | "wheel"
  | "bootstrap"
  | "ready"
  | "error";
```

UI 文言を Worker から直接送るより、`stage` と詳細を送り、表示文言はメイン側で決める方がテストしやすい。

計算の進捗は、単一の Python 関数内部からは通知できない。進捗表示が必要な一括処理はクライアントまたは Worker でチャンク分割する。

## 6.6 エラーとフォールバック

推奨する扱いは次のとおり。

1. 通常の Python 例外
   - リクエスト単位でエラー応答
   - Worker は維持
2. `WebAssembly.RuntimeError` / `memory access out of bounds`
   - Worker を終了
   - 新しい Worker を生成
   - 1回だけ再初期化・再試行
3. Worker のロード失敗
   - ユーザーへ明示
   - 必要なら旧メインスレッド実装へ限定フォールバック
4. 再試行も失敗
   - 計算を停止し、再読み込み案内

メインスレッド版への自動フォールバックは慎重にすべきである。Worker の目的である「UI を固めない」という保証が、環境によって突然失われるためである。また Worker 版とメイン版を同時初期化すると、Wasm メモリと転送量が二重になる。

推奨は次の順序。

- リリース初期は feature flag で Worker/legacy を選択可能にする。
- Worker 初期化失敗時の自動フォールバックは1回だけ。
- フォールバックしたことを UI またはログで識別可能にする。
- 安定後は Worker 再生成を標準復旧経路にし、メインスレッド版を削除する。

---

## 7. Astro / Vite での Worker バンドル

基本形はこれでよい。

```ts
const worker = new Worker(
  new URL("./worker.ts", import.meta.url),
  { type: "module" },
);
```

Vite が Worker エントリを別チャンクとして処理するため、手書きの出力パス管理は不要である。

ただし現在の `loadScriptOnce()` は `<script>`、`window`、`document` に依存するため Worker 内では利用できない。

候補は二つある。

### 案A: module Worker + Pyodide ESM エントリ

Worker 内で Pyodide の ESM エントリを動的 import し、`loadPyodide()` を得る。

利点:

- Vite の module Worker と自然に統合できる
- `importScripts()` に依存しない
- TypeScript で構成しやすい

注意点:

- Pyodide v0.26.4 の配信 ESM エントリ、CORS、CSP を対象ブラウザで検証する必要がある
- Vite が外部 CDN URL をビルド時解決しようとしないよう、外部 import の扱いを確認する必要がある

### 案B: Worker 用ローダーを同一オリジンに置く

Pyodide ローダーを同一オリジン配信し、Worker からロードする。

利点:

- CSP と CORS が単純
- CDN 障害への依存を減らせる
- `worker-src 'self'` と `script-src 'self'` に寄せられる

欠点:

- Pyodide 配布物の管理・更新コストが増える
- 現在の CDN 向け Service Worker キャッシュ設計を見直す必要がある

初期実装は案Aで技術検証し、本番安定性を重視するなら案Bを検討するのがよい。

---

## 8. CSP への影響

現在の CSP は静的アセットと SSR の両方で概ね以下を許可している。

```text
script-src 'self' 'unsafe-inline' 'unsafe-eval'
           'wasm-unsafe-eval' https://cdn.jsdelivr.net
connect-src 'self' https://cdn.jsdelivr.net
worker-src 'self' blob:
```

同一オリジンの Vite Worker チャンクは `worker-src 'self'` で許可される。Vite やライブラリが Blob Worker を生成する場合も、既存の `blob:` で許可済みである。

Pyodide の CDN アセット取得も、現状の `connect-src https://cdn.jsdelivr.net` で許可されている。

ただし確認すべき点がある。

- Worker 内の動的 module import が `script-src` と `worker-src` のどちらの適用を受けるか、実配信環境で確認する。
- `pyodide.mjs` を CDN から import する場合、現在の `script-src` には jsDelivr があるため方針上は整合する。
- Wasm コンパイルには現在すでに `'wasm-unsafe-eval'` がある。
- `public/_headers` と `src/lib/security-headers.ts` は同一内容を維持する必要がある。
- `/speed-chart` 系だけは middleware が `frame-ancestors` を変更するが、Worker には影響しない。

現状の CSP に Worker 化を妨げる明白な不足はない。新しい外部オリジンを追加せず、jsDelivr または同一オリジンに限定するのが望ましい。

---

## 9. wheel マニフェストとオフラインキャッシュ

Worker ファイルからも現在と同様に以下を静的 import できる。

```ts
import manifest from "../../../public/master-data/pyodide/wheel-manifest.json";
```

そこから同一オリジン URL を組み立てればよい。

```ts
const wheelUrl =
  `/master-data/pyodide/wheels/${manifest.filename}`;
```

この URL は既存 `pyodide-sw.js` の `/master-data/pyodide/` パターンに一致する。Worker の `fetch` もページを制御する Service Worker の fetch ハンドラを通るため、既存の cache-first 方針を再利用できる。

ただし初回訪問では SW のインストール・claim と Pyodide fetch が競合し、キャッシュを経由しない可能性がある。これは現状と同じである。

改善するなら次の選択肢がある。

- SW の install 時に固定 Pyodide アセットを precache
- wheel マニフェストから現行 wheel を precache
- `registerOfflineCache()` 完了後に明示的な warm-up メッセージを送る
- Cache Storage にあるかを確認して初期化 UI を調整する

ただし Pyodide 一式は約6.3MBあるため、全利用者への無条件 precache は推奨しない。ダメージ計算を使う画面・ユーザーに限定すべきである。

---

## 10. 段階的な移行手順

| 段階 | 内容 | コスト | 主なリスク |
|---|---|---:|---|
| 0 | 初期化と各計算に User Timing を追加し、6202ms の内訳を取得 | 小 | 計測名やテスト条件の不統一 |
| 1 | 型・プロトコルを DOM 非依存ファイルへ分離。現在の API シグネチャは維持 | 小～中 | 大きい型ファイルの循環 import |
| 2 | 既存エンジンの前面に client facade を置く。内部はまだメインスレッド実装 | 中 | エラー・進捗購読の互換性 |
| 3 | RPC クライアントを実装。リクエストID、pending Map、進捗、fatal、reset を整備 | 中 | Promise のリーク、Worker 終了時の未解決 Promise |
| 4 | Worker 内に Pyodide 初期化と4計算 API を実装 | 中～大 | CDN ESM/CORS/CSP、Pyodide の Worker ロード方式 |
| 5 | `/damage-calc` を feature flag で Worker に切替 | 中 | 古い結果の反映、すばやさ計算の順序 |
| 6 | `/box/[id]` のダメージ表・詳細パネルを切替 | 大 | 相互 import、行保存・再計算・詳細パネルとの整合 |
| 7 | 一括耐久調整を切替 | 中～大 | 多数 RPC、キャンセル、fatal 時の再試行 |
| 8 | `/box/matchup` と `/team/[id]` を切替 | 中 | 大きな matrix メッセージ、進捗粒度 |
| 9 | legacy fallback を縮小または削除 | 小～中 | 未対応ブラウザや障害時の復旧 |
| 10 | 初期化開始タイミングとキャッシュ戦略を別施策として調整 | 小～中 | 他操作との CPU・ネットワーク競合 |

各段階で従来 API が動く facade を維持すれば、常に動作可能な状態で進められる。

### 最初に切り替える対象

`/damage-calc` が最適である。

- 依存が `matchup-card.ts` に集中している
- 既に `currentRequestId` がある
- 保存との結合が弱い
- 既存資料に long task の実測方法がある
- Worker 化の効果を UI 応答性で確認しやすい

逆に `/box/[id]` は、ダメージ表・詳細パネル・保存・一括調整・循環 import が絡むため、最初の対象には向かない。

---

## 11. 6202ms に対する効果予測

### Worker 化だけを行った場合

期待できること:

- Pyodide 初期化中の CPU 区間でメインスレッドが空く
- 各計算中もスクロール、アニメーション、キャンセル操作、進捗表示が応答する
- yield の入れ忘れに起因する long task を構造的に防げる
- 一括耐久調整や matrix 計算の悪化が UI フリーズに直結しなくなる

期待しにくいこと:

- 3秒のプリフェッチ待ちはそのまま
- 約6.3MBの初回取得はそのまま
- wheel の展開、jpoke import、計算量はそのまま
- `postMessage` の structured clone と RPC 往復が追加される
- Worker 起動コストが追加される
- 完了時刻は同等か、数十～数百ms悪化する可能性もある

したがって Worker 化単独では、6202ms はおおむね 6000～6500ms程度に留まる可能性が高い。5000ms 達成を約束できる施策ではない。

改善するのは主に「待っている間の操作可能性」と「最大 long task」である。

### 初期化の開始を前倒しした場合

現在の計測条件では3秒の固定待機があるため、ダメージタブを最初から表示している場合に限り、初期化を直ちに始めれば理論上最大約3秒短縮できる。

単純計算では次の範囲が見込める。

```text
6202ms - 約3000ms = 約3200ms
```

実際にはページ初期描画との競合や dev/build 差があるため、そのまま3秒短縮とは限らない。それでも5000ms達成に対する効果は Worker 化単独より明確に大きい。

Worker 化後なら、初期化を早く始めてもメインスレッドの CPU 競合が減るため、両施策は相性がよい。

---

## 12. Worker 化以外の代替案

| 施策 | 初回完了時間 | UI 応答性 | コスト | 評価 |
|---|---|---|---:|---|
| ダメージタブ初期表示時に即 `initEngine()` | 大きく改善し得る | 初期化CPUは現状メインを塞ぐ | 小 | 6202ms対策として最優先候補 |
| Pyodide を Worker 化 | ほぼ不変 | 大きく改善 | 中～大 | 応答性の根本対策 |
| 即初期化 + Worker | 大きく改善し得る | 大きく改善 | 大 | 最終的な理想形 |
| wheel/Pyodide の事前キャッシュ | 再訪時を改善 | 変化小 | 中 | 初回訪問には効かない |
| SW install で無条件 precache | 次回を改善 | 変化小 | 中 | 6.3MBを不要ユーザーにも取得するため非推奨 |
| ダメージ画面への遷移意図で preload | 条件付きで改善 | 現方式ではCPU競合あり | 小～中 | hover/pointerdown/タブ表示予測と相性がよい |
| jpoke import/bootstrap の永続化 | Web の通常構成では困難 | — | 大 | Pyodide インスタンスはページをまたいで保持できない |
| SharedWorker でページ間共有 | 再遷移に有効な可能性 | 良い | 大 | 対応・寿命・CSP・デバッグが複雑。Dedicated Workerの後 |
| 計算のバッチ化 | 計算部分を短縮可能 | 呼び出し回数も減る | 中 | `calcMaxDamageMatrix` の発想を他画面へ展開可能 |
| 純JS/Wasmネイティブ実装への移行 | 最大の改善余地 | 良い | 非常に大 | jpokeとの結果同一性維持が難しい |

---

## 13. 検証指標

着手する場合、完了時間だけで評価すると Worker 化の価値を見誤る。最低限、次を分けて記録すべきである。

- Worker 生成開始 → Worker ready
- Pyodide ローダー取得
- `loadPyodide()` 完了
- `micropip` 完了
- wheel install 完了
- bootstrap 完了
- 初回 RPC 開始 → 終了
- 初回結果の DOM 反映
- 最大 long task
- 最大 rAF フレームギャップ
- Worker 再生成時間
- cold cache / warm HTTP cache / Service Worker cache の別

成功条件の例:

- 初回表示完了: 5000ms以下
- 計算中のメインスレッド long task: 50ms超を原則発生させない
- 古いリクエストの DOM 反映: 0件
- Worker fatal 後の再初期化: 1回で復旧
- Worker 終了時の未解決 Promise: 0件

---

## 14. 最終推奨

### 推奨方針

「非同期 facade の整備と計測を先行し、Worker 化は `/damage-calc` から段階導入する」。

優先順は次のとおり。

1. 初期化各段階と計算に計測点を追加し、6202ms の内訳を確定する。
2. `/box/[id]?tab=damage` 初期表示時だけ、3秒待たず初期化を始める実験を行う。
3. 公開 API を互換 facade の背後に置き、Worker RPC に交換可能にする。
4. `/damage-calc` を Worker 化し、long task とフレームギャップを比較する。
5. 効果と安定性を確認して `/box/[id]`、一括調整、相性チェックへ広げる。

### 判断理由

- 6202ms の直接原因は Worker 不在より、3秒の開始遅延と Pyodide 初期化時間である。
- ただし同期 Pyodide 呼び出しによるフリーズは複数画面に存在し、yield を個別に追加し続ける方式には漏れやすさがある。
- 計算量が大きい一括耐久調整や相性 matrix では、Worker 化の価値が特に高い。
- 既存の `currentRequestId !== requestId` はそのまま活用でき、UI 側の古い結果破棄設計は良好である。
- CSP、Astro/Vite、wheel マニフェスト、既存 Service Worker のいずれにも致命的な障害は見当たらない。
- 最大の技術リスクは、Pyodide の Worker 用ロード方式、fatal 時の Worker 再生成、キャンセルが「実行中 Python の中断」にはならない点である。

したがって「6202msを直すためだけに即全面Worker化」は勧めないが、中期的な応答性と保守性の改善としては着手価値がある。初期化前倒しと組み合わせる前提で、段階導入するのが最も費用対効果が高い。