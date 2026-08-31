import { el } from "../owned-pokemon-form";
import { kanaIncludes } from "../kana";
import { bindModalDismissal } from "../modal-dismiss";
import { applyItemImage } from "./shared-core";

type ItemAutocompleteEntry = { name?: unknown; regulations?: unknown };

let itemNamesPromise: Promise<string[]> | null = null;

function getSharedItemNames(): Promise<string[]> {
	if (!itemNamesPromise) {
		itemNamesPromise = fetch("/master-data/autocomplete/items.json")
			.then(async (response) => {
				if (!response.ok) throw new Error("Failed to load item autocomplete data");
				const rows = await response.json() as ItemAutocompleteEntry[];
				return rows
					.filter((row) => Array.isArray(row.regulations) && row.regulations.length > 0)
					.map((row) => typeof row.name === "string" ? row.name : "")
					.filter(Boolean);
			});
	}
	return itemNamesPromise;
}

export interface ItemSelectGridOptions {
	gridEl: HTMLElement;
	emptyEl: HTMLElement;
	getActiveValue: () => string | null;
	onSelect: (value: string) => void;
	/** 未指定なら共有マスタの並び順(五十音順)のまま。指定時は""を除いた値配列を並べ替える。 */
	sortRest?: (values: string[]) => string[];
	/** 未指定ならlabelをそのままtextContentに設定する。指定時は名前表示セルへの描画を差し替える(改行位置の調整など)。 */
	renderLabel?: (label: string, textEl: HTMLElement) => void;
}

export interface ItemSelectGrid {
	ensureBuilt: () => Promise<void>;
	render: (searchQuery: string) => void;
}

/** Shared item database list, ordering, image rendering, and kana search. */
export function createItemSelectGrid(options: ItemSelectGridOptions): ItemSelectGrid {
	const cellByValue = new Map<string, HTMLButtonElement>();
	let gridBuilt = false;
	let buildPromise: Promise<void> | null = null;

	function createCell(value: string, label: string): HTMLButtonElement {
		const cell = document.createElement("button");
		cell.type = "button";
		cell.className = "item-select-cell";
		cell.dataset.value = value;
		cell.setAttribute("role", "option");
		cell.setAttribute("aria-label", label);
		cell.title = label;
		if (value) {
			const img = document.createElement("img");
			img.className = "item-select-cell-image";
			img.alt = "";
			void applyItemImage(img, value);
			cell.appendChild(img);
		} else {
			const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			icon.classList.add("item-select-cell-none-icon");
			icon.setAttribute("viewBox", "0 0 24 24");
			icon.setAttribute("aria-hidden", "true");
			icon.innerHTML = '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
			cell.appendChild(icon);
		}
		const textEl = document.createElement("span");
		textEl.className = "item-select-cell-text";
		if (options.renderLabel) options.renderLabel(label, textEl);
		else textEl.textContent = label;
		cell.appendChild(textEl);
		cell.addEventListener("click", () => options.onSelect(value));
		return cell;
	}

	async function ensureBuilt(): Promise<void> {
		if (gridBuilt) return;
		if (!buildPromise) {
			buildPromise = getSharedItemNames().then((names) => {
				gridBuilt = true;
				cellByValue.set("", createCell("", "なし"));
				for (const name of names) cellByValue.set(name, createCell(name, name));
			});
		}
		return buildPromise;
	}

	function render(searchQuery: string): void {
		const noneCell = cellByValue.get("");
		let restValues = Array.from(cellByValue.keys()).filter((value) => value !== "");
		if (options.sortRest) restValues = options.sortRest(restValues);
		const rest = restValues.map((value) => [value, cellByValue.get(value)!] as const);
		const matches = (label: string) => !searchQuery || kanaIncludes(label, searchQuery);
		const activeValue = options.getActiveValue() ?? "__none_selected__";
		const visible: HTMLButtonElement[] = [];
		if (noneCell && (matches("なし") || matches("もちものなし"))) {
			noneCell.classList.toggle("is-active", activeValue === "");
			visible.push(noneCell);
		}
		for (const [value, cell] of rest) {
			if (!matches(value)) continue;
			cell.classList.toggle("is-active", activeValue === value);
			visible.push(cell);
		}
		options.gridEl.hidden = visible.length === 0;
		options.emptyEl.hidden = visible.length !== 0;
		if (visible.length) options.gridEl.replaceChildren(...visible);
	}

	return { ensureBuilt, render };
}

function initializeItemSelectDialog(): void {
	const itemInput = el<HTMLInputElement>("item");
	const triggerButton = el<HTMLButtonElement>("item-dropdown-button");
	const backdropEl = el<HTMLElement>("item-select-backdrop");
	const dialogEl = el<HTMLElement>("item-select-dialog");
	const closeButton = el<HTMLButtonElement>("item-select-close-button");
	const gridEl = el<HTMLElement>("item-select-grid");
	const emptyEl = el<HTMLElement>("item-select-empty");
	const searchInput = el<HTMLInputElement>("item-select-search-input");
	let searchQuery = "";
	function closeDialog(): void {
		backdropEl.hidden = true;
		dialogEl.hidden = true;
		triggerButton.focus();
	}
	const grid = createItemSelectGrid({
		gridEl,
		emptyEl,
		getActiveValue: () => itemInput.value.trim(),
		onSelect: (value) => {
			if (itemInput.value !== value) {
				itemInput.value = value;
				itemInput.dispatchEvent(new Event("input"));
				itemInput.dispatchEvent(new Event("change"));
			}
			closeDialog();
		},
	});
	async function openDialog(): Promise<void> {
		await grid.ensureBuilt();
		searchQuery = "";
		searchInput.value = "";
		grid.render(searchQuery);
		backdropEl.hidden = false;
		dialogEl.hidden = false;
		dialogEl.focus();
	}
	document.addEventListener("box-settings:open", (event) => {
		if ((event as CustomEvent<{ kind?: string }>).detail?.kind === "item") void openDialog();
	});
	closeButton.addEventListener("click", closeDialog);
	bindModalDismissal({ backdrop: backdropEl, isOpen: () => !dialogEl.hidden, onDismiss: closeDialog });
	searchInput.addEventListener("input", () => {
		searchQuery = searchInput.value.trim();
		grid.render(searchQuery);
	});
}

if (document.getElementById("item-select-dialog")) initializeItemSelectDialog();
