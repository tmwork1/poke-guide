// 個体編集画面(/box/[id])「耐久調整」機能のソルバー(純粋なロジック)。
//
// ⚠️ このファイルはDOMに一切触れない(documentを使わない)。UI(ポップアップの表示・
// クリック・入力)は別エージェントが src/pages/box/[id].astro / BulkAdjustDialog.astro /
// bulk-adjust.ts で実装する。ここは「防御ダメージ計算カード群を、N発をM%以上の確率で
// 耐えられる性格+努力値(H/B/D)の組み合わせに変換する」計算だけを担当する。
//
// ⚠️ Pyodideエンジン(src/lib/pyodide-engine.ts)は import せず、SolveOptions.engine
// として呼び出し元(src/lib/box-id/bulk-adjust.ts)から注入する。pyodide-engine.ts は
// wheel-manifest.json を静的importするブラウザ専用モジュールで、素のNode(tests/を
// 動かす `node --test`)からは読み込めないため。この注入により探索アルゴリズム本体を
// 偽エンジンで単体テストできる(tests/bulk-adjust-solver.test.ts)。同じ理由で
// ../stats は拡張子つき("../stats.ts")でimportしている(Nodeの素のESM解決は
// 拡張子省略を許さない。tsconfigは allowImportingTsExtensions: true・Viteは
// 明示拡張子をそのまま解決するため、ビルド側には影響しない)。
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
// 【性質2: 性格は現在値に固定】
// 耐久調整では性格を変更候補にせず、呼び出し側から渡された現在の性格1種類について
// H/B/D努力値だけを探索する。候補のnatureは型互換と適用処理のため現在値を保持する。
//
// 【性質3: B/Dの分離】多くのカードは物理のみ/特殊のみの技で構成され、耐久判定は
// B・Dの片方にしか依存しない。依存の有無は技名から物理/特殊を引く表を使わず、実測で
// 判定する(壁・特性・テラスタル等で実効の物理/特殊が変わるため、実測の方が確実)。
// 各カードについてB(またはD)を最小/最大にした2通りをcalcLethalSequence()で計算し、
// perAttackDamages/cumulativeDamageが変わるかを見る(probeDependency参照)。
// 全カードが「Bのみ」「Dのみ」に分類できれば、minB(H)とminD(H)は独立に求まる。
// 1枚のカードの中に物理技と特殊技が混在する等、両方に依存するカードが1つでもあれば、
// そのクラスの探索全体をHP×Bの2次元走査にフォールバックする(コストが跳ね上がるため
// onProgress・signal中断に対応する)。
//
// 【性質4: 支配(Pareto dominance)による枝刈り】(2026-08-05 高速化)
// 性質1の単調性は「1軸ずつ」ではなく多次元同時に効く。すなわち
//   ・ある(H実数値, B実数値, D実数値)が「耐えられない」なら、3つとも**それ以下**の点は
//     全て耐えられない
//   ・ある点が「耐えられる」なら、3つとも**それ以上**の点は全て耐えられる
// が常に成り立つ。判定済みの点を「極大な不合格点の反鎖」「極小な合格点の反鎖」として
// 持っておけば(MonotoneMemo)、新しい点はまずこの支配関係で照合するだけでエンジンを
// 呼ばずに合否が決まることが多い。HP努力値を1段上げた直後の再判定・性格クラスをまたいだ
// 再判定はほぼ全てここで無料になる。
//
// ⚠️ よくある誤解: 「耐久指数(H×B・H×D・H*B*D/(B+D))が要求を下回る点を切る」枝刈りは
// **正しくない**。耐久指数が同じでも配分が違えば合否は変わり得る(例: 特殊技だけの
// カードに対し、H×Bが大きくてもDが低ければ落ちる)ため、指数は合否の全順序になっていない。
// 使ってよいのは上の**支配関係(半順序)**の方で、こちらは指数による枝刈りより厳密に
// 強い(指数で切れる点は全て支配でも切れる、かつ支配は誤って切らない)。
//
// 【性質5: 判定は「実数値」だけで決まる。かつ依存しない軸はキーから落とせる】
// 判定結果は努力値ではなく実数値で決まるため、性格クラスをまたいでも実数値が同じなら
// 再利用できる。さらに性質3のprobeDependencyでB(またはD)に依存しないと判明した
// カードは、その軸をメモのキーから丸ごと落とせる(値が何であっても結果が変わらないと
// 実測済みのため)。結果としてB専用カードのメモは(H実数値, B実数値)の2次元になり、
// B倍率0.9/1.0/1.1の3グループが同じメモを共有する。
//
// 【性質6: 3つのB倍率を「実数値グリッド」に統合して1回で探索する】(2026-08-05 高速化)
// 改修前は B倍率ごと(0.9/1.0/1.1)に独立の探索を3回、D倍率も3回、計6回走らせていた。
// 性質5より合否はB実数値だけで決まるので、3倍率で到達可能なB実数値を全てマージして
// 昇順に並べた1本のグリッド上で「HP実数値ごとに合格する最小のB実数値(閾値)」を1回
// 求めれば足りる。各性格クラスの最小B努力値は、その閾値以上になる最小の努力値を
// calcOtherStat()で引くだけ(エンジン呼び出し0回)で求まる。同じことをD側にも行う。
// → エンジン呼び出しが6探索ぶん → 2探索ぶんに減る。
//
// 【性質7: 探索方向はギャロップ+二分探索】(2026-08-05 高速化)
// 閾値はHP努力値について単調非増加なので、1段前のHPで求めた閾値がそのまま上界になる。
// そこで上界から下方向へ 1,2,4,8… と指数的に飛んで不合格点を挟み込み(ギャロップ)、
// 挟んだ区間だけを二分探索する(minPassingIndex)。閾値が動かないHP段では1回、Δだけ
// 下がる段では O(log Δ) 回で済む。改修前の「1段ずつ下ろす二方向ポインタ」は初回HP段で
// グリッド長ぶん(最大90回)の呼び出しを要していたが、ギャロップで log に落ちる。
//
// 【候補の展開方針】各(性格, H努力値)につき、条件を満たす最小の(B, D)の1点だけを
// 返す(合計努力値が最小の代表点)。それより大きいB/Dの組み合わせも条件を満たすが、
// 全部返すと膨大になるため含めない。この方針により「searchedEvTotal昇順の一覧」が
// 意味を持つ(候補を上から採用すれば必ず努力値効率の良い順になる)。

