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
 *   --from <path>       --page の前に同じ context で開く遷移元画面
 *   --base <url>        省略時は `astro dev status` から自動検出
 *   --theme light|dark  既定 light
 *   --size 390x844      ビューポート。既定 1920x1080
 *   --timeout <ms>      Pyodide待ちのタイムアウト。既定 300000
 *   --keep-toolbar      Astro開発ツールバーを消さずに見る
 *   --block <部分文字列> そのURLを含むリクエストを落として開く(複数指定可)。「この通信が
 *                       来なかったらどうなるか」を実測して原因を切り分ける。例:
 *                       `--block fonts.gstatic.com` でWebフォント抜きのレイアウトを見る
 *   --no-js             JSを無効にして開く。SSRだけの寸法が見えるので、`--rect` の結果を
 *                       JS有効時と見比べれば「JSが入って何px動くか」= 揺れの正体が分かる
 *   --watch <sel>       その要素の内側で起きたDOM変更(テキスト・属性・子要素の増減)を
 *                       起きた順に記録する。--cls が出す「どの要素が動いたか」の次に要る
 *                       「誰が動かしたか」を出すためのもの。--cls と併用する
 *
 * 操作(**指定した順に**実行される。DBを汚しうる。上記の注意を読むこと):
 *   --click <sel>       クリック。`text=xxx` で完全一致テキスト
 *   --drag <sel=dx,dy>  マウスでドラッグ(スクロールバーを掴めるかの検証)。
 *                       `sel@x,y=dx,dy` で要素内の開始点を指定(負値は右/下端からの相対)
 *   --swipe <sel=dx,dy> 指(タッチ)でフリック。横スクロールが指で動くかの検証
 *   --fill <sel=value>  入力欄を埋める
 *   --press <sel=Key>   キー送出(例 `input.search=Enter`)。`sel=` を省くとページ全体へ
 *   --hover <sel>       ホバー
 *   --hold <sel=ms>     マウスで長押し(押下→ms待つ→離す)。長押しUIの検証用
 *   --hold-touch <sel=ms>  指(タッチ)で長押し。実機の挙動に近いのはこちら
 *   --scroll <sel|px>   要素までスクロール、または縦に指定px
 *   --wait <sel>        その要素が出るまで待つ
 *   --wait-ms <n>       n ミリ秒待つ
 *   --mark <label>      --cls の計測をここで区切る(以降の揺れを別フェーズとして集計)。
 *                       例: 初期表示 → --mark tab-damage → --click ... で、タブ切替後の
 *                       揺れだけを取り出せる。操作自体は何もしない
 *
 * 実測(いずれも複数指定可。指定が1つも無ければ `--overflow` 相当のサマリだけ出す):
 *   --rect <sel>            位置・サイズ・可視性・はみ出しを実測
 *   --style <sel:prop,...>  getComputedStyle の指定プロパティ
 *   --text <sel>            テキスト内容
 *   --html <sel>            outerHTML(既定1000字で切る。--html-len で変更)
 *   --count <sel>           一致件数だけ
 *   --overflow              横スクロールの有無と、はみ出している要素の一覧
 *   --eval <js>             ページ内で式を評価(JSONで返せる値のみ。Promiseを返せばawaitする)
 *   --limit <n>             セレクタごとの最大報告件数。既定 10
 *   --json                  JSONだけを出す(既定は人が読めるサマリ + JSON)
 *
 * 追加観測: --from は遷移元画面、--guest は開発用ゲストCookie、--cls はレイアウトシフト(揺れ)、--timing は Navigation/Paint Timing、
 * --repeat <n> は各観測を独立 context で n 回実行して中央値も出力する。
 *
 * 【--cls の読み方】
 *   total   : 入力起因(hadRecentInput)を除いた合計。Web VitalsのCLSと同じ定義
 *   totalAll: 入力起因も含めた合計。**操作後の揺れはこちらを見る**(タップ直後の再描画は
 *             hadRecentInputが立ち total から落ちるため、total だけ見ると揺れを見逃す)
 *   phases  : --mark で区切ったフェーズごとの合計。区切りが無ければ load フェーズ1つ
 *   各shiftのselector/dx/dy/dw/dh が犯人と動いた量。startTimeで発生タイミングが分かる
 */

