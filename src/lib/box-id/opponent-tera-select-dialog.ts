import { markModalPortal } from "../modal-dismiss";
import { createTeraSelectDialog } from "../tera-select-dialog";

type ActiveTeraSelect = {
	trigger: HTMLButtonElement;
	getValue: () => string;
	onSelect: (value: string) => void;
};

let active: ActiveTeraSelect | null = null;
let dialogController: { open: () => void } | null = null;

function getDialogController(): { open: () => void } {
	if (dialogController) return dialogController;
	// TeraSelectDialog.astro の idPrefix="opponent-" と対応する(id は接頭辞 + "tera-select-*")。
	const prefix = "opponent-tera-select-";
	const backdrop = document.getElementById(`${prefix}backdrop`) as HTMLElement;
	const dialog = document.getElementById(`${prefix}dialog`) as HTMLElement;
	const closeButton = document.getElementById(`${prefix}close-button`) as HTMLButtonElement;
	const grid = document.getElementById(`${prefix}grid`) as HTMLElement;

	// createTeraSelectDialog()はトリガーを1つ受け取るため、現在のトリガーへ
	// フォーカスを戻す代理ボタンを使って共有モーダルを1個だけ初期化する。
	const focusProxy = document.createElement("button");
	focusProxy.focus = () => active?.trigger.focus();

	// ダメージ詳細パネルの上で開くため、下位モーダルの背景操作ブロック対象から外す。
	markModalPortal(backdrop);
	markModalPortal(dialog);
	dialogController = createTeraSelectDialog(
		{ backdrop, dialog, closeButton, grid },
		focusProxy,
		() => active?.getValue() ?? "",
		(value) => active?.onSelect(value),
	);
	return dialogController;
}

export function openOpponentTeraSelectDialog(trigger: HTMLButtonElement, getValue: () => string, onSelect: (value: string) => void): void {
	active = { trigger, getValue, onSelect };
	const controller = getDialogController();
	controller.open();
	(document.getElementById("opponent-tera-select-dialog") as HTMLElement).focus();
}
