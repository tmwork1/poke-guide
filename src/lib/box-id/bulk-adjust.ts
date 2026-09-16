// ダメージタブ下部のステータス調整シートにある #bulk-adjust-button を押すと、防御方向
// (相手→自分)のダメージ計算カードだけを圧縮表示した
// ポップアップ(src/components/box-id/BulkAdjustDialog.astro)を開く。カードごとに
// 「N発(加算計算の行はNセット)をM%以上の確率で耐える」の N・M を入力し、ダイアログ内の「計算」ボタンを押すと
// src/lib/box-id/bulk-adjust-solver.ts の solveDurability() で
// 条件を満たす性格・努力値(H/B/D)の組み合わせを探索する。結果はダメージ詳細パネル
// (src/lib/box-id/damage-detail-panel.ts の renderBulkAdjustResults)に一覧表示し、一覧をクリックすると
// 育成パネルの性格・努力値を実際に書き換える。
//
// このファイルは src/components/box-id/BulkAdjustDialog.astro の <script> から
// 副作用importされ、モジュール読み込み時に自身で初期化する(PokemonEditPanel.astro/pokemon-edit-panel.ts、
// DamageCalcSection.astro/damage-calc.tsと同じ構成)。BulkAdjustDialog.astroは
// box/[id].astro側で PokemonEditPanel/DamageCalcSection/DamageDetailPanel と同じ「pokemonが存在する
// ときだけ描画される」分岐の中に置かれているため、#bulk-adjust-button・
// #opponent-notes-section・#damage-detail-panel等はこのファイルの実行時に必ず存在する
// (存在しない場合はel()がthrowする。pokemon-edit-panel.ts/damage-calc.tsと同じ前提)。
import { el, readEv } from "../owned-pokemon-form";
import { bindModalDismissal } from "../modal-dismiss";
import {
	getBulkAdjustBridge,
	buildAttackerSpec,
	baseStatsMapPromise,
	natureNameFromBoosts,
	nextNatureBoosts,
	type BulkAdjustRowSnapshot,
} from "./shared-core";
import {
	initEngine,
	calcLethalSequence,
	isEngineFatal,
	resetEngine,
	type EngineProgress,
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
import { renderBulkAdjustResults, openDetailPanelOverlay } from "./damage-detail-panel";

const bulkAdjustButton = el<HTMLButtonElement>("bulk-adjust-button");
const backdropEl = el<HTMLElement>("bulk-adjust-backdrop");
const dialogEl = el<HTMLElement>("bulk-adjust-dialog");
const dialogComputeButton = el<HTMLButtonElement>("bulk-adjust-dialog-compute-button");
const dialogCloseButton = el<HTMLButtonElement>("bulk-adjust-dialog-close-button");
const dialogBodyInnerEl = el<HTMLElement>("bulk-adjust-dialog-body-inner");
const cancelButton = el<HTMLButtonElement>("bulk-adjust-cancel-button");
const progressTextEl = el<HTMLElement>("bulk-adjust-progress-text");

// カードのCSSは祖先に id="opponent-notes-section" を持つ要素があることを前提にした
// セレクタになっている。このダイアログの静的マークアップは
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
// ダイアログに残っている行=計算対象、という単純な対応にする(削除された行はこのMapからも消える)。
const rowInputEls = new Map<string, { nInput: HTMLInputElement; mInput: HTMLInputElement }>();
let activeAbortController: AbortController | null = null;

function includedRowCount(): number {
	return rowInputEls.size;
}

function updateComputeButtonDisabled(): void {
	const hasIncludedRows = includedRowCount() > 0;
	dialogComputeButton.disabled = isComputing || !hasIncludedRows;
	dialogComputeButton.title = hasIncludedRows ? "" : "計算対象の攻撃がありません";
}

// 画面側の確定数表示が最大10発(加算計算なら10セット)までを扱うため、入力・探索も同じ範囲にそろえる。
const MAX_ATTACK_COUNT = 10;

// 現在のカードに表示済みの累計確定数(「確N」。加算計算の行ではセット数)を初期値に使う。
// 計算前・10発以上・エラー表示など数値を取り出せない場合だけ、従来値1へフォールバックする。
function currentConfirmedCount(preview: HTMLElement | null): number | null {
	const text = preview?.querySelector<HTMLElement>(".damage-row-total-result .damage-result-verdict")?.textContent?.trim();
	const match = text?.match(/^確(\d+)$/);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 1 && n <= MAX_ATTACK_COUNT ? n : null;
}

// ダイアログを開いていない間だけ、防御カードが1枚以上なら有効化する。
// BulkAdjustBridgeには行の増減・名前変更を通知する購読機構が無く、
// かつ相手ポケモン名や技名の入力(input.valueの変更)はDOM属性の変化を伴わずMutationObserverでは
// 拾えないため、軽い間隔ポーリングで最新状態に追随させる(600ms間隔。getDefenseRows()は
// 既存行配列を読むだけの軽量処理のため負荷は無視できる)。
function updateBulkAdjustButtonReadyState(): void {
	if (isDialogOpen || isComputing) return;
	const bridge = getBulkAdjustBridge();
	const ready = !!bridge && bridge.getDefenseRows().length > 0;
	bulkAdjustButton.disabled = !ready;
	bulkAdjustButton.title = ready ? "耐久調整(守カードの条件を満たす努力値配分を探す)" : "守カードを追加すると耐久調整が使えます";
	bulkAdjustButton.setAttribute("aria-label", ready ? "耐久調整" : "守カードを追加すると耐久調整が使えます");
}
// Pyodide約5.5MBは、実際にボタンを押した時点で初期化する。
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
	const preview = bridge.buildCardPreview(row.id);
	if (preview) {
		previewWrap.appendChild(preview);
	}
	wrap.appendChild(previewWrap);

	// 削除ボタンで消すのは調整ウィンドウ上の行だけで、VSタブのカードには影響しない。
	// currentRows(=VSタブの実カードのスナップショット)には手を触れず、この行のDOMと
	// rowInputElsの登録だけを消す。runCompute()は rowInputEls に残っている行だけを
	// ソルバへ渡すので、消した行は今回の計算から外れる。次にダイアログを開き直すと
	// getDefenseRows()から作り直されるため、また現れる(=VSタブ側は無傷)。
	const removeButton = document.createElement("button");
	removeButton.type = "button";
	removeButton.className = "btn-ghost bulk-adjust-row-remove";
	removeButton.textContent = "×";
	removeButton.title = "この攻撃を耐久調整から外す";
	removeButton.setAttribute("aria-label", `${row.name}の攻撃を耐久調整から外す(VSタブのカードは残ります)`);
	removeButton.addEventListener("click", () => {
		if (isComputing) return;
		rowInputEls.delete(row.id);
		wrap.remove();
		updateComputeButtonDisabled();
	});
	wrap.appendChild(removeButton);

	const inputsRow = document.createElement("div");
	inputsRow.className = "bulk-adjust-row-inputs";

	const nLabel = document.createElement("label");
	const nLabelTextBefore = document.createElement("span");
	// 誰の攻撃かは直上のカード(ドット絵+特性+実数値)で分かるので種族名は省く。
	// aria-labelは読み上げだけが頼りなので、種族名を含めたままにする。
	nLabelTextBefore.textContent = "攻撃";
	// 技が2つ以上(加算計算)の行は、確定数を技列1巡=1セット単位で数える
	// (bulk-adjust-solver.ts の DurabilityRequirement.n 参照)ため、単位を「セット」と表記する。
	const unit = row.attacks.length >= 2 ? "セット" : "発";
	const nInput = document.createElement("input");
	nInput.type = "number";
	nInput.className = "bulk-adjust-n-input tnum";
	nInput.min = "1";
	nInput.max = String(MAX_ATTACK_COUNT);
	nInput.step = "1";
	nInput.inputMode = "numeric";
	// 開く時点の努力値配分に対する確定数を優先し、努力値変更後に古い入力値を持ち越さない。
	nInput.value = String(currentConfirmedCount(preview) ?? 1);
	nInput.setAttribute("aria-label", `${row.name}の攻撃を何${unit}耐えるか(${unit})`);
	const nLabelTextAfter = document.createElement("span");
	nLabelTextAfter.textContent = `${unit}を`;
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
	mLabelTextAfter.textContent = "%以上で耐える";
	mLabel.append(mInput, mLabelTextAfter);

	inputsRow.append(nLabel, mLabel);
	wrap.appendChild(inputsRow);

	rowInputEls.set(row.id, { nInput, mInput });
	return wrap;
}

