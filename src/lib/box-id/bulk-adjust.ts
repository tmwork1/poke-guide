// UI改修依頼(個体編集画面、2026-08-02)「耐久調整」機能。
//
// トップバーの #bulk-adjust-button(box/[id].astro側の静的マークアップ、実装済み・元は
// disabled)を押すと、防御方向(相手→自分)のダメージ計算カードだけを圧縮表示した
// ポップアップ(src/components/box-id/BulkAdjustDialog.astro)を開く。カードごとに
// 「N発をM%以上の確率で耐える」の N・M を入力し、同じボタン(このとき「ステータスを計算」に
// ラベルが変わる)を押すと src/lib/box-id/bulk-adjust-solver.ts の solveDurability() で
// 条件を満たす性格・努力値(H/B/D)の組み合わせを探索する。結果は右パネル
// (src/lib/box-id/right-panel.ts の renderBulkAdjustResults)に一覧表示し、一覧をクリックすると
// 左パネルの性格・努力値を実際に書き換える。
//
// このファイルは src/components/box-id/BulkAdjustDialog.astro の <script> から
// 副作用importされ、モジュール読み込み時に自身で初期化する(LeftPanel.astro/left-panel.ts、
// DamageCalcSection.astro/damage-calc.tsと同じ構成)。BulkAdjustDialog.astroは
// box/[id].astro側で LeftPanel/DamageCalcSection/RightPanel と同じ「pokemonが存在する
// ときだけ描画される」分岐の中に置かれているため、#bulk-adjust-button・
// #opponent-notes-section・#damage-detail-panel等はこのファイルの実行時に必ず存在する
// (存在しない場合はel()がthrowする。left-panel.ts/damage-calc.tsと同じ前提)。
import { el, readEv } from "../owned-pokemon-form";
import {
	getBulkAdjustBridge,
	buildAttackerSpec,
	baseStatsMapPromise,
	natureNameFromBoosts,
	type BulkAdjustRowSnapshot,
} from "./shared-core";
import {
	isEngineReady,
	initEngine,
	calcLethalSequence,
	isEngineFatal,
	resetEngine,
} from "../pyodide-engine";
import type { PokemonSpec } from "../pyodide-engine";
import { STAT_KEYS, NATURE_STAT_MODIFIERS, type StatKey } from "../stats";
import {
	solveDurability,
	EngineFatalError,
	type DurabilityRequirement,
	type DurabilityCandidate,
	type SolveResult,
} from "./bulk-adjust-solver";
import { renderBulkAdjustResults, openDetailPanelOverlayIfNarrow } from "./right-panel";

const bulkAdjustButton = el<HTMLButtonElement>("bulk-adjust-button");
const bulkAdjustButtonLabelEl = bulkAdjustButton.querySelector<HTMLElement>(".bulk-adjust-button-label");
const backdropEl = el<HTMLElement>("bulk-adjust-backdrop");
const dialogEl = el<HTMLElement>("bulk-adjust-dialog");
const dialogCloseButton = el<HTMLButtonElement>("bulk-adjust-dialog-close");
// UI改修依頼(個体編集画面、2026-08-04)「ウィンドウ上部に計算する ボタンを配置」。
const dialogComputeButton = el<HTMLButtonElement>("bulk-adjust-dialog-compute-button");
const dialogStatusEl = el<HTMLElement>("bulk-adjust-dialog-status");
const dialogBodyInnerEl = el<HTMLElement>("bulk-adjust-dialog-body-inner");
const dialogFooterEl = el<HTMLElement>("bulk-adjust-dialog-footer");
const cancelButton = el<HTMLButtonElement>("bulk-adjust-cancel-button");
const progressTextEl = el<HTMLElement>("bulk-adjust-progress-text");

// ⚠️ 圧縮表示カード(buildCollapsedPreview()の複製)のCSS
// (「#opponent-notes-section .card-damage[data-collapsed="true"] ...」等、
// DamageCalcSection.astroの<style is:global>)は、祖先に id="opponent-notes-section" を
// 持つ要素があることを前提にしたセレクタになっている。このダイアログの静的マークアップは
// box/[id].astro側では#opponent-notes-sectionの外に置かれているため、実行時にこの2要素
// (背景オーバーレイ・ダイアログ本体)を#opponent-notes-sectionの直下へ移す。
// position:fixedのため見た目上の位置(画面中央/画面全体)には一切影響しない
// (#damage-detail-panelも同様にDOM上の位置と画面上の位置が独立している既存パターン)。
// #opponent-notes-section自身の子要素の書き換えはdamage-calc.ts側で#damage-rows-list
// (このセクションの中の1要素)に閉じているため、直下に新しい兄弟要素を2つ追加するだけの
// この操作はdamage-calc.ts側の処理と衝突しない。
const opponentNotesSectionEl = document.getElementById("opponent-notes-section");
if (opponentNotesSectionEl) {
	opponentNotesSectionEl.appendChild(backdropEl);
	opponentNotesSectionEl.appendChild(dialogEl);
}

