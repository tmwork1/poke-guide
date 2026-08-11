/**
 * 可算カード用の削除モード。カード本体を長押しすると、同じ一覧内の削除操作を
 * まとめて表示する。個々の削除処理は各画面が引き続き担当する。
 */
export function initializeCardDeleteMode(
	container: HTMLElement,
	cardSelector: string,
	deleteButtonSelector: string,
): void {
	const LONG_PRESS_MS = 600;
	let pressTimer: ReturnType<typeof window.setTimeout> | undefined;
	let suppressNextClick = false;
	let isActive = false;

	const cards = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(cardSelector));
	const exit = (): void => {
		if (!isActive) return;
		isActive = false;
		container.classList.remove("is-card-delete-mode");
		cards().forEach((card) => card.classList.remove("is-delete-mode"));
	};
	const enter = (): void => {
		if (isActive) return;
		isActive = true;
		suppressNextClick = true;
		container.classList.add("is-card-delete-mode");
		cards().forEach((card) => card.classList.add("is-delete-mode"));
	};
	const clearPress = (): void => {
		if (pressTimer !== undefined) window.clearTimeout(pressTimer);
		pressTimer = undefined;
	};
	const cardFor = (target: EventTarget | null): HTMLElement | null => {
		const card = target instanceof Element ? target.closest<HTMLElement>(cardSelector) : null;
		return card && container.contains(card) ? card : null;
	};
	const isControl = (target: EventTarget | null, card: HTMLElement): boolean => {
		if (!(target instanceof Element)) return true;
		const control = target.closest("button, input, textarea, select, option, label, [contenteditable='true']");
		return control !== null && control !== card;
	};

	container.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || isActive) return;
		const card = cardFor(event.target);
		if (!card || !container.contains(card) || isControl(event.target, card)) return;
		pressTimer = window.setTimeout(enter, LONG_PRESS_MS);
	});
	container.addEventListener("pointerup", clearPress);
	container.addEventListener("pointercancel", clearPress);
	container.addEventListener("pointerleave", clearPress);
	container.addEventListener("contextmenu", (event) => {
		if (pressTimer !== undefined || isActive) event.preventDefault();
	});
	// iPhoneのホーム画面と同じく、カードではない場所をタップするとモードを抜ける。
	document.addEventListener("pointerdown", (event) => {
		if (isActive && !cardFor(event.target)) exit();
	});
	container.addEventListener("click", (event) => {
		const card = cardFor(event.target);
		const isDeleteButton = event.target instanceof Element && event.target.closest(deleteButtonSelector);
		if (isActive && card && !isDeleteButton) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (!suppressNextClick) return;
		suppressNextClick = false;
		event.preventDefault();
		event.stopPropagation();
	}, true);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") exit();
	});
}
