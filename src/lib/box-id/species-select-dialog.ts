// /box/[id] の種族選択モーダル。選択結果は #species-name の input/change で伝える契約を保つ。
import { el } from "../owned-pokemon-form";
import { createSpeciesSelectDialog } from "./species-select-dialog-core";
import { requestSettingsModal } from "./settings-modal";

const speciesInput = el<HTMLInputElement>("species-name");
const triggerButton = el<HTMLButtonElement>("species-select-trigger-button");
const triggerLabel = el<HTMLElement>("species-select-trigger-label");

function updateTriggerButton(): void {
	const name = speciesInput.value.trim();
	triggerButton.classList.toggle("is-empty", name === "");
	triggerLabel.textContent = name || "ポケモン";
}

export function selectSpecies(name: string): void {
	if (speciesInput.value !== name) {
		speciesInput.value = name;
		speciesInput.dispatchEvent(new Event("input"));
		speciesInput.dispatchEvent(new Event("change"));
	}
	dialog.close();
}

const dialog = createSpeciesSelectDialog({
	elements: {
		backdrop: el<HTMLElement>("species-select-backdrop"),
		dialog: el<HTMLElement>("species-select-dialog"),
		closeButton: el<HTMLButtonElement>("species-select-close-button"),
		list: el<HTMLElement>("species-select-grid"),
		listWrap: el<HTMLElement>("species-select-grid-wrap"),
		empty: el<HTMLElement>("species-select-empty"),
		searchInput: el<HTMLInputElement>("species-select-search-input"),
		sortButton: el<HTMLButtonElement>("species-select-sort-button"),
		sortPanel: el<HTMLElement>("species-select-sort-panel"),
	},
	variant: "grid",
	onSelect: selectSpecies,
	onClose: () => triggerButton.focus(),
});

speciesInput.addEventListener("input", updateTriggerButton);
updateTriggerButton();
triggerButton.addEventListener("click", () => requestSettingsModal({ kind: "species" }));
document.addEventListener("box-settings:open", (event) => {
	if ((event as CustomEvent<{ kind?: string }>).detail?.kind === "species") void dialog.open();
});
document.addEventListener("game-screen-ocr:select-species", (event) => {
	const name = (event as CustomEvent<{ name?: string }>).detail?.name;
	if (name) selectSpecies(name);
});
