#!/usr/bin/env node
/**
 * 初回表示で本文フォントがフォールバックから差し替わる際の横方向のレイアウト揺れをなくすため、
 * アプリで表示し得る文字を一つに集めた M PLUS Rounded 1c のコアサブセットを生成する。
 *
 * 従来の Google Fonts 由来の unicode-range 分割フォントは残し、ここで生成するフォントにも
 * 同じ unicode-range を明示する。これによりコア内の文字は preload された一ファイルで最初から
 * 揃い、コア外の稀な文字だけは従来の分割フォントへフォールバックできる。
 *
 * 使い方:
 *   node scripts/fonts/build-core-subset.mjs
 *
 * 生成物:
 *   public/fonts/m-plus-rounded-1c-core/core-<weight>.<hash>.woff2
 *   src/styles/webfont-m-plus-rounded-1c-core.css
 *   src/lib/webfont-core-preload.ts
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import subsetFont from "subset-font";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const MASTER_DATA_DIR = path.join(REPO_ROOT, "public", "master-data");
const SRC_DIR = path.join(REPO_ROOT, "src");
const OUT_DIR = path.join(REPO_ROOT, "public", "fonts", "m-plus-rounded-1c-core");
const SCRATCH_DIR = path.join(REPO_ROOT, ".tmp-font-core-subset");
const CSS_OUT = path.join(REPO_ROOT, "src", "styles", "webfont-m-plus-rounded-1c-core.css");
const PRELOAD_OUT = path.join(REPO_ROOT, "src", "lib", "webfont-core-preload.ts");
const PUBLIC_PREFIX = "/fonts/m-plus-rounded-1c-core";

const SOURCE_FONTS = [
	{
		weight: 400,
		name: "MPLUSRounded1c-Regular.ttf",
		url: "https://raw.githubusercontent.com/google/fonts/main/ofl/mplusrounded1c/MPLUSRounded1c-Regular.ttf",
	},
	{
		weight: 500,
		name: "MPLUSRounded1c-Medium.ttf",
		url: "https://raw.githubusercontent.com/google/fonts/main/ofl/mplusrounded1c/MPLUSRounded1c-Medium.ttf",
	},
	{
		weight: 700,
		name: "MPLUSRounded1c-Bold.ttf",
		url: "https://raw.githubusercontent.com/google/fonts/main/ofl/mplusrounded1c/MPLUSRounded1c-Bold.ttf",
	},
];

const SOURCE_EXTENSIONS = new Set([".astro", ".ts", ".tsx", ".js", ".mjs", ".css"]);
const FIXED_RANGES = [
	[0x0020, 0x007e],
	[0x00a0, 0x00ff],
	[0x2190, 0x21ff],
	[0x2460, 0x24ff],
	[0x25a0, 0x25ff],
	[0x2600, 0x26ff],
	[0x3000, 0x303f],
	[0x3040, 0x309f],
	[0x30a0, 0x30ff],
	[0x31f0, 0x31ff],
	[0xff00, 0xffef],
];

async function listFiles(directory, predicate) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(entryPath, predicate)));
		} else if (entry.isFile() && predicate(entryPath)) {
			files.push(entryPath);
		}
	}
	return files;
}

function addTextCharacters(characters, text) {
	for (const character of text) characters.add(character.codePointAt(0));
}

function addJsonStringCharacters(characters, value) {
	if (typeof value === "string") {
		addTextCharacters(characters, value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) addJsonStringCharacters(characters, item);
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			// キーも画面表示用の文言になる可能性があるため、安全側で含める。
			addTextCharacters(characters, key);
			addJsonStringCharacters(characters, item);
		}
	}
}

async function buildCharacterSet() {
	const characters = new Set();

	for (const [start, end] of FIXED_RANGES) {
		for (let codePoint = start; codePoint <= end; codePoint += 1) characters.add(codePoint);
	}

	const masterDataFiles = await listFiles(MASTER_DATA_DIR, (file) => path.extname(file) === ".json");
	for (const file of masterDataFiles) {
		const json = JSON.parse(await readFile(file, "utf8"));
		addJsonStringCharacters(characters, json);
	}

	const sourceFiles = await listFiles(SRC_DIR, (file) => SOURCE_EXTENSIONS.has(path.extname(file)));
	for (const file of sourceFiles) addTextCharacters(characters, await readFile(file, "utf8"));

	return { characters, masterDataFiles: masterDataFiles.length, sourceFiles: sourceFiles.length };
}

function toUnicodeRange(codePoints) {
	const ranges = [];
	let start = codePoints[0];
	let end = start;
	for (const codePoint of codePoints.slice(1)) {
		if (codePoint === end + 1) {
			end = codePoint;
			continue;
		}
		ranges.push([start, end]);
		start = codePoint;
		end = codePoint;
	}
	ranges.push([start, end]);
	return ranges.map(([rangeStart, rangeEnd]) => {
		const startHex = rangeStart.toString(16).toUpperCase();
		const endHex = rangeEnd.toString(16).toUpperCase();
		return rangeStart === rangeEnd ? `U+${startHex}` : `U+${startHex}-${endHex}`;
	});
}

function getGlyphCount(sfnt) {
	const tableCount = sfnt.readUInt16BE(4);
	for (let index = 0; index < tableCount; index += 1) {
		const offset = 12 + index * 16;
		if (sfnt.toString("ascii", offset, offset + 4) !== "maxp") continue;
		const tableOffset = sfnt.readUInt32BE(offset + 8);
		return sfnt.readUInt16BE(tableOffset + 4);
	}
	throw new Error("生成したフォントから maxp テーブルを見つけられませんでした");
}

async function fetchFont(source) {
	console.log(`取得中: ${source.weight} (${source.url})`);
	const response = await fetch(source.url);
	if (!response.ok) throw new Error(`${source.url} の取得に失敗しました (${response.status})`);
	const buffer = Buffer.from(await response.arrayBuffer());
	await writeFile(path.join(SCRATCH_DIR, source.name), buffer);
	return buffer;
}

function createCss(files, unicodeRanges) {
	const header = `/* 自動生成: node scripts/fonts/build-core-subset.mjs\n   直接編集しないこと。コア外の文字は従来の unicode-range 分割フォントへ委ねる。 */\n`;
	return header + files.map(({ weight, url }) => `\n@font-face {\n  font-family: "M PLUS Rounded 1c";\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(${url}) format("woff2");\n  unicode-range: ${unicodeRanges.join(",")};\n}\n`).join("");
}

function createPreloadModule(urls) {
	return `// 自動生成: node scripts/fonts/build-core-subset.mjs\n// 直接編集しないこと。初回描画より前にコア文字のフォント取得を開始する。\nexport const webfontCorePreloadUrls = [\n${urls.map((url) => `\t"${url}",`).join("\n")}\n] as const;\n`;
}

