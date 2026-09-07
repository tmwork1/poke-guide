#!/usr/bin/env node
/**
 * UI検証用の実測・操作スクリプト。`npm run shot`(撮る)の相棒で、こちらは「測る・触る」担当。
 *
 * 【毎回 `.tmp-*.mjs` を書き起こさない】
 *   Playwrightの起動・dev serverのURL検出・Pyodide初期化待ち・dev toolbar非表示・
 *   console/pageerror/失敗リクエストの収集は全部ここに実装済み。
 *   検証の内容はオプションの組み合わせで表現し、使い捨てスクリプトを新規に書かない。
 *   足りない観点が出たら、その場しのぎのスクリプトではなく**このファイルにオプションを足す**。
 *
 * 【触るので、DBを汚しうる】
 *   `--click` / `--fill` 等の操作系オプションを使うと `/box/[id]` の自動保存が走りうる
 *   (→ `.claude/skills/ui/references/pitfalls.md`「自動保存があるので、検証クリックがデータを壊す」)。
 *   操作系を使うときは、保存が走らないと確認済みの要素に限るか、後片付けまで含めて計画する。
 *   操作系を一切指定しなければ、このスクリプトは画面を読むだけでDBを触らない。
 *
 * 使い方:
 *   npm run dev                                              # 別ターミナルで先に起動しておく
 *   npm run probe -- --page box --rect .card-pokemon         # 位置・サイズを実測
 *   npm run probe -- --page box --overflow                   # 横はみ出しの犯人を特定
 *   npm run probe -- --page box/<id> --style ".card-damage:padding,font-size,color"
 *   npm run probe -- --page team --click "text=編成" --rect .team-slot   # 操作してから実測
 *   npm run probe -- --page box --eval "document.title"      # 任意のJSを1発だけ評価
 *
 * Git Bash から叩くときは `--page box` のように**先頭スラッシュを付けない**。
 *
 * 対象・環境:
 *   --page <path>       見る画面(必須)。`home` は `/` の別名
 *   --base <url>        省略時は `astro dev status` から自動検出
 *   --theme light|dark  既定 light
 *   --size 390x844      ビューポート。既定 1920x1080
 *   --timeout <ms>      Pyodide待ちのタイムアウト。既定 300000
 *   --keep-toolbar      Astro開発ツールバーを消さずに見る
 *
 * 操作(**指定した順に**実行される。DBを汚しうる。上記の注意を読むこと):
 *   --click <sel>       クリック。`text=xxx` で完全一致テキスト
 *   --fill <sel=value>  入力欄を埋める
 *   --press <sel=Key>   キー送出(例 `input.search=Enter`)。`sel=` を省くとページ全体へ
 *   --hover <sel>       ホバー
 *   --scroll <sel|px>   要素までスクロール、または縦に指定px
 *   --wait <sel>        その要素が出るまで待つ
 *   --wait-ms <n>       n ミリ秒待つ
 *
 * 実測(いずれも複数指定可。指定が1つも無ければ `--overflow` 相当のサマリだけ出す):
 *   --rect <sel>            位置・サイズ・可視性・はみ出しを実測
 *   --style <sel:prop,...>  getComputedStyle の指定プロパティ
 *   --text <sel>            テキスト内容
 *   --html <sel>            outerHTML(既定1000字で切る。--html-len で変更)
 *   --count <sel>           一致件数だけ
 *   --overflow              横スクロールの有無と、はみ出している要素の一覧
 *   --eval <js>             ページ内で式を評価(JSONで返せる値のみ)
 *   --limit <n>             セレクタごとの最大報告件数。既定 10
 *   --json                  JSONだけを出す(既定は人が読めるサマリ + JSON)
 */

import { chromium } from "@playwright/test";
import {
	assertServerUp,
	detectBaseUrl,
	hideDevToolbar,
	normalizePagePath,
	parseSize,
	resolveLocator,
	waitForPyodideIfPresent,
} from "./lib/page-session.mjs";