// --- 開閉 ---
function openDialog(): void {
	const bridge = getBulkAdjustBridge();
	if (!bridge) return;
	currentRows = bridge.getDefenseRows();
	rowInputEls.clear();
	dialogBodyInnerEl.innerHTML = "";
	progressTextEl.textContent = "";
	if (currentRows.length === 0) {
		// 0件のときはポップアップを開かない(ボタンはdisabledのはずだが、行の削除等の
		// タイミングで開いてしまった場合の防御的フォールバック)。
		return;
	}
	for (const row of currentRows) {
		dialogBodyInnerEl.appendChild(buildRowEl(bridge, row));
	}
	updateComputeButtonDisabled();
	backdropEl.hidden = false;
	dialogEl.hidden = false;
	isDialogOpen = true;
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
	updateBulkAdjustButtonReadyState();
	bulkAdjustButton.focus();
}

function renderEnginePreparationProgress(progress: EngineProgress): void {
	if (!isDialogOpen) return;
	if (progress.status === "ready") {
		progressTextEl.textContent = "";
	} else if (progress.status === "error") {
		progressTextEl.textContent = "";
		progressTextEl.textContent = "計算エンジンを準備できませんでした";
	} else {
		progressTextEl.textContent = "計算エンジンを準備中…";
	}
}

