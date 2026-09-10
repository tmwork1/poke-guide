import {
	championSpriteIconUrl,
	championSpriteMediumUrl,
	championSpriteUrl,
	loadImageIdMap,
	officialArtworkUrl,
} from "./pokemon-master-data";
import { itemIconUrl } from "./sprite-urls";

const imageIdMapPromise = loadImageIdMap();

export type CompactPokemonSpriteVariant = "icon" | "medium" | "full";

export interface CompactPokemonSpriteOptions {
	/** 画像を出せないときに、頭文字の代わりに隠す要素。 */
	hideContainer?: HTMLElement;
}

function hideFallback(fallbackEl: HTMLElement): void {
	fallbackEl.hidden = true;
	fallbackEl.style.display = "";
}

function showInitialFallback(fallbackEl: HTMLElement, name: string): void {
	fallbackEl.hidden = false;
	fallbackEl.style.display = "flex";
	fallbackEl.textContent = name ? name.charAt(0) : "?";
}

/**
 * コンパクト表示用のポケモン画像を適用する。
 *
 * variant は一次URLを選ぶ(既定は6列タイル用の icon WebP)。box-id/shared-core.ts の
 * applySprite と同じ意味にそろえてあり、"full" だけは Champions PNG が一次なので
 * PNGへの退避段を飛ばす。退避順は 一次URL → Champions PNG → 公式絵 →
 * 頭文字(または hideContainer によるラッパー非表示)。
 *
 * ⚠️ 大きめに表示する画像(個体編集パネルの種族絵、team-overview-preview-card など)へ
 * icon WebP を使うと解像度が足りない。呼び出し側で variant を明示すること。
 */
export async function applyCompactPokemonSprite(
	imgEl: HTMLImageElement,
	fallbackEl: HTMLElement | null,
	name: string,
	variant: CompactPokemonSpriteVariant = "icon",
	options: CompactPokemonSpriteOptions = {},
): Promise<void> {
	// hidden の間にも必ず取得できるよう、lazy 読み込みにはしない。
	imgEl.loading = "eager";
	imgEl.hidden = true;
	if (fallbackEl) hideFallback(fallbackEl);
	if (options.hideContainer) options.hideContainer.hidden = true;

	const imageId = name ? (await imageIdMapPromise).get(name) : undefined;
	const showUnavailable = (): void => {
		imgEl.hidden = true;
		imgEl.removeAttribute("src");
		if (options.hideContainer) {
			options.hideContainer.hidden = true;
			return;
		}
		if (fallbackEl) showInitialFallback(fallbackEl, name);
	};
	if (imageId == null) {
		showUnavailable();
		return;
	}

	let triedPngFallback = false;
	let triedArtworkFallback = false;
	imgEl.onerror = () => {
		if (variant !== "full" && !triedPngFallback) {
			triedPngFallback = true;
			imgEl.src = championSpriteUrl(imageId);
			return;
		}
		if (!triedArtworkFallback) {
			triedArtworkFallback = true;
			imgEl.src = officialArtworkUrl(imageId);
			return;
		}
		showUnavailable();
	};
	imgEl.onload = () => {
		imgEl.hidden = false;
		if (fallbackEl) hideFallback(fallbackEl);
		if (options.hideContainer) options.hideContainer.hidden = false;
	};
	imgEl.src =
		variant === "icon"
			? championSpriteIconUrl(imageId)
			: variant === "medium"
				? championSpriteMediumUrl(imageId)
				: championSpriteUrl(imageId);
}

/** 持ち物アイコンを適用し、読込失敗時はアイコン（および任意のラッパー）を隠す。 */
export function applyCompactItemIcon(
	imgEl: HTMLImageElement,
	itemName: string,
	visibilityEl?: HTMLElement,
): void {
	imgEl.loading = "eager";
	const hide = (): void => {
		imgEl.hidden = true;
		imgEl.removeAttribute("src");
		if (visibilityEl) visibilityEl.hidden = true;
	};
	const name = itemName.trim();
	if (!name) {
		hide();
		return;
	}
	imgEl.hidden = true;
	if (visibilityEl) visibilityEl.hidden = true;
	imgEl.onerror = hide;
	imgEl.onload = () => {
		imgEl.hidden = false;
		if (visibilityEl) visibilityEl.hidden = false;
	};
	imgEl.src = itemIconUrl(name);
}
