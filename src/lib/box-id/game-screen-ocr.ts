import { bindModalDismissal } from "../modal-dismiss";
import { loadAbilitiesMap, loadBaseStatsMap, loadLearnsetFor, loadPokemonMasterList } from "../pokemon-master-data";
import { STAT_KEYS, type StatKey } from "../stats";
import { mergeGameScreenOcrResults, parseGameScreenLines, type GameScreenOcrResult } from "../game-screen-ocr-parse";
import { preprocessGameScreenImage } from "../game-screen-ocr-image";

const fileInput = document.getElementById("game-screen-ocr-file") as HTMLInputElement | null;
const button = document.getElementById("game-screen-ocr-button") as HTMLButtonElement | null;
const backdrop = document.getElementById("game-screen-ocr-backdrop") as HTMLElement | null;
const dialog = document.getElementById("game-screen-ocr-dialog") as HTMLElement | null;
const closeButton = document.getElementById("game-screen-ocr-close") as HTMLButtonElement | null;
const cancelButton = document.getElementById("game-screen-ocr-cancel") as HTMLButtonElement | null;
const applyButton = document.getElementById("game-screen-ocr-apply") as HTMLButtonElement | null;
const progress = document.getElementById("game-screen-ocr-progress") as HTMLElement | null;
const resultEl = document.getElementById("game-screen-ocr-result") as HTMLElement | null;
const form = document.getElementById("edit-form") as HTMLFormElement | null;

let parsedResult: GameScreenOcrResult | null = null;

/** OCR処理の進捗メッセージをダイアログへ反映する。 */
function setProgress(text: string): void {
	if (progress) progress.textContent = text;
}

/** OCRダイアログを表示し、画像選択後の操作を受け付ける。 */
function openDialog(): void {
	if (!backdrop || !dialog) return;
	backdrop.hidden = false;
	dialog.hidden = false;
	dialog.focus();
}

/** OCRダイアログを閉じ、前回の解析結果と表示状態を初期化する。 */
function closeDialog(): void {
	if (!backdrop || !dialog) return;
	backdrop.hidden = true;
	dialog.hidden = true;
	parsedResult = null;
	if (resultEl) {
		resultEl.hidden = true;
		resultEl.replaceChildren();
	}
	if (applyButton) applyButton.hidden = true;
	setProgress("");
}

/** ステータスキーを画面表示用のラベルへ変換する。 */
function statLabel(key: StatKey): string {
	return ({ hp: "HP", atk: "こうげき", def: "ぼうぎょ", spa: "とくこう", spd: "とくぼう", spe: "すばやさ" })[key];
}

/** OCR結果の種族・性格・技・特性・ステータスをダイアログへ描画する。 */
function renderResult(result: GameScreenOcrResult): void {
	if (!resultEl || !applyButton) return;
	const summary = document.createElement("dl");
	for (const [label, value, warning] of [
		["種族", result.species ?? "照合できません", !result.species],
		["性格", result.nature, false],
		["わざ", result.moves.filter(Boolean).join(" / ") || "照合できません", result.moves.some((move) => move === null)],
		["特性", result.ability ?? "照合できません", !result.ability],
	] as Array<[string, string, boolean]>) {
		const term = document.createElement("dt");
		term.textContent = label;
		const detail = document.createElement("dd");
		detail.textContent = value;
		if (warning) detail.className = "game-screen-ocr-warning";
		summary.append(term, detail);
	}
	const stats = document.createElement("div");
	stats.className = "game-screen-ocr-stats";
	for (const stat of result.stats) {
		// [ラベル] / [実数値] / [努力値 ○×] の3行。○×は「種族値+努力値+推定性格から計算した実数値」と
		// 読み取った実数値が一致したか(不一致・未読は警告色)。
		const item = document.createElement("div");
		item.className = "game-screen-ocr-stat";
		const label = document.createElement("span");
		label.className = "game-screen-ocr-stat-label";
		label.textContent = statLabel(stat.key);
		const actual = document.createElement("span");
		actual.className = "game-screen-ocr-stat-actual";
		actual.textContent = stat.actual == null ? "?" : String(stat.actual);
		const ev = document.createElement("span");
		ev.className = "game-screen-ocr-stat-ev";
		ev.textContent = `努力値 ${stat.ev ?? "?"} ${stat.verified === true ? "○" : "×"}`;
		if (stat.verified !== true) item.classList.add("game-screen-ocr-warning");
		item.append(label, actual, ev);
		stats.appendChild(item);
	}
	resultEl.replaceChildren(summary, stats);
	resultEl.hidden = false;
	applyButton.hidden = !result.species;
}

/** OCRの複数閾値処理で再利用するキャンバスと元画素を準備する。 */
async function resizeForOcr(file: File): Promise<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; pixels: ImageData }> {
	const image = await createImageBitmap(file);
	const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(image.width * scale));
	canvas.height = Math.max(1, Math.round(image.height * scale));
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("OCR canvas is unavailable");
	context.drawImage(image, 0, 0, canvas.width, canvas.height);
	image.close();
	return { canvas, context, pixels: context.getImageData(0, 0, canvas.width, canvas.height) };
}

/** キャンバスの現在画像をPNG Blobへ変換する。 */
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("OCR image encoding failed")), "image/png"));
}

