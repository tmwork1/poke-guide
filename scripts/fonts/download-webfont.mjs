#!/usr/bin/env node
/**
 * Google Fonts の M PLUS Rounded 1c を自前配信用にダウンロードして
 * public/fonts/ 配下へ置き、同一オリジンを指す @font-face CSS を生成する。
 *
 * 【なぜ自前配信にしたか】
 *   Google Fonts は「fonts.googleapis.com からCSSを取る」→「fonts.gstatic.com から
 *   woff2 を取る」の2往復かかるため、フォントが届くのは必ず初回描画のあとになる。
 *   その結果、フォールバックフォントで一度描かれてからWebフォントに差し替わり、
 *   ほぼ全ページでテキストが 4.5〜7.2px 横へ動いていた(2026-09-10 実測。
 *   → docs/stabilize/dashboard.md「Webフォント」)。同一オリジンから preload すれば
 *   初回描画に間に合うので、差し替えそのものが起きなくなる。
 *
 * 【unicode-range 分割はそのまま維持する】
 *   日本語フォントは Google 側で100個弱のサブセットに分割されていて、ブラウザは
 *   ページに出てくる文字を含むサブセットだけを取得する。まとめて1ファイルにすると
 *   数MBを常に転送することになるので、分割された woff2 をそのまま持ってきて
 *   unicode-range も含めてCSSを書き写す。
 *
 * 使い方:
 *   node scripts/fonts/download-webfont.mjs
 *
 * 生成物(いずれもリポジトリにコミットする。public/type-icons 等と同じ方式):
 *   public/fonts/m-plus-rounded-1c/*.woff2
 *   src/styles/webfont-m-plus-rounded-1c.css
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "public", "fonts", "m-plus-rounded-1c");
const CSS_OUT = path.join(REPO_ROOT, "src", "styles", "webfont-m-plus-rounded-1c.css");
const PUBLIC_PREFIX = "/fonts/m-plus-rounded-1c";

// global.css が使う太さだけを取る(--font-weight-normal/medium/semibold/bold)。
// 800 は以前URLに入っていたが、どのCSSからも参照されていないので落とす。
const CSS_URL =
	"https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;500;600;700&display=swap";

// woff2 版のURLを返させるために、woff2に対応したブラウザのUAを名乗る。
// (UAを送らないと Google は古い truetype 版のCSSを返す)
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchText(url) {
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
	return res.text();
}

async function main() {
	const css = await fetchText(CSS_URL);

	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	// 同じ woff2 を2回落とさないよう、URL -> ローカルファイル名 で覚えておく。
	const localNameByUrl = new Map();
	const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
	let downloaded = 0;
	let bytes = 0;

	for (const url of urls) {
		if (localNameByUrl.has(url)) continue;
		// gstatic のファイル名は「…oTdprA.0.woff2」のように末尾が連番。太さごとにハッシュが
		// 違うので、そのままの basename を使えば衝突しない。
		const name = url.slice(url.lastIndexOf("/") + 1);
		const res = await fetch(url, { headers: { "User-Agent": UA } });
		if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
		const buffer = Buffer.from(await res.arrayBuffer());
		await writeFile(path.join(OUT_DIR, name), buffer);
		localNameByUrl.set(url, name);
		downloaded += 1;
		bytes += buffer.length;
		if (downloaded % 25 === 0) console.log(`  ${downloaded}/${urls.length} ...`);
	}

	const rewritten = css.replace(
		/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g,
		(_match, url) => `url(${PUBLIC_PREFIX}/${localNameByUrl.get(url)})`,
	);

	const header = `/* 自動生成: node scripts/fonts/download-webfont.mjs
   直接編集しない。取得元は Google Fonts の M PLUS Rounded 1c (SIL Open Font License 1.1)。
   なぜ自前配信にしたかはスクリプト冒頭のコメントを参照。 */\n`;
	await writeFile(CSS_OUT, header + rewritten, "utf8");

	const files = await readdir(OUT_DIR);
	console.log(`woff2 ${files.length}件 / ${(bytes / 1024 / 1024).toFixed(1)}MB`);
	console.log(`CSS: ${path.relative(REPO_ROOT, CSS_OUT)}`);
}

await main();