let isDialogOpen = false;
let isComputing = false;
let currentRows: BulkAdjustRowSnapshot[] = [];
const rowInputEls = new Map<string, { nInput: HTMLInputElement; mInput: HTMLInputElement; includeInput: HTMLInputElement }>();
let activeAbortController: AbortController | null = null;

function includedRowCount(): number {
	let count = 0;
	for (const { includeInput } of rowInputEls.values()) {
		if (includeInput.checked) count++;
	}
	return count;
}

function updateComputeButtonDisabled(): void {
	const hasIncludedRows = includedRowCount() > 0;
	dialogComputeButton.disabled = isComputing || !hasIncludedRows;
	dialogComputeButton.title = hasIncludedRows ? "" : "計算対象の攻撃がありません";
	if (!isComputing && !hasIncludedRows) dialogStatusEl.textContent = "計算対象の攻撃がありません";
	else if (!isComputing && dialogStatusEl.textContent === "計算対象の攻撃がありません") dialogStatusEl.textContent = "";
}

// UI改修依頼(2026-08-05): 画面側の確定数表示が最大10発までを扱うため、入力・探索も同じ範囲にそろえる。
const MAX_ATTACK_COUNT = 10;

// 現在のカードに表示済みの累計確定数(「確N」)を初期値に使う。計算前・10発以上・
// エラー表示など数値を取り出せない場合だけ、従来値1へフォールバックする。
function currentConfirmedCount(preview: HTMLElement | null): number | null {
	const text = preview?.querySelector<HTMLElement>(".damage-row-total-result .damage-result-verdict")?.textContent?.trim();
	const match = text?.match(/^確(\d+)$/);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 1 && n <= MAX_ATTACK_COUNT ? n : null;
}

function setButtonLabel(text: string): void {
	if (bulkAdjustButtonLabelEl) bulkAdjustButtonLabelEl.textContent = text;
	else bulkAdjustButton.textContent = text;
}

// ダイアログを開いていない間だけ、「エンジン準備済み・防御カード1枚以上」で有効化する
// (#damage-collapse-toggle-buttonのupdateCollapseToggleButtonLabelと同じ「disabled切り替えを
// 1関数に集約する」流儀)。BulkAdjustBridgeには行の増減・名前変更を通知する購読機構が無く
// (damage-calc.ts/shared-core.tsは編集対象外のため追加できない)、かつ相手ポケモン名や
// 技名の入力(input.valueの変更)はDOM属性の変化を伴わずMutationObserverでは拾えないため、
// 軽い間隔ポーリングで最新状態に追随させる(600ms間隔。getDefenseRows()は既存行配列を
// 読むだけの軽量処理のため負荷は無視できる)。
function updateBulkAdjustButtonReadyState(): void {
	if (isDialogOpen || isComputing) return;
	const bridge = getBulkAdjustBridge();
	const ready = isEngineReady() && !!bridge && bridge.getDefenseRows().length > 0;
	bulkAdjustButton.disabled = !ready;
}
initEngine(() => updateBulkAdjustButtonReadyState());
updateBulkAdjustButtonReadyState();
window.setInterval(updateBulkAdjustButtonReadyState, 600);

// --- N/M入力欄のバリデーション ---
// Nは1以上の整数、Mは0より大きく100以下(既定値 N=1, M=100)。
function clampN(raw: string): number {
	const n = Math.round(Number(raw));
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(n, MAX_ATTACK_COUNT);
}
function clampM(raw: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 100;
	if (n > 100) return 100;
	return n;
}