function prepareEngine(): Promise<void> {
	return initEngine(renderEnginePreparationProgress).then(() => undefined);
}

bulkAdjustButton.addEventListener("click", () => {
	if (isComputing || isDialogOpen) return;
	openDialog();
	void prepareEngine().catch((err) => {
		console.error(err);
	});
});
// ダイアログ内の「計算」が唯一の計算実行ボタン。
dialogComputeButton.addEventListener("click", () => {
	if (isComputing) return;
	void runCompute();
});
dialogCloseButton.addEventListener("click", closeDialog);
bindModalDismissal({ backdrop: backdropEl, dialog: dialogEl, isOpen: () => isDialogOpen, onDismiss: closeDialog });
cancelButton.addEventListener("click", () => {
	activeAbortController?.abort();
});

// --- 計算 ---
function setComputingState(computing: boolean): void {
	isComputing = computing;
	dialogComputeButton.hidden = computing;
	cancelButton.hidden = !computing;
	bulkAdjustButton.disabled = computing;
	updateComputeButtonDisabled();
	// rowInputElsに残っている行だけが計算対象なので、計算中かどうかだけで入力欄の可否を決める。
	for (const { nInput, mInput } of rowInputEls.values()) {
		nInput.disabled = computing;
		mInput.disabled = computing;
	}
	// 削除ボタン(×)も計算中は押させない(押しても no-op だが、押せるように見えるのを避ける)。
	for (const button of dialogBodyInnerEl.querySelectorAll<HTMLButtonElement>(".bulk-adjust-row-remove")) {
		button.disabled = computing;
	}
}

async function runCompute(): Promise<void> {
	const bridge = getBulkAdjustBridge();
	if (!bridge || currentRows.length === 0) {
		// 対象行が無いときは「計算」ボタン自体がdisabledなので、ここは防御的な早期returnのみ。
		return;
	}
	progressTextEl.textContent = "";

	// ×で外した行はソルバへ渡す前に除外し、ソルバ側の契約を変えない
	// (判定は「rowInputElsにまだ登録が残っているか」)。
	const includedRows = currentRows.filter((row) => rowInputEls.has(row.id));
	if (includedRows.length === 0) {
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
		progressTextEl.textContent = "種族名が未入力です";
		return;
	}
	let baseStats: number[] | undefined;
	try {
		baseStats = (await baseStatsMapPromise).get(speciesName);
	} catch (err) {
		// マスターデータPromiseの失敗も未処理rejectionにせず、他の失敗と同じ共通領域で知らせる。
		console.error(err);
		progressTextEl.textContent = "種族値データを取得できませんでした";
		return;
	}
	if (!baseStats) {
		progressTextEl.textContent = "種族値データを取得できませんでした";
		return;
	}
	const fixedEvs = { atk: readEv("atk"), spa: readEv("spa"), spe: readEv("spe") };
	const currentBoosts = currentEditNatureBoosts();
	const currentNature = natureNameFromBoosts(currentBoosts.up, currentBoosts.down);

	const controller = new AbortController();
	activeAbortController = controller;
	setComputingState(true);
	// エンジン未準備ならここでロードを待つ。準備済みの場合もシングルトンのPromiseを
	// そのまま待つだけなので、計算経路を分けずに済む。
	progressTextEl.textContent = "計算エンジンを準備中…";
	try {
		await prepareEngine();
		progressTextEl.textContent = "計算を準備しています…";
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
			progressTextEl.textContent = "条件を満たす配分がありません";
			return;
		}
		progressTextEl.textContent = "";
		closeDialog();
		renderBulkAdjustResults(result, (candidate) => applyCandidateToPokemonEditPanel(candidate));
		openDetailPanelOverlay();
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			// ユーザーによる中断。ダイアログは開いたままにする(条件を直してやり直せるように)。
			progressTextEl.textContent = "計算を中断しました";
		} else if (err instanceof EngineFatalError) {
			// 計算エンジンが致命的エラー(WebAssembly.RuntimeError等)で停止し、
			// resetEngine()での1回のリトライも失敗した状態(bulk-adjust-solver.ts参照)。
			// AbortErrorと同様ダイアログは開いたままにする(finallyでボタン・入力欄が
			// 再度有効になるため、条件はそのままで再実行できる)。
			console.error(err);
			progressTextEl.textContent = err.message;
		} else {
			console.error(err);
			progressTextEl.textContent = "計算に失敗しました。時間をおいて再度お試しください";
		}
	} finally {
		activeAbortController = null;
		setComputingState(false);
	}
}

