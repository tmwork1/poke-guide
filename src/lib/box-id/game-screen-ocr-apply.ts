// /box/new で、/box から sessionStorage 経由で渡されたゲーム画面OCRの結果を登録フォームへ反映する。
// ここではダイアログを出さずに反映→保存まで進める。
// フォームとの連携は pokemon-edit-panel.ts / species-select-dialog.ts のカスタムイベント
// (game-screen-ocr:set-nature / select-species / ability-options-ready / commit)で行う。
import type { GameScreenOcrResult } from "../game-screen-ocr-parse";
import { takeGameScreenOcrResult } from "../game-screen-ocr-transfer";

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
async function applyResult(result: GameScreenOcrResult): Promise<void> {
	const form = document.getElementById("edit-form") as HTMLFormElement | null;
	if (!result.species || !form) return;
	// 反映中は pokemon-edit-panel.ts の自動保存・種族確定時の自動入力を止め、最後の commit で1回だけ保存する
	form.dataset.gameScreenOcrApplying = "true";
	try {
		for (const stat of result.stats) if (stat.ev != null) setInput(`ev-${stat.key}`, String(stat.ev));
		applyNature(result.nature);
		for (let slot = 1; slot <= 4; slot++) setInput(`move-${slot}`, result.moves[slot - 1] ?? "");
		// 種族確定 → pokemon-edit-panel.ts が特性候補を再構築 → ability-options-ready を受けてから特性を入れる。
		// ready が来ないケース(種族が既に同じ値など)に備えてタイムアウトで抜ける。
		const ready = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 3000);
			document.addEventListener("game-screen-ocr:ability-options-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
		document.dispatchEvent(new CustomEvent("game-screen-ocr:select-species", { detail: { name: result.species } }));
		await ready;
		if (result.ability) setInput("ability", result.ability);
		delete form.dataset.gameScreenOcrApplying;
		document.dispatchEvent(new Event("game-screen-ocr:commit"));
	} finally {
		delete form.dataset.gameScreenOcrApplying;
	}
}

// このモジュールはページ内の他の module script(フォーム側のリスナー登録)より先に評価されるので、
// 全スクリプトの実行が終わる load まで待ってから反映する。DOMContentLoaded では不十分
// (astro dev では module script の評価より先に発火し、リスナーが呼ばれないことを実測済み)。
function applyTransferredResult(): void {
	if (window.location.pathname !== "/box/new") return;
	const result = takeGameScreenOcrResult();
	if (result) void applyResult(result);
}
if (document.readyState === "complete") applyTransferredResult();
else window.addEventListener("load", applyTransferredResult);
