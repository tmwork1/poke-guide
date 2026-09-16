// ブラウザOCR結果の純粋パーサー。DOM非依存。
// ブラウザ側は src/lib/box-id/game-screen-ocr.ts、検証は tests/game-screen-ocr-parse.test.ts。

import { calcHpStat, calcOtherStat, NATURE_STAT_MODIFIERS, STAT_KEYS, type StatKey } from "./stats.ts";

export interface OcrMasterEntry {
	name: string;
	types: string[];
}

export interface ParsedStat {
	key: StatKey;
	actual: number | null;
	ev: number | null;
	verified: boolean | null;
}

export interface OcrFieldScores {
	species: number;
	stats: Record<StatKey, number>;
	moves: number[];
	ability: number;
}

export interface GameScreenOcrResult {
	species: string | null;
	nature: string;
	stats: ParsedStat[];
	moves: Array<string | null>;
	ability: string | null;
	confidence: OcrFieldScores;
}

export interface GameScreenOcrParseData {
	master: OcrMasterEntry[];
	baseStats: number[] | undefined;
	learnset: string[];
	abilities: string[];
}

const STAT_LABELS: Array<{ key: StatKey; labels: string[] }> = [
	{ key: "hp", labels: ["hp"] },
	{ key: "atk", labels: ["こうげき", "ころげき"] },
	{ key: "def", labels: ["ぼうぎょ", "ぼうきょ", "ほうきょ", "ほっきょ"] },
	{ key: "spa", labels: ["とくこう", "こくこう"] },
	{ key: "spd", labels: ["とくぼう", "こくほう", "こほう"] },
	{ key: "spe", labels: ["すばやさ"] },
];
const ABILITY_LABEL = "特性";

/** Unicode正規化と記号除去で、OCR文字列を候補名と比較できる形にする。 */
function normalizedName(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[ぁ-ゖ]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x60))
		.toLowerCase()
		.replace(/[\s\d\p{P}\p{S}]/gu, "");
}

/** OCR文字列と候補名の編集距離を計算し、誤認識を許容した比較に使う。 */
export function editDistance(first: string, second: string): number {
	const a = normalizedName(first);
	const b = normalizedName(second);
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = current;
		}
	}
	return row[b.length];
}

/** 完全一致だけでなく、OCR結果内の部分文字列も候補名と比較する。 */
function similarity(value: string, candidate: string): number {
	const source = normalizedName(value);
	const target = normalizedName(candidate);
	if (!source || !target) return 0;
	let best = Math.max(0, 1 - editDistance(source, target) / Math.max(source.length, target.length));
	for (let start = 0; start < source.length; start++) {
		for (
			let length = Math.max(1, target.length - 2);
			length <= Math.min(source.length - start, target.length + 2);
			length++
		) {
			const window = source.slice(start, start + length);
			best = Math.max(best, 1 - editDistance(window, target) / Math.max(window.length, target.length));
		}
	}
	return best;
}

/** 候補の中で最も近い名前を選び、0.45未満は誤認識の可能性が高いので棄却する。 */
function nearestNameWithScore(value: string, candidates: string[], minimumScore = 0.45): { name: string | null; score: number } {
	const scored = candidates.map((candidate) => ({ name: candidate, score: similarity(value, candidate) }));
	let best = scored.reduce<{ name: string | null; score: number }>((acc, entry) => (entry.score > acc.score ? entry : acc), { name: null, score: 0 });
	// similarity は部分文字列の窓でも比較するため、「かみなりバンチ」に対して短い「かみなり」が
	// 完全一致(1.0)して「かみなりパンチ」(0.86)に勝ってしまう。最良候補を含む長い候補が十分近い
	// (0.8以上)なら、行に文字が余っている=長い方が本来の名前とみなして差し替える。
	// 本当に「かみなり」の行なら長い候補との類似度は 4/7≒0.57 に留まるので誤って伸びない。
	if (best.name) {
		const shortName = normalizedName(best.name);
		const longer = scored.filter((entry) => {
			const longName = normalizedName(entry.name);
			return entry.score >= 0.8 && longName.length > shortName.length && longName.includes(shortName);
		});
		if (longer.length > 0) {
			best = longer.reduce((acc, entry) => (entry.score > acc.score ? entry : acc));
		}
	}
	return best.score >= minimumScore ? best : { name: null, score: 0 };
}