// --- ダイアログの中身の組み立て ---
function buildRowEl(bridge: NonNullable<ReturnType<typeof getBulkAdjustBridge>>, row: BulkAdjustRowSnapshot): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "bulk-adjust-row";
	wrap.dataset.rowId = row.id;

	const previewWrap = document.createElement("div");
	previewWrap.className = "bulk-adjust-row-preview";
	const preview = bridge.buildCollapsedPreview(row.id);
	if (preview) previewWrap.appendChild(preview);
	wrap.appendChild(previewWrap);

	const inputsRow = document.createElement("div");
	inputsRow.className = "bulk-adjust-row-inputs";

	const nLabel = document.createElement("label");
	const nLabelTextBefore = document.createElement("span");
	nLabelTextBefore.textContent = `${row.name}の攻撃`;
	const nInput = document.createElement("input");
	nInput.type = "number";
	nInput.className = "bulk-adjust-n-input tnum";
	nInput.min = "1";
	nInput.max = String(MAX_ATTACK_COUNT);
	nInput.step = "1";
	nInput.inputMode = "numeric";
	// UI改修依頼(2026-08-05): 開く時点の努力値配分に対する確定数を優先し、努力値変更後に古い入力値を持ち越さない。
	nInput.value = String(currentConfirmedCount(preview) ?? 1);
	nInput.setAttribute("aria-label", `${row.name}の攻撃を何発耐えるか(発)`);
	const nLabelTextAfter = document.createElement("span");
	nLabelTextAfter.textContent = "発を";
	nLabel.append(nLabelTextBefore, nInput, nLabelTextAfter);

	const mLabel = document.createElement("label");
	const mInput = document.createElement("input");
	mInput.type = "number";
	mInput.className = "bulk-adjust-m-input tnum";
	mInput.min = "0.01";
	mInput.max = "100";
	mInput.step = "any";
	mInput.inputMode = "decimal";
	mInput.value = "100";
	mInput.setAttribute("aria-label", `${row.name}の攻撃に耐える確率の下限(%)`);
	const mLabelTextAfter = document.createElement("span");
	mLabelTextAfter.textContent = "%以上の確率で耐える";
	mLabel.append(mInput, mLabelTextAfter);

	// 計算対象の切替はダイアログを開いている間だけDOMで保持し、保存データには含めない。
	const includeLabel = document.createElement("label");
	includeLabel.className = "bulk-adjust-include-label";
	const includeInput = document.createElement("input");
	includeInput.type = "checkbox";
	includeInput.checked = true;
	includeInput.setAttribute("aria-label", `${row.name}の攻撃を調整に含める`);
	const includeText = document.createElement("span");
	includeText.textContent = "調整に含める";
	includeLabel.append(includeInput, includeText);
	const refreshIncludedState = (): void => {
		const included = includeInput.checked;
		wrap.classList.toggle("is-excluded", !included);
		nInput.disabled = !included || isComputing;
		mInput.disabled = !included || isComputing;
		updateComputeButtonDisabled();
	};
	includeInput.addEventListener("change", refreshIncludedState);

	inputsRow.append(nLabel, mLabel, includeLabel);
	wrap.appendChild(inputsRow);

	rowInputEls.set(row.id, { nInput, mInput, includeInput });
	return wrap;
}

// --- 開閉 ---
function openDialog(): void {
	const bridge = getBulkAdjustBridge();
	if (!bridge) return;
	currentRows = bridge.getDefenseRows();
	rowInputEls.clear();
	dialogBodyInnerEl.innerHTML = "";
	dialogStatusEl.textContent = "";
	if (currentRows.length === 0) {
		// 要件: 0件のときはポップアップを開かない(ボタンはdisabledのはずだが、行の削除等の
		// タイミングで開いてしまった場合の防御的フォールバック)。
		return;
	}
	for (const row of currentRows) {
		dialogBodyInnerEl.appendChild(buildRowEl(bridge, row));
	}
	updateComputeButtonDisabled();
	// ⚠️ 実装時に踏んだ罠: 背景オーバーレイ(#bulk-adjust-backdrop)のtopはCSSで
	// var(--topbar-height)固定にしていたが、狭幅(390px等)ではトップバーの操作ボタン列
	// (.app-topbar-actions)が折り返して2行以上になることがあり、実際のトップバー高さが
	// この固定値を超えてボタン(#bulk-adjust-button)自身が覆われクリック不能になる
	// (Playwright実機検証で再現)。z-indexで前面に出す対策は.app-topbar自身が独自の
	// スタッキングコンテキスト(position:sticky+z-index:20、global.css)を持つため効かなかった
	// (子要素のz-indexは外の要素と比較されない)。開くたびに実際のトップバー下端を測って
	// backdropのtopへ反映することで、折り返しの有無・段数によらず常にボタンの真下から
	// 覆うようにする。
	const topbarEl = document.querySelector<HTMLElement>(".app-topbar");
	backdropEl.style.top = topbarEl ? `${topbarEl.getBoundingClientRect().bottom}px` : "";
	backdropEl.hidden = false;
	dialogEl.hidden = false;
	isDialogOpen = true;
	setButtonLabel("ステータスを計算");
	bulkAdjustButton.disabled = false;
	dialogEl.focus();
}

