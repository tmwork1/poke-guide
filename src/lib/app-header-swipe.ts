// app-header(横タブ)の直下コンテンツ領域を左右にフリックしたとき、隣のタブへ切り替える。
// タブ項目(.app-header__item)は<button>(同一ページ内切り替え)と<a>(別ページへの
// リンク)の両方があり得るため、共通して.click()を呼ぶことで両方に対応する。

interface SwipeState {
	startX: number;
	startY: number;
	startTime: number;
	active: boolean;
}

const SWIPE_MIN_DISTANCE = 48;
const SWIPE_MAX_DURATION = 600;
const SWIPE_DIRECTION_RATIO = 1.5;

function isHorizontallyScrollable(el: Element): boolean {
	if (!(el instanceof HTMLElement)) return false;
	if (el.scrollWidth <= el.clientWidth) return false;
	const overflowX = getComputedStyle(el).overflowX;
	return overflowX === "auto" || overflowX === "scroll";
}

function startsInsideHorizontalScroller(target: EventTarget | null, contentEl: HTMLElement): boolean {
	let node: Element | null = target instanceof Element ? target : null;
	while (node && node !== contentEl.parentElement) {
		if (isHorizontallyScrollable(node)) return true;
		node = node.parentElement;
	}
	return false;
}

// 開いているモーダル(aria-modal="true")の中で始まったタッチは、モーダル自身が
// 独自のフリック操作(タブ切り替え等)を持ちうるため、背後のページのタブ切り替えには使わない。
// 例: ダメージ計算の詳細設定パネル(#damage-detail-panel、モバイルでは中央に浮くモーダル)は
// 本文を左右にフリックしてタブを切り替える独自ジェスチャーを持ち、フリック幅が大きいと
// この関数が無いと同じジェスチャーが背後のbox編集ページのタブ切り替えとしても誤検知されていた。
function startsInsideOpenModal(target: EventTarget | null, contentEl: HTMLElement): boolean {
	let node: Element | null = target instanceof Element ? target : null;
	while (node && node !== contentEl.parentElement) {
		if (node instanceof HTMLElement && node.getAttribute("aria-modal") === "true") return true;
		node = node.parentElement;
	}
	return false;
}

function tabItems(headerEl: HTMLElement): HTMLElement[] {
	return Array.from(headerEl.querySelectorAll<HTMLElement>(".app-header__item"));
}

function activeTabIndex(items: HTMLElement[]): number {
	return items.findIndex((item) => item.dataset.active === "true" || item.getAttribute("aria-current") === "page");
}

/**
 * app-header(横タブ)のコンテンツ領域(contentEl)を左右にフリックしたとき、
 * headerEl内の隣の .app-header__item へ切り替える(次のタブへ .click() する)。
 * headerEl/contentElのどちらかがnullなら何もしない。
 */
export function setupAppHeaderSwipe(headerEl: HTMLElement | null, contentEl: HTMLElement | null): void {
	if (!headerEl || !contentEl) return;

	let state: SwipeState | null = null;

	contentEl.addEventListener(
		"touchstart",
		(event) => {
			if (event.touches.length !== 1) {
				state = null;
				return;
			}
			const touch = event.touches[0];
			state = {
				startX: touch.clientX,
				startY: touch.clientY,
				startTime: event.timeStamp,
				active:
					!startsInsideHorizontalScroller(event.target, contentEl) &&
					!startsInsideOpenModal(event.target, contentEl),
			};
		},
		{ passive: true },
	);

	contentEl.addEventListener(
		"touchmove",
		(event) => {
			if (state && event.touches.length !== 1) state.active = false;
		},
		{ passive: true },
	);

	contentEl.addEventListener(
		"touchend",
		(event) => {
			const current = state;
			state = null;
			if (!current || !current.active) return;
			const touch = event.changedTouches[0];
			if (!touch) return;
			const dx = touch.clientX - current.startX;
			const dy = touch.clientY - current.startY;
			const dt = event.timeStamp - current.startTime;
			if (dt > SWIPE_MAX_DURATION) return;
			if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
			if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTION_RATIO) return;

			const items = tabItems(headerEl);
			const activeIndex = activeTabIndex(items);
			if (activeIndex === -1) return;
			const step = dx < 0 ? 1 : -1;
			let nextIndex = activeIndex + step;
			while (nextIndex >= 0 && nextIndex < items.length && items[nextIndex].classList.contains("is-disabled")) {
				nextIndex += step;
			}
			if (nextIndex < 0 || nextIndex >= items.length) return;
			items[nextIndex].click();
		},
		{ passive: true },
	);
}
