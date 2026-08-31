export type SettingsModalKind = "species" | "item" | "tera" | "move" | "stats";

export interface SettingsModalRequest {
	kind: SettingsModalKind;
	slot?: number;
}

/** 育成フォームとプレビューから設定モーダルを開く共通入口。 */
export function requestSettingsModal(request: SettingsModalRequest): void {
	document.dispatchEvent(new CustomEvent<SettingsModalRequest>("box-settings:open", { detail: request }));
}

/** プレビュー内の擬似ボタンを、通常のボタンと同じモーダル入口に接続する。 */
export function bindSettingsModalTrigger(element: HTMLElement, request: SettingsModalRequest): void {
	let handledByPointer = false;
	const open = () => requestSettingsModal(request);
	element.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		handledByPointer = true;
		open();
		suppressNextClick();
	});
	element.addEventListener("click", () => {
		if (handledByPointer) {
			handledByPointer = false;
			return;
		}
		open();
	});
	element.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		open();
	});
}

// pointerdownで開いた直後、同じタップに由来するclickが今開いたばかりのモーダル
// (閉じるボタン・背景)の上で発火し、開いた瞬間に閉じてしまう(ゴーストクリック)。
// clickのヒットテストはpointerdown時点ではなくclick発火時点のDOMで行われるため、
// トリガー要素自身でhandledByPointerを見ても防げない。次の1回のclickだけを
// キャプチャ段階で握りつぶし、新しく表示された要素に届く前に止める。
function suppressNextClick(): void {
	document.addEventListener(
		"click",
		(event) => {
			event.stopPropagation();
			event.preventDefault();
		},
		{ capture: true, once: true },
	);
}