// --- 結果クリック時: 育成パネルの性格・努力値(H/B/D)を実際に更新する ---
// ⚠️ 最も壊しやすい箇所。#ev-hp/#ev-def/#ev-spd は.valueへの代入だけではinput/change
// どちらのイベントも発火せず、再計算(recalcStats)も自動保存(scheduleSave)も走らない
// (pokemon-edit-panel.ts:224のコメントに明記)。値を代入したうえで input/change 両方を
// bubbles:true で発火させる。性格は<select>ではなく#nature-toggle-{key}の単一ボタンを
// クリックする方式(nextNatureBoosts、shared-core.ts)。遷移規則そのものを使って、現在と
// 目的の状態の間のクリック順を探索してclick()する。
function currentEditNatureBoosts(): { up: StatKey | null; down: StatKey | null } {
	let up: StatKey | null = null;
	let down: StatKey | null = null;
	for (const key of STAT_KEYS) {
		if (key === "hp") continue;
		const state = document.getElementById(`nature-toggle-${key}`)?.dataset.natureState;
		if (state === "up") up = key;
		else if (state === "down") down = key;
	}
	return { up, down };
}

type Boosts = { up: StatKey | null; down: StatKey | null };

function boostsKey(boosts: Boosts): string {
	return `${boosts.up ?? ""}:${boosts.down ?? ""}`;
}

function planNatureClicks(current: Boosts, target: Boosts): StatKey[] {
	const targetKey = boostsKey(target);
	if (boostsKey(current) === targetKey) return [];

	const nonHpKeys = STAT_KEYS.filter((key) => key !== "hp");
	const visited = new Set<string>([boostsKey(current)]);
	const queue: Array<{ state: Boosts; path: StatKey[] }> = [{ state: current, path: [] }];

	while (queue.length > 0) {
		const { state, path } = queue.shift()!;
		for (const key of nonHpKeys) {
			const next = nextNatureBoosts(state, key);
			const nextKey = boostsKey(next);
			if (visited.has(nextKey)) continue;
			const nextPath = [...path, key];
			if (nextKey === targetKey) return nextPath;
			visited.add(nextKey);
			queue.push({ state: next, path: nextPath });
		}
	}

	// 到達できない場合（理論上は起こらない）はクリックしない。
	return [];
}

function applyNatureToPokemonEditPanel(natureName: string): void {
	const target = NATURE_STAT_MODIFIERS[natureName] ?? { up: null, down: null };
	const current = currentEditNatureBoosts();
	const clicks = planNatureClicks(current, target);
	for (const key of clicks) {
		(document.getElementById(`nature-toggle-${key}`) as HTMLButtonElement | null)?.click();
	}
}

function applyEvToPokemonEditPanel(key: "hp" | "def" | "spd", value: number): void {
	const input = document.getElementById(`ev-${key}`) as HTMLInputElement | null;
	if (!input) return;
	input.value = String(value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function applyCandidateToPokemonEditPanel(candidate: DurabilityCandidate): void {
	applyNatureToPokemonEditPanel(candidate.nature);
	applyEvToPokemonEditPanel("hp", candidate.evs.hp);
	applyEvToPokemonEditPanel("def", candidate.evs.def);
	applyEvToPokemonEditPanel("spd", candidate.evs.spd);
}