export function nearestName(value: string, candidates: string[]): string | null {
	return nearestNameWithScore(value, candidates).name;
}

/** 数字に見える英字を数字へ補正して、OCRが分割した数値トークンを抽出する。 */
function numericTokens(line: string): number[] {
	const corrected = line
		.replace(/[OoQq]/g, "0")
		.replace(/[Il|]/g, "1")
		.replace(/[Ss]/g, "5")
		.replace(/[Bb]/g, "8");
	return [...corrected.matchAll(/\d+/g)].map((match) => Number(match[0])).filter(Number.isFinite);
}

// HPだけは短すぎて編集距離が不安定なため、専用の正規表現で判定する。
function labelScore(line: string, label: string): number {
	return label === "hp" ? (/hp/i.test(line) ? 1 : 0) : similarity(line, label);
}

/** ステータス名の確度と範囲内の実数値を組み合わせて、1行を解析する。 */
function statFromLine(line: string): { key: StatKey; actual: number | null; ev: number | null; score: number } | null {
	let matched: { key: StatKey; score: number } | null = null;
	for (const entry of STAT_LABELS) {
		const score = Math.max(...entry.labels.map((label) => labelScore(line, label)));
		if (!matched || score > matched.score) matched = { key: entry.key, score };
	}
	if (!matched || matched.score < 0.4) return null;
	const numbers = numericTokens(line);
	const actualIndex = numbers.findIndex((value) => value >= 40 && value <= 999);
	const actual = actualIndex < 0 ? null : numbers[actualIndex];
	if (actual == null) return null;
	const ev = numbers.slice(actualIndex + 1).find((value) => value >= 0 && value <= 32) ?? null;
	return { key: matched.key, actual, ev, score: matched.score };
}

/** タイプ行より上で、最も近い名前だけを種族候補にすることでニックネームを避ける。 */
function speciesFromLines(lines: string[], master: OcrMasterEntry[]): { species: string | null; score: number } {
	const firstStat = lines.findIndex((line) => statFromLine(line) !== null);
	const candidates = lines.slice(0, firstStat < 0 ? lines.length : firstStat);
	let best = { species: null as string | null, score: 0 };
	for (const line of candidates) {
		const match = nearestNameWithScore(line, master.map((entry) => entry.name));
		if (match.name && match.score > best.score) best = { species: match.name, score: match.score };
	}
	return best;
}

/** 特性ラベルは短いOCR誤読を許容するため、0.6以上を見出しとみなす。 */
function abilityLineIndex(lines: string[]): number {
	return lines.findIndex((line) => similarity(line, ABILITY_LABEL) >= 0.6 || normalizedName(line).includes(ABILITY_LABEL));
}

/** 実数値を種族値・IV31・レベル50・EVから逆算し、最も整合する性格を推定する。 */
export function inferNature(baseStats: number[] | undefined, stats: ParsedStat[]): { nature: string; verified: Map<StatKey, boolean | null> } {
	const neutralNature = Object.entries(NATURE_STAT_MODIFIERS).find(([, modifier]) => modifier.up === null && modifier.down === null)?.[0] ?? "まじめ";
	if (!baseStats || baseStats.length !== STAT_KEYS.length) return { nature: neutralNature, verified: new Map(stats.map((stat) => [stat.key, null])) };
	let bestNature = neutralNature;
	let bestScore = -1;
	for (const [name, modifier] of Object.entries(NATURE_STAT_MODIFIERS)) {
		let score = 0;
		for (const stat of stats) {
			if (stat.key === "hp" || stat.actual == null || stat.ev == null) continue;
			const index = STAT_KEYS.indexOf(stat.key);
			const multiplier = modifier.up === stat.key ? 1.1 : modifier.down === stat.key ? 0.9 : 1;
			if (calcOtherStat(50, baseStats[index], 31, stat.ev, multiplier) === stat.actual) score++;
		}
		if (score > bestScore || (score === bestScore && name === neutralNature)) {
			bestNature = name;
			bestScore = score;
		}
	}
	const modifier = NATURE_STAT_MODIFIERS[bestNature];
	const verified = new Map<StatKey, boolean | null>();
	for (const stat of stats) {
		if (stat.actual == null || stat.ev == null) {
			verified.set(stat.key, null);
			continue;
		}
		const index = STAT_KEYS.indexOf(stat.key);
		const expected = stat.key === "hp"
			? calcHpStat(50, baseStats[index], 31, stat.ev)
			: calcOtherStat(50, baseStats[index], 31, stat.ev, modifier.up === stat.key ? 1.1 : modifier.down === stat.key ? 0.9 : 1);
		verified.set(stat.key, expected === stat.actual);
	}
	return { nature: bestNature, verified };
}

