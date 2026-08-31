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
