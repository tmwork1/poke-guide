// damage-calc.ts の `if (opponentNotesSection) { ... }` ブロック(約2,800行)に閉じていた
// 純粋関数のうち、クロージャの状態(rows / ownedPokemonId / 各種WeakMap など)を一切
// 参照していないものをここへ切り出したもの。
//
// 【なぜ切り出すか】
// あのブロックの中身は外から参照もテストもできないため、同じロジックが他所へコピペ
// される温床になっていた(ランクピッカーが damage-calc-page/control-panel.ts へ丸ごと
// 複製されていたのが実例)。ここに出しておけば import で共有でき、node --test でも
// 直接テストできる。
//
// 【このファイルの制約】
// DOM操作を伴う setResultVerdict / setResultPlain 以外は DOM・fetch・Node API に
// 依存しないこと。damage-calc.ts を import してはいけない(循環参照になる)。
// pyodide-engine.ts からは型だけを借りる(値をimportすると計算エンジン一式を
// 引き込んでしまう。damage-summary.ts 冒頭コメントと同じ理由)。

import type { LethalResult } from "../pyodide-engine";
import type { OpponentClientResultInput } from "../opponent-notes-validation";
import { STAT_KEYS, type StatKey } from "../stats";
import { MAX_STANDALONE_ATTACKS, TEN_OR_MORE_LABEL } from "../damage-summary";

/** 確N判定の重み。severity-bar[data-severity](global.css)の値と対応する。 */
export type DamageSeverity = "lethal" | "risky" | "safe" | "none";

export interface DamageVerdict {
	label: string;
	severity: DamageSeverity;
}

/** 能力値キー -> 表示用の1文字(H/A/B/C/D/S)。 */
export const STAT_KANJI: Record<string, string> = { hp: "H", atk: "A", def: "B", spa: "C", spd: "D", spe: "S" };