import type { CalcDamagesOptions, CalcLethalSequenceResult, PokemonSpec, SequenceAttack } from "../pyodide-engine";
import { NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from "../stats.ts";

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

/**
 * ソルバーが使うダメージ計算エンジン。src/lib/pyodide-engine.ts の
 * `{ calcLethalSequence, isEngineFatal, resetEngine }` をそのまま渡せる形にしてある
 * (ファイル冒頭の「⚠️ Pyodideエンジンは import せず注入する」参照)。
 */
export interface SolverEngine {
	calcLethalSequence(
		attackerSpec: PokemonSpec,
		defenderSpec: PokemonSpec,
		attacks: SequenceAttack[],
		options?: CalcDamagesOptions,
	): Promise<CalcLethalSequenceResult>;
	isEngineFatal(): boolean;
	resetEngine(): Promise<void>;
}

export interface SolveOptions {
	/** ダメージ計算エンジン(呼び出し元が pyodide-engine の関数群を渡す) */
	engine: SolverEngine;
	/** 自分の種族値 [H,A,B,C,D,S] */
	baseStats: number[];
	/** 固定する努力値(現在値)。探索対象外 */
	fixedEvs: { atk: number; spa: number; spe: number };
	/** 左パネルで現在選択されている性格。この1種類だけを探索する。 */
	currentNature: string;
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

function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/**
 * 探索中にPyodideエンジンが致命的エラー(WebAssembly.RuntimeError /
 * "memory access out of bounds")で停止し、resetEngine() による1回のリトライでも
 * 復帰できなかったことを表すエラー型(2026-08-02 要件2対応)。solveDurability() は
 * この場合、探索を中断してこのエラーをそのままthrowする(AbortErrorと同じ経路)。
 * 呼び出し元(src/lib/box-id/bulk-adjust.ts)はDOMException("AbortError")と同様、
 * これを個別にcatchしてユーザーに分かるメッセージを出し、再実行できる状態に戻す必要がある。
 */
export class EngineFatalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineFatalError";
	}
}

