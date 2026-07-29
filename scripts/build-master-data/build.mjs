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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
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
    run(jpokePython, ['-m', 'build', '--wheel', '--outdir', tmpOutDir], { cwd: jpokeDir });

    const wheels = readdirSync(tmpOutDir).filter((f) => f.endsWith('.whl'));
    if (wheels.length === 0) {
      throw new Error('wheel のビルドに成功しましたが .whl ファイルが見つかりませんでした。');
    }
    for (const wheel of wheels) {
      copyFileSync(path.join(tmpOutDir, wheel), path.join(wheelOutDir, wheel));
      console.log(`wrote ${path.join(wheelOutDir, wheel)}`);
    }

    // jpoke (pyproject.toml) のバージョンが変わると生成されるファイル名も変わる
    // (例: jpoke-0.2.0-py3-none-any.whl → jpoke-0.3.0-py3-none-any.whl)。
    // 実際に生成されたファイル名をそのままマニフェストに書き出し、
    // src/lib/pyodide-engine.ts 側はこれを読むだけにする(バージョン文字列を
    // アプリ側で手書きしない)。複数wheelが生成されるケースは想定していない
    // (wheelOutDir は毎回全削除してから1回だけビルドするため)が、
    // 万一複数生成された場合はソートして最初の1件を採用する。
    const wheelFilename = [...wheels].sort()[0];
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