const USAGE = [
	"使い方: npm run probe -- --page <path> [操作] [実測]",
	"",
	"  対象  --page box/<id> [--theme dark] [--size 390x844]",
	"  操作  --click <sel> / --fill <sel=値> / --press <sel=Key> / --hover <sel>",
	"        --scroll <sel|px> / --wait <sel> / --wait-ms <n>   ※指定順に実行",
	"  実測  --rect <sel> / --style <sel:prop,...> / --text <sel> / --html <sel>",
	"        --count <sel> / --overflow / --eval <js> / --limit <n> / --json",
	"",
	"詳細はこのファイル冒頭のコメントを参照。",
].join("\n");

function parseArgs(argv) {
	const opts = {
		page: null,
		base: null,
		theme: "light",
		size: "1920x1080",
		timeout: 300_000,
		keepToolbar: false,
		htmlLen: 1000,
		limit: 10,
		json: false,
		help: false,
		actions: [],
		probes: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (value === undefined) throw new Error(`${arg} には値が必要です`);
			i += 1;
			return value;
		};
		switch (arg) {
			case "--page":
				opts.page = next();
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
			case "--timeout":
				opts.timeout = Number(next());
				break;
			case "--keep-toolbar":
				opts.keepToolbar = true;
				break;
			case "--html-len":
				opts.htmlLen = Number(next());
				break;
			case "--limit":
				opts.limit = Number(next());
				break;
			case "--json":
				opts.json = true;
				break;
			case "--click":
			case "--fill":
			case "--press":
			case "--hover":
			case "--scroll":
			case "--wait":
			case "--wait-ms":
				opts.actions.push({ kind: arg.slice(2), value: next() });
				break;
			case "--rect":
			case "--style":
			case "--text":
			case "--html":
			case "--count":
			case "--eval":
				opts.probes.push({ kind: arg.slice(2), value: next() });
				break;
			case "--overflow":
				opts.probes.push({ kind: "overflow", value: null });
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
 * `sel=value` を分解する。
 * セレクタ側は `input[type="search"]` のように `=` を含みうるので、
 * 角括弧・引用符の外にある最初の `=` で割る(値側の `=` はそのまま残る)。
 */
function splitPair(input, what) {
	let depth = 0;
	let quote = null;
	for (let i = 0; i < input.length; i += 1) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[") depth += 1;
		else if (ch === "]") depth -= 1;
		else if (ch === "=" && depth === 0) return [input.slice(0, i), input.slice(i + 1)];
	}
	throw new Error(`${what} は <selector>=<値> の形式で指定してください: ${input}`);
}

async function runAction(page, action) {
	const { kind, value } = action;
	switch (kind) {
		case "click":
			await resolveLocator(page, value).first().click({ timeout: 30_000 });
			break;
		case "hover":
			await resolveLocator(page, value).first().hover({ timeout: 30_000 });
			break;
		case "fill": {
			const [sel, text] = splitPair(value, "--fill");
			await resolveLocator(page, sel).first().fill(text, { timeout: 30_000 });
			break;
		}
		case "press": {
			// `sel=Key` ならその要素へ、`Key` だけならページ全体へ送る。
			let pair = null;
			try {
				pair = splitPair(value, "--press");
			} catch {
				pair = null;
			}
			if (pair) {
				await resolveLocator(page, pair[0]).first().press(pair[1], { timeout: 30_000 });
			} else {
				await page.keyboard.press(value);
			}
			break;
		}
		case "scroll":
			if (/^-?\d+$/.test(value)) {
				await page.evaluate((px) => window.scrollBy(0, px), Number(value));
			} else {
				await resolveLocator(page, value).first().scrollIntoViewIfNeeded({ timeout: 30_000 });
			}
			break;
		case "wait":
			await page.waitForSelector(value, { timeout: 60_000 });
			break;
		case "wait-ms":
			await page.waitForTimeout(Number(value));
			break;
		default:
			throw new Error(`不明な操作: ${kind}`);
	}
}

/**
 * ページ内で要素を集める共通部分。ページ側へ関数ごと注入するので、
 * 外側のスコープを参照せず、JSON化できる素の値だけを返すこと。
 */
function collectElements(selector, limit, mode, extra) {
	const nodes = [...document.querySelectorAll(selector)].slice(0, limit);
	const round = (n) => Math.round(n * 100) / 100;
	return nodes.map((el) => {
		const rect = el.getBoundingClientRect();
		const base = {
			tag: el.tagName.toLowerCase(),
			id: el.id || undefined,
			class: typeof el.className === "string" && el.className ? el.className : undefined,
		};
		if (mode === "rect") {
			const style = getComputedStyle(el);
			return {
				...base,
				text: (el.textContent ?? "").trim().slice(0, 40) || undefined,
				x: round(rect.x),
				y: round(rect.y),
				w: round(rect.width),
				h: round(rect.height),
				right: round(rect.right),
				bottom: round(rect.bottom),
				visible:
					style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0,
				// 中身が枠から溢れている(=省略記号やスクロールが出る)かどうか。
				overflowsSelf: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
				// ビューポート右端をはみ出しているか(横スクロールの犯人候補)。
				overflowsViewport: round(rect.right) > document.documentElement.clientWidth + 1,
			};
		}
		if (mode === "style") {
			const style = getComputedStyle(el);
			const values = {};
			for (const prop of extra) values[prop] = style.getPropertyValue(prop);
			return { ...base, ...values };
		}
		if (mode === "text") {
			return { ...base, text: (el.textContent ?? "").replace(/\s+/g, " ").trim() };
		}
		if (mode === "html") {
			return { ...base, html: el.outerHTML.slice(0, extra) };
		}
		return base;
	});
}

async function runProbe(page, probe, opts) {
	const { kind, value } = probe;
	if (kind === "count") {
		const count = await page.locator(value).count();
		return { kind, selector: value, count };
	}
	if (kind === "eval") {
		const result = await page.evaluate((expr) => {
			// 検証用に任意の式を1発だけ評価する(繋ぎ先はローカルのdev serverだけ)。
			// eslint-disable-next-line no-eval
			const out = eval(expr);
			return out === undefined ? null : JSON.parse(JSON.stringify(out));
		}, value);
		return { kind, expr: value, result };
	}
	if (kind === "overflow") {
		const result = await page.evaluate((limit) => {
			const doc = document.documentElement;
			const round = (n) => Math.round(n * 100) / 100;
			const culprits = [];
			for (const el of document.querySelectorAll("body *")) {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) continue;
				if (rect.right > doc.clientWidth + 1 || rect.left < -1) {
					culprits.push({
						tag: el.tagName.toLowerCase(),
						id: el.id || undefined,
						class: typeof el.className === "string" && el.className ? el.className : undefined,
						text: (el.textContent ?? "").trim().slice(0, 30) || undefined,
						left: round(rect.left),
						right: round(rect.right),
						w: round(rect.width),
					});
				}
			}
			// 祖先ごと巻き込まれて全部並ぶので、はみ出し量が大きい順に絞って返す。
			culprits.sort((a, b) => b.right - a.right);
			return {
				clientWidth: doc.clientWidth,
				scrollWidth: doc.scrollWidth,
				hasHorizontalScroll: doc.scrollWidth > doc.clientWidth + 1,
				culprits: culprits.slice(0, limit),
			};
		}, opts.limit);
		return { kind, ...result };
	}
	if (kind === "style") {
		// セレクタ自体が `:hover` 等のコロンを含みうるので、最後のコロンで割る。
		const at = value.lastIndexOf(":");
		if (at < 0) throw new Error(`--style は <selector>:<prop,prop> の形式です: ${value}`);
		const selector = value.slice(0, at);
		const props = value
			.slice(at + 1)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const elements = await page.evaluate(
			({ selector, limit, mode, extra }) => window.collectElementsInPage(selector, limit, mode, extra),
			{ selector, limit: opts.limit, mode: "style", extra: props },
		);
		return { kind, selector, props, elements };
	}
	const extra = kind === "html" ? opts.htmlLen : null;
	const elements = await page.evaluate(
		({ selector, limit, mode, extra }) => window.collectElementsInPage(selector, limit, mode, extra),
		{ selector: value, limit: opts.limit, mode: kind, extra },
	);
	return { kind, selector: value, elements };
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || !opts.page) {
		process.stdout.write(USAGE + "\n");
		process.exitCode = opts.help ? 0 : 1;
		return;
	}
	if (opts.theme !== "light" && opts.theme !== "dark") {
		throw new Error(`--theme は light / dark のいずれかです: ${opts.theme}`);
	}
	const viewport = parseSize(opts.size);
	const pagePath = normalizePagePath(opts.page);
	if (!opts.base) {
		opts.base = await detectBaseUrl();
		process.stderr.write(`ベースURL: ${opts.base}\n`);
	}
	await assertServerUp(opts.base);
	// 実測指定が無いときは、とりあえず横はみ出しだけ見る(空振りで終わらせない)。
	if (opts.probes.length === 0) opts.probes.push({ kind: "overflow", value: null });

	const browser = await chromium.launch();
	const context = await browser.newContext({ viewport });
	const page = await context.newPage();
	const consoleErrors = [];
	const pageErrors = [];
	const failedRequests = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => pageErrors.push(String(err)));
	page.on("requestfailed", (req) => failedRequests.push(`${req.method()} ${req.url()}`));
	page.on("response", (res) => {
		if (res.status() >= 400) failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
	});

	const report = { url: `${opts.base}${pagePath}`, theme: opts.theme, viewport, probes: [] };
	try {
		await page.emulateMedia({ colorScheme: opts.theme });
		const response = await page.goto(report.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
		report.status = response?.status() ?? 0;
		if (!opts.keepToolbar) await hideDevToolbar(page);
		// 実測用のDOM収集関数をページ側へ1回だけ注入する(probeごとに関数本体を送らない)。
		await page.evaluate(`window.collectElementsInPage = ${collectElements.toString()}`);

		const pyodide = await waitForPyodideIfPresent(page, opts.timeout);
		report.pyodideWaited = pyodide !== null;
		if (pyodide?.engineStatusVisible) report.engineStatusVisible = true;
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.evaluate(() => document.fonts?.ready);

		for (const action of opts.actions) {
			process.stderr.write(`操作: --${action.kind} ${action.value}\n`);
			await runAction(page, action);
		}
		if (opts.actions.length > 0) await page.waitForTimeout(250);

		for (const probe of opts.probes) {
			report.probes.push(await runProbe(page, probe, opts));
		}

		// リダイレクトされていると別画面を測る事故になる(例: `/damage-calc` は `/box` へ302)。
		const finalUrl = page.url().replace(/\/$/, "");
		if (finalUrl !== report.url.replace(/\/$/, "")) report.redirectedTo = finalUrl;
	} finally {
		if (consoleErrors.length > 0) report.consoleErrors = consoleErrors.slice(0, 20);
		if (pageErrors.length > 0) report.pageErrors = pageErrors.slice(0, 20);
		if (failedRequests.length > 0) report.failedRequests = [...new Set(failedRequests)].slice(0, 20);
		await context.close();
		await browser.close();
	}

	if (!opts.json) {
		const lines = [
			"",
			`=== ${report.url} (${opts.theme}, ${viewport.width}x${viewport.height}) HTTP ${report.status} ===`,
		];
		if (report.redirectedTo) lines.push(`⚠ ${report.redirectedTo} にリダイレクト`);
		if (report.engineStatusVisible) lines.push("⚠ ダメージ計算エンジンの初期化行が残ったまま");
		if (report.consoleErrors) lines.push(`⚠ console error ${report.consoleErrors.length}件`);
		if (report.pageErrors) lines.push(`⚠ pageerror ${report.pageErrors.length}件`);
		if (report.failedRequests) lines.push(`⚠ 失敗リクエスト ${report.failedRequests.length}件`);
		process.stderr.write(lines.join("\n") + "\n");
	}
	process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
	process.stderr.write(`${err.stack ?? err}\n`);
	process.exitCode = 1;
});
