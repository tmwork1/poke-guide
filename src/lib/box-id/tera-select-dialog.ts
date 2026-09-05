import { el } from "../owned-pokemon-form";
import { createTeraSelectDialog } from "../tera-select-dialog";
import { getTeraSuggestionRatio } from "./left-panel";
import { requestSettingsModal } from "./settings-modal";

const teraSelect = el<HTMLSelectElement>("tera");
const triggerButton = el<HTMLButtonElement>("tera-dropdown-button");
const dialog = createTeraSelectDialog({
	backdrop: el<HTMLElement>("tera-select-backdrop"),
	dialog: el<HTMLElement>("tera-select-dialog"),
	closeButton: el<HTMLButtonElement>("tera-select-close-button"),
	grid: el<HTMLElement>("tera-select-grid"),
}, triggerButton, () => teraSelect.value, (value) => {
	teraSelect.value = value;
	teraSelect.dispatchEvent(new Event("change"));
}, { sortRatio: getTeraSuggestionRatio });

triggerButton.addEventListener("click", () => requestSettingsModal({ kind: "tera" }));
document.addEventListener("box-settings:open", (event) => {
	if ((event as CustomEvent<{ kind?: string }>).detail?.kind === "tera") dialog.open();
});
