// /box/[id] の種族選択モーダル。種族値・特性候補・保存など既存の処理は
// #species-name の input/change イベントに集約されているため、このファイルは選択値を
// 書き換えて両イベントを発火するだけにとどめる。
import { el, readSpeciesUsageData, sortPokemonNamesByUsage } from "../owned-pokemon-form";
import {
	loadAbilitiesMap,
	loadLearnsetMap,
	loadPokemonMasterList,
	type PokemonMasterEntry,
} from "../pokemon-master-data";
import { typeIconUrl } from "../sprite-urls";
import { TERA_TYPES } from "../tera-types";
import { kanaIncludes } from "../kana";
import { bindModalDismissal } from "../modal-dismiss";
import { applySprite } from "./shared-core";

type SortMode = "popularity" | "dex" | "kana";

const speciesInput = el<HTMLInputElement>("species-name");
const triggerButton = el<HTMLButtonElement>("species-select-trigger-button");
const triggerLabel = el<HTMLElement>("species-select-trigger-label");
const triggerIconImg = el<HTMLImageElement>("species-select-trigger-icon-img");
const triggerIconFallback = el<HTMLElement>("species-select-trigger-icon-fallback");
const backdropEl = el<HTMLElement>("species-select-backdrop");
const dialogEl = el<HTMLElement>("species-select-dialog");
const closeButton = el<HTMLButtonElement>("species-select-close-button");
const gridEl = el<HTMLElement>("species-select-grid");
const emptyEl = el<HTMLElement>("species-select-empty");
const nameFilterInput = el<HTMLInputElement>("species-select-name-filter");
const abilityFilterInput = el<HTMLInputElement>("species-select-ability-filter");
const megaToggle = el<HTMLInputElement>("species-select-mega-toggle");
const sortButton = el<HTMLButtonElement>("species-select-sort-button");
const sortPanel = el<HTMLElement>("species-select-sort-panel");
const typeButton = el<HTMLButtonElement>("species-select-type-button");
const typePanel = el<HTMLElement>("species-select-type-panel");
const moveButton = el<HTMLButtonElement>("species-select-move-button");
const movePanel = el<HTMLElement>("species-select-move-panel");
const moveInput = el<HTMLInputElement>("species-select-move-input");
const moveChipsEl = el<HTMLElement>("species-select-move-chips");

let sortMode: SortMode = "popularity";
let includeMega = true;
let nameFilter = "";
let abilityFilter = "";
const selectedTypes = new Set<string>();
const moveChips: string[] = [];

let masterList: PokemonMasterEntry[] | null = null;
let abilitiesMap: Map<string, string[]> | null = null;
let learnsetMap: Map<string, string[]> | null = null;
let dataPromise: Promise<void> | null = null;
let gridBuilt = false;
let typePanelBuilt = false;
const cellByName = new Map<string, HTMLButtonElement>();

const sortLabels: Record<SortMode, string> = {
	popularity: "人気順",
	dex: "図鑑番号順",
	kana: "50音順",
};

function updateTriggerButton(): void {
	const name = speciesInput.value.trim();
	triggerButton.classList.toggle("is-empty", name === "");
	triggerLabel.textContent = name || "種族";
	void applySprite(triggerIconImg, triggerIconFallback, name);
}

function updateSortButton(): void {
	sortButton.textContent = `ソート条件(${sortLabels[sortMode]})`;
	for (const option of document.querySelectorAll<HTMLButtonElement>(".species-select-sort-option")) {
		const selected = option.dataset.sort === sortMode;
		option.classList.toggle("is-selected", selected);
		option.setAttribute("aria-pressed", String(selected));
	}
}

function updateTypeButton(): void {
	typeButton.textContent = selectedTypes.size === 0 ? "タイプ (AND)" : `タイプ (AND) (${selectedTypes.size})`;
}