/** attacks を先頭から繰り返して長さnの配列にする(累計に対してNを指定する、というユーザー指示の解釈)。 */
function expandAttacksToN(attacks: SequenceAttack[], n: number): SequenceAttack[] {
	// UI側の検証をすり抜けても、空配列や巨大配列をPyodideへ渡して計算失敗にしないため、ソルバー境界でも契約を検証する。
	if (attacks.length === 0) throw new RangeError("攻撃が1件も指定されていません。");
	if (!Number.isInteger(n) || n < 1 || n > 10) throw new RangeError("攻撃回数は1〜10で指定してください。");
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

/** 各座標について a <= b か(支配判定。性質4)。 */
function dominatedBy(a: number[], b: number[]): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i] > b[i]) return false;
	}
	return true;
}

/**
 * 単調述語「この実数値の組で耐えられるか」のメモ(性質4)。
 * 座標は実数値の配列で、次元数はカードごとに異なる(性質5。B専用カードなら
 * [H実数値, B実数値]、B/D両方に依存するカードなら [H実数値, B実数値, D実数値])。
 *
 * fails には「不合格と分かっている点」のうち極大なものだけ、passes には「合格と
 * 分かっている点」のうち極小なものだけを反鎖(antichain)として持つ。反鎖にしておくと
 * 走査対象が最小限になり、かつ完全一致のキャッシュを別に持つ必要がなくなる
 * (自分自身は自分自身に支配されるため、同じ点の再照会は必ずここで当たる)。
 */
class MonotoneMemo {
	private readonly fails: number[][] = [];
	private readonly passes: number[][] = [];

	/** 支配関係から合否が確定するなら true/false、分からなければ undefined。 */
	lookup(point: number[]): boolean | undefined {
		for (const f of this.fails) {
			if (dominatedBy(point, f)) return false;
		}
		for (const p of this.passes) {
			if (dominatedBy(p, point)) return true;
		}
		return undefined;
	}

	record(point: number[], pass: boolean): void {
		const list = pass ? this.passes : this.fails;
		for (let i = list.length - 1; i >= 0; i--) {
			// 合格点は「より小さい合格点」に、不合格点は「より大きい不合格点」に吸収される。
			const redundant = pass ? dominatedBy(point, list[i]) : dominatedBy(list[i], point);
			if (redundant) list.splice(i, 1);
		}
		list.push(point.slice());
	}
}

/**
 * 単調述語 P(i)(iが大きいほど合格しやすい)について、P(ub) が true と分かっているとき、
 * P(i) が true になる最小の i(0 <= i <= ub)を求める(性質7)。
 *
 * ub から下へ 1,2,4,8… と指数的に飛んで最初の不合格点を見つけ(ギャロップ)、挟み込んだ
 * 区間だけを二分探索する。答えが ub のまま動かないときは1回、Δだけ下がるときは
 * O(log Δ) 回の P 呼び出しで済む。
 */
