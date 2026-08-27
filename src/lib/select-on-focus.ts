/**
 * すべてのテキスト系入力欄で、フォーカス時に既存の内容を全選択する。
 * マウスクリックでフォーカスした直後の mouseup は選択を解除してカーソル位置に
 * 戻してしまうため、フォーカス直後の1回だけ mouseup の既定動作を止めて選択を保持する
 * (2回目以降のクリックはカーソル移動として通常どおり働く)。
 */
const SELECTABLE = 'input[type="text"], input[type="number"], input[type="search"], textarea';

export function setupSelectOnFocus(): void {
	let justFocused: HTMLInputElement | HTMLTextAreaElement | null = null;

	document.addEventListener("focusin", (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.matches(SELECTABLE)) return;
		const field = target as HTMLInputElement | HTMLTextAreaElement;
		justFocused = field;
		try {
			field.select();
		} catch {
			// 一部のinput type(未使用のtype含む)はselect()未対応のため無視する。
		}
	});

	document.addEventListener("mouseup", (event) => {
		if (justFocused && event.target === justFocused) {
			event.preventDefault();
		}
		justFocused = null;
	});
}