function updateMoveButton(): void {
	moveButton.textContent = moveChips.length === 0 ? "覚えるわざ (AND)" : `覚えるわざ (AND) (${moveChips.length})`;
}

function closeAllPopovers(): void {
	sortPanel.hidden = true;
	typePanel.hidden = true;
	movePanel.hidden = true;
	sortButton.setAttribute("aria-expanded", "false");
	typeButton.setAttribute("aria-expanded", "false");
	moveButton.setAttribute("aria-expanded", "false");
}

function togglePopover(panel: HTMLElement, button: HTMLButtonElement): void {
	const shouldOpen = panel.hidden;
	closeAllPopovers();
	if (!shouldOpen) return;
	panel.hidden = false;
	button.setAttribute("aria-expanded", "true");
}

function selectSpecies(name: string): void {
	if (speciesInput.value !== name) {
		speciesInput.value = name;
		speciesInput.dispatchEvent(new Event("input"));
		speciesInput.dispatchEvent(new Event("change"));
	}
	closeDialog();
}

function buildGridOnce(): void {
	if (gridBuilt || !masterList) return;
	gridBuilt = true;
	for (const entry of masterList) {
		const cell = document.createElement("button");
		cell.type = "button";
		cell.className = "species-select-cell";
		cell.dataset.name = entry.name;
		cell.setAttribute("role", "option");
		cell.setAttribute("aria-label", entry.name);

		const img = document.createElement("img");
		img.className = "species-select-cell-icon";
		img.alt = "";
		img.style.display = "none";
		const fallback = document.createElement("span");
		fallback.className = "sprite-fallback species-select-cell-fallback";
		const name = document.createElement("span");
		name.className = "species-select-cell-name";
		name.textContent = entry.name;
		cell.append(img, fallback, name);
		cell.addEventListener("click", () => selectSpecies(entry.name));
		cellByName.set(entry.name, cell);
		void applySprite(img, fallback, entry.name);
	}
}

async function ensureData(): Promise<void> {
	if (!dataPromise) {
		dataPromise = Promise.all([loadPokemonMasterList(), loadAbilitiesMap(), loadLearnsetMap()]).then(
			([master, abilities, learnset]) => {
				masterList = master;
				abilitiesMap = abilities;
				learnsetMap = learnset;
				buildGridOnce();
			},
		);
	}
	return dataPromise;
}

function renderGrid(): void {
	if (!masterList || !abilitiesMap || !learnsetMap) return;
	let entries = masterList.filter((entry) =>
		(includeMega || !(entry.forme?.startsWith("Mega") ?? false)) &&
		(nameFilter === "" || kanaIncludes(entry.name, nameFilter)) &&
		(selectedTypes.size === 0 || [...selectedTypes].every((type) => entry.types.includes(type))) &&
		(abilityFilter === "" || (abilitiesMap.get(entry.name) ?? []).some((ability) => kanaIncludes(ability, abilityFilter))) &&
		(moveChips.length === 0 || moveChips.every((move) => (learnsetMap.get(entry.name) ?? []).includes(move))),
	);

	if (sortMode === "kana") {
		entries = [...entries].sort((a, b) => a.name.localeCompare(b.name, "ja"));
	} else if (sortMode === "popularity") {
		const usageByRegulation = readSpeciesUsageData();
		if (usageByRegulation !== null) {
			const regulation = (document.getElementById("regulation") as HTMLSelectElement | null)?.value ?? "";
			const byName = new Map(entries.map((entry) => [entry.name, entry]));
			entries = sortPokemonNamesByUsage(
				entries.map((entry) => entry.name),
				usageByRegulation[regulation.trim()] ?? {},
			).flatMap((name) => {
				const entry = byName.get(name);
				return entry ? [entry] : [];
			});
		}
	}

	const orderedButtons = entries.flatMap((entry) => {
		const cell = cellByName.get(entry.name);
		return cell ? [cell] : [];
	});
	gridEl.hidden = orderedButtons.length === 0;
	emptyEl.hidden = orderedButtons.length !== 0;
	if (orderedButtons.length > 0) gridEl.replaceChildren(...orderedButtons);
}