function closeDialog(): void {
	if (isComputing) {
		activeAbortController?.abort();
	}
	backdropEl.hidden = true;
	dialogEl.hidden = true;
	isDialogOpen = false;
	setButtonLabel("耐久調整");
	dialogFooterEl.hidden = true;
	updateBulkAdjustButtonReadyState();
	bulkAdjustButton.focus();
}

bulkAdjustButton.addEventListener("click", () => {
	if (isComputing) return;
	if (isDialogOpen) {
		void runCompute();
	} else {
		openDialog();
	}
});
dialogCloseButton.addEventListener("click", closeDialog);
// UI改修依頼(個体編集画面、2026-08-04)「ウィンドウ上部に計算する ボタンを配置」。
// 外部トリガー(#bulk-adjust-button、ダイアログを開いている間は「ステータスを計算」実行
// ボタンを兼ねる)と完全に同じ共通関数runCompute()を呼ぶだけで、実行ロジックは二重に
// 持たない(closeDialog()→renderBulkAdjustResults()のフローもrunCompute()内に閉じている)。
dialogComputeButton.addEventListener("click", () => {
	if (isComputing) return;
	void runCompute();
});
backdropEl.addEventListener("click", closeDialog);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && isDialogOpen) closeDialog();
});
cancelButton.addEventListener("click", () => {
	activeAbortController?.abort();
});

// --- 計算 ---
function setComputingState(computing: boolean): void {
	isComputing = computing;
	dialogFooterEl.hidden = !computing;
	bulkAdjustButton.disabled = computing;
	updateComputeButtonDisabled();
	dialogCloseButton.disabled = false; // 中断経路として閉じるボタンは常に押せるようにする
	for (const { nInput, mInput, includeInput } of rowInputEls.values()) {
		nInput.disabled = computing || !includeInput.checked;
		mInput.disabled = computing || !includeInput.checked;
		includeInput.disabled = computing;
	}
	if (!computing) {
		progressTextEl.textContent = "";
	}
}

async function runCompute(): Promise<void> {
	const bridge = getBulkAdjustBridge();
	if (!bridge || currentRows.length === 0) {
		// 共通ステータス領域は入力不足にも使い、モーダルを閉じずに修正を促す。
		dialogStatusEl.textContent = "計算対象の攻撃がありません";
		return;
	}
	dialogStatusEl.textContent = "";

	// OFFの行はソルバへ渡す前に除外し、ソルバ側の契約を変えない。
	const includedRows = currentRows.filter((row) => rowInputEls.get(row.id)?.includeInput.checked ?? true);
	if (includedRows.length === 0) {
		dialogStatusEl.textContent = "計算対象の攻撃がありません";
		return;
	}
	const requirements: DurabilityRequirement[] = includedRows.map((row) => {
		const inputs = rowInputEls.get(row.id);
		const n = inputs ? clampN(inputs.nInput.value) : 1;
		const m = inputs ? clampM(inputs.mInput.value) : 100;
		if (inputs) {
			inputs.nInput.value = String(n);
			inputs.mInput.value = String(m);
		}
		return {
			rowId: row.id,
			attackerSpec: row.attackerSpec,
			attacks: row.attacks,
			seed: row.seed,
			n,
			m,
		};
	});

	const speciesName = el<HTMLInputElement>("species-name").value.trim();
	if (speciesName === "") {
		dialogStatusEl.textContent = "種族名が未入力です";
		return;
	}
	let baseStats: number[] | undefined;
	try {
		baseStats = (await baseStatsMapPromise).get(speciesName);
	} catch (err) {
		// マスターデータPromiseの失敗も未処理rejectionにせず、他の失敗と同じ共通領域で知らせる。
		console.error(err);
		dialogStatusEl.textContent = "種族値データを取得できませんでした";
		return;
	}
	if (!baseStats) {
		dialogStatusEl.textContent = "種族値データを取得できませんでした";
		return;
	}
	const fixedEvs = { atk: readEv("atk"), spa: readEv("spa"), spe: readEv("spe") };
	const currentNature = natureNameFromBoosts(currentPressedNatureKey("up"), currentPressedNatureKey("down"));

	const controller = new AbortController();
	activeAbortController = controller;
	setComputingState(true);
	// 進行中表示は画面全体の表記規約に合わせて三点リーダーを使う。
	progressTextEl.textContent = "計算を準備しています…";
	try {
		const result: SolveResult = await solveDurability(requirements, {
			engine: { calcLethalSequence, isEngineFatal, resetEngine },
			baseStats,
			fixedEvs,
			currentNature,
			buildDefenderSpec: (nature: string, evs: number[]): PokemonSpec => buildAttackerSpec({ nature, evs }),
			onProgress: (info) => {
				progressTextEl.textContent = `${info.phase}(${info.done}/${info.total})`;
			},
			signal: controller.signal,
		});
		if (result.infeasible) {
			// 解なしは計算エラーではない。入力値を保持したまま条件を緩めて再計算できるようにする。
			dialogStatusEl.textContent = "条件を満たす配分がありません";
			return;
		}
		dialogStatusEl.textContent = "";
		closeDialog();
		renderBulkAdjustResults(result, (candidate) => applyCandidateToLeftPanel(candidate));
		openDetailPanelOverlayIfNarrow();
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			// ユーザーによる中断。ダイアログは開いたままにする(条件を直してやり直せるように)。
			dialogStatusEl.textContent = "計算を中断しました";
		} else if (err instanceof EngineFatalError) {
			// 計算エンジンが致命的エラー(WebAssembly.RuntimeError等)で停止し、
			// resetEngine()での1回のリトライも失敗した状態(bulk-adjust-solver.ts参照)。
			// AbortErrorと同様ダイアログは開いたままにする(finallyでボタン・入力欄が
			// 再度有効になるため、条件はそのままで再実行できる)。
			console.error(err);
			dialogStatusEl.textContent = err.message;
		} else {
			console.error(err);
			dialogStatusEl.textContent = "計算に失敗しました。時間をおいて再度お試しください";
		}
	} finally {
		activeAbortController = null;
		setComputingState(false);
	}
}

