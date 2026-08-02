// 個体編集画面(/box/[id])のステータス表 H・B・D 行に付く「調整」ボタンの計算ロジック(純粋関数)。
//
// ⚠️ このファイルはDOMに一切触れない(documentを使わない)。UI(ボタンの表示・クリック・
// 一覧の表示・適用)は別エージェントが LeftPanel.astro / left-panel.ts / right-panel.ts で
// 実装する。ここは「残りの努力値をH/B/Dに配って、指定の耐久指数を最大化する候補を
// 求める」計算だけを担当する。Pyodide/jpokeは使わない(実数値だけで計算できるため)。
//
// 【3種類の指数】
//   total(総合耐久指数)   = H*B*D/(B+D)
//   physical(物理耐久指数) = H*B
//   special(特殊耐久指数)  = H*D
// いずれも実数値(努力値ではない)で計算する。
//
// 【予算の考え方】
// 予算は「残りの努力値」だけ(remaining = 66 - 現在の6つの努力値の合計)。現在の
// H/B/Dは減らさず、その上に残りを配る(白紙に戻して配り直すのではない)。各努力値の
// 上限は32(チャンピオンズルール、現在値+配分<=32)。
//
// 【全探索で足りる理由】
// 残りをH/B/Dの3つに配る組み合わせは高々 C(66+2,2) ≒ 2300通り(実際は32上限の
// クランプでさらに減る)。Pyodideを使わない純JS計算のため全探索で一瞬で終わる
// (bulk-adjust-solver.tsのような単調性を使った枝刈りは不要)。
//
// 【集約(実数値が同一の候補を1件にまとめる)方針】
// 努力値の0〜32スケールは1段が必ず実数値+1に対応するわけではない(4刻みで実数値が
// 上がる場所とそうでない場所がある)。そのため異なる配分でも実数値が完全に一致する
// 候補が多数生まれ、そのまま並べると上位10件が同じ内容で埋まってしまう。実数値
// (H,B,D)の3つ組をキーにグルーピングし、配った合計努力値(addedEvTotal)が最小の
// ものを代表にする(努力値を無駄遣いしない配分を優先する)。
//
// 【「変更前の配分」を必ず候補に含める理由】
// 呼び出し側はbestを即座に適用する=即座にDBへ保存される設計のため、一覧が
// アンドゥ手段を兼ねる(設計アドバイザーの指摘)。現在の配分(addH=addB=addD=0)は
// 全探索に自然に含まれる1点なので、特別扱いせず isCurrent フラグだけで識別する。

import { NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from "../stats";

export type DurabilityIndexKind = "total" | "physical" | "special";

export interface DurabilityIndexCandidate {
	/** この候補の H/B/D 努力値(現在値 + 配分後の最終値) */
	evs: { hp: number; def: number; spd: number };
	/** その努力値での実数値 */
	realStats: { hp: number; def: number; spd: number };
	/** 指数の値 */
	index: number;
	/** 残りから実際に配った合計(0 なら「変更前の配分」) */
	addedEvTotal: number;
	/** 変更前の配分(何も配っていない状態)か */
	isCurrent: boolean;
}

export interface MaximizeOptions {
	kind: DurabilityIndexKind;
	/** 自分の種族値 [H,A,B,C,D,S] */
	baseStats: number[];
	/** 現在の努力値 [H,A,B,C,D,S](0〜32スケール) */
	currentEvs: number[];
	/** 性格名(例 "いじっぱり")。B/Dの補正にのみ使う */
	nature: string;
	/** 返す候補の最大件数(既定 10) */
	limit?: number;
}

export interface MaximizeResult {
	/** 指数が最大の候補(呼び出し側が即座に適用する) */
	best: DurabilityIndexCandidate;
	/** 指数の大きい順。best を先頭に含む。実数値が同一の候補は集約済み */
	candidates: DurabilityIndexCandidate[];
	/** 配れる残りの努力値(66 - 現在の合計)。0以下なら配る余地が無い */
	remaining: number;
}

const LEVEL = 50;
const IV = 31;
const EV_CAP = 32; // チャンピオンズルール: 各努力値の上限
const EV_TOTAL_CAP = 66; // チャンピオンズルール: 6努力値の合計上限
const DEFAULT_LIMIT = 10;

// STAT_KEYS([HP, atk, def, spa, spd, spe])上のインデックス。box-id配下の他ファイル
// (bulk-adjust-solver.ts等)と同じ並び順(baseStats/currentEvsは[H,A,B,C,D,S])に合わせる。
const IDX_HP = 0;
const IDX_DEF = 2;
const IDX_SPD = 4;

/**
 * 性格名からB(def)・D(spd)の実数値補正倍率を求める。
 * up==="def"なら1.1、down==="def"なら0.9、それ以外1.0(Dも同様)。
 * 未知の性格名(呼び出し側の入力ミス等)が来ても壊れないよう、該当なしは
 * 補正なし(1.0/1.0)として扱う(防御的)。
 */
function natureMultipliers(nature: string): { defMul: number; spdMul: number } {
	const modifier = NATURE_STAT_MODIFIERS[nature];
	if (!modifier) return { defMul: 1.0, spdMul: 1.0 };
	const defMul = modifier.up === "def" ? 1.1 : modifier.down === "def" ? 0.9 : 1.0;
	const spdMul = modifier.up === "spd" ? 1.1 : modifier.down === "spd" ? 0.9 : 1.0;
	return { defMul, spdMul };
}

/**
 * 指数を計算する。total(H*B*D/(B+D))はB+Dが0になるケースは実質無いが、
 * 防御的に0除算を避ける(0を返す。壊れないことを優先する)。
 */
function computeIndex(kind: DurabilityIndexKind, hp: number, def: number, spd: number): number {
	switch (kind) {
		case "total": {
			const denom = def + spd;
			return denom === 0 ? 0 : (hp * def * spd) / denom;
		}
		case "physical":
			return hp * def;
		case "special":
			return hp * spd;
	}
}

/**
 * 候補の並び順を決める比較関数(降順ソート用、a-bの符号がそのままsortに渡せる形)。
 * 第1キー: 指数の降順。
 * 第2キー(同値時の安定した順序): 配った合計努力値の昇順(努力値を無駄遣いしない
 * 配分を優先)。
 * 第3キー: H,B,Dの努力値の昇順(実行ごとに順序がぶれないようにするための最終タイブレーク)。
 */
function compareCandidates(a: DurabilityIndexCandidate, b: DurabilityIndexCandidate): number {
	if (a.index !== b.index) return b.index - a.index;
	if (a.addedEvTotal !== b.addedEvTotal) return a.addedEvTotal - b.addedEvTotal;
	if (a.evs.hp !== b.evs.hp) return a.evs.hp - b.evs.hp;
	if (a.evs.def !== b.evs.def) return a.evs.def - b.evs.def;
	return a.evs.spd - b.evs.spd;
}

/** 現在の配分(何も配らない状態)の候補を作る。remaining<=0のときや、全探索の基点として使う。 */
function buildCurrentCandidate(
	kind: DurabilityIndexKind,
	baseStats: number[],
	currentEvs: number[],
	defMul: number,
	spdMul: number,
): DurabilityIndexCandidate {
	const hp = calcHpStat(LEVEL, baseStats[IDX_HP], IV, currentEvs[IDX_HP]);
	const def = calcOtherStat(LEVEL, baseStats[IDX_DEF], IV, currentEvs[IDX_DEF], defMul);
	const spd = calcOtherStat(LEVEL, baseStats[IDX_SPD], IV, currentEvs[IDX_SPD], spdMul);
	return {
		evs: { hp: currentEvs[IDX_HP], def: currentEvs[IDX_DEF], spd: currentEvs[IDX_SPD] },
		realStats: { hp, def, spd },
		index: computeIndex(kind, hp, def, spd),
		addedEvTotal: 0,
		isCurrent: true,
	};
}

export function maximizeDurabilityIndex(options: MaximizeOptions): MaximizeResult {
	const { kind, baseStats, currentEvs, nature } = options;
	const limit = options.limit ?? DEFAULT_LIMIT;
	const { defMul, spdMul } = natureMultipliers(nature);

	const currentTotal = currentEvs.reduce((sum, v) => sum + v, 0);
	const remaining = EV_TOTAL_CAP - currentTotal;

	const currentCandidate = buildCurrentCandidate(kind, baseStats, currentEvs, defMul, spdMul);

	// remaining<=0(既に66使い切っている、または想定外の入力で超過している)ときは
	// 配る余地が無いので、「変更前の配分」1件だけを返す(例外を投げない)。
	if (remaining <= 0) {
		return { best: currentCandidate, candidates: [currentCandidate], remaining };
	}

	const capH = EV_CAP - currentEvs[IDX_HP];
	const capB = EV_CAP - currentEvs[IDX_DEF];
	const capD = EV_CAP - currentEvs[IDX_SPD];

	// 実数値(H,B,D)の3つ組をキーに、配った合計努力値が最小の候補だけを残す(集約)。
	const bestByRealStatKey = new Map<string, DurabilityIndexCandidate>();

	for (let addH = 0; addH <= Math.min(capH, remaining); addH++) {
		const remainingAfterH = remaining - addH;
		const capBForH = Math.min(capB, remainingAfterH);
		for (let addB = 0; addB <= capBForH; addB++) {
			const remainingAfterHB = remainingAfterH - addB;
			const capDForHB = Math.min(capD, remainingAfterHB);
			for (let addD = 0; addD <= capDForHB; addD++) {
				const finalH = currentEvs[IDX_HP] + addH;
				const finalB = currentEvs[IDX_DEF] + addB;
				const finalD = currentEvs[IDX_SPD] + addD;

				const hp = calcHpStat(LEVEL, baseStats[IDX_HP], IV, finalH);
				const def = calcOtherStat(LEVEL, baseStats[IDX_DEF], IV, finalB, defMul);
				const spd = calcOtherStat(LEVEL, baseStats[IDX_SPD], IV, finalD, spdMul);

				const candidate: DurabilityIndexCandidate = {
					evs: { hp: finalH, def: finalB, spd: finalD },
					realStats: { hp, def, spd },
					index: computeIndex(kind, hp, def, spd),
					addedEvTotal: addH + addB + addD,
					isCurrent: addH === 0 && addB === 0 && addD === 0,
				};

				const key = `${hp},${def},${spd}`;
				const existing = bestByRealStatKey.get(key);
				if (!existing || candidate.addedEvTotal < existing.addedEvTotal) {
					bestByRealStatKey.set(key, candidate);
				}
			}
		}
	}

	const sorted = Array.from(bestByRealStatKey.values()).sort(compareCandidates);
	const best = sorted[0];

	// 上位limit件を指数順に採用しつつ、「変更前の配分」(isCurrent)が漏れていたら
	// 必ず含める(bestを即座に適用する仕様のため、この一覧がアンドゥ手段を兼ねる)。
	// limitが極端に小さい(1など)場合を除き、best・currentの両方が候補に残る。
	let candidates = sorted.slice(0, limit);
	if (!candidates.some((c) => c.isCurrent)) {
		const current = sorted.find((c) => c.isCurrent);
		if (current) {
			candidates = [...sorted.slice(0, Math.max(0, limit - 1)), current].sort(compareCandidates);
		}
	}

	return { best, candidates, remaining };
}
