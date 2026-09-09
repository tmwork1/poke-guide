#!/usr/bin/env node
/**
 * UI講評用スクリーンショット撮影スクリプト。
 *
 * `.claude/skills/ui` / `.claude/skills/new-page` の撮影ステップで毎回
 * `.tmp-shot.mjs` を書き起こしていたものを、手順ごとスクリプトに固定したもの。
 * `.claude/skills/ui/references/pitfalls.md` の「Playwright」節の内容
 * (ライト/ダーク両方・Pyodide初期化待ち・拡大クロップ・dev toolbar)は
 * すべてここに実装済みなので、撮る側が思い出す必要はない。
 *
 * 【このスクリプトは画面を「見る」だけで、一切「触らない」】
 *   クリック・入力を一切しないので `/box/[id]` の自動保存が走らずDBを汚さない
 *   (→ pitfalls.md「自動保存があるので、検証クリックがデータを壊す」)。
 *   密度検証も `--clone` でDOM複製するだけでDBに個体を作らない
 *   (→ pitfalls.md「密度検証でDBに個体を作らない」)。
 *
 * 使い方:
 *   npm run dev                                       # 別ターミナルで先に起動しておく
 *   npm run shot -- --page box --page box/<id>        # ライト・ダーク両方を1920x1080で
 *   npm run shot -- --page box --clone .card-pokemon --clone-count 40  # 密度検証用
 *   npm run shot -- --page box/<id> --clip .card-damage --scale 3      # 細部の拡大クロップ
 *     ※ ダメージ計算カード本体のクラスは `.card-damage`(`.damage-card` ではない)。
 *        `.damage-row` というクラスの要素は存在しない(2026-07-29 ラウンド29で実測)。
 *
 * Git Bash から叩くときは `--page box` のように**先頭スラッシュを付けない**。
 * MSYSが `/box` を `C:/Program Files/Git/box` に変換してしまう(検出してエラーにする)。
 *
 * 主なオプション:
 *   --page <path>       撮る画面。複数指定可 / カンマ区切り可。`home` は `/` の別名。(必須)
 *   --base <url>        省略時は `astro dev status` から自動検出(既定 http://localhost:4321)
 *   --theme light|dark|both   既定 dark(2026-09-10にダークモードへ一本化したため)
 *   --size 1920x1080    ビューポート。既定 1920x1080
 *   --scale <n>         deviceScaleFactor。細部を見るときは 3。既定 1
 *   --full              ページ全体(スクロール分を含む)を撮る
 *   --clip <selector>   その要素だけを撮る
 *   --clip-pad <px>     --clip の周囲に余白を足して撮る(既定 0)
 *   --clone <selector>  その要素を複製して件数を水増しする(DBは汚さない)
 *   --clone-count <n>   --clone の目標件数。既定 40
 *   --click <selector>  Pyodide待ち完了後にクリックする(複数指定可、指定順)。
 *                       トグル系のUI状態(例: 折りたたみ表示)を撮るためのオプトイン。
 *                       全クリック後、hover/focusと短いCSSトランジションが抜けてから撮影する。
 *                       ⚠️ このスクリプトは既定では一切「触らない」(冒頭コメント参照)。
 *                       クリックしても安全(自動保存を誘発しない、DBを汚さない)と
 *                       確認済みの要素だけに使うこと。text=から始めると
 *                       `getByText(...).click()` 相当(完全一致)、それ以外は通常のCSSセレクタ。
 *   --wait <selector>   撮る前に待つ要素
 *   --out <dir>         出力先。既定 .tmp-shots
 *   --tag <str>         ファイル名の末尾に付ける識別子
 *   --keep-toolbar      Astro開発ツールバーを消さずに撮る(既定は消す)
 *   --timeout <ms>      Pyodide待ちのタイムアウト。既定 300000
 *
 * 主な追加オプション: --guest はページを開く前に開発用ゲストCookieを入れ、出力名にも -guest を付ける。
 */

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	REPO_ROOT,
	applyGuestCookie,
	assertServerUp,
	detectBaseUrl,
	hideDevToolbar,
	normalizePagePath,
	parseSize,
	resolveLocator,
	slugForPath,
	waitForPyodideIfPresent,
} from "./lib/page-session.mjs";

