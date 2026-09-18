import { markModalPortal, bindModalDismissal } from "../modal-dismiss";
import { createItemSelectGrid, sortItemsByUsage } from "./item-select-dialog";

export type OpponentItemPopularity = { options: { value: string; ratio: number }[] };

type ActiveItemSelect = {
	trigger: HTMLButtonElement;
	input: HTMLInputElement;
	popularity: OpponentItemPopularity | undefined;
};

let active: ActiveItemSelect | null = null;
let gridBuilt = false;

function byId<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

function popularityRatio(value: string): number | undefined {
	return active?.popularity?.options.find((option) => option.value === value)?.ratio;
}

function renderUsageRates(gridEl: HTMLElement): void {
	for (const cell of gridEl.querySelectorAll<HTMLButtonElement>(".item-select-cell")) {
		const value = cell.dataset.value ?? "";
		const usageEl = cell.querySelector<HTMLElement>(".item-select-cell-usage");
		if (!usageEl || value === "") continue;
		const ratio = popularityRatio(value);
		usageEl.textContent = ratio == null ? "" : `${Math.ceil(ratio * 100)}%`;
		usageEl.hidden = ratio == null;
	}
}

let dialogController: { open: (selection: ActiveItemSelect) => Promise<void>; refreshPopularity: (input: HTMLInputElement, popularity: OpponentItemPopularity | undefined) => void } | null = null;

function getDialogController(): NonNullable<typeof dialogController> {
	if (dialogController) return dialogController;
	const backdrop = byId<HTMLElement>("opponent-item-select-backdrop");
	const dialog = byId<HTMLElement>("opponent-item-select-dialog");
	const closeButton = byId<HTMLButtonElement>("opponent-item-select-close-button");
	const gridEl = byId<HTMLElement>("opponent-item-select-grid");
	const emptyEl = byId<HTMLElement>("opponent-item-select-empty");
	const searchInput = byId<HTMLInputElement>("opponent-item-select-search-input");
	let searchQuery = "";
	let openToken = 0;

	// ダメージ詳細パネルの上で開くため、下位モーダルの背景操作ブロック対象から外す。
	markModalPortal(backdrop);
	markModalPortal(dialog);

	function render(grid: ReturnType<typeof createItemSelectGrid>): void {
		grid.render(searchQuery);
		renderUsageRates(gridEl);
	}

	function closeDialog(): void {
		backdrop.hidden = true;
		dialog.hidden = true;
		active?.trigger.focus();
	}

	const grid = createItemSelectGrid({
		gridEl,
		emptyEl,
		getActiveValue: () => active?.input.value.trim() ?? "",
		sortRest: (values) => sortItemsByUsage(values, popularityRatio),
		onSelect: (value) => {
			const input = active?.input;
			if (input && input.value !== value) {
				// row.itemNameの書き込みなど既存の値保存経路はinput/changeの両方をリッスンしている
				// 前提のため(育成パネルのselectItemと同じ)、両方発火させる。
				input.value = value;
				input.dispatchEvent(new Event("input"));
				input.dispatchEvent(new Event("change"));
			}
			closeDialog();
		},
	});

	async function open(selection: ActiveItemSelect): Promise<void> {
		active = selection;
		const token = ++openToken;
		await grid.ensureBuilt();
		if (token !== openToken) return;
		gridBuilt = true;
		searchQuery = "";
		searchInput.value = "";
		render(grid);
		backdrop.hidden = false;
		dialog.hidden = false;
		dialog.focus();
	}

	closeButton.addEventListener("click", closeDialog);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
	searchInput.addEventListener("input", () => {
		searchQuery = searchInput.value.trim();
		render(grid);
	});

	dialogController = {
		open,
		refreshPopularity(input, popularity) {
			if (!gridBuilt || active?.input !== input) return;
			active.popularity = popularity;
			render(grid);
		},
	};
	return dialogController;
}

export function openOpponentItemSelectDialog(trigger: HTMLButtonElement, input: HTMLInputElement, popularity: OpponentItemPopularity | undefined): Promise<void> {
	return getDialogController().open({ trigger, input, popularity });
}

export function setOpponentItemSelectPopularity(input: HTMLInputElement, popularity: OpponentItemPopularity | undefined): void {
	getDialogController().refreshPopularity(input, popularity);
}
