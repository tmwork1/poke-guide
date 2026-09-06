/** Shared dismissal and background-interaction blocking for every modal. */
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
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "contextmenu", "touchstart", "touchend"] as const) {
		document.addEventListener(eventName, blockBackgroundInteraction, { capture: true, passive: false });
	}
}
