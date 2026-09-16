import { bindModalDismissal } from "../modal-dismiss";
import { loadAbilitiesMap, loadBaseStatsMap, loadLearnsetFor, loadPokemonMasterList } from "../pokemon-master-data";
import { isSameOwnedPokemon, mergeGameScreenOcrResults, parseGameScreenLines, type GameScreenOcrResult } from "../game-screen-ocr-parse";
import { listOwnedPokemonPage } from "../data/pokemon-repo";
import { preprocessGameScreenImage } from "../game-screen-ocr-image";
import { saveGameScreenOcrResult } from "../game-screen-ocr-transfer";

// 「カメラで撮影」は capture 付き、「写真を選ぶ」(カメラロール)は capture なしの file input をそれぞれ開く。
const cameraInput = document.getElementById("game-screen-ocr-camera-file") as HTMLInputElement | null;
const libraryInput = document.getElementById("game-screen-ocr-library-file") as HTMLInputElement | null;
const cameraButton = document.getElementById("game-screen-ocr-camera-button") as HTMLButtonElement | null;
const libraryButton = document.getElementById("game-screen-ocr-library-button") as HTMLButtonElement | null;
const backdrop = document.getElementById("game-screen-ocr-backdrop") as HTMLElement | null;
const dialog = document.getElementById("game-screen-ocr-dialog") as HTMLElement | null;
const closeButton = document.getElementById("game-screen-ocr-close") as HTMLButtonElement | null;
const picker = document.getElementById("game-screen-ocr-picker") as HTMLElement | null;
const progress = document.getElementById("game-screen-ocr-progress") as HTMLElement | null;

let busy = false;

/** OCR処理の進捗メッセージをダイアログへ反映する。 */
function setProgress(text: string): void {
	if (progress) progress.textContent = text;
}

/** 写真選択の案内と進捗表示を切り替える。 */
function setReadingState(reading: boolean): void {
	if (picker) picker.hidden = reading;
	if (progress) progress.hidden = !reading;
}

/** OCRダイアログを表示し、画像選択後の操作を受け付ける。 */
function openDialog(): void {
	if (!backdrop || !dialog) return;
	setReadingState(false);
	setProgress("");
	backdrop.hidden = false;
	dialog.hidden = false;
	dialog.focus();
}

/** OCRダイアログを閉じ、写真選択の表示状態へ戻す。 */
function closeDialog(): void {
	if (busy || !backdrop || !dialog) return;
	backdrop.hidden = true;
	dialog.hidden = true;
	setReadingState(false);
	setProgress("");
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

/** 同じ個体(種族・性格・努力値・わざが一致)が既に登録済みならそのIDを返す。一覧は更新順なので最新の1件。 */
async function findRegisteredPokemonId(result: GameScreenOcrResult): Promise<string | null> {
	const PAGE_SIZE = 48;
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const page = await listOwnedPokemonPage({ limit: PAGE_SIZE, offset });
		const found = page.data.find((owned) => isSameOwnedPokemon(result, owned));
		if (found) return found.id;
		if (!page.hasMore || page.data.length === 0) return null;
	}
}

async function readFile(input: HTMLInputElement): Promise<void> {
	const file = input.files?.[0];
	input.value = "";
	if (!file) return;
	busy = true;
	setReadingState(true);
	setProgress("読み取りを開始します…");
	try {
		const result = await recognize(file);
		if (!result.species) throw new Error("species not found");
		// 撮った個体が登録済みなら、新規に作らずそのポケモンの編集画面へ移る(busy のまま遷移するので閉じる操作は効かない)
		setProgress("登録済みのポケモンを確認中…");
		const registeredId = await findRegisteredPokemonId(result);
		if (registeredId) {
			window.location.href = `/box/${encodeURIComponent(registeredId)}`;
			return;
		}
		saveGameScreenOcrResult(result);
		window.location.href = "/box/new";
	} catch {
		busy = false;
		setProgress("");
		setReadingState(false);
		window.alert("ポケモンを読み取れませんでした。ボックス画面の右側が写るように撮り直してください。");
	}
}

if (cameraInput && libraryInput && cameraButton && libraryButton && backdrop && dialog && closeButton && picker && progress) {
	cameraButton.addEventListener("click", () => cameraInput.click());
	libraryButton.addEventListener("click", () => libraryInput.click());
	cameraInput.addEventListener("change", () => void readFile(cameraInput));
	libraryInput.addEventListener("change", () => void readFile(libraryInput));
	closeButton.addEventListener("click", closeDialog);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
	document.addEventListener("game-screen-ocr:open", openDialog);
}