import { chromium } from "@playwright/test";
import {
	applyGuestCookie,
	assertServerUp,
	detectBaseUrl,
	hideDevToolbar,
	normalizePagePath,
	parseSize,
	resolveLocator,
	waitForPyodideIfPresent,
} from "./lib/page-session.mjs";

const USAGE = [
	"  --from <path> / --guest / --cls / --mark <label> / --watch <sel> / --no-js / --timing / --repeat <n>",
	"使い方: npm run probe -- --page <path> [操作] [実測]",
	"",
	"  対象  --page box/<id> [--theme dark] [--size 390x844]",
	"  操作  --click <sel> / --drag <sel=dx,dy> / --swipe <sel=dx,dy>",
	"        --fill <sel=値> / --press <sel=Key> / --hover <sel>",
	"        --hold <sel=ms> / --hold-touch <sel=ms>",
		"        --scroll <sel|px> / --wait <sel> / --wait-ms <n>   ※指定順に実行",
	"  実測  --rect <sel> / --style <sel:prop,...> / --text <sel> / --html <sel>",
	"        --count <sel> / --overflow / --eval <js> / --limit <n> / --json",
	"",
	"詳細はこのファイル冒頭のコメントを参照。",
].join("\n");

function parseArgs(argv) {
	const opts = {
		page: null,
		from: null,
		base: null,
		theme: "light",
		size: "1920x1080",
		timeout: 300_000,
		keepToolbar: false,
		noJs: false,
		block: [],
		watch: null,
		htmlLen: 1000,
		limit: 10,
		json: false,
		guest: false,
		cls: false,
		timing: false,
		repeat: 1,
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
			case "--from":
				opts.from = next();
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
			case "--no-js":
				opts.noJs = true;
				break;
			case "--watch":
				opts.watch = next();
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
			case "--guest":
				opts.guest = true;
				break;
			case "--block":
				opts.block.push(next());
				break;
			case "--cls":
				opts.cls = true;
				break;
			case "--timing":
				opts.timing = true;
				break;
			case "--repeat":
				opts.repeat = Number(next());
				break;
			case "--click":
			case "--drag":
			case "--swipe":
			case "--fill":
			case "--press":
			case "--hover":
			case "--hold":
			case "--hold-touch":
			case "--scroll":
			case "--wait":
			case "--wait-ms":
			case "--mark":
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
		// マウス/指のドラッグ。スクロールバーを掴めるか、フリックでスクロールするかの検証用。
		// `--drag ".sel=-120,0"` は要素中央から左へ120px。`@x,y` を足すと要素内の開始点を
		// 左上からの相対px(負値は右/下端からの相対)で指定できる: `".sel@-4,-3=-120,0"`。
		case "drag":
		case "swipe": {
			const [selWithPoint, delta] = splitPair(value, `--${kind}`);
			const atIndex = selWithPoint.lastIndexOf("@");
			const sel = atIndex === -1 ? selWithPoint : selWithPoint.slice(0, atIndex);
			const point = atIndex === -1 ? null : selWithPoint.slice(atIndex + 1).split(",").map(Number);
			const [dx, dy] = delta.split(",").map(Number);
			const box = await resolveLocator(page, sel).first().boundingBox({ timeout: 30_000 });
			if (!box) throw new Error(`--${kind}: 要素の位置を取得できません: ${sel}`);
			const startX = point ? box.x + (point[0] < 0 ? box.width + point[0] : point[0]) : box.x + box.width / 2;
			const startY = point ? box.y + (point[1] < 0 ? box.height + point[1] : point[1]) : box.y + box.height / 2;
			if (kind === "drag") {
				await page.mouse.move(startX, startY);
				await page.mouse.down();
				for (let step = 1; step <= 10; step += 1) {
					await page.mouse.move(startX + (dx * step) / 10, startY + (dy * step) / 10);
				}
				await page.mouse.up();
			} else {
				// CDPのタッチ入力。フリック(慣性なし)で横スクロールが動くかを見る。
				const client = await page.context().newCDPSession(page);
				const touch = (x, y) => [{ x, y, radiusX: 5, radiusY: 5, force: 1 }];
				await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(startX, startY) });
				for (let step = 1; step <= 10; step += 1) {
					await client.send("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: touch(startX + (dx * step) / 10, startY + (dy * step) / 10),
					});
				}
				await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await client.detach();
			}
			break;
		}
		// 長押し。指を置いたまま動かさずに離す操作(揮発状態の効果説明ポップオーバー等)を
		// 実測するためのもの。合成PointerEventのdispatchでは「本物の押下で起きること」
		// (contextmenu・テキスト選択・pointercancel)が再現できず、動くように見えて
		// 実機で動かない見落としが出るため、本物の入力として送る。
		// `--hold ".sel=700"` で700ms押し続ける。`kind` が hold-touch なら指(CDPタッチ)で行う。
		case "hold":
		case "hold-touch": {
			const [sel, ms] = splitPair(value, `--${kind}`);
			const box = await resolveLocator(page, sel).first().boundingBox({ timeout: 30_000 });
			if (!box) throw new Error(`--${kind}: 要素の位置を取得できません: ${sel}`);
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			if (kind === "hold") {
				await page.mouse.move(x, y);
				await page.mouse.down();
				await page.waitForTimeout(Number(ms));
				await page.mouse.up();
			} else {
				const client = await page.context().newCDPSession(page);
				const touch = [{ x, y, radiusX: 5, radiusY: 5, force: 1 }];
				await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch });
				await page.waitForTimeout(Number(ms));
				await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await client.detach();
			}
			break;
		}
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
		// --cls のフェーズ区切り。画面には何もせず、この時点の時刻にラベルを打つだけ。
		// 以降に起きたレイアウトシフトは、集計時にこのラベルのフェーズへ振り分けられる。
		case "mark":
			await page.evaluate((label) => {
				(window.__probeClsMarks ??= []).push({ label, time: performance.now() });
			}, value);
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
		const result = await page.evaluate(async (expr) => {
			// 検証用に任意の式を1発だけ評価する(繋ぎ先はローカルのdev serverだけ)。
			// 長押し・遅延描画のように「待ってから測る」検証があるため、式がPromiseを
			// 返したらawaitしてから直列化する(awaitしないとJSON.stringify(Promise)が
			// 常に {} になり、非同期の観測結果が全部消える)。
			// eslint-disable-next-line no-eval
			const out = await eval(expr);
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

/**
 * addInitScript は page.goto より前に評価される。後から Observer を付けると、初期描画で起きる
 * シフトと LCP を取り逃すため、計測指定時だけここで登録する。
 */
async function installNavigationObservers(page, watchSelector) {
	await page.addInitScript((watchSelector) => {
		const selectorFor = (node) => {
			if (!(node instanceof Element)) return "unknown";
			let selector = node.tagName.toLowerCase();
			if (node.id) selector += `#${node.id}`;
			const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
			if (classes.length) selector += classes.map((name) => `.${name}`).join("");
			return selector;
		};
		const rectFor = (rect) => rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
		window.__probeLayoutShifts = [];
		window.__probeClsMarks = [];
		window.__probeMutations = [];
		window.__probeLcp = null;
		// --watch: 指定した要素の内側で起きたDOM変更を、起きた順に記録する。
		// 「どの要素が動いたか」(layout-shiftのsources)までは分かっても「誰が動かしたか」は
		// 分からない、という揺れ調査の詰まりどころを埋めるためのもの。
		if (watchSelector) {
			const record = (entry) => {
				if (window.__probeMutations.length >= 400) return;
				window.__probeMutations.push({ time: Math.round(performance.now() * 100) / 100, ...entry });
			};
			const inWatch = (node) => {
				const element = node instanceof Element ? node : node?.parentElement;
				try { return Boolean(element?.closest(watchSelector)); } catch { return false; }
			};
			const trim = (text) => (text ?? "").trim().slice(0, 40);
			new MutationObserver((records) => {
				for (const record_ of records) {
					if (!inWatch(record_.target)) continue;
					if (record_.type === "attributes") {
						record({
							kind: `attr:${record_.attributeName}`, selector: selectorFor(record_.target),
							from: trim(record_.oldValue), to: trim(record_.target.getAttribute(record_.attributeName)),
						});
					} else if (record_.type === "characterData") {
						record({ kind: "text", selector: selectorFor(record_.target.parentElement), from: trim(record_.oldValue), to: trim(record_.target.data) });
					} else {
						record({
							kind: "childList", selector: selectorFor(record_.target),
							from: `-${record_.removedNodes.length}`, to: `+${record_.addedNodes.length}`,
						});
					}
				}
			}).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
		}
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					window.__probeLayoutShifts.push({
						value: entry.value,
						hadRecentInput: entry.hadRecentInput,
						startTime: entry.startTime,
						sources: (entry.sources ?? []).slice(0, 10).map((source) => ({
							selector: selectorFor(source.node),
							prevRect: rectFor(source.previousRect),
							currRect: rectFor(source.currentRect),
						})),
					});
				}
			}).observe({ type: "layout-shift", buffered: true });
			new PerformanceObserver((list) => {
				const entries = list.getEntries();
				if (entries.length) window.__probeLcp = entries[entries.length - 1].toJSON();
			}).observe({ type: "largest-contentful-paint", buffered: true });
		} catch {
			// 古いブラウザでは対応しない entry type だけを欠損として扱い、通常の probe は継続する。
		}
	}, watchSelector ?? null);
}

