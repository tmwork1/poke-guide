/** Shared dismissal and background-interaction blocking for every modal. */

/** モーダル自身のポップアップをdocument.body直下へ逃がす(ポータルする)ときに付ける印。
 *  下のblockBackgroundInteractionはDOM上の包含関係でモーダル内外を判定するため、
 *  ポータルした要素はこの印が無いと「モーダルの外側」と見なされ、
 *  pointerdown/clickがキャプチャ段階で握り潰されて一切操作できなくなる
 *  (例: 努力値ピッカー .number-stepper-picker は position:fixed で表示するため
 *   body直下へ移す)。 */
const MODAL_PORTAL_ATTR = "data-modal-portal";
/** ポータルした要素かを判定するためのセレクタ(「モーダル外クリック」判定を持つ側が使う)。 */
export const MODAL_PORTAL_SELECTOR = `[${MODAL_PORTAL_ATTR}]`;

/** document.body直下へ逃がすポップアップに印を付ける。 */
export function markModalPortal(element: Element): void {
	element.setAttribute(MODAL_PORTAL_ATTR, "");
}

function isModalPortalTarget(target: Node | null): boolean {
	const element = target instanceof Element ? target : target?.parentElement ?? null;
	return !!element?.closest(MODAL_PORTAL_SELECTOR);
}

function isAppBottomNavTarget(target: Node | null): boolean {
	const element = target instanceof Element ? target : target?.parentElement ?? null;
	return !!element?.closest(".app-bottom-nav");
}

export function bindModalDismissal({
	backdrop,
	dialog,
	isOpen,
	onDismiss,
}: {
	backdrop: HTMLElement;
	dialog: HTMLElement;
	isOpen: () => boolean;
	onDismiss: () => void;
}): void {
	backdrop.addEventListener("click", () => {
		if (isOpen()) onDismiss();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && isOpen()) onDismiss();
	});

	// 長押し後にブラウザが再発火する互換mouseイベントを含め、モーダルの外側を
	// 対象にした操作はキャプチャ段階で止める。backdropは従来どおり閉じる操作として通す。
	const blockBackgroundInteraction = (event: Event): void => {
		if (!isOpen()) return;
		const target = event.target as Node | null;
		if (target && (dialog.contains(target) || backdrop.contains(target))) return;
		if (isModalPortalTarget(target)) return;
		// 下部ナビはモーダルより前面に表示しているため、リンク遷移を妨げない。
		if (isAppBottomNavTarget(target)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "contextmenu", "touchstart", "touchend"] as const) {
		document.addEventListener(eventName, blockBackgroundInteraction, { capture: true, passive: false });
	}
}
