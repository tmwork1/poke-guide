import { bindModalDismissal } from "./modal-dismiss";
import { teraTypeIconUrl } from "./sprite-urls";
import { TERA_TYPES } from "./tera-types";

export interface TeraSelectDialogElements {
	backdrop: HTMLElement;
	dialog: HTMLElement;
	closeButton: HTMLButtonElement;
	grid: HTMLElement;
}

export interface TeraSelectDialogOptions {
	sortRatio?: (value: string) => number | undefined;
}

export function createTeraSelectDialog(elements: TeraSelectDialogElements, triggerButton: HTMLButtonElement, getValue: () => string, onSelect: (value: string) => void, options: TeraSelectDialogOptions = {}): { open: () => void } {
	const { backdrop, dialog, closeButton, grid } = elements;
	const cellByValue = new Map<string, HTMLButtonElement>();
	let gridBuilt = false;
	const close = () => { backdrop.hidden = true; dialog.hidden = true; triggerButton.focus(); };
	const select = (value: string) => { if (getValue() !== value) onSelect(value); close(); };
	const buildGridOnce = () => {
		if (gridBuilt) return;
		gridBuilt = true;
		for (const value of ["", ...TERA_TYPES]) {
			const label = value === "" ? "なし" : value;
			const cell = document.createElement("button");
			cell.type = "button"; cell.className = "tera-select-cell"; cell.dataset.value = value;
			cell.setAttribute("role", "option"); cell.setAttribute("aria-label", label); cell.title = label;
			if (value === "") {
				const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				icon.classList.add("tera-select-cell-none-icon"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
				icon.innerHTML = '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
				cell.appendChild(icon);
			} else {
				const image = document.createElement("img"); image.className = "tera-select-cell-image"; image.alt = "";
				const url = teraTypeIconUrl(value);
				if (url) { image.onerror = () => { image.style.display = "none"; }; image.src = url; } else image.style.display = "none";
				cell.appendChild(image);
			}
			const text = document.createElement("span"); text.className = "tera-select-cell-text"; text.textContent = label;
			cell.appendChild(text); cell.addEventListener("click", () => select(value)); cellByValue.set(value, cell);
		}
	};
	const render = () => {
		const none = cellByValue.get("");
		const rest = Array.from(cellByValue.entries()).filter(([value]) => value !== "");
		if (options.sortRatio) rest.sort(([a], [b]) => {
			const aRatio = options.sortRatio?.(a), bRatio = options.sortRatio?.(b);
			if (aRatio != null && bRatio != null) return bRatio - aRatio;
			if (aRatio != null) return -1;
			if (bRatio != null) return 1;
			return 0;
		});
		const cells = [...(none ? [none] : []), ...rest.map(([, cell]) => cell)];
		for (const cell of cells) cell.classList.toggle("is-active", cell.dataset.value === getValue());
		grid.replaceChildren(...cells);
	};
	const open = () => { buildGridOnce(); render(); backdrop.hidden = false; dialog.hidden = false; };
	closeButton.addEventListener("click", close);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: close });
	return { open };
}
