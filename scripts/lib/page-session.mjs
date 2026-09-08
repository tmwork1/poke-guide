/**
 * `scripts/shot.mjs`(撮る)と `scripts/probe.mjs`(測る・触る)の共通部分。
 *
 * dev serverのURL検出・Pyodide待ち・dev toolbar非表示・セレクタ解決といった
 * 「毎回書き起こすと必ずどれかを忘れる」手順をここに集約している。
 * 個別の検証で `.tmp-*.mjs` を新規に書き起こさないこと。
 */
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Pyodide(ダメージ計算)を積んでいる画面かどうかの判定に使うセレクタ。 */
const PYODIDE_RESULT_SELECTOR = ".damage-row-total-result";
/** 計算が終わっていないときに結果セルに出る文字列。 */
const PYODIDE_PENDING_TEXT = /計算前|初期化待ち/;
/**
 * エンジン初期化状況の1行。準備完了(status="ready")になると `hidden` が付いて消える。
 *
 * 【なぜ結果セルだけでは足りないか】2026-07-30 ラウンド31の検証で判明した穴:
 * ブラウザキャッシュが冷えている(= jpokeのwheelを毎回ダウンロードする)と、
 * **結果セルが埋まった後もこの行が "jpoke (wheel) をインストール中..." のまま残る**。
 * その状態で撮ると初期化行(高さ36.5px)が写り込み、以降のダメージ計算カードが
 * 全部 43px 下にずれる。実際にCoordinatorが「回帰では?」と疑って切り分けに時間を使った
 * (暖まった状態で3回撮り直して初めて撮影アーティファクトだと分かった)。
 * 結果セルの充足とエンジンの ready は別イベントなので、両方を待つ。
 */
const ENGINE_STATUS_SELECTOR = "#damage-calc-engine-status";

export function normalizePagePath(input) {
	// Git Bash (MSYS) は先頭スラッシュの引数を `C:/Program Files/Git/box` のような実パスに
	// 勝手に変換する。対象が404になるだけで原因が分かりにくいので明示的に弾く。
	if (/^[A-Za-z]:[\/]/.test(input) || /[\/]Git[\/]/.test(input)) {
		throw new Error(
			`--page の値がWindowsのパスに変換されています(${input})。` +
				"Git Bashから実行する場合は先頭のスラッシュを外して `--page box` のように指定してください。",
		);
	}
	if (input === "home") return "/";
	return input.startsWith("/") ? input : `/${input}`;
}

/**
 * `--base` 省略時のベースURLを決める。
 * Astro 7 の `astro dev` はデーモンとして起動し、4321が埋まっていると 4322... と
 * ずれた port を掴む。`astro dev status` が実際のURLを持っているのでそれを使う。
 */
export async function detectBaseUrl() {
	const fallback = "http://localhost:4321";
	try {
		// Windowsでは `npx` の実体は npx.cmd で、Nodeは shell 無しでの .cmd 起動を
		// EINVAL で拒否する。一方 shell:true + 引数配列は DEP0190 警告になるので、
		// 定数のコマンド文字列を execSync に渡す(引数は固定なので注入の余地は無い)。
		const { execSync } = await import("node:child_process");
		const out = execSync("npx astro dev status", {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 20_000,
		});
		const match = /https?:\/\/[^\s"\)]+/.exec(out);
		if (match) return match[0].replace(/\/$/, "");
		process.stderr.write(`astro dev status からURLを読めませんでした。${fallback} を試します。\n`);
	} catch {
		// デーモンが起動していない場合はここに来る。既定ポートで試す。
		process.stderr.write(`astro dev status が取れませんでした。${fallback} を試します。\n`);
	}
	return fallback;
}

export function slugForPath(pagePath) {
	const slug = pagePath
		.replace(/^\/+|\/+$/g, "")
		.replace(/\//g, "-")
		// クエリ付きの画面(例: `speed-chart?owned=<uuid>`)もそのまま渡せるように、
		// Windowsのファイル名に使えない文字(? & = : * " < > |)をハイフンへ潰す。
		.replace(/[?&=:*"<>|]+/g, "-")
		.replace(/-+$/g, "");
	return slug === "" ? "home" : slug;
}

export function parseSize(size) {
	const match = /^(\d+)x(\d+)$/.exec(size);
	if (!match) throw new Error(`--size は 1920x1080 の形式で指定してください: ${size}`);
	return { width: Number(match[1]), height: Number(match[2]) };
}

export async function assertServerUp(base) {
	try {
		const res = await fetch(base, { method: "GET" });
		// 401/404 でもサーバー自体は起きているので続行する。
		if (res.status >= 500) {
			throw new Error(`${base} が ${res.status} を返しました`);
		}
	} catch (cause) {
		throw new Error(
			`${base} に繋がりません。別ターミナルで \`npm run dev\` を起動してから実行してください。`,
			{ cause },
		);
	}
}

/**
 * dev server は通常ログイン済みを返すため、遷移前に context へ明示的にゲスト用 cookie を入れる。
 * page.goto 後に入れると最初の SSR 応答だけ通常ユーザーになるため、ページ生成より前に呼び出す。
 */
export async function applyGuestCookie(context, baseUrl) {
	const url = new URL("/", baseUrl).toString();
	await context.addCookies([{ name: "poke-dev-force-guest", value: "1", url }]);
}

/**
 * ダメージ計算の結果セルが出そろうまで待つ。
 * Pyodideを積んでいない画面では何もしない(→ pitfalls.md「Pyodideの初期化を待つ」)。
 */
export async function waitForPyodideIfPresent(page, timeout) {
	try {
		await page.waitForSelector(PYODIDE_RESULT_SELECTOR, { timeout: 3_000, state: "attached" });
	} catch {
		return null;
	}
	await page.waitForFunction(
		({ selector, pendingSource }) => {
			const pending = new RegExp(pendingSource);
			const cells = [...document.querySelectorAll(selector)];
			return cells.length > 0 && cells.every((cell) => !pending.test(cell.textContent ?? ""));
		},
		{ selector: PYODIDE_RESULT_SELECTOR, pendingSource: PYODIDE_PENDING_TEXT.source },
		{ timeout },
	);
	// 結果が出ても初期化行が残っていることがある。この行が消えるまで待つ。
	// エンジンが error で止まった場合は消えないので、待ち時間を区切って呼び出し元へ返す。
	let engineStatusVisible = false;
	try {
		await page.waitForFunction(
			(selector) => {
				const el = document.querySelector(selector);
				return !el || el.hasAttribute("hidden") || getComputedStyle(el).display === "none";
			},
			ENGINE_STATUS_SELECTOR,
			{ timeout: Math.min(timeout, 120_000) },
		);
	} catch {
		engineStatusVisible = true;
	}
	return { engineStatusVisible };
}

/**
 * Astro開発ツールバーは `astro dev` のときだけ出る開発用の帯で、UIの欠陥ではない。
 * 撮影・実測の邪魔になるのでCSSで隠す(astro.config.mjs は変更しない)。
 */
export async function hideDevToolbar(page) {
	await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
}

/**
 * `text=<文字列>` なら完全一致のテキスト検索、それ以外はCSSセレクタとして解決する。
 * (shot.mjs の `--click` と probe.mjs の操作系オプションで共通の記法)
 */
export function resolveLocator(page, selector) {
	return selector.startsWith("text=")
		? page.getByText(selector.slice("text=".length), { exact: true })
		: page.locator(selector);
}
