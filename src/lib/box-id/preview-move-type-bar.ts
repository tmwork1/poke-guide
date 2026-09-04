// ポケモンプレビュー(.pokemon-preview、MobilePokemonPreview.astro)の技タイプバー
// (#pokemon-preview-move-type-{slot})を塗る共通ロジック。
//
// 編集フォームがある育成タブ(left-panel.ts)と、フォームを持たない読み取り専用タブ
// (バトルデータ/上位チーム/相性、MobilePokemonPreview.astroの<script>から直接呼ぶ)の両方から
// 共有する。以前は左パネル側にだけこの処理があり、読み取り専用タブでは技名の左のバーが
// 常にhiddenのまま塗られなかった。
import { loadMoveTypeMap } from "../pokemon-master-data";
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from "../type-colors";

const moveTypeMapPromise = loadMoveTypeMap();

/**
 * isStale: 非同期解決後に呼び出し側が「もうこのmoveNameの結果は不要」と判定するための関数。
 * 省略時は常に反映する(読み取り専用タブなど、技名が後から変わらない場合)。
 */
export function applyPreviewMoveTypeBar(slot: number, moveName: string, isStale?: () => boolean): void {
	const bar = document.getElementById(`pokemon-preview-move-type-${slot}`) as HTMLElement | null;
	if (!bar) return;
	bar.hidden = true;
	bar.style.removeProperty("background-color");
	if (!moveName) return;
	void moveTypeMapPromise.then((moveTypeMap) => {
		if (isStale?.()) return;
		const type = moveTypeMap.get(moveName);
		if (!type) return;
		bar.style.backgroundColor = TYPE_COLORS[type] ?? DEFAULT_TYPE_COLOR;
		bar.hidden = false;
	});
}

/** SSR済みの#pokemon-preview-move-{slot}のテキストから技名を読み取り、4枠ぶん一括で塗る。 */
export function applyPreviewMoveTypeBarsFromDom(): void {
	for (let slot = 1; slot <= 4; slot++) {
		const text = document.getElementById(`pokemon-preview-move-${slot}`)?.textContent?.trim() ?? "";
		applyPreviewMoveTypeBar(slot, text === "-" ? "" : text);
	}
}