function median(values) {
	const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (ordered.length === 0) return null;
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

async function collectNavigationMetrics(page, includeCls, includeTiming, limit) {
	return page.evaluate(({ includeCls, includeTiming, limit }) => {
		const round = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
		const shifts = includeCls ? (window.__probeLayoutShifts ?? []) : [];
		const marks = includeCls ? (window.__probeClsMarks ?? []) : [];
		// --mark で打った時刻でフェーズに区切る。区切りが無ければ load フェーズ1つ。
		const phaseBounds = [{ label: "load", from: 0 }, ...marks.map((mark) => ({ label: mark.label, from: mark.time }))];
		const phaseOf = (startTime) => {
			let label = phaseBounds[0].label;
			for (const bound of phaseBounds) if (startTime >= bound.from) label = bound.label;
			return label;
		};
		const describeSource = (source) => {
			const prev = source.prevRect;
			const curr = source.currRect;
			return {
				selector: source.selector,
				dx: round((curr?.x ?? 0) - (prev?.x ?? 0)), dy: round((curr?.y ?? 0) - (prev?.y ?? 0)),
				dw: round((curr?.width ?? 0) - (prev?.width ?? 0)), dh: round((curr?.height ?? 0) - (prev?.height ?? 0)),
			};
		};
		const describe = (shift) => {
			// 1件のシフトには複数のsource(動いた要素)が入る。先頭だけ見ると「押された側」しか
			// 分からず、押した側(縮んだ/伸びた要素)を取り逃がすので全部返す。
			const sources = (shift.sources.length ? shift.sources : [{ selector: "unknown", prevRect: null, currRect: null }]).map(describeSource);
			return {
				value: round(shift.value), hadRecentInput: shift.hadRecentInput, startTime: round(shift.startTime),
				phase: phaseOf(shift.startTime), ...sources[0], sources,
			};
		};
		const sum = (list) => round(list.reduce((total, shift) => total + shift.value, 0));
		const cls = includeCls ? {
			// total は Web Vitals と同じ定義(入力起因を除く)。操作後の揺れは totalAll を見る。
			total: sum(shifts.filter((shift) => !shift.hadRecentInput)),
			totalAll: sum(shifts),
			phases: phaseBounds.map((bound) => {
				const inPhase = shifts.filter((shift) => phaseOf(shift.startTime) === bound.label);
				return { label: bound.label, from: round(bound.from), total: sum(inPhase), count: inPhase.length };
			}),
			shifts: [...shifts].sort((a, b) => b.value - a.value).slice(0, limit).map(describe),
		} : undefined;
		if (!includeTiming) return { cls };
		const nav = performance.getEntriesByType("navigation")[0];
		const paint = performance.getEntriesByType("paint").find((entry) => entry.name === "first-contentful-paint");
		const resources = performance.getEntriesByType("resource").map((entry) => entry.toJSON());
		const resourceRows = resources.map((entry) => ({ url: entry.name.length > 60 ? `…${entry.name.slice(-60)}` : entry.name, transferSize: entry.transferSize ?? 0, decodedBodySize: entry.decodedBodySize ?? 0, duration: entry.duration ?? 0 }));
		resourceRows.sort((a, b) => b.transferSize - a.transferSize);
		return {
			cls,
			timing: {
				ttfb: round(nav.responseStart - nav.requestStart), responseEnd: round(nav.responseEnd - nav.startTime),
				domInteractive: round(nav.domInteractive), domContentLoadedEventEnd: round(nav.domContentLoadedEventEnd), loadEventEnd: round(nav.loadEventEnd),
				transferSize: nav.transferSize, decodedBodySize: nav.decodedBodySize,
				fcp: round(paint?.startTime), lcp: round(window.__probeLcp?.startTime),
				resources: { count: resourceRows.length, transferSize: resourceRows.reduce((total, entry) => total + entry.transferSize, 0), largest: resourceRows.slice(0, 10) },
			},
		};
	}, { includeCls, includeTiming, limit });
}

// --block で指定した部分文字列を含むURLのリクエストを落とす。Webフォントや外部画像が
// 「来なかった場合」のレイアウトを実測して、揺れの原因がその通信かどうかを切り分けるためのもの。
async function applyBlockRules(context, patterns) {
	if (!patterns || patterns.length === 0) return;
	await context.route("**/*", (route) => {
		const url = route.request().url();
		if (patterns.some((pattern) => url.includes(pattern))) return route.abort();
		return route.continue();
	});
}

async function measureWithObservers(browser, opts, viewport, pagePath) {
	const context = await browser.newContext({ viewport, hasTouch: true, javaScriptEnabled: !opts.noJs });
	if (opts.guest) await applyGuestCookie(context, opts.base);
	await applyBlockRules(context, opts.block);
	const page = await context.newPage();
	const report = { url: `${opts.base}${pagePath}`, theme: opts.theme, viewport, probes: [] };
	try {
		await page.emulateMedia({ colorScheme: opts.theme });
		if (opts.from) {
			const fromPath = normalizePagePath(opts.from);
			await page.goto(`${opts.base}${fromPath}`, { waitUntil: "load", timeout: 60_000 });
			await page.waitForLoadState("networkidle").catch(() => {});
			await page.waitForTimeout(300);
		}
		if (opts.cls || opts.timing || opts.watch) await installNavigationObservers(page, opts.watch);
		const response = await page.goto(report.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
		report.status = response?.status() ?? 0;
		if (!opts.keepToolbar && !opts.noJs) await hideDevToolbar(page);
		if (!opts.noJs) {
			await page.evaluate(`window.collectElementsInPage = ${collectElements.toString()}`);
			const pyodide = await waitForPyodideIfPresent(page, opts.timeout);
			report.pyodideWaited = pyodide !== null;
		}
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.evaluate(() => document.fonts?.ready);
		if (opts.cls || opts.timing || opts.watch) await page.waitForTimeout(500);
		for (const action of opts.actions) await runAction(page, action);
		if (opts.actions.length > 0) await page.waitForTimeout(opts.cls ? 1000 : 250);
		for (const probe of opts.probes) report.probes.push(await runProbe(page, probe, opts));
		if (opts.cls || opts.timing) Object.assign(report, await collectNavigationMetrics(page, opts.cls, opts.timing, opts.limit));
		if (opts.watch) report.mutations = await page.evaluate(() => window.__probeMutations ?? []);
	} finally {
		await context.close();
	}
	return report;
}

function timingMedian(reports, opts) {
	const result = {};
	if (opts.cls) result.cls = { total: median(reports.map((report) => report.cls?.total)), totalAll: median(reports.map((report) => report.cls?.totalAll)) };
	if (opts.timing) {
		const names = ["ttfb", "responseEnd", "domInteractive", "domContentLoadedEventEnd", "loadEventEnd", "transferSize", "decodedBodySize", "fcp", "lcp"];
		result.timing = Object.fromEntries(names.map((name) => [name, median(reports.map((report) => report.timing?.[name]))]));
		result.timing.resources = { count: median(reports.map((report) => report.timing?.resources?.count)), transferSize: median(reports.map((report) => report.timing?.resources?.transferSize)) };
	}
	return result;
}

async function runNewMeasurement(opts) {
	if (opts.theme !== "light" && opts.theme !== "dark") throw new Error(`--theme は light / dark のいずれかです: ${opts.theme}`);
	if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error("--repeat は 1 以上の整数で指定してください");
	const viewport = parseSize(opts.size);
	const pagePath = normalizePagePath(opts.page);
	if (!opts.base) opts.base = await detectBaseUrl();
	await assertServerUp(opts.base);
	if (opts.probes.length === 0) opts.probes.push({ kind: "overflow", value: null });
	const browser = await chromium.launch();
	const reports = [];
	try {
		for (let index = 0; index < opts.repeat; index += 1) reports.push(await measureWithObservers(browser, opts, viewport, pagePath));
	} finally {
		await browser.close();
	}
	const report = opts.repeat === 1 ? reports[0] : { ...reports[0], repeat: opts.repeat, runs: reports, median: timingMedian(reports, opts) };
	if (!opts.json) {
		const lines = ["", `=== ${report.url} (${opts.theme}, ${viewport.width}x${viewport.height}) HTTP ${report.status} ===`];
		if (report.cls) {
			lines.push(`CLS: ${report.cls.total} (入力起因を含む合計 ${report.cls.totalAll})`);
			if (report.cls.phases.length > 1) {
				for (const phase of report.cls.phases) lines.push(`  [${phase.label}] ${phase.total} (${phase.count}件, ${phase.from}ms〜)`);
			}
			for (const shift of report.cls.shifts) {
				lines.push(`  ${shift.value} @ ${shift.startTime}ms [${shift.phase}] ${shift.selector} dx=${shift.dx} dy=${shift.dy} dw=${shift.dw} dh=${shift.dh}${shift.hadRecentInput ? " (input)" : ""}`);
				for (const source of shift.sources.slice(1)) lines.push(`      + ${source.selector} dx=${source.dx} dy=${source.dy} dw=${source.dw} dh=${source.dh}`);
			}
		}
		if (report.mutations) {
			lines.push(`DOM変更 (${report.mutations.length}件${report.mutations.length >= 400 ? "、上限で打ち切り" : ""}): ${opts.watch} の内側`);
			for (const mutation of report.mutations) lines.push(`  ${mutation.time}ms ${mutation.selector} ${mutation.kind} "${mutation.from}" → "${mutation.to}"`);
		}
		if (report.timing) {
			const timing = report.timing;
			lines.push(`Timing: TTFB ${timing.ttfb}ms / responseEnd ${timing.responseEnd}ms / DOM interactive ${timing.domInteractive}ms / DCL ${timing.domContentLoadedEventEnd}ms / load ${timing.loadEventEnd}ms / FCP ${timing.fcp}ms / LCP ${timing.lcp}ms`);
			lines.push(`  navigation ${timing.transferSize}B transfer, ${timing.decodedBodySize}B decoded; resources ${timing.resources.count}, ${timing.resources.transferSize}B transfer`);
			for (const resource of timing.resources.largest) lines.push(`  ${resource.transferSize}B ${resource.url}`);
		}
		if (report.median) lines.push(`中央値 (${opts.repeat}回): ${JSON.stringify(report.median)}`);
		process.stderr.write(lines.join("\n") + "\n");
	}
	process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || !opts.page) {
		process.stdout.write(USAGE + "\n");
		process.exitCode = opts.help ? 0 : 1;
		return;
	}
	if (opts.from || opts.guest || opts.cls || opts.timing || opts.watch || opts.repeat !== 1) {
		await runNewMeasurement(opts);
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
	// --swipe(タッチ)を使えるよう、コンテキストは常にタッチ有効で作る。
		const context = await browser.newContext({ viewport, hasTouch: true });
	await applyBlockRules(context, opts.block);
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