/** 複数の二値化閾値でOCRを実行し、解析結果をマージする。 */
async function recognize(file: File): Promise<GameScreenOcrResult> {
	setProgress("画像を準備中…");
	const image = await resizeForOcr(file);
	setProgress("言語データを読み込み中…");
	const { createWorker } = await import("tesseract.js");
	const thresholds = [170, 180, 190];
	let activePass = 0;
	const worker = await createWorker("jpn", 1, {
		langPath: "/tessdata",
		workerPath: "/tesseract/worker.min.js",
		corePath: "/tesseract/tesseract-core-lstm.wasm.js",
		logger: (message) => {
			if (message.status === "recognizing text") setProgress(`認識中 (${activePass + 1}/${thresholds.length}) ${Math.round(message.progress * 100)}%`);
			else if (message.status) setProgress(message.status.includes("loading language") ? "言語データを読み込み中…" : "認識エンジンを準備中…");
		},
	});
	try {
		const master = await loadPokemonMasterList();
		const rawPasses: string[][] = [];
		for (activePass = 0; activePass < thresholds.length; activePass++) {
			const preprocessed = preprocessGameScreenImage(image.pixels, thresholds[activePass]);
			image.context.putImageData(new ImageData(preprocessed.data, preprocessed.width, preprocessed.height), 0, 0);
			const recognized = await worker.recognize(await canvasBlob(image.canvas), { tessedit_pageseg_mode: "6" });
			rawPasses.push(recognized.data.text.split(/\r?\n/));
		}
		const initialData = { master, baseStats: undefined, learnset: [], abilities: [] };
		const first = mergeGameScreenOcrResults(rawPasses.map((lines) => parseGameScreenLines(lines, initialData)), initialData);
		const [baseStatsMap, learnset, abilitiesMap] = await Promise.all([
			loadBaseStatsMap(),
			first.species ? loadLearnsetFor(first.species) : Promise.resolve([]),
			loadAbilitiesMap(),
		]);
		const parseData = {
			master,
			baseStats: first.species ? baseStatsMap.get(first.species) : undefined,
			learnset,
			abilities: first.species ? abilitiesMap.get(first.species) ?? [] : [],
		};
		return mergeGameScreenOcrResults(rawPasses.map((lines) => parseGameScreenLines(lines, parseData)), parseData);
	} finally {
		await worker.terminate();
	}
}

/** 対象フォームの入力値を更新し、既存の入力イベント連携も発火させる。 */
function setInput(id: string, value: string): void {
	const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
	if (!input) return;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 推定した性格を編集パネルへ渡す(pokemon-edit-panel.ts の game-screen-ocr:set-nature リスナーが上昇/下降を直接セットする)。 */
function applyNature(nature: string): void {
	document.dispatchEvent(new CustomEvent("game-screen-ocr:set-nature", { detail: { nature } }));
}

/** OCR結果を編集フォームへ反映し、種族変更後に特性を設定する。 */
async function applyResult(): Promise<void> {
	if (!parsedResult?.species || !form) return;
	applyButton && (applyButton.disabled = true);
	form.dataset.gameScreenOcrApplying = "true";
	try {
		for (const stat of parsedResult.stats) if (stat.ev != null) setInput(`ev-${stat.key}`, String(stat.ev));
		applyNature(parsedResult.nature);
		for (let slot = 1; slot <= 4; slot++) {
			setInput(`move-${slot}`, parsedResult.moves[slot - 1] ?? "");
		}
		// 種族確定 → pokemon-edit-panel.ts が特性候補を再構築 → ability-options-ready を受けてから特性を入れる。
		// 種族が既に同じ値のとき(同じ結果を2回適用など)は input イベントが出ず ready が来ないので、タイムアウトで抜ける。
		const ready = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 3000);
			document.addEventListener("game-screen-ocr:ability-options-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
		document.dispatchEvent(new CustomEvent("game-screen-ocr:select-species", { detail: { name: parsedResult.species } }));
		await ready;
		if (parsedResult.ability) setInput("ability", parsedResult.ability);
		closeDialog();
		delete form.dataset.gameScreenOcrApplying;
		document.dispatchEvent(new Event("game-screen-ocr:commit"));
	} finally {
		delete form.dataset.gameScreenOcrApplying;
		if (applyButton) applyButton.disabled = false;
	}
}

if (fileInput && button && backdrop && dialog && closeButton && cancelButton && applyButton) {
	button.addEventListener("click", () => fileInput.click());
	fileInput.addEventListener("change", () => {
		const file = fileInput.files?.[0];
		fileInput.value = "";
		if (!file) return;
		openDialog();
		setProgress("読み取りを開始します…");
		void recognize(file).then((result) => {
			parsedResult = result;
			setProgress("");
			renderResult(result);
		}).catch((error: unknown) => setProgress(error instanceof Error ? error.message : "読み取りに失敗しました。"));
	});
	closeButton.addEventListener("click", closeDialog);
	cancelButton.addEventListener("click", closeDialog);
	applyButton.addEventListener("click", () => void applyResult());
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
	(window as typeof window & { openGameScreenOcrDemo?: () => void }).openGameScreenOcrDemo = () => {
		parsedResult = {
			species: "カイリュー",
			nature: "いじっぱり",
			stats: STAT_KEYS.map((key) => ({ key, actual: 100, ev: 0, verified: key !== "hp" })),
			moves: ["しんそく", null, null, null],
			ability: "マルチスケイル",
			confidence: {
				species: 1,
				stats: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
				moves: [1, 0, 0, 0],
				ability: 1,
			},
		};
		openDialog();
		renderResult(parsedResult);
	};
}