function parseArgs(argv) {
	const opts = {
		pages: [],
		base: null,
		theme: "dark",
		size: "1920x1080",
		scale: 1,
		full: false,
		clip: null,
		clipPad: 0,
		clone: null,
		cloneCount: 40,
		click: [],
		wait: null,
		out: ".tmp-shots",
		tag: null,
		keepToolbar: false,
		timeout: 300_000,
		guest: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${arg} には値が必要です`);
			}
			i += 1;
			return value;
		};
		switch (arg) {
			case "--page":
				opts.pages.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
				break;
			case "--base":
				opts.base = next().replace(/\/$/, "");
				break;
			case "--theme":
				opts.theme = next();
				break;
			case "--size":
				opts.size = next();
				break;
			case "--scale":
				opts.scale = Number(next());
				break;
			case "--full":
				opts.full = true;
				break;
			case "--clip":
				opts.clip = next();
				break;
			case "--clip-pad":
				opts.clipPad = Number(next());
				break;
			case "--clone":
				opts.clone = next();
				break;
			case "--clone-count":
				opts.cloneCount = Number(next());
				break;
			case "--click":
				opts.click.push(next());
				break;
			case "--wait":
				opts.wait = next();
				break;
			case "--out":
				opts.out = next();
				break;
			case "--tag":
				opts.tag = next();
				break;
			case "--keep-toolbar":
				opts.keepToolbar = true;
				break;
			case "--timeout":
				opts.timeout = Number(next());
				break;
			case "--guest":
				opts.guest = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				throw new Error(`不明なオプション: ${arg}`);
		}
	}
	return opts;
}

/**
 * 一覧の密度を見るために既存カードをDOM上で複製する。
 * DBに個体を作らないための手段(→ pitfalls.md「密度検証でDBに個体を作らない」)。
 */
async function cloneNodes(page, selector, targetCount) {
	return page.evaluate(
		({ selector, targetCount }) => {
			const first = document.querySelector(selector);
			if (!first) return { ok: false, count: 0 };
			const parent = first.parentElement;
			if (!parent) return { ok: false, count: 0 };
			let count = parent.querySelectorAll(`:scope > ${selector}`).length;
			if (count === 0) count = document.querySelectorAll(selector).length;
			const source = parent.lastElementChild ?? first;
			while (count < targetCount) {
				parent.appendChild(source.cloneNode(true));
				count += 1;
			}
			return { ok: true, count };
		},
		{ selector, targetCount },
	);
}

async function shootOne(context, opts, pagePath, theme, viewport) {
	const page = await context.newPage();
	const consoleErrors = [];
	const pageErrors = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(String(err)));

	await page.emulateMedia({ colorScheme: theme });
	const url = `${opts.base}${pagePath}`;
	const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
	const status = response?.status() ?? 0;

	if (!opts.keepToolbar) {
		await hideDevToolbar(page);
	}

	if (opts.wait) {
		await page.waitForSelector(opts.wait, { timeout: 60_000 });
	}
	const pyodideResult = await waitForPyodideIfPresent(page, opts.timeout);
	const pyodideWaited = pyodideResult !== null;
	const engineStatusVisible = pyodideResult?.engineStatusVisible ?? false;

	for (const selector of opts.click) {
		await resolveLocator(page, selector).first().click({ timeout: 30_000 });
	}
	if (opts.click.length > 0) {
		await page.mouse.move(0, 0);
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		});
		await page.waitForTimeout(250);
	}

	let cloned = null;
	if (opts.clone) {
		cloned = await cloneNodes(page, opts.clone, opts.cloneCount);
	}

	await page.waitForLoadState("networkidle").catch(() => {});
	await page.evaluate(() => document.fonts?.ready);

	const hasHorizontalScroll = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	);

	const parts = [slugForPath(pagePath), theme];
	// --tag の値を変えずに、同じ条件の通常撮影とゲスト撮影を共存させる。
	if (opts.guest) parts.push("guest");
	if (opts.tag) parts.push(opts.tag);
	const file = path.resolve(REPO_ROOT, opts.out, `${parts.join("-")}.png`);

	if (opts.clip) {
		const locator = page.locator(opts.clip).first();
		await locator.waitFor({ timeout: 30_000 });
		if (opts.clipPad > 0) {
			// boundingBox() はビューポート座標を返すため、画面外の要素だと y が負になり
			// Math.max(0, ...) で頭を切られて「まったく別の場所」を撮ってしまう。
			// locator.screenshot() 側は自動でスクロールするので、pad ありの経路だけ明示的に揃える。
			await locator.scrollIntoViewIfNeeded();
			const box = await locator.boundingBox();
			if (!box) throw new Error(`--clip の要素が可視ではありません: ${opts.clip}`);
			const pad = opts.clipPad;
			await page.screenshot({
				path: file,
				clip: {
					x: Math.max(0, box.x - pad),
					y: Math.max(0, box.y - pad),
					width: box.width + pad * 2,
					height: box.height + pad * 2,
				},
			});
		} else {
			await locator.screenshot({ path: file });
		}
	} else {
		await page.screenshot({ path: file, fullPage: opts.full });
	}

	// リダイレクトされていると「指定した画面のつもりで別の画面を撮る」事故になる
	// (例: `/damage-calc` は `/box` へ302で飛ぶ)。撮れた画面のURLを必ず報告する。
	const finalUrl = page.url().replace(/\/$/, "");
	const redirectedTo = finalUrl === url.replace(/\/$/, "") ? null : finalUrl;

	await page.close();
	return {
		file,
		url,
		redirectedTo,
		theme,
		status,
		pyodideWaited,
		engineStatusVisible,
		cloned,
		hasHorizontalScroll,
		consoleErrors,
		pageErrors,
		viewport,
	};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || opts.pages.length === 0) {
		process.stdout.write(
			[
				"使い方: npm run shot -- --page <path> [options]",
				"",
				"  --page box --page box/<id>          複数指定可(カンマ区切りも可)",
				"                                      ※Git Bashでは先頭スラッシュを付けない",
				"  --theme light|dark|both             既定 dark",
				"  --size 1920x1080                    既定 1920x1080",
				"  --scale 3                           細部を見るときの拡大率",
				"  --clip <selector> [--clip-pad 24]   その要素だけを撮る",
				"  --clone <selector> --clone-count 40 密度検証用にDOMを複製(DBは汚さない)",
				"  --click <selector>   安全と確認済みの要素をクリックしてから撮る(複数指定可)",
				"  --full / --wait <sel> / --tag <str> / --out <dir> / --keep-toolbar / --guest",
				"",
				"詳細はこのファイル冒頭のコメントを参照。",
			].join("\n") + "\n",
		);
		process.exitCode = opts.help ? 0 : 1;
		return;
	}

	const themes = opts.theme === "both" ? ["light", "dark"] : [opts.theme];
	for (const theme of themes) {
		if (theme !== "light" && theme !== "dark") {
			throw new Error(`--theme は light / dark / both のいずれかです: ${opts.theme}`);
		}
	}
	const viewport = parseSize(opts.size);
	const pages = opts.pages.map(normalizePagePath);
	if (!opts.base) {
		opts.base = await detectBaseUrl();
		process.stderr.write(`ベースURL: ${opts.base}\n`);
	}

	await assertServerUp(opts.base);
	await mkdir(path.resolve(REPO_ROOT, opts.out), { recursive: true });

	const browser = await chromium.launch();
	const context = await browser.newContext({ viewport, deviceScaleFactor: opts.scale });
	const results = [];
	try {
		if (opts.guest) await applyGuestCookie(context, opts.base);
		for (const pagePath of pages) {
			for (const theme of themes) {
				process.stderr.write(`撮影中: ${pagePath} (${theme}) ...\n`);
				results.push(await shootOne(context, opts, pagePath, theme, viewport));
			}
		}
	} finally {
		await context.close();
		await browser.close();
	}

	const outDir = path.resolve(REPO_ROOT, opts.out);
	await writeFile(
		path.join(outDir, "shots.json"),
		JSON.stringify({ viewport, scale: opts.scale, results }, null, 2) + "\n",
		"utf8",
	);

	const lines = ["", "=== 撮影結果 ==="];
	for (const r of results) {
		lines.push(`${r.file}`);
		const notes = [`HTTP ${r.status}`, `${viewport.width}x${viewport.height}@${opts.scale}x`];
		if (r.redirectedTo) notes.push(`⚠ ${r.url} → ${r.redirectedTo} にリダイレクト`);
		if (r.pyodideWaited) notes.push("Pyodide計算完了まで待機");
		if (r.engineStatusVisible) {
			notes.push("⚠ 計算エンジンの初期化行が消えないまま撮影(この行のぶんカードが下にずれています)");
		}
		if (r.cloned) notes.push(r.cloned.ok ? `複製後 ${r.cloned.count} 件` : `複製失敗(${opts.clone} が見つからない)`);
		if (r.hasHorizontalScroll) notes.push("⚠ 横スクロールあり");
		if (r.pageErrors.length) notes.push(`⚠ pageerror ${r.pageErrors.length}件`);
		if (r.consoleErrors.length) notes.push(`⚠ console.error ${r.consoleErrors.length}件`);
		lines.push(`  ${notes.join(" / ")}`);
		for (const e of [...r.pageErrors, ...r.consoleErrors].slice(0, 5)) {
			lines.push(`  ! ${e.replace(/\s+/g, " ").slice(0, 200)}`);
		}
	}
	lines.push("");
	lines.push("エラーが無いことは品質の証明にならない。必ず Read tool で画像を自分の目で見ること。");
	lines.push("");
	process.stdout.write(lines.join("\n"));
}

main().catch((err) => {
	process.stderr.write(`\n撮影に失敗しました: ${err.message}\n`);
	if (err.cause) process.stderr.write(`  原因: ${err.cause}\n`);
	process.exitCode = 1;
});