/** OCR行を正規化し、種族・能力値・技・特性を各マスターデータへ照合する。 */
export function parseGameScreenLines(rawLines: string[], data: GameScreenOcrParseData): GameScreenOcrResult {
	const lines = rawLines.map((line) => line.trim()).filter(Boolean);
	const speciesMatch = speciesFromLines(lines, data.master);
	const foundStats = new Map<StatKey, { actual: number | null; ev: number | null; score: number }>();
	let lastStatIndex = -1;
	for (let index = 0; index < lines.length; index++) {
		const parsed = statFromLine(lines[index]);
		if (!parsed) continue;
		const previous = foundStats.get(parsed.key);
		if (!previous || parsed.score > previous.score || (parsed.actual != null && previous.actual == null)) foundStats.set(parsed.key, parsed);
		lastStatIndex = index;
	}
	const stats = STAT_KEYS.map((key) => ({ key, actual: foundStats.get(key)?.actual ?? null, ev: foundStats.get(key)?.ev ?? null, verified: null }));
	const natureResult = inferNature(data.baseStats, stats);
	for (const stat of stats) stat.verified = natureResult.verified.get(stat.key) ?? null;
	const abilityIndex = abilityLineIndex(lines);
	const moveLines = lines.slice(lastStatIndex + 1, abilityIndex < 0 ? lines.length : abilityIndex).slice(0, 4);
	const moveMatches = moveLines.map((line) => nearestNameWithScore(line.replace(/[0-9OoQqIl|SsBb]+\s*$/, "").trim(), data.learnset));
	const moves = moveMatches.map((match) => match.name);
	while (moves.length < 4) moves.push(null);
	const abilitySource = abilityIndex < 0 ? "" : lines[abilityIndex].replace(new RegExp(ABILITY_LABEL, "g"), "").trim();
	// 特性名はラベル除去後の短い文字列になりやすいため、0.25まで誤読を許容する。
	const abilityMatch = nearestNameWithScore(abilitySource, data.abilities, 0.25);
	const statScores = Object.fromEntries(STAT_KEYS.map((key) => [key, foundStats.get(key)?.score ?? 0])) as Record<StatKey, number>;
	return {
		species: speciesMatch.species,
		nature: natureResult.nature,
		stats,
		moves,
		ability: abilityMatch.name,
		confidence: { species: speciesMatch.score, stats: statScores, moves: moveMatches.map((match) => match.score), ability: abilityMatch.score },
	};
}

/** 実数値だけ、EVまで、性格補正込みの順に、種族に整合するステータスを優先する。 */
function statConsistency(stat: ParsedStat, base: number | undefined): number {
	if (stat.actual == null) return 0;
	if (stat.ev == null || base == null) return 0.5;
	if (stat.key === "hp") return calcHpStat(50, base, 31, stat.ev) === stat.actual ? 2 : 0;
	const matchesNature = Object.values(NATURE_STAT_MODIFIERS).some((nature) => {
		const multiplier = nature.up === stat.key ? 1.1 : nature.down === stat.key ? 0.9 : 1;
		return calcOtherStat(50, base, 31, stat.ev!, multiplier) === stat.actual;
	});
	return matchesNature ? 2 : 0;
}

/**
 * 種族と特性は確度の高い非null値、ステータスは計算整合性・実数値・EV・確度の順、
 * 技は読めた数と合計確度が最良のパスを軸に、他パスの未出重複なし技を補ってマージする。
 */