function buildTypePanelOnce(): void {
	if (typePanelBuilt) return;
	typePanelBuilt = true;
	for (const type of TERA_TYPES) {
		if (type === "ステラ") continue;
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "species-select-type-chip";
		chip.setAttribute("aria-label", type);
		chip.setAttribute("aria-pressed", "false");
		const icon = document.createElement("img");
		icon.alt = "";
		const url = typeIconUrl(type);
		if (url) icon.src = url;
		else icon.style.display = "none";
		icon.onerror = () => { icon.style.display = "none"; };
		chip.appendChild(icon);
		chip.addEventListener("click", () => {
			if (selectedTypes.has(type)) selectedTypes.delete(type);
			else selectedTypes.add(type);
			const selected = selectedTypes.has(type);
			chip.classList.toggle("is-selected", selected);
			chip.setAttribute("aria-pressed", String(selected));
			updateTypeButton();
			renderGrid();
		});
		typePanel.appendChild(chip);
	}
}

function renderMoveChips(): void {
	const fragment = document.createDocumentFragment();
	for (const move of moveChips) {
		const chip = document.createElement("span");
		chip.className = "species-select-move-chip";
		chip.append(document.createTextNode(move));
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "species-select-move-chip-remove";
		remove.setAttribute("aria-label", `${move}を削除`);
		remove.textContent = "×";
		remove.addEventListener("click", () => {
			const index = moveChips.indexOf(move);
			if (index >= 0) moveChips.splice(index, 1);
			renderMoveChips();
			updateMoveButton();
			renderGrid();
		});
		chip.appendChild(remove);
		fragment.appendChild(chip);
	}
	moveChipsEl.replaceChildren(fragment);
}

async function openDialog(): Promise<void> {
	await ensureData();
	backdropEl.hidden = false;
	dialogEl.hidden = false;
	renderGrid();
	nameFilterInput.focus();
}

function closeDialog(): void {
	backdropEl.hidden = true;
	dialogEl.hidden = true;
	closeAllPopovers();
	triggerButton.focus();
}

speciesInput.addEventListener("input", updateTriggerButton);
updateTriggerButton();
triggerButton.addEventListener("click", () => { void openDialog(); });
closeButton.addEventListener("click", closeDialog);
bindModalDismissal({ backdrop: backdropEl, isOpen: () => !dialogEl.hidden, onDismiss: closeDialog });

sortButton.addEventListener("click", () => togglePopover(sortPanel, sortButton));
for (const option of document.querySelectorAll<HTMLButtonElement>(".species-select-sort-option")) {
	option.addEventListener("click", () => {
		const mode = option.dataset.sort;
		if (mode === "popularity" || mode === "dex" || mode === "kana") sortMode = mode;
		updateSortButton();
		closeAllPopovers();
		renderGrid();
	});
}
updateSortButton();

megaToggle.addEventListener("change", () => {
	includeMega = megaToggle.checked;
	renderGrid();
});
nameFilterInput.addEventListener("input", () => {
	nameFilter = nameFilterInput.value.trim();
	renderGrid();
});

typeButton.addEventListener("click", () => {
	buildTypePanelOnce();
	togglePopover(typePanel, typeButton);
});
updateTypeButton();

abilityFilterInput.addEventListener("input", () => {
	abilityFilter = abilityFilterInput.value.trim();
	renderGrid();
});

moveButton.addEventListener("click", () => togglePopover(movePanel, moveButton));
moveInput.addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	event.preventDefault();
	const move = moveInput.value.trim();
	if (!move || moveChips.includes(move)) return;
	moveChips.push(move);
	moveInput.value = "";
	renderMoveChips();
	updateMoveButton();
	renderGrid();
});
updateMoveButton();
