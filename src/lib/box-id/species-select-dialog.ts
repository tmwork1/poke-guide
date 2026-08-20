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
const backdropEl = el<HTMLElement>("species-select-backdrop");
const dialogEl = el<HTMLElement>("species-select-dialog");
const closeButton = el<HTMLButtonElement>("species-select-close-button");
const gridEl = el<HTMLElement>("species-select-grid");
const emptyEl = el<HTMLElement>("species-select-empty");
const searchInput = el<HTMLInputElement>("species-select-search-input");
const sortButton = el<HTMLButtonElement>("species-select-sort-button");
const sortPanel = el<HTMLElement>("species-select-sort-panel");
const typeRow = el<HTMLElement>("species-select-type-row");

let sortMode: SortMode = "popularity";
let searchQuery = "";
const selectedTypes: string[] = [];

let masterList: PokemonMasterEntry[] | null = null;
let abilitiesMap: Map<string, string[]> | null = null;
let learnsetMap: Map<string, string[]> | null = null;
let dataPromise: Promise<void> | null = null;
let gridBuilt = false;
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
}

function updateSortButton(): void {
	sortButton.textContent = `⇅${sortLabels[sortMode]}`;
	for (const option of document.querySelectorAll<HTMLButtonElement>(".species-select-sort-option")) {
		const selected = option.dataset.sort === sortMode;
		option.classList.toggle("is-selected", selected);
		option.setAttribute("aria-pressed", String(selected));
	}
}

function closeAllPopovers(): void {
	sortPanel.hidden = true;
	sortButton.setAttribute("aria-expanded", "false");
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

function matchesSearch(entry: PokemonMasterEntry): boolean {
	if (searchQuery === "") return true;
	if (kanaIncludes(entry.name, searchQuery)) return true;
	if ((abilitiesMap?.get(entry.name) ?? []).some((ability) => kanaIncludes(ability, searchQuery))) return true;
	if ((learnsetMap?.get(entry.name) ?? []).some((move) => kanaIncludes(move, searchQuery))) return true;
	return false;
}

function matchesType(entry: PokemonMasterEntry): boolean {
	return selectedTypes.length === 0 || selectedTypes.every((type) => entry.types.includes(type));
}

function renderGrid(): void {
	if (!masterList || !abilitiesMap || !learnsetMap) return;
	const filtered = masterList.filter((entry) => matchesSearch(entry) && matchesType(entry));
	const isMega = (entry: PokemonMasterEntry): boolean => entry.forme?.startsWith("Mega") ?? false;
	const nonMegaEntries = filtered.filter((entry) => !isMega(entry));
	const megaEntries = filtered.filter(isMega);
	let sortedNonMega = nonMegaEntries;

	if (sortMode === "kana") {
		sortedNonMega = [...nonMegaEntries].sort((a, b) => a.name.localeCompare(b.name, "ja"));
	} else if (sortMode === "popularity") {
		const usageByRegulation = readSpeciesUsageData();
		if (usageByRegulation !== null) {
			const regulation = (document.getElementById("regulation") as HTMLSelectElement | null)?.value ?? "";
			const byName = new Map(nonMegaEntries.map((entry) => [entry.name, entry]));
			sortedNonMega = sortPokemonNamesByUsage(
				nonMegaEntries.map((entry) => entry.name),
				usageByRegulation[regulation.trim()] ?? {},
			).flatMap((name) => {
				const entry = byName.get(name);
				return entry ? [entry] : [];
			});
		}
	}

	const megaByDex = new Map<number, PokemonMasterEntry[]>();
	for (const mega of megaEntries) {
		const megas = megaByDex.get(mega.dexNo) ?? [];
		megas.push(mega);
		megaByDex.set(mega.dexNo, megas);
	}

	const ordered: PokemonMasterEntry[] = [];
	const usedDex = new Set<number>();
	for (const entry of sortedNonMega) {
		ordered.push(entry);
		const megas = megaByDex.get(entry.dexNo);
		if (megas && !usedDex.has(entry.dexNo)) {
			ordered.push(...megas);
			usedDex.add(entry.dexNo);
		}
	}
	for (const [dexNo, megas] of megaByDex) {
		if (!usedDex.has(dexNo)) ordered.push(...megas);
	}

	const orderedButtons = ordered.flatMap((entry) => {
		const cell = cellByName.get(entry.name);
		return cell ? [cell] : [];
	});
	gridEl.hidden = orderedButtons.length === 0;
	emptyEl.hidden = orderedButtons.length !== 0;
	if (orderedButtons.length > 0) gridEl.replaceChildren(...orderedButtons);
}

function buildTypeRow(): void {
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
			const index = selectedTypes.indexOf(type);
			if (index >= 0) {
				selectedTypes.splice(index, 1);
			} else {
				if (selectedTypes.length >= 2) selectedTypes.shift();
				selectedTypes.push(type);
			}
			for (const typeChip of typeRow.querySelectorAll<HTMLButtonElement>(".species-select-type-chip")) {
				const selected = selectedTypes.includes(typeChip.getAttribute("aria-label") ?? "");
				typeChip.classList.toggle("is-selected", selected);
				typeChip.setAttribute("aria-pressed", String(selected));
			}
			renderGrid();
		});
		typeRow.appendChild(chip);
	}
}

async function openDialog(): Promise<void> {
	await ensureData();
	backdropEl.hidden = false;
	dialogEl.hidden = false;
	renderGrid();
	searchInput.focus();
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

searchInput.addEventListener("input", () => {
	searchQuery = searchInput.value.trim();
	renderGrid();
});
buildTypeRow();
