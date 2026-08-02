// 個体編集画面(/box/[id])「耐久調整」機能のソルバー(純粋なロジック)。
//
// ⚠️ このファイルはDOMに一切触れない(documentを使わない)。UI(ポップアップの表示・
// クリック・入力)は別エージェントが src/pages/box/[id].astro / BulkAdjustDialog.astro /
// bulk-adjust.ts で実装する。ここは「防御ダメージ計算カード群を、N発をM%以上の確率で
// 耐えられる性格+努力値(H/B/D)の組み合わせに変換する」計算だけを担当する。
//
// 【なぜ全探索が成立しないか】
// 性格25種 × 努力値H/B/D(Champions形式0〜32、各33通り) = 25 × 33^3 ≒ 89万通り。
// calcLethalSequence() 1回の実測所要時間は約20ms(Coordinator計測、3発の技列・
// Pyodideウォームアップ後)のため、全探索は約5時間かかり絶対に成立しない。
// 以下の性質を使って探索空間を数百コールまで圧縮する。
//
// 【性質1: 単調性】
// 耐える確率はHP実数値・B実数値・D実数値それぞれについて単調非減少(硬いほど・HPが
// 多いほど耐えやすい)。そのため「条件を満たす最小の努力値」の境界だけを二分探索/
// 二方向ポインタで求めればよく、境界より上は全て合格になる。
//
// 【性質2: 性格は(B倍率,D倍率)の組でしか耐久判定に効かない】
// 25性格のうちB/D以外の上昇/下降(攻撃・特攻・素早さ)は、防御側であるこのポケモン
// 自身の「耐える確率」には影響しない(このポケモンは技を撃たないため)。B/D倍率は
// 0.9/1.0/1.1の3通りしかなく、上昇と下降が同じ実数値に同時に掛かることは無いため
// (B/D)倍率の組み合わせは (1,1)(1.1,1)(1,1.1)(0.9,1)(1,0.9)(1.1,0.9)(0.9,1.1) の
// 7通りに畳み込める(natureMultipliers()参照)。判定は7クラスぶんだけ行い、結果を
// 各クラスに属する性格名へ展開する。
//
// 【例外: パラドックス系】自分側が「こだいかっせい」「クォークチャージ」持ち、または
// 「ブーストエナジー」持ちの場合、実際に発動する能力上昇は「6実数値のうち最大のもの」
// で決まる。攻撃/特攻/素早さの実数値は性格の上昇/下降で変わり得る(努力値は固定でも
// 性格ごとに実数値は変わる)ため、同じ(B倍率,D倍率)クラスでも性格によって発動対象が
// 変わり結果が変わり得る。この場合は7クラスへ畳み込まず25性格を個別に評価する
// (detectParadoxAbility参照。遅くなるため onProgress の phase でその旨を伝える)。
//
// 【性質3: B/Dの分離】多くのカードは物理のみ/特殊のみの技で構成され、耐久判定は
// B・Dの片方にしか依存しない。依存の有無は技名から物理/特殊を引く表を使わず、実測で
// 判定する(壁・特性・テラスタル等で実効の物理/特殊が変わるため、実測の方が確実)。
// 各カードについてB(またはD)を最小/最大にした2通りをcalcLethalSequence()で計算し、
// perAttackDamages/cumulativeDamageが変わるかを見る(probeDependency参照)。
// 全カードが「Bのみ」「Dのみ」に分類できれば、minB(H)とminD(H)は独立に二方向ポインタ
// (性質5)で求まる。1枚のカードの中に物理技と特殊技が混在する等、両方に依存するカードが
// 1つでもあれば、そのクラスの探索全体をHP×Bの2次元走査にフォールバックする
// (solveClassFallback参照。コストが跳ね上がるため onProgress・signal中断に対応する)。
//
// 【性質4: 実数値キャッシュ】判定結果は (rowId, HP実数値, B実数値, D実数値) をキーに
// メモ化する。努力値が異なっても実数値が同じなら同じ結果になるため、性格クラスを
// またいでも再利用できる。ただし(B倍率,D倍率)が異なれば同じ努力値でも実数値の
// 進み方(努力値→実数値の対応)が変わるため、後述のとおりB/Dの二方向ポインタ探索
// 自体は「(B倍率,D倍率)クラス」ではなく「distinctなB倍率/D倍率」単位(通常時は3+3=6回)
// で行い、7クラスへは事後に配列参照だけで合成する(エンジン呼び出しを7回→6回相当に
// 抑える。パラドックス例外時はこの共有ができないため25性格それぞれで独立に行う)。
//
// 【性質5: 二方向ポインタ】HP努力値を昇順に走査しながら、必要な最小B(またはD)努力値を
// 単調に下げていく(下げるだけで上げ直さない)ことで、1回の探索全体がO(HP数+B数)で
// 済む(HPごとに毎回二分探索し直さない)。twoPointerMinByH参照。
//
// 【候補の展開方針】各(性格, H努力値)につき、条件を満たす最小の(B, D)の1点だけを
// 返す(合計努力値が最小の代表点)。それより大きいB/Dの組み合わせも条件を満たすが、
// 全部返すと膨大になるため含めない。この方針により「searchedEvTotal昇順の一覧」が
// 意味を持つ(候補を上から採用すれば必ず努力値効率の良い順になる)。