async function main() {
	console.log("コアサブセット用の文字集合を収集中...");
	const { characters, masterDataFiles, sourceFiles } = await buildCharacterSet();
	const codePoints = [...characters].sort((a, b) => a - b);
	const subsetText = String.fromCodePoint(...codePoints);
	const unicodeRanges = toUnicodeRange(codePoints);
	console.log(`文字集合: ${codePoints.length} 文字（master-data JSON ${masterDataFiles} 件、src ${sourceFiles} 件）`);
	console.log(`unicode-range: ${unicodeRanges.length} レンジ`);

	await rm(SCRATCH_DIR, { recursive: true, force: true });
	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(SCRATCH_DIR, { recursive: true });
	await mkdir(OUT_DIR, { recursive: true });

	try {
		const files = [];
		let totalBytes = 0;
		for (const source of SOURCE_FONTS) {
			const ttf = await fetchFont(source);
			console.log(`サブセット生成中: ${source.weight}`);
			// subset-font だけに依存したままグリフ数を数えるため、同じ入力から SFNT も生成する。
			const sfnt = await subsetFont(ttf, subsetText, { targetFormat: "sfnt" });
			const woff2 = await subsetFont(ttf, subsetText, { targetFormat: "woff2" });
			const hash = createHash("sha256").update(woff2).digest("hex").slice(0, 8);
			const name = `core-${source.weight}.${hash}.woff2`;
			const url = `${PUBLIC_PREFIX}/${name}`;
			await writeFile(path.join(OUT_DIR, name), woff2);
			const glyphCount = getGlyphCount(sfnt);
			totalBytes += woff2.length;
			files.push({ weight: source.weight, url, glyphCount, bytes: woff2.length });
			console.log(`  ${source.weight}: ${glyphCount} グリフ / ${woff2.length} バイト`);
		}

		await writeFile(CSS_OUT, createCss(files, unicodeRanges), "utf8");
		await writeFile(PRELOAD_OUT, createPreloadModule(files.map(({ url }) => url)), "utf8");
		console.log(`合計: ${totalBytes} バイト`);
		console.log(`CSS: ${path.relative(REPO_ROOT, CSS_OUT)}`);
		console.log(`preload 一覧: ${path.relative(REPO_ROOT, PRELOAD_OUT)}`);
	} finally {
		// 元の TTF は生成専用なので、リポジトリに残さない。
		await rm(SCRATCH_DIR, { recursive: true, force: true });
	}
}

await main();
