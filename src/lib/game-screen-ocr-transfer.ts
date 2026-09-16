// ゲーム画面OCRの結果を /box から /box/new のフォームへ渡す。
// 写真そのものは渡さず、解析値だけを sessionStorage に置く
// (タブを閉じれば消える。他タブへ漏れない)。
import type { GameScreenOcrResult } from "./game-screen-ocr-parse";

export const GAME_SCREEN_OCR_TRANSFER_KEY = "poke-guide:game-screen-ocr-result";

export function saveGameScreenOcrResult(result: GameScreenOcrResult): void {
	window.sessionStorage.setItem(GAME_SCREEN_OCR_TRANSFER_KEY, JSON.stringify(result));
}

/** 保存された結果を取り出して消す(1回きり)。壊れた値でフォームを操作しないよう最低限の形だけ確認する。 */
export function takeGameScreenOcrResult(): GameScreenOcrResult | null {
	const raw = window.sessionStorage.getItem(GAME_SCREEN_OCR_TRANSFER_KEY);
	window.sessionStorage.removeItem(GAME_SCREEN_OCR_TRANSFER_KEY);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const candidate = parsed as Partial<GameScreenOcrResult>;
		if (typeof candidate.species !== "string" || !Array.isArray(candidate.stats) || !Array.isArray(candidate.moves)) return null;
		return candidate as GameScreenOcrResult;
	} catch {
		return null;
	}
}
