#!/usr/bin/env node
/**
 * jpoke (vendor/jpoke) を単一の情報源として、以下3種類の静的アセットを
 * public/master-data/ 配下に生成するビルドスクリプト。
 *
 *   1. オートコンプリート用軽量 JSON: public/master-data/autocomplete/*.json
 *   2. 検索結果の詳細表示用 JSON:     public/master-data/detail/*.json (Phase 4-1)
 *   3. Pyodide 実行用 wheel:          public/master-data/pyodide/wheels/*.whl
 *
 * 実行: npm run build:master-data
 *
 * jpoke はこのリポジトリ内に `vendor/jpoke` としてバージョン固定で同梱(vendoring)している
 * (開発プラン §4リスク表: 「jpoke をバージョン固定で vendoring し、更新は回帰テスト付きで
 * 取り込む」)。CI・Cloudflareのビルド環境には存在しない兄弟ディレクトリ `../jpoke` には
 * 依存しない。更新手順は vendor/jpoke/VENDORING.md を参照。
 *
 * 環境変数:
 *   JPOKE_DIR    jpoke リポジトリのパス(既定: このリポジトリ内の vendor/jpoke。
 *                ローカルで手元の最新 jpoke を試したい場合などに上書き可能)
 *   JPOKE_PYTHON jpoke 用 Python 実行ファイルのパス(既定: システムの `python`/`python3`。
 *                jpoke 専用の venv がある場合はそのパスを指定してもよい)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const jpokeDir = path.resolve(process.env.JPOKE_DIR ?? path.join(repoRoot, 'vendor', 'jpoke'));
const jpokeSrcDir = path.join(jpokeDir, 'src');

// vendor/jpoke は venv を持たない(ソースのみを同梱)ため、既定では jpokeDir/.venv があれば
// それを優先しつつ(ローカルで JPOKE_DIR を手元の jpoke に向けた場合の後方互換)、無ければ
// システムの python(3) にフォールバックする。CI では setup-python + `pip install build` で
// システム Python 側に必要なものが揃う想定。
const venvPython = process.platform === 'win32'
  ? path.join(jpokeDir, '.venv', 'Scripts', 'python.exe')
  : path.join(jpokeDir, '.venv', 'bin', 'python');
const systemPython = process.platform === 'win32' ? 'python' : 'python3';
const jpokePython = process.env.JPOKE_PYTHON ?? (existsSync(venvPython) ? venvPython : systemPython);

const autocompleteOutDir = path.join(repoRoot, 'public', 'master-data', 'autocomplete');
const detailOutDir = path.join(repoRoot, 'public', 'master-data', 'detail');
const wheelOutDir = path.join(repoRoot, 'public', 'master-data', 'pyodide', 'wheels');
// UI改善ラウンド22 22-E-3: wheelのファイル名(バージョン番号を含む)を1箇所(ここ)でしか
// 書かない。src/lib/pyodide-engine.ts はこのJSONをビルド時にVite静的import(src/pages/api/search.ts
// が public/master-data/autocomplete/*.json を静的importしているのと同じ方式)で読み、
// wheel URL を組み立てる。ハードコードした文字列を2箇所で手動同期する必要が無くなる。
const wheelManifestPath = path.join(repoRoot, 'public', 'master-data', 'pyodide', 'wheel-manifest.json');

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`コマンドが失敗しました (exit ${result.status}): ${command} ${args.join(' ')}`);
  }
}

function assertExists(targetPath, hint) {
  if (!existsSync(targetPath)) {
    throw new Error(`見つかりません: ${targetPath}\n${hint}`);
  }
}

// jpokePython がシステム PATH 上のコマンド名(python/python3)の場合は existsSync では検証できない
// (絶対パスではないため)。venv やユーザー指定の絶対パスの場合のみ事前チェックし、それ以外は
// spawnSync 実行時のエラーに委ねる。
function assertPythonUsable() {
  if (path.isAbsolute(jpokePython)) {
    assertExists(jpokePython, 'jpoke 用の Python 実行ファイルが見つかりません。JPOKE_PYTHON 環境変数で Python 実行ファイルを指定してください。');
  }
}

function buildAutocomplete() {
  console.log('\n=== 1. オートコンプリート用軽量 JSON + 検索詳細用 JSON を生成 ===');
  assertExists(jpokeDir, 'JPOKE_DIR 環境変数で jpoke リポジトリの場所を指定してください。');
  assertPythonUsable();

  mkdirSync(autocompleteOutDir, { recursive: true });
  mkdirSync(detailOutDir, { recursive: true });

  const extractScript = path.join(__dirname, 'extract_autocomplete.py');
  run(jpokePython, [extractScript, jpokeSrcDir, autocompleteOutDir, detailOutDir]);
}

function buildPyodideWheel() {
  console.log('\n=== 2. Pyodide 実行用 wheel をビルド ===');
  assertExists(jpokeDir, 'JPOKE_DIR 環境変数で jpoke リポジトリの場所を指定してください。');
  assertPythonUsable();

  mkdirSync(wheelOutDir, { recursive: true });

  // 既存の wheel をクリアしてから再ビルド(バージョン変更時に古い wheel が残らないようにする)。
  for (const entry of readdirSync(wheelOutDir)) {
    if (entry.endsWith('.whl')) {
      rmSync(path.join(wheelOutDir, entry));
    }
  }

  const tmpOutDir = mkdtempSync(path.join(tmpdir(), 'jpoke-wheel-'));
  try {
    // Cloudflare Pages の Python には `build` パッケージが入っていない。wheel は
    // Python 標準ライブラリだけでも作れるため、外部パッケージに依存しないこのスクリプトを
    // 使う。これにより `npm clean-install` 後のクリーンなビルド環境でも動作する。
    run(jpokePython, [path.join(__dirname, 'build_wheel.py'), jpokeDir, tmpOutDir]);

    const wheels = readdirSync(tmpOutDir).filter((f) => f.endsWith('.whl'));
    if (wheels.length === 0) {
      throw new Error('wheel のビルドに成功しましたが .whl ファイルが見つかりませんでした。');
    }
    // 複数wheelが生成されるケースは想定していない(wheelOutDir は毎回全削除してから
    // 1回だけビルドするため)が、万一複数生成された場合はソートして最初の1件を採用する。
    const builtFilename = [...wheels].sort()[0];
    const builtBytes = readFileSync(path.join(tmpOutDir, builtFilename));

    // 🔴 2026-07-30発覚のバグ対応: public/pyodide-sw.js はこの wheel を cache-first で
    // キャッシュする(CACHE_NAME固定・期限なし)。jpoke のバージョン(pyproject.toml)を
    // 上げずに中身だけ更新すると wheel のファイル名が変わらないため、既にService Workerを
    // 登録済みのブラウザは古いキャッシュ済みバイト列を無期限に使い続け、実行中のJS側だけが
    // 新しい契約(例: Battle.calc_lethal()のresume_from引数)を期待してTypeErrorで
    // 全計算が失敗する事故が実際に発生した(round-46調査、damage-calc.tsの
    // 「エラー: 計算に失敗しました」で顕在化)。
    // 対策: wheel の内容ハッシュ(sha256先頭10桁)を「ビルドタグ」としてファイル名に
    // 埋め込み、内容が変わるたびにURL自体が変わるようにする(cache-first でも安全になる)。
    // ビルドタグは PEP 427 のwheelファイル名仕様で `{name}-{version}(-{build tag})?-
    // {python tag}-{abi tag}-{platform tag}.whl` の任意要素として正式にサポートされており、
    // 「数字から始まる」制約があるため先頭に "0" を付ける(micropip/pip 共通の
    // WHEEL_INFO_RE = `...((-(?P<build>\d[^-]*?))?-(?P<pyver>.+?)-...)` に適合させるため)。
    const nameMatch = /^(?<name>.+?)-(?<version>[^-]+)-(?<pyver>[^-]+)-(?<abi>[^-]+)-(?<plat>[^-]+)\.whl$/.exec(
      builtFilename,
    );
    if (!nameMatch) {
      throw new Error(`想定外のwheelファイル名形式です(ビルドタグ挿入に失敗): ${builtFilename}`);
    }
    const { name, version, pyver, abi, plat } = nameMatch.groups;
    const contentHash = createHash('sha256').update(builtBytes).digest('hex').slice(0, 10);
    const wheelFilename = `${name}-${version}-0${contentHash}-${pyver}-${abi}-${plat}.whl`;

    writeFileSync(path.join(wheelOutDir, wheelFilename), builtBytes);
    console.log(`wrote ${path.join(wheelOutDir, wheelFilename)} (元のビルド出力名: ${builtFilename})`);

    // src/lib/pyodide-engine.ts 側はこのJSONを読むだけにする(ファイル名をアプリ側で
    // 手書きしない。UI改善ラウンド22 22-E-3由来の既存方針、上記コメント参照)。
    writeFileSync(
      wheelManifestPath,
      JSON.stringify({ filename: wheelFilename }, null, 2) + '\n',
      'utf-8',
    );
    console.log(`wrote ${wheelManifestPath} (filename: ${wheelFilename})`);
  } finally {
    rmSync(tmpOutDir, { recursive: true, force: true });
  }
}

function main() {
  console.log(`jpoke ディレクトリ: ${jpokeDir}`);
  console.log(`jpoke python: ${jpokePython}`);

  buildAutocomplete();
  buildPyodideWheel();

  console.log('\n完了: public/master-data/ 配下にマスタデータを生成しました。');
}

main();