export function mergeGameScreenOcrResults(passes: GameScreenOcrResult[], data: GameScreenOcrParseData): GameScreenOcrResult {
	if (!passes.length) return parseGameScreenLines([], data);
	const selectName = (get: (pass: GameScreenOcrResult) => string | null, score: (pass: GameScreenOcrResult) => number): string | null =>
		[...passes].sort((a, b) => score(b) - score(a)).map(get).find((value): value is string => value != null) ?? null;
	const species = selectName((pass) => pass.species, (pass) => pass.confidence.species);
	const stats = STAT_KEYS.map((key, index) => {
		const best = [...passes].sort((a, b) => {
			const aStat = a.stats[index];
			const bStat = b.stats[index];
			return statConsistency(bStat, data.baseStats?.[index]) - statConsistency(aStat, data.baseStats?.[index])
				|| Number(bStat.actual != null) - Number(aStat.actual != null)
				|| Number(bStat.ev != null) - Number(aStat.ev != null)
				|| b.confidence.stats[key] - a.confidence.stats[key];
		})[0].stats[index];
		return { key, actual: best.actual, ev: best.ev, verified: null };
	});
	const nature = inferNature(data.baseStats, stats);
	for (const stat of stats) stat.verified = nature.verified.get(stat.key) ?? null;
	const countMoves = (pass: GameScreenOcrResult) => pass.moves.filter((move) => move != null).length;
	const sumMoveScores = (pass: GameScreenOcrResult) => pass.confidence.moves.reduce((sum, score) => sum + score, 0);
	const anchor = [...passes].sort((a, b) => countMoves(b) - countMoves(a) || sumMoveScores(b) - sumMoveScores(a))[0];
	const moves: Array<string | null> = anchor.moves.filter((move): move is string => move != null);
	for (const pass of passes) {
		for (const move of pass.moves) {
			if (!move || moves.length >= 4) continue;
			// 別パスで「かみなりパンチ」が「かみなり」に化けた場合など、既存のわざ名を含む/含まれる名前は同一とみなす。
			const duplicate = moves.some((known) => known != null && (known.includes(move) || move.includes(known)));
			if (!duplicate) moves.push(move);
		}
	}
	while (moves.length < 4) moves.push(null);
	const ability = selectName((pass) => pass.ability, (pass) => pass.confidence.ability);
	return { species, nature: nature.nature, stats, moves, ability, confidence: passes[0].confidence };
}

/** 登録済みポケモンとの同一判定に使う最小限の項目(owned_pokemon の列名に合わせる)。 */
export interface OwnedPokemonLike {
	species_name: string;
	nature: string | null;
	ability_name: string | null;
	evs: number[];
	move_names: string[];
}

/**
 * OCR結果が登録済みのポケモンと同一個体とみなせるか。
 * 種族・性格・努力値6値・わざ(順不同)が一致すれば同一。特性は両方読めているときだけ比較する
 * (特性の読み取りは落ちやすく、null で不一致扱いにすると再登録されてしまうため)。
 * わざは4つとも読めていることを条件にし、1つでも欠けていれば別個体の可能性を残して一致させない。
 */
export function isSameOwnedPokemon(result: GameScreenOcrResult, owned: OwnedPokemonLike): boolean {
	if (!result.species || result.species !== owned.species_name) return false;
	if (result.nature !== (owned.nature ?? "")) return false;
	// 読めなかった努力値はフォームに入れず 0 のまま保存されるので、比較でも 0 として扱う(前回の保存値と揃える)
	if (result.stats.some((stat, index) => (stat.ev ?? 0) !== (owned.evs[index] ?? 0))) return false;
	const moves = result.moves.filter((move): move is string => move !== null);
	if (moves.length !== 4) return false;
	const ownedMoves = owned.move_names.filter((move) => move !== "");
	if (ownedMoves.length !== 4 || [...moves].sort().join("/") !== [...ownedMoves].sort().join("/")) return false;
	if (result.ability && owned.ability_name && result.ability !== owned.ability_name) return false;
	return true;
}
