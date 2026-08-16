/** Shared backdrop-click and Escape dismissal for every modal. */
export function bindModalDismissal({
	backdrop,
	isOpen,
	onDismiss,
}: {
	backdrop: HTMLElement;
	isOpen: () => boolean;
	onDismiss: () => void;
}): void {
	backdrop.addEventListener("click", () => {
		if (isOpen()) onDismiss();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && isOpen()) onDismiss();
	});
}