async function minPassingIndex(ub: number, P: (i: number) => Promise<boolean>): Promise<number> {
	if (ub <= 0) return 0;
	let hiPass = ub; // P(hiPass) === true が既知
	let loFail = -1; // P(loFail) === false が既知(-1 は「まだ不合格点を見つけていない」)
	let step = 1;
	while (hiPass > 0) {
		const probe = Math.max(0, hiPass - step);
		// eslint-disable-next-line no-await-in-loop
		if (await P(probe)) {
			hiPass = probe;
			if (probe === 0) return 0;
			step *= 2;
		} else {
			loFail = probe;
			break;
		}
	}
	if (loFail < 0) return hiPass;
	let lo = loFail + 1;
	let hi = hiPass;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		// eslint-disable-next-line no-await-in-loop
		if (await P(mid)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** 統合実数値グリッドの1点(性質6)。value を実現する代表の(性格, 努力値)を持つ。 */
interface GridPoint {
	value: number;
	nature: string;
	ev: number;
}

/** 実数値の閾値を満たす最小の努力値(0〜32)。届かなければ null。 */
function minEvForThreshold(base: number, mult: number, threshold: number): number | null {
	for (let ev = 0; ev <= MAX_EV; ev++) {
		if (calcOtherStat(LEVEL, base, IV, ev, mult) >= threshold) return ev;
	}
	return null;
}

export async function solveDurability(
	requirements: DurabilityRequirement[],
	options: SolveOptions,
): Promise<SolveResult> {
	const {
		engine,
		baseStats,
		fixedEvs,
		currentNature,
		buildDefenderSpec,
		onProgress,
		signal,
		maxCandidates = DEFAULT_MAX_CANDIDATES,
	} = options;

	let engineCallCount = 0;
	let lastProgressAt = 0;
	// エンジン致命的エラーからの復帰通知(要件2)で使う、直近のdone/total。
	// reportProgress()はスロットルで実際にonProgressを呼ばないことがあるため、
	// 値そのものは呼ばれたかどうかに関わらず毎回更新しておく。
	let lastProgressDone = 0;
	let lastProgressTotal = 1;
	function reportProgress(done: number, total: number, phase: string): void {
		lastProgressDone = done;
		lastProgressTotal = total;
		if (!onProgress) return;
		const now = Date.now();
		// 数十msに1回程度、または完了時のみ通知する(呼びすぎ防止)。
		if (done >= total || now - lastProgressAt >= 50) {
			lastProgressAt = now;
			onProgress({ done, total, phase });
		}
	}

	// --- 要件3: キャンセル・進捗表示の実効性 ---
	// Pyodide呼び出し(calcLethalSequence)自体がメインスレッドを占有する同期処理のため、
	// await一回だけ(マイクロタスクの消化)ではブラウザの入力・再描画イベントは処理されない
	// (前段のUI実装者からの報告: 探索が重いとキャンセルボタンのクリックが30秒以上効かない
	// ことがある)。数回に1回 setTimeout(0) でマクロタスクへ明示的に降りることで、その間に
	// クリックされたキャンセルボタン(signal.abort())やブラウザの再描画が実際に反映される
	// ようにする。実測(検証項目4): キャンセルから中断までの秒数を参照。
	const YIELD_EVERY_N_CALLS = 2;
	let callsSinceYield = 0;
	async function yieldToEventLoopIfDue(): Promise<void> {
		callsSinceYield++;
		if (callsSinceYield >= YIELD_EVERY_N_CALLS) {
			callsSinceYield = 0;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		checkAborted(signal);
	}

	// --- 要件2: 致命的エラーからの復帰 ---
	// calcLethalSequence()の呼び出しをこの関数1箇所に集約し、致命的エラー
	// (isEngineFatal()がtrueになる = WebAssembly.RuntimeError / "memory access out of
	// bounds")を検知したら resetEngine()(実測約2.4秒)で1回だけ再初期化してこの呼び出しを
	// リトライする。リトライも失敗したら探索全体を中断する(EngineFatalErrorをthrow。
	// 呼び出し元 src/lib/box-id/bulk-adjust.ts が個別にcatchしてユーザーに知らせる)。
	// engineCallCountは実際にPyodideへディスパッチした回数(リトライ分を含む)を数える。
	async function callLethalSequenceResilient(
		attackerSpec: PokemonSpec,
		defenderSpec: PokemonSpec,
		attacksN: SequenceAttack[],
		callOptions: CalcDamagesOptions,
	): Promise<CalcLethalSequenceResult> {
		checkAborted(signal);
		let result: CalcLethalSequenceResult;
		try {
			engineCallCount++;
			result = await engine.calcLethalSequence(attackerSpec, defenderSpec, attacksN, callOptions);
		} catch (err) {
			if (!engine.isEngineFatal()) throw err;
			// onProgressへスロットルを無視して即座に通知する(resetEngineは約2.4秒かかるため、
			// UIが無反応に見えないようにする。bulk-adjust.tsの汎用progress表示
			// `${info.phase}(${info.done}/${info.total})` にそのまま乗る)。
			onProgress?.({
				done: lastProgressDone,
				total: lastProgressTotal,
				phase: "エンジンが致命的エラーで停止したため再起動しています(数秒かかります)",
			});
			await engine.resetEngine();
			checkAborted(signal);
			try {
				engineCallCount++;
				result = await engine.calcLethalSequence(attackerSpec, defenderSpec, attacksN, callOptions);
			} catch {
				// リトライは1回まで(要件2)。再度失敗したら探索を中断する。
				throw new EngineFatalError(
					"計算エンジンが致命的エラーで停止したため、耐久調整の探索を中断しました。もう一度お試しください。",
				);
			}
		}
		await yieldToEventLoopIfDue();
		return result;
	}

	// --- 性質3: カードごとにB/D依存の有無を実測する(現在の性格、HP努力値0固定で
	// evB/evDを最小/最大にした2〜3通りをcalcLethalSequenceし、perAttackDamages/
	// cumulativeDamageが変わるかを見る)。性格クラス・探索アルゴリズムには依存しないため、
	// 探索全体で1度だけ行う。---
	async function probeDependency(req: DurabilityRequirement): Promise<{ dependsOnB: boolean; dependsOnD: boolean }> {
		const attacksN = expandAttacksToN(req.attacks, req.n);
		const nature = currentNature;
		async function call(evB: number, evD: number): Promise<CalcLethalSequenceResult> {
			checkAborted(signal);
			const evs = [0, fixedEvs.atk, evB, fixedEvs.spa, evD, fixedEvs.spe];
			const spec = buildDefenderSpec(nature, evs);
			// ⚠️ ここは意図的に sequentialOnly を付けない(既定 false のまま)。
			// 理由(要件1「どちらか選ぶ」の判断・実測含めコメント必須という指示への回答):
			// sameOutcome() は cumulativeDamage と perAttackDamages の両方を比較しているが、
			// sequentialOnly:true にすると perAttackDamages が常に空配列になり「常に同じ」と
			// 誤判定され、B/D依存判定(dependsOnB/dependsOnD)が必ず false に壊れてしまう。
			// 「sameOutcome を cumulativeDamage だけの比較に変える」案も検討したが、
			// cumulativeDamage は「確率100%に達するまでの累計」であり、Bを上げて生存ターン数が
			// 伸びると「1発あたりのダメージ減少」と「合成対象ターン数の増加」が丸め誤差の範囲で
			// 相殺し、本当はBに依存しているのに差が出ない偽陰性が理論上あり得る(具体例までは
			// 特定できていないため、安全側に倒した=実測はしていない)。probeDependencyの呼び出し
			// 回数はrequirement 1件あたり高々3回(baseline/bMax/dMax)でクラッシュリスクが小さい
			// ため、正しさを優先してここだけ従来通り(perAttackDamagesも計算する重い方)のまま
			// にする。B/D依存判定が改修前と一致することは検証項目1で実測確認する。
			return callLethalSequenceResilient(req.attackerSpec, spec, attacksN, { seed: req.seed });
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

	const { bMult, dMult } = natureMultipliers(currentNature);
	const natureClasses = [{ natures: [currentNature], representative: currentNature, bMult, dMult }];

	// --- 判定のメモ(性質4・性質5)---
	// 現在の性格1種類だけを扱うため、カード(rowId)ごとに1つ持つ。
	const memos = new Map<string, MonotoneMemo>();
	function memoFor(req: DurabilityRequirement): MonotoneMemo {
		const key = req.rowId;
		let memo = memos.get(key);
		if (!memo) {
			memo = new MonotoneMemo();
			memos.set(key, memo);
		}
		return memo;
	}

	async function requirementPasses(
		req: DurabilityRequirement,
		nature: string,
		evH: number,
		evB: number,
		evD: number,
	): Promise<boolean> {
		const mods = natureMultipliers(nature);
		const hp = calcHpStat(LEVEL, baseStats[0], IV, evH);
		const def = calcOtherStat(LEVEL, baseStats[2], IV, evB, mods.bMult);
		const spd = calcOtherStat(LEVEL, baseStats[4], IV, evD, mods.dMult);
		// 性質5: このカードが依存しないと実測済みの軸はメモのキーから落とす。
		// 落とした軸は値が何であっても結果が変わらないため、支配判定の次元も減らせる
		// (= B専用カードならD側の値が違ってもキャッシュが当たる)。
		const point: number[] = [hp];
		if (dependsOnBMap.get(req.rowId)) point.push(def);
		if (dependsOnDMap.get(req.rowId)) point.push(spd);

		const memo = memoFor(req);
		const known = memo.lookup(point);
		if (known !== undefined) return known;

		checkAborted(signal);
		const evs = [evH, fixedEvs.atk, evB, fixedEvs.spa, evD, fixedEvs.spe];
		const defenderSpec = buildDefenderSpec(nature, evs);
		const attacksN = expandAttacksToN(req.attacks, req.n);
		// sequentialOnly: true (要件1本体): この探索経路はlethalしか読まないため、
		// isolated側(perAttackDamages/perAttackLethal)の計算を丸ごとスキップしてもらう。
		// lethal/cumulativeDamageの値・打ち切り仕様はsequentialOnlyの有無で完全に一致する
		// ことが実測済み(pyodide-engine.ts CalcDamagesOptions.sequentialOnlyのコメント参照)。
		// 1呼び出しあたりのBattle構築+calc_lethal呼び出しが2回→1回に減り、これがクラッシュ
		// 対策の本体になる(検証: n=16,m=100などは改修前クラッシュしていたが完走するように
		// なった。検証項目2参照)。
		const result = await callLethalSequenceResilient(req.attackerSpec, defenderSpec, attacksN, {
			seed: req.seed,
			sequentialOnly: true,
		});
		const lethal = lethalProbabilityAtN(result, req.n);
		const surviveProbability = 1 - lethal;
		const pass = surviveProbability >= req.m / 100 - 1e-9;
		memo.record(point, pass);
		return pass;
	}

	// カードが複数あるとき、落ちやすいカードから評価するとANDの短絡が早く効いて
	// エンジン呼び出しが減る。どれが厳しいかは事前に分からないため、実際に不合格に
	// なった回数を数えて多い順に並べ替える(適応的な順序付け。結果は順序に依存しない)。
	const failCounts = new Map<string, number>();

	async function allPass(
		reqs: DurabilityRequirement[],
		nature: string,
		evH: number,
		evB: number,
		evD: number,
	): Promise<boolean> {
		const ordered =
			reqs.length > 1
				? [...reqs].sort((a, b) => (failCounts.get(b.rowId) ?? 0) - (failCounts.get(a.rowId) ?? 0))
				: reqs;
		for (const req of ordered) {
			checkAborted(signal);
			const ok = await requirementPasses(req, nature, evH, evB, evD);
			if (!ok) {
				failCounts.set(req.rowId, (failCounts.get(req.rowId) ?? 0) + 1);
				return false;
			}
		}
		return true;
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
		// 分類できる。minB(H)とminD(H)を独立に求める。---
		const bOnlyReqs = requirements.filter((r) => dependsOnBMap.get(r.rowId) && !dependsOnDMap.get(r.rowId));
		const dOnlyReqs = requirements.filter((r) => !dependsOnBMap.get(r.rowId) && dependsOnDMap.get(r.rowId));
		const neitherReqs = requirements.filter((r) => !dependsOnBMap.get(r.rowId) && !dependsOnDMap.get(r.rowId));

		// neitherReqs(B/Dどちらにも依存しないカード)はHPだけで合否が決まるので、
		// 性格に依存しない単一の探索で「合格する最小HP努力値」を1回だけ求める。
		async function computeNeitherFeasible(): Promise<boolean[]> {
			const result: boolean[] = new Array(MAX_EV + 1).fill(true);
			if (neitherReqs.length === 0) return result;
			const passAt = (evH: number) => allPass(neitherReqs, currentNature, evH, 0, 0);
			if (!(await passAt(MAX_EV))) {
				result.fill(false);
				return result;
			}
			const lo = await minPassingIndex(MAX_EV, passAt);
			for (let h = 0; h <= MAX_EV; h++) result[h] = h >= lo;
			return result;
		}

		/**
		 * 性質6+7の本体。HP努力値ごとに「合格する最小のB(またはD)実数値」を統合グリッド上で
		 * 求める。閾値はHPについて単調非増加なので、1段前の答えをそのまま上界に使い、
		 * そこからギャロップ+二分探索(minPassingIndex)で下ろす。届かないHP段は null。
		 */
		async function solveAxisThresholds(
			reqs: DurabilityRequirement[],
			grid: GridPoint[],
			phaseLabel: string,
			progressBase: number,
			progressTotal: number,
		): Promise<(number | null)[]> {
			const thresholds: (number | null)[] = new Array(MAX_EV + 1).fill(null);
			if (reqs.length === 0) return thresholds.fill(0);
			const passAt = (evH: number, gridIndex: number) =>
				allPass(reqs, grid[gridIndex].nature, evH, grid[gridIndex].ev, grid[gridIndex].ev);
			let upper = grid.length - 1;
			for (let evH = 0; evH <= MAX_EV; evH++) {
				checkAborted(signal);
				// upper は「1段前のHPで合格した最小点」。HPが増えた今も単調性より必ず合格するので、
				// 2段目以降のこの判定はメモの支配関係だけで即答され、エンジンを呼ばない。
				if (await passAt(evH, upper)) {
					const idx = await minPassingIndex(upper, (i) => passAt(evH, i));
					upper = idx;
					thresholds[evH] = grid[idx].value;
				}
				reportProgress(progressBase + evH + 1, progressTotal, phaseLabel);
			}
			return thresholds;
		}

		const neitherFeasible = await computeNeitherFeasible();

		// 探索グループは現在の性格の倍率だけを持つ1本に固定する。
		interface AxisSearchGroup {
			key: string;
			grid: GridPoint[];
		}
		function buildSearchGroups(stat: "def" | "spd", base: number): { groups: AxisSearchGroup[]; keyOf: (nature: string) => string } {
			const mult = stat === "def" ? bMult : dMult;
			const grid: GridPoint[] = [];
			for (let ev = 0; ev <= MAX_EV; ev++) {
				const value = calcOtherStat(LEVEL, base, IV, ev, mult);
				if (grid.length === 0 || grid[grid.length - 1].value !== value) grid.push({ value, nature: currentNature, ev });
			}
			return { groups: [{ key: currentNature, grid }], keyOf: () => currentNature };
		}

		const bSearch = buildSearchGroups("def", baseStats[2]);
		const dSearch = buildSearchGroups("spd", baseStats[4]);

		const bThresholds = new Map<string, (number | null)[]>();
		for (let i = 0; i < bSearch.groups.length; i++) {
			const group = bSearch.groups[i];
			bThresholds.set(
				group.key,
				await solveAxisThresholds(
					bOnlyReqs,
					group.grid,
					"最小B努力値を探索中",
					i * (MAX_EV + 1),
					bSearch.groups.length * (MAX_EV + 1),
				),
			);
		}

		const dThresholds = new Map<string, (number | null)[]>();
		for (let i = 0; i < dSearch.groups.length; i++) {
			const group = dSearch.groups[i];
			dThresholds.set(
				group.key,
				await solveAxisThresholds(
					dOnlyReqs,
					group.grid,
					"最小D努力値を探索中",
					i * (MAX_EV + 1),
					dSearch.groups.length * (MAX_EV + 1),
				),
			);
		}

		// 閾値(実数値)→ 各性格クラスの最小努力値への変換はエンジンを呼ばない純粋計算。
		for (const cls of natureClasses) {
			const bArr = bThresholds.get(bSearch.keyOf(cls.representative))!;
			const dArr = dThresholds.get(dSearch.keyOf(cls.representative))!;
			for (let evH = 0; evH <= MAX_EV; evH++) {
				if (!neitherFeasible[evH]) continue;
				const bThreshold = bArr[evH];
				const dThreshold = dArr[evH];
				if (bThreshold == null || dThreshold == null) continue;
				const evB = minEvForThreshold(baseStats[2], cls.bMult, bThreshold);
				const evD = minEvForThreshold(baseStats[4], cls.dMult, dThreshold);
				if (evB == null || evD == null) continue;
				for (const nature of cls.natures) {
					candidates.push(makeCandidate(nature, evH, evB, evD));
				}
			}
		}
	} else {
		// --- フォールバック経路: 物理技・特殊技が混在するなど、B・D両方に依存するカードが
		// 1枚でもある場合。性質3のとおり独立探索が使えないためHP×Bの2次元走査に切り替える。
		// 出力の定義は改修前と同じ「最小のB努力値、そのBでの最小のD努力値」。
		//
		// 高速化(2026-08-05): 「解が存在する最小のB努力値」はHP努力値について非増加、
		// 「そのBでの最小D努力値」も(同じBについて)HPに対して非増加なので、1段前のHPの
		// 答えを上界として引き継ぎ、そこからギャロップ+二分探索(性質7)で下ろす。
		// 引き継いだ上界の再判定はメモの支配関係(性質4)で無料になるため、改修前の
		// 「HP段ごとにB=0から走査し直す」約15,000回の呼び出しが数百回まで落ちる。
		// 現在の性格1種類だけなので、性格をまたぐ追加探索は発生しない。
		const totalWork = natureClasses.length * (MAX_EV + 1);
		let doneWork = 0;
		for (const cls of natureClasses) {
			checkAborted(signal);
			const nature = cls.representative;
			// 「B努力値 evB で(D努力値をいくらでも積めるなら)解があるか」= allPass(evH, evB, MAX_EV)。
			let evBUpper = MAX_EV;
			// evB ごとの「最小D努力値」の上界。HPが増えると下がる一方なので使い回せる。
			const evDUpperByEvB: number[] = new Array(MAX_EV + 1).fill(MAX_EV);
			for (let evH = 0; evH <= MAX_EV; evH++) {
				checkAborted(signal);
				if (await allPass(requirements, nature, evH, evBUpper, MAX_EV)) {
					const evB = await minPassingIndex(evBUpper, (i) => allPass(requirements, nature, evH, i, MAX_EV));
					evBUpper = evB;
					const evD = await minPassingIndex(evDUpperByEvB[evB], (i) =>
						allPass(requirements, nature, evH, evB, i),
					);
					evDUpperByEvB[evB] = evD;
					for (const n of cls.natures) {
						candidates.push(makeCandidate(n, evH, evB, evD));
					}
				}
				doneWork++;
				reportProgress(doneWork, totalWork, "B/D混在カードのため2次元探索中");
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