// --- 結果クリック時: 左パネルの性格・努力値(H/B/D)を実際に更新する ---
// ⚠️ 最も壊しやすい箇所。#ev-hp/#ev-def/#ev-spd は.valueへの代入だけではinput/change
// どちらのイベントも発火せず、再計算(recalcStats)も自動保存(scheduleSave)も走らない
// (left-panel.ts:224のコメントに明記)。値を代入したうえで input/change 両方を
// bubbles:true で発火させる。性格は<select>ではなく#nature-up-{key}/#nature-down-{key}の
// ▲▼トグルボタンをクリックする方式(toggleNatureUp/toggleNatureDown、shared-core.ts)。
// 「同じものを再クリックすると解除、別のものをクリックすると差し替え」という既存の
// トグル仕様に沿って、現在の押下状態と目的の性格から必要なボタンだけをclick()する。
function currentPressedNatureKey(direction: "up" | "down"): StatKey | null {
	for (const key of STAT_KEYS) {
		if (key === "hp") continue;
		const btn = document.getElementById(`nature-${direction}-${key}`);
		if (btn?.getAttribute("aria-pressed") === "true") return key;
	}
	return null;
}

function applyNatureToLeftPanel(natureName: string): void {
	const target = NATURE_STAT_MODIFIERS[natureName] ?? { up: null, down: null };
	const currentUp = currentPressedNatureKey("up");
	const currentDown = currentPressedNatureKey("down");
	if (target.up !== currentUp) {
		const keyToClick = target.up ?? currentUp;
		if (keyToClick) (document.getElementById(`nature-up-${keyToClick}`) as HTMLButtonElement | null)?.click();
	}
	if (target.down !== currentDown) {
		const keyToClick = target.down ?? currentDown;
		if (keyToClick) (document.getElementById(`nature-down-${keyToClick}`) as HTMLButtonElement | null)?.click();
	}
}

function applyEvToLeftPanel(key: "hp" | "def" | "spd", value: number): void {
	const input = document.getElementById(`ev-${key}`) as HTMLInputElement | null;
	if (!input) return;
	input.value = String(value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function applyCandidateToLeftPanel(candidate: DurabilityCandidate): void {
	applyNatureToLeftPanel(candidate.nature);
	applyEvToLeftPanel("hp", candidate.evs.hp);
	applyEvToLeftPanel("def", candidate.evs.def);
	applyEvToLeftPanel("spd", candidate.evs.spd);
}
