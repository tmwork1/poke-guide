import { el } from "../owned-pokemon-form";
import { kanaIncludes } from "../kana";
import { bindModalDismissal } from "../modal-dismiss";
import { applyItemImage } from "./shared-core";

let itemNamesPromise: Promise<string[]> | null = null;

function getSharedItemNames(): Promise<string[]> {
	if (!itemNamesPromise) {
		itemNamesPromise = fetch("/master-data/autocomplete/items.json")
			.then(async (response) => {
				if (!response.ok) throw new Error("Failed to load item autocomplete data");
				const rows = await response.json() as Array<{ name?: unknown }>;
				return rows.map((row) => typeof row.name === "string" ? row.name : "").filter(Boolean);
			});
	}
	return itemNamesPromise;
}

export interface ItemSelectGridOptions {
	gridEl: HTMLElement;
	emptyEl: HTMLElement;
	getActiveValue: () => string | null;
	onSelect: (value: string) => void;
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
			const spacer = document.createElement("span");
			spacer.className = "item-select-cell-image-spacer";
			spacer.setAttribute("aria-hidden", "true");
			cell.appendChild(spacer);
		}
		const textEl = document.createElement("span");
		textEl.className = "item-select-cell-text";
		textEl.textContent = label;
		cell.appendChild(textEl);
		cell.addEventListener("click", () => options.onSelect(value));
		return cell;
	}

	async function ensureBuilt(): Promise<void> {
		if (gridBuilt) return;
		if (!buildPromise) {
			buildPromise = getSharedItemNames().then((names) => {
				gridBuilt = true;
				cellByValue.set("", createCell("", "もちものなし"));
				for (const name of names) cellByValue.set(name, createCell(name, name));
			});
		}
		return buildPromise;
	}

	function render(searchQuery: string): void {
		const noneCell = cellByValue.get("");
		const rest = Array.from(cellByValue.entries()).filter(([value]) => value !== "");
		const matches = (label: string) => !searchQuery || kanaIncludes(label, searchQuery);
		const activeValue = options.getActiveValue() ?? "__none_selected__";
		const visible: HTMLButtonElement[] = [];
		if (noneCell && matches("もちものなし")) {
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