import { calcLethalSequence } from "../pyodide-engine";
import type { CalcLethalSequenceResult, PokemonSpec, SequenceAttack } from "../pyodide-engine";
import { NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from "../stats";

/** カード1枚ぶんの耐久要件 */
export interface DurabilityRequirement {
	rowId: string;
	/** 相手(攻撃側)のspec。BulkAdjustRowSnapshot.attackerSpec をそのまま渡す */
	attackerSpec: PokemonSpec;
	/** 技列。BulkAdjustRowSnapshot.attacks(=recalcRowのsafeAttacks)をそのまま渡す */
	attacks: SequenceAttack[];
	seed?: number;
	/** 何発耐えるか(1以上の整数) */
	n: number;
	/** 耐える確率の下限(%)。0 < m <= 100 */
	m: number;
}

export interface SolveOptions {
	/** 自分の種族値 [H,A,B,C,D,S] */
	baseStats: number[];
	/** 固定する努力値(現在値)。探索対象外 */
	fixedEvs: { atk: number; spa: number; spe: number };
	/** 性格名と努力値配列[H,A,B,C,D,S]から自分側のPokemonSpecを作る(UI側が buildAttackerSpec をラップして渡す) */
	buildDefenderSpec: (nature: string, evs: number[]) => PokemonSpec;
	/** 進捗通知。engine呼び出しのたびに呼ぶ必要はなく、適度に間引いてよい */
	onProgress?: (info: { done: number; total: number; phase: string }) => void;
	/** 中断用 */
	signal?: AbortSignal;
	/** 返す候補の上限(既定 300)。打ち切ったら truncated: true にする */
	maxCandidates?: number;
}

export interface DurabilityCandidate {
	nature: string;
	evs: { hp: number; def: number; spd: number };
	/** H+B+D(探索した3つの合計)。並び替えのキー */
	searchedEvTotal: number;
	/** A/C/Sの固定分も含めた総合計 */
	totalEv: number;
	/** その組み合わせでの実数値 */
	realStats: { hp: number; def: number; spd: number };
	/** totalEv > 66 か(チャンピオンズルールの上限超過。除外はしないが明示する) */
	exceedsChampionsCap: boolean;
}

export interface SolveResult {
	/** searchedEvTotal の昇順。同値なら安定した順序で */
	candidates: DurabilityCandidate[];
	/** 実際に走らせたエンジン呼び出し回数(性能検証用) */
	engineCallCount: number;
	/** maxCandidates で打ち切ったか */
	truncated: boolean;
	/** 条件を満たす組み合わせが1つも無かったか */
	infeasible: boolean;
}

const DEFAULT_MAX_CANDIDATES = 300;
const LEVEL = 50;
const IV = 31;
const MAX_EV = 32;

// パラドックス系の例外(コメント冒頭「例外」参照)。この2特性/この道具を自分側が
// 持つ場合、A/C/Sの実数値差(=性格差)でも発動対象が変わり結果が変わり得るため、
// 25性格を個別に評価する。
const PARADOX_ABILITIES = new Set(["こだいかっせい", "クォークチャージ"]);
const PARADOX_ITEM = "ブーストエナジー";

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** attacks を先頭から繰り返して長さnの配列にする(累計に対してNを指定する、というユーザー指示の解釈)。 */
function expandAttacksToN(attacks: SequenceAttack[], n: number): SequenceAttack[] {
	const result: SequenceAttack[] = [];
	for (let i = 0; i < n; i++) {
		result.push(attacks[i % attacks.length]);
	}
	return result;
}

/**
 * calcLethalSequence() の戻り値からN発目時点の致死率を取り出す。
 * ⚠️ lethal は確率が100%に達した時点で打ち切られ attacks より短くなり得る
 * (pyodide-engine.ts:223-241)。lethal.length < n のときは「途中で確定致死になった」
 * = 致死率1.0として扱う(lethal[n-1]は単純に読むとundefinedになるため)。
 */
function lethalProbabilityAtN(result: CalcLethalSequenceResult, n: number): number {
	if (result.lethal.length >= n) return result.lethal[n - 1].probability;
	return 1.0;
}

/** 性格名から(B倍率,D倍率)を求める。NATURE_STAT_MODIFIERSのup/downがdef/spdかどうかだけを見る。 */
function natureMultipliers(nature: string): { bMult: number; dMult: number } {
	const mod = NATURE_STAT_MODIFIERS[nature] ?? { up: null, down: null };
	const bMult = mod.up === "def" ? 1.1 : mod.down === "def" ? 0.9 : 1.0;
	const dMult = mod.up === "spd" ? 1.1 : mod.down === "spd" ? 0.9 : 1.0;
	return { bMult, dMult };
}

interface NatureClassGroup {
	/** このクラスに属する性格名一覧(候補展開用) */
	natures: string[];
	/** エンジン呼び出しに使う代表性格 */
	representative: string;
	bMult: number;
	dMult: number;
}

/**
 * 25性格を(B倍率,D倍率)でグルーピングする。パラドックス例外時は1性格=1クラスにする
 * (性質2の例外。コメント冒頭参照)。非例外時は必ず7クラスになる(up/downがdefと
 * spdへ同時に掛かることは無いため、9通り中7通りしか実現しない)。
 */
function buildNatureClasses(paradoxException: boolean): NatureClassGroup[] {
	const allNatures = Object.keys(NATURE_STAT_MODIFIERS);
	if (paradoxException) {
		return allNatures.map((n) => {
			const { bMult, dMult } = natureMultipliers(n);
			return { natures: [n], representative: n, bMult, dMult };
		});
	}
	const map = new Map<string, NatureClassGroup>();
	for (const n of allNatures) {
		const { bMult, dMult } = natureMultipliers(n);
		const key = `${bMult}:${dMult}`;
		let group = map.get(key);
		if (!group) {
			group = { natures: [], representative: n, bMult, dMult };
			map.set(key, group);
		}
		group.natures.push(n);
	}
	return [...map.values()];
}

/**
 * 自分側のspecが「こだいかっせい」「クォークチャージ」を特性として持つか、
 * 「ブーストエナジー」を持ち物として持つかを判定する。性格・努力値は結果に影響しない
 * フィールド(abilityName/itemName)だけを見るため、ダミー値で1回specを組み立てて確認する。
 */
function detectParadoxException(buildDefenderSpec: SolveOptions["buildDefenderSpec"]): boolean {
	const spec = buildDefenderSpec("まじめ", [0, 0, 0, 0, 0, 0]);
	if (spec.abilityName && PARADOX_ABILITIES.has(spec.abilityName)) return true;
	if (spec.itemName === PARADOX_ITEM) return true;
	return false;
}

function sameOutcome(a: CalcLethalSequenceResult, b: CalcLethalSequenceResult): boolean {
	if (a.cumulativeDamage.min !== b.cumulativeDamage.min || a.cumulativeDamage.max !== b.cumulativeDamage.max) {
		return false;
	}
	if (a.perAttackDamages.length !== b.perAttackDamages.length) return false;
	for (let i = 0; i < a.perAttackDamages.length; i++) {
		const x = a.perAttackDamages[i];
		const y = b.perAttackDamages[i];
		if (x.length !== y.length) return false;
		for (let j = 0; j < x.length; j++) {
			if (x[j] !== y[j]) return false;
		}
	}
	return true;
}

export async function solveDurability(
	requirements: DurabilityRequirement[],
	options: SolveOptions,
): Promise<SolveResult> {
	const { baseStats, fixedEvs, buildDefenderSpec, onProgress, signal, maxCandidates = DEFAULT_MAX_CANDIDATES } = options;

	let engineCallCount = 0;
	let lastProgressAt = 0;
	function reportProgress(done: number, total: number, phase: string): void {
		if (!onProgress) return;
		const now = Date.now();
		// 数十msに1回程度、または完了時のみ通知する(呼びすぎ防止)。
		if (done >= total || now - lastProgressAt >= 50) {
			lastProgressAt = now;
			onProgress({ done, total, phase });
		}
	}

	// (rowId, 性格クラスキー, HP実数値, B実数値, D実数値) -> 耐えるか(合否)。
	// 性質4のとおり、性格クラスキーは非パラドックス時は(B倍率,D倍率)を表す文字列、
	// パラドックス例外時は性格名そのもの(A/C/Sの実数値差で結果が変わり得るため
	// 実数値だけでは同一視できない)。
	const passCache = new Map<string, boolean>();

	async function requirementPasses(
		req: DurabilityRequirement,
		nature: string,
		natureCacheKey: string,
		evH: number,
		evB: number,
		evD: number,
	): Promise<boolean> {
		const mods = natureMultipliers(nature);
		const hp = calcHpStat(LEVEL, baseStats[0], IV, evH);
		const def = calcOtherStat(LEVEL, baseStats[2], IV, evB, mods.bMult);
		const spd = calcOtherStat(LEVEL, baseStats[4], IV, evD, mods.dMult);
		const cacheKey = `${req.rowId}|${natureCacheKey}|${hp}|${def}|${spd}`;
		const cached = passCache.get(cacheKey);
		if (cached !== undefined) return cached;

		checkAborted(signal);
		const evs = [evH, fixedEvs.atk, evB, fixedEvs.spa, evD, fixedEvs.spe];
		const defenderSpec = buildDefenderSpec(nature, evs);
		const attacksN = expandAttacksToN(req.attacks, req.n);
		engineCallCount++;
		const result = await calcLethalSequence(req.attackerSpec, defenderSpec, attacksN, { seed: req.seed });
		const lethal = lethalProbabilityAtN(result, req.n);
		const surviveProbability = 1 - lethal;
		const pass = surviveProbability >= req.m / 100 - 1e-9;
		passCache.set(cacheKey, pass);
		return pass;
	}

	async function allPass(
		reqs: DurabilityRequirement[],
		nature: string,
		natureCacheKey: string,
		evH: number,
		evB: number,
		evD: number,
	): Promise<boolean> {
		for (const req of reqs) {
			checkAborted(signal);
			const ok = await requirementPasses(req, nature, natureCacheKey, evH, evB, evD);
			if (!ok) return false;
		}
		return true;
	}

	// --- 性質3: カードごとにB/D依存の有無を実測する(nature="まじめ"固定、HP努力値0固定で
	// evB/evDを最小/最大にした2〜3通りをcalcLethalSequenceし、perAttackDamages/
	// cumulativeDamageが変わるかを見る)。性格クラス・探索アルゴリズムには依存しないため、
	// 探索全体で1度だけ行う。---
	async function probeDependency(req: DurabilityRequirement): Promise<{ dependsOnB: boolean; dependsOnD: boolean }> {
		const attacksN = expandAttacksToN(req.attacks, req.n);
		const nature = "まじめ";
		async function call(evB: number, evD: number): Promise<CalcLethalSequenceResult> {
			checkAborted(signal);
			const evs = [0, fixedEvs.atk, evB, fixedEvs.spa, evD, fixedEvs.spe];
			const spec = buildDefenderSpec(nature, evs);
			engineCallCount++;
			return calcLethalSequence(req.attackerSpec, spec, attacksN, { seed: req.seed });
		}
		const baseline = await call(0, 0);
		const bMax = await call(MAX_EV, 0);
		const dMax = await call(0, MAX_EV);
		return {
			dependsOnB: !sameOutcome(baseline, bMax),
			dependsOnD: !sameOutcome(baseline, dMax),
		};
	}

	reportProgress(0, requirements.length || 1, "各カードのB/D依存を判定中");
	const dependsOnBMap = new Map<string, boolean>();
	const dependsOnDMap = new Map<string, boolean>();
	for (let i = 0; i < requirements.length; i++) {
		const req = requirements[i];
		const { dependsOnB, dependsOnD } = await probeDependency(req);
		dependsOnBMap.set(req.rowId, dependsOnB);
		dependsOnDMap.set(req.rowId, dependsOnD);
		reportProgress(i + 1, requirements.length, "各カードのB/D依存を判定中");
	}

	const mixedReqs = requirements.filter((r) => dependsOnBMap.get(r.rowId) && dependsOnDMap.get(r.rowId));
	const isMixedOverall = mixedReqs.length > 0;

	const paradoxException = detectParadoxException(buildDefenderSpec);
	const natureClasses = buildNatureClasses(paradoxException);
	if (paradoxException) {
		reportProgress(0, 1, "こだいかっせい/クォークチャージ/ブーストエナジーを検出: 25性格を個別評価中(低速)");
	}

	function makeCandidate(nature: string, evH: number, evB: number, evD: number): DurabilityCandidate {
		const mods = natureMultipliers(nature);
		const hp = calcHpStat(LEVEL, baseStats[0], IV, evH);
		const def = calcOtherStat(LEVEL, baseStats[2], IV, evB, mods.bMult);
		const spd = calcOtherStat(LEVEL, baseStats[4], IV, evD, mods.dMult);
		const searchedEvTotal = evH + evB + evD;
		const totalEv = searchedEvTotal + fixedEvs.atk + fixedEvs.spa + fixedEvs.spe;
		return {
			nature,
			evs: { hp: evH, def: evB, spd: evD },
			searchedEvTotal,
			totalEv,
			realStats: { hp, def, spd },
			exceedsChampionsCap: totalEv > 66,
		};
	}

	const candidates: DurabilityCandidate[] = [];

	if (!isMixedOverall) {
		// --- 高速経路: 全カードが「Bのみ」「Dのみ」「どちらにも依存しない」のいずれかに
		// 分類できる。minB(H)とminD(H)を独立に、二方向ポインタで求める。---
		const bOnlyReqs = requirements.filter((r) => dependsOnBMap.get(r.rowId) && !dependsOnDMap.get(r.rowId));
		const dOnlyReqs = requirements.filter((r) => !dependsOnBMap.get(r.rowId) && dependsOnDMap.get(r.rowId));
		const neitherReqs = requirements.filter((r) => !dependsOnBMap.get(r.rowId) && !dependsOnDMap.get(r.rowId));

		// neitherReqs(B/Dどちらにも依存しないカード)はHPだけで合否が決まるので、
		// 性格に依存しない単一の二分探索で「合格する最小HP努力値」を1回だけ求める。
		async function computeNeitherFeasible(): Promise<boolean[]> {
			const result: boolean[] = new Array(MAX_EV + 1).fill(true);
			if (neitherReqs.length === 0) return result;
			const passAt = (evH: number) => allPass(neitherReqs, "まじめ", "neither", evH, 0, 0);
			if (!(await passAt(MAX_EV))) {
				result.fill(false);
				return result;
			}
			let lo = 0;
			let hi = MAX_EV;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				// eslint-disable-next-line no-await-in-loop
				if (await passAt(mid)) hi = mid;
				else lo = mid + 1;
			}
			for (let h = 0; h <= MAX_EV; h++) result[h] = h >= lo;
			return result;
		}

		// 二方向ポインタ本体(性質5)。dimensionValue(h, val)は「HP努力値h・対象努力値val」
		// (もう片方の探索対象外の努力値は0固定。対象外なので値は結果に影響しない)で
		// 全requirementが合格するかを返す。valポインタはH昇順ループの中で単調に
		// 下げるだけで、上げ直さないため、この関数全体でO(33+33)回のallPass呼び出しに収まる。
		async function twoPointerMinByH(
			reqs: DurabilityRequirement[],
			nature: string,
			natureCacheKey: string,
			dimension: "B" | "D",
			phaseLabel: string,
			progressBase: number,
			progressTotal: number,
		): Promise<(number | null)[]> {
			const result: (number | null)[] = new Array(MAX_EV + 1).fill(null);
			if (reqs.length === 0) return result.fill(0);
			const passAt = (evH: number, val: number) =>
				dimension === "B"
					? allPass(reqs, nature, natureCacheKey, evH, val, 0)
					: allPass(reqs, nature, natureCacheKey, evH, 0, val);
			let ptr = MAX_EV;
			for (let evH = 0; evH <= MAX_EV; evH++) {
				checkAborted(signal);
				while (ptr > 0 && (await passAt(evH, ptr - 1))) ptr--;
				result[evH] = (await passAt(evH, ptr)) ? ptr : null;
				reportProgress(progressBase + evH + 1, progressTotal, phaseLabel);
			}
			return result;
		}

		const neitherFeasible = await computeNeitherFeasible();

		// distinctなB倍率/D倍率ごとに1回だけ探索する(性質4)。非パラドックス時は最大3+3、
		// パラドックス例外時は性格を共有できないため最大25+25になる(遅くなる旨は
		// 上のonProgressで既に伝えている)。
		const bGroupKeyOf = (representative: string) => (paradoxException ? representative : String(natureMultipliers(representative).bMult));
		const dGroupKeyOf = (representative: string) => (paradoxException ? representative : String(natureMultipliers(representative).dMult));

		const bGroups = new Map<string, string>(); // groupKey -> representative nature
		const dGroups = new Map<string, string>();
		for (const cls of natureClasses) {
			const bKey = bGroupKeyOf(cls.representative);
			if (!bGroups.has(bKey)) bGroups.set(bKey, cls.representative);
			const dKey = dGroupKeyOf(cls.representative);
			if (!dGroups.has(dKey)) dGroups.set(dKey, cls.representative);
		}

		const minBByGroup = new Map<string, (number | null)[]>();
		let bGroupIndex = 0;
		for (const [key, representative] of bGroups) {
			const arr = await twoPointerMinByH(
				bOnlyReqs,
				representative,
				key,
				"B",
				"最小B努力値を探索中",
				bGroupIndex * (MAX_EV + 1),
				bGroups.size * (MAX_EV + 1),
			);
			minBByGroup.set(key, arr);
			bGroupIndex++;
		}

		const minDByGroup = new Map<string, (number | null)[]>();
		let dGroupIndex = 0;
		for (const [key, representative] of dGroups) {
			const arr = await twoPointerMinByH(
				dOnlyReqs,
				representative,
				key,
				"D",
				"最小D努力値を探索中",
				dGroupIndex * (MAX_EV + 1),
				dGroups.size * (MAX_EV + 1),
			);
			minDByGroup.set(key, arr);
			dGroupIndex++;
		}

		for (const cls of natureClasses) {
			const minBArr = minBByGroup.get(bGroupKeyOf(cls.representative))!;
			const minDArr = minDByGroup.get(dGroupKeyOf(cls.representative))!;
			for (let evH = 0; evH <= MAX_EV; evH++) {
				if (!neitherFeasible[evH]) continue;
				const evB = minBArr[evH];
				const evD = minDArr[evH];
				if (evB == null || evD == null) continue;
				for (const nature of cls.natures) {
					candidates.push(makeCandidate(nature, evH, evB, evD));
				}
			}
		}
	} else {
		// --- フォールバック経路: 物理技・特殊技が混在するなど、B・D両方に依存するカードが
		// 1枚でもある場合。性質3のとおり、独立探索が使えないためHP×Bの2次元走査に切り替える。
		// クラスごとに: HP努力値を昇順に回し、各HPで B努力値を昇順に動かしながら
		// (Dポインタは単調に下げつつ)最小のB努力値・その時点のDを探し、最初に合格した
		// (B,D)を採用する(candidatesの展開方針=最小努力値の代表点、というコメント冒頭の
		// 方針に沿う)。全カードをまとめて評価するためgroup共有はできず、クラスの数だけ
		// 走査するので大幅にコストが増える(onProgress/signalで進捗通知・中断に対応する)。
		const totalWork = natureClasses.length * (MAX_EV + 1);
		let doneWork = 0;
		for (const cls of natureClasses) {
			checkAborted(signal);
			for (let evH = 0; evH <= MAX_EV; evH++) {
				checkAborted(signal);
				let evD = MAX_EV;
				let found: { evB: number; evD: number } | null = null;
				for (let evB = 0; evB <= MAX_EV; evB++) {
					checkAborted(signal);
					while (evD > 0 && (await allPass(requirements, cls.representative, cls.representative, evH, evB, evD - 1))) {
						evD--;
					}
					// eslint-disable-next-line no-await-in-loop
					if (await allPass(requirements, cls.representative, cls.representative, evH, evB, evD)) {
						found = { evB, evD };
						break;
					}
				}
				if (found) {
					for (const nature of cls.natures) {
						candidates.push(makeCandidate(nature, evH, found.evB, found.evD));
					}
				}
				doneWork++;
				reportProgress(doneWork, totalWork, "B/D混在カードのため2次元探索中(低速)");
			}
		}
	}

	candidates.sort((a, b) => a.searchedEvTotal - b.searchedEvTotal);

	const infeasible = candidates.length === 0;
	const truncated = candidates.length > maxCandidates;
	const finalCandidates = truncated ? candidates.slice(0, maxCandidates) : candidates;

	return {
		candidates: finalCandidates,
		engineCallCount,
		truncated,
		infeasible,
	};
}
