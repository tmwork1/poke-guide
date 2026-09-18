import { el } from "../owned-pokemon-form";
import { markModalPortal } from "../modal-dismiss";
import { createSpeciesSelectDialog } from "./species-select-dialog-core";

let activeSelect: ((name: string) => void) | null = null;
let activeTrigger: HTMLButtonElement | null = null;
const backdrop = el<HTMLElement>("opponent-select-backdrop");
const dialogEl = el<HTMLElement>("opponent-select-dialog");
// ダメージ詳細パネルの上に出るため、下位モーダルの背景操作ブロック対象から外す。
markModalPortal(backdrop);
markModalPortal(dialogEl);
const dialog = createSpeciesSelectDialog({
	elements: {
		backdrop, dialog: dialogEl, closeButton: el<HTMLButtonElement>("opponent-select-close-button"),
		list: el<HTMLElement>("opponent-select-list"), listWrap: el<HTMLElement>("opponent-select-list-wrap"), empty: el<HTMLElement>("opponent-select-empty"),
		searchInput: el<HTMLInputElement>("opponent-select-search-input"), sortButton: el<HTMLButtonElement>("opponent-select-sort-button"), sortPanel: el<HTMLElement>("opponent-select-sort-panel"),
	},
	variant: "list",
	onSelect: (name) => activeSelect?.(name),
	onClose: () => { const trigger = activeTrigger; activeSelect = null; activeTrigger = null; trigger?.focus(); },
});

export function openOpponentSelectDialog(trigger: HTMLButtonElement, onSelect: (name: string) => void): Promise<void> {
	activeTrigger = trigger; activeSelect = onSelect;
	return dialog.open();
}
