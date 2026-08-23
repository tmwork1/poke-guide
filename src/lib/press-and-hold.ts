/**
 * 通常クリックを保ちつつ、長押し時だけ一定間隔で操作を繰り返す。
 * callback が false を返した場合は、値が端に達したものとして繰り返しを止める。
 */
export function bindPressAndHold(
	button: HTMLButtonElement,
	activate: () => boolean,
	{ delay = 350, interval = 75 }: { delay?: number; interval?: number } = {},
): void {
	let delayTimer: number | undefined;
	let repeatTimer: number | undefined;
	let repeated = false;
	let suppressNextClick = false;

	const stop = () => {
		if (delayTimer !== undefined) window.clearTimeout(delayTimer);
		if (repeatTimer !== undefined) window.clearInterval(repeatTimer);
		delayTimer = undefined;
		repeatTimer = undefined;
		if (repeated) suppressNextClick = true;
	};
	const run = (): boolean => {
		const changed = activate();
		if (!changed) stop();
		return changed;
	};

	button.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || button.disabled) return;
		repeated = false;
		button.setPointerCapture?.(event.pointerId);
		delayTimer = window.setTimeout(() => {
			delayTimer = undefined;
			repeated = true;
			if (run()) repeatTimer = window.setInterval(run, interval);
		}, delay);
	});
	button.addEventListener("pointerup", stop);
	button.addEventListener("pointercancel", stop);
	button.addEventListener("lostpointercapture", stop);
	window.addEventListener("blur", stop);
	button.addEventListener("click", (event) => {
		if (!suppressNextClick) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		suppressNextClick = false;
	});
}