/** 乱数シード入力欄の値。空欄・数値でない入力は「指定なし」(undefined)にする。 */
export function parseSeed(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const n = Number(trimmed);
	return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** オブジェクトのキー順に依存しないJSON文字列。計算入力が変わったかの比較に使う。 */
export function canonicalStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(",")}}`;
}

/**
 * 旧形式(6要素のboosts配列)から、技カード1枚ぶんのランク補正を1つの数値に畳む。
 * 物理ならA(無ければC)、防御側なら B(無ければD)という優先順位。
 */
export function rankFromLegacyBoosts(boosts: number[] | undefined, primaryKey: StatKey, secondaryKey: StatKey): number {
	if (!Array.isArray(boosts)) return 0;
	const primary = boosts[STAT_KEYS.indexOf(primaryKey)] ?? 0;
	if (primary !== 0) return primary;
	return boosts[STAT_KEYS.indexOf(secondaryKey)] ?? 0;
}

/** 技1発ぶんのダメージ幅。「min〜max (min%〜max%)」の形にする。 */
export function formatDamageRange(damages: number[] | undefined, defenderHp: number | undefined): string {
	if (!damages || damages.length === 0) return "";
	const min = Math.min(...damages);
	const max = Math.max(...damages);
	const range = min === max ? `${min}` : `${min}〜${max}`;
	if (defenderHp && defenderHp > 0) {
		const pctMinText = ((min / defenderHp) * 100).toFixed(1);
		const pctMaxText = ((max / defenderHp) * 100).toFixed(1);
		const pct = pctMinText === pctMaxText ? `${pctMinText}%` : `${pctMinText}〜${pctMaxText}%`;
		return `${range} (${pct})`;
	}
	return range;
}

/** 全乱数分岐が致死になる最小の攻撃回数(=確定数)。無ければ null。 */
export function computeConfirmedKillAttackCount(result: OpponentClientResultInput | null): number | null {
	if (!result || !Array.isArray(result.lethal)) return null;
	const confirmed = result.lethal.find((l) => l.probability >= 0.9999);
	return confirmed ? confirmed.attackCount : null;
}

/** エンジンが返す確定数系列から「確N」「乱N xx.xx%」のラベルを作る。 */
export function describeSeriesVerdict(series: LethalResult[] | undefined, noLethalLabel: string): DamageVerdict {
	if (!Array.isArray(series) || series.length === 0) return { label: "-", severity: "none" };
	const firstLethal = series.find((l) => l.probability > 0);
	if (!firstLethal) return { label: noLethalLabel, severity: "safe" };
	const severity: "lethal" | "risky" | "safe" =
		firstLethal.attackCount === 1 ? "lethal" : firstLethal.attackCount === 2 ? "risky" : "safe";
	if (firstLethal.probability >= 0.9999) return { label: `確${firstLethal.attackCount}`, severity };
	return { label: `乱${firstLethal.attackCount} ${(firstLethal.probability * 100).toFixed(2)}%`, severity };
}

/**
 * 技1つを最大MAX_STANDALONE_ATTACKS回連発したときの確定数。
 * describeSeriesVerdictと同じく、「一部の乱数分岐だけが致死する(zero > 0だが
 * zero !== total)」段階では確定と言えないため、全分岐が致死(zero === total)に
 * なるまで確定数として採用しない。
 */
export function describeStandaloneLethal(damages: number[] | undefined, defenderHp: number | undefined): DamageVerdict {
	if (!damages || damages.length === 0 || !defenderHp || defenderHp <= 0) {
		return { label: "-", severity: "none" };
	}
	let dist = new Map<number, number>([[defenderHp, 1]]);
	for (let attack = 1; attack <= MAX_STANDALONE_ATTACKS; attack += 1) {
		const next = new Map<number, number>();
		for (const [remain, freq] of dist) {
			for (const d of damages) {
				const value = Math.max(0, remain - d);
				next.set(value, (next.get(value) ?? 0) + freq);
			}
		}
		dist = next;
		let total = 0;
		for (const freq of dist.values()) total += freq;
		const zero = dist.get(0) ?? 0;
		if (total > 0 && zero === total) {
			const severity: "lethal" | "risky" | "safe" =
				attack === 1 ? "lethal" : attack === 2 ? "risky" : "safe";
			return { label: `確${attack}`, severity };
		}
	}
	// 10発当てても全分岐が致死に至らない = 実質的に倒せない組み合わせ。
	return { label: TEN_OR_MORE_LABEL, severity: "safe" };
}

/**
 * 技列を繰り返し当て続けた場合の確定数ラベル。
 * validAttackCount は技名が設定済みの攻撃列の件数(呼び出し側が数えて渡す)。
 */
export function describeExtendedTotalNoLethalLabel(
	validAttackCount: number,
	result: OpponentClientResultInput,
): string {
	// 有効な攻撃列が1件だけの行は、エンジンが返す perAttackLethal[0](その技を
	// 最大10回連発した場合の厳密な確定数系列。たべのこし等のターン終了時処理も
	// 反映済み)がそのまま「攻撃列を繰り返し当て続けた場合」と一致するため、
	// 下の近似計算より優先して使う(技列側の表示と数値が食い違わないようにする)。
	if (validAttackCount === 1 && Array.isArray(result.perAttackLethal?.[0])) {
		return describeSeriesVerdict(result.perAttackLethal[0], TEN_OR_MORE_LABEL).label;
	}
	const per = result.perAttackDamages;
	const hp = result.defenderHp;
	if (!Array.isArray(per) || per.length === 0 || !hp || hp <= 0) {
		return TEN_OR_MORE_LABEL;
	}
	const extendedSeries: LethalResult[] = [];
	let dist = new Map<number, number>([[hp, 1]]);
	for (let attack = 1; attack <= MAX_STANDALONE_ATTACKS; attack += 1) {
		const damages = per[(attack - 1) % per.length];
		if (!Array.isArray(damages) || damages.length === 0) continue;
		const next = new Map<number, number>();
		for (const [remain, freq] of dist) {
			for (const d of damages) {
				const value = Math.max(0, remain - d);
				next.set(value, (next.get(value) ?? 0) + freq);
			}
		}
		dist = next;
		let total = 0;
		for (const freq of dist.values()) total += freq;
		const zero = dist.get(0) ?? 0;
		extendedSeries.push({ attackCount: attack, probability: total > 0 ? zero / total : 0 });
	}
	return describeSeriesVerdict(extendedSeries, TEN_OR_MORE_LABEL).label;
}

/** 能力値見出しのクリックで巡回する性格補正の、表示記号と読み上げ文。 */
export function describeNatureCycleState(
	key: StatKey,
	mod: "up" | "down" | null,
): { indicator: string; description: string } {
	const kanji = STAT_KANJI[key];
	if (mod === "up") {
		return { indicator: "▲", description: `相手の${kanji}は性格補正で上昇中です(クリックで下降に切り替え)` };
	}
	if (mod === "down") {
		return { indicator: "▼", description: `相手の${kanji}は性格補正で下降中です(クリックで無補正に戻します)` };
	}
	return { indicator: "", description: `相手の${kanji}は性格補正なしです(クリックで上昇に設定します)` };
}

/**
 * 結果セルへ「確N」+ ダメージ量を書き込む。
 * ラベルがTEN_OR_MORE_LABEL(="10発以上")のときは確定数ラベル自体を出さない
 * (太字の確定数ラベルとしては意味を持たないため。detailSpanのみ残す)。
 */
export function setResultVerdict(el: HTMLElement, detailText: string, label: string): void {
	el.innerHTML = "";
	if (label !== TEN_OR_MORE_LABEL) {
		const verdictSpan = document.createElement("span");
		verdictSpan.className = "damage-result-verdict";
		const randomKoParts = label.match(/^(乱\d+) (\d+\.\d+%)$/);
		if (randomKoParts) {
			verdictSpan.append(randomKoParts[1], " ");
			const probabilitySpan = document.createElement("span");
			probabilitySpan.className = "damage-result-probability";
			probabilitySpan.textContent = randomKoParts[2];
			verdictSpan.appendChild(probabilitySpan);
		} else {
			verdictSpan.textContent = label;
		}
		el.appendChild(verdictSpan);
	}
	if (detailText !== "") {
		const detailSpan = document.createElement("span");
		detailSpan.className = "damage-result-detail";
		detailSpan.textContent = detailText;
		el.appendChild(detailSpan);
	}
}

/** 結果セルへ、確定数ラベルを持たない素のテキストを書き込む。 */
export function setResultPlain(el: HTMLElement, text: string): void {
	el.innerHTML = "";
	el.textContent = text;
}
