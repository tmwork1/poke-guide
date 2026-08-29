/**
 * 削除確定の一瞬(EXIT_EFFECT_MS)だけ、削除ボタンをfill反転しカードを萎ませる。
 * 実際の削除処理(fetch・状態更新・再描画)は待ち終わってから呼び出し側が行う
 * (transitionendを待つ非同期化より安く、setTimeoutで固定時間待つだけにしている)。
 */
const EXIT_EFFECT_MS = 200;
export function playCardDeleteExitEffect(card: HTMLElement, button: HTMLElement): Promise<void> {
	button.classList.add("is-deleting");
	card.classList.add("is-card-removing");
	return new Promise((resolve) => window.setTimeout(resolve, EXIT_EFFECT_MS));
}

/**
 * 可算カード用の削除モード。カード本体を長押しすると、同じ一覧内の削除操作を
 * まとめて表示する。個々の削除処理は各画面が引き続き担当する。
 */
export function initializeCardDeleteMode(
	container: HTMLElement,
	cardSelector: string,
	deleteButtonSelector: string,
	// 通常はbutton等のコントロール上からの長押しではモードへ入らない(isControl参照)。
	// この一覧内だけ「ボタンだが長押しでモードに入ってよい」要素を明示的に許可するための
	// セレクタ(例: ダメージカードの「＋わざを追加」ボタン)。
	longPressableControlSelector?: string,
): void {
	const LONG_PRESS_MS = 600;
	let pressTimer: ReturnType<typeof window.setTimeout> | undefined;
	// 長押し解除時に発生する合成clickを1回だけ握りつぶすためのフラグ。
	// 端末によってはこの合成clickが発火しないことがあり、次のclickで必ずfalseに戻る
	// 前提のままだとフラグが残り続けて、次に押した削除ボタンの1回目のタップまで
	// 誤って握りつぶしてしまう(二回タップしないと削除できない不具合の原因だった)。
	// clickではなく次のpointerdown(=次の物理的なタップの開始)で確実に解除する。
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
		if (longPressableControlSelector && target.closest(longPressableControlSelector)) return false;
		const control = target.closest("button, input, textarea, select, option, label, [contenteditable='true']");
		return control !== null && control !== card;
	};

	container.addEventListener("pointerdown", (event) => {
		// 新しい物理的なタップが始まった時点で、前回分の合成click待ちは打ち切る
		// (合成clickが来ないままの残留を防ぐ。詳細はsuppressNextClickの宣言部を参照)。
		suppressNextClick = false;
		if (event.button !== 0) return;
		const card = cardFor(event.target);
		if (!card || !container.contains(card) || isControl(event.target, card)) return;
		// 削除モード中にカードを再度長押しすると、そのままモードを解除する
		// (共通仕様: 長押しでの開始/終了を対にする)。
		pressTimer = window.setTimeout(() => {
			suppressNextClick = true;
			if (isActive) exit(); else enter();
		}, LONG_PRESS_MS);
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
			// 長押し解除で発生する合成clickをここで処理し終える。
			suppressNextClick = false;
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
