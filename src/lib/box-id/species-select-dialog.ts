// /box/[id] の種族選択モーダル。種族値・特性候補・保存など既存の処理は
// #species-name の input/change イベントに集約されているため、このファイルは選択値を
// 書き換えて両イベントを発火するだけにとどめる。
import { el, orderPokemonEntriesForDatalist } from "../owned-pokemon-form";
import {
	loadAbilitiesMap,
	loadLearnsetMap,
	loadPokemonMasterList,
	type PokemonMasterEntry,
} from "../pokemon-master-data";
import { kanaIncludes } from "../kana";
import { splitSearchTokens } from "../search-tokens";
import { bindModalDismissal } from "../modal-dismiss";
import { applySprite } from "./shared-core";
import { requestSettingsModal } from "./settings-modal";
import { readJsonScriptRankedSpecies, type RankedSpeciesEntry } from "../json-script";

type SortMode = "popularity" | "dex" | "kana";

const speciesInput = el<HTMLInputElement>("species-name");
const triggerButton = el<HTMLButtonElement>("species-select-trigger-button");
const triggerLabel = el<HTMLElement>("species-select-trigger-label");
const backdropEl = el<HTMLElement>("species-select-backdrop");
const dialogEl = el<HTMLElement>("species-select-dialog");
const closeButton = el<HTMLButtonElement>("species-select-close-button");
const gridEl = el<HTMLElement>("species-select-grid");
const gridWrapEl = el<HTMLElement>("species-select-grid-wrap");
const emptyEl = el<HTMLElement>("species-select-empty");
const searchInput = el<HTMLInputElement>("species-select-search-input");
const sortButton = el<HTMLButtonElement>("species-select-sort-button");
const sortPanel = el<HTMLElement>("species-select-sort-panel");

let sortMode: SortMode = "popularity";
let searchQuery = "";

let masterList: PokemonMasterEntry[] | null = null;
let abilitiesMap: Map<string, string[]> | null = null;
let learnsetMap: Map<string, string[]> | null = null;
let dataPromise: Promise<void> | null = null;
let gridBuilt = false;
const cellByName = new Map<string, HTMLButtonElement>();
let spriteObserver: IntersectionObserver | null = null;
let searchFocusFrame: number | null = null;
let opggRankByName: Map<string, number | null> | null = null;

// OP.GG は種族単位の使用率を公開していないため、順位(rank)を表示用に持つ(box/[id].astro 参照)。
// 読み出しは owned-pokemon-form.ts の pokemon-list と共通の readJsonScriptRankedSpecies に一本化。
function readRankedSpecies(): RankedSpeciesEntry[] {
	return readJsonScriptRankedSpecies("box-opgg-ranked-species");
}

function getOpggRankByName(): Map<string, number | null> {
	if (!opggRankByName) opggRankByName = new Map(readRankedSpecies().map(({ name, rank }) => [name, rank]));
	return opggRankByName;
}

function cancelScheduledSearchFocus(): void {
	if (searchFocusFrame !== null) window.cancelAnimationFrame(searchFocusFrame);
	searchFocusFrame = null;
}

// モーダルの表示とグリッドの初回レイアウト後に検索欄へ移す。preventScrollにより、
// フォーカス起点で背面またはグリッドのスクロール位置が変わることを防ぐ。
function focusSearchAfterOpen(): void {
	cancelScheduledSearchFocus();
	searchFocusFrame = window.requestAnimationFrame(() => {
		searchFocusFrame = window.requestAnimationFrame(() => {
			searchFocusFrame = null;
			if (!dialogEl.hidden) searchInput.focus({ preventScroll: true });
		});
	});
}

const sortLabels: Record<SortMode, string> = {
	popularity: "人気",
	dex: "番号",
	kana: "名前",
};

function getSpriteObserver(): IntersectionObserver {
	if (!spriteObserver) {
		spriteObserver = new IntersectionObserver(
			(observedEntries) => {
				for (const observedEntry of observedEntries) {
					if (!observedEntry.isIntersecting) continue;
					const cell = observedEntry.target as HTMLElement;
					const name = cell.dataset.name;
					const img = cell.querySelector<HTMLImageElement>(".species-select-cell-icon");
					const fallback = cell.querySelector<HTMLElement>(".species-select-cell-fallback");
					if (name && img && fallback) {
						void applySprite(img, fallback, name);
					}
					spriteObserver?.unobserve(cell);
				}
			},
			{ root: gridWrapEl, rootMargin: "300px 0px", threshold: 0 },
		);
	}
	return spriteObserver;
}

function updateTriggerButton(): void {
	const name = speciesInput.value.trim();
	triggerButton.classList.toggle("is-empty", name === "");
	triggerLabel.textContent = name || "ポケモン";
}

function updateSortButton(): void {
	sortButton.textContent = `⇅ ${sortLabels[sortMode]}`;
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

export function selectSpecies(name: string): void {
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
	// OP.GG の順位は基本フォルム名でしか付かない(メガシンカは基本フォルムの統計に含まれる)ため、
	// メガシンカのセルには同じ図鑑番号の基本フォルムの順位を出す。
	const rankByName = getOpggRankByName();
	const baseRankByDex = new Map<number, number>();
	for (const entry of masterList) {
		if (entry.forme?.startsWith("Mega")) continue;
		const rank = rankByName.get(entry.name);
		if (rank != null && !baseRankByDex.has(entry.dexNo)) baseRankByDex.set(entry.dexNo, rank);
	}
	for (const entry of masterList) {
		const cell = document.createElement("button");
		cell.type = "button";
		cell.className = "species-select-cell";
		cell.dataset.name = entry.name;
		cell.setAttribute("role", "option");
		cell.setAttribute("aria-label", entry.name);
		cell.title = entry.name;

		const img = document.createElement("img");
		img.className = "species-select-cell-icon";
		img.alt = "";
		// applySprite() は imgEl.hidden の切り替えだけで表示に戻す(shared-core.ts)ため、
		// 初期非表示も hidden 属性で行う(style.display だと [hidden] より優先され消えたままになる)。
		img.hidden = true;
		const fallback = document.createElement("span");
		fallback.className = "sprite-fallback species-select-cell-fallback";
		const rank = rankByName.get(entry.name) ?? (entry.forme?.startsWith("Mega") ? baseRankByDex.get(entry.dexNo) : undefined);
		if (rank != null) {
			const usageEl = document.createElement("span");
			usageEl.className = "species-select-cell-usage tnum";
			usageEl.textContent = String(rank);
			cell.append(img, fallback, usageEl);
		} else {
			cell.append(img, fallback);
		}
		cell.addEventListener("click", () => selectSpecies(entry.name));
		cellByName.set(entry.name, cell);
		getSpriteObserver().observe(cell);
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
	return splitSearchTokens(searchQuery).every((token) =>
		kanaIncludes(entry.name, token)
		|| entry.types.some((type) => kanaIncludes(type, token))
		|| (abilitiesMap?.get(entry.name) ?? []).some((ability) => kanaIncludes(ability, token))
		|| (learnsetMap?.get(entry.name) ?? []).some((move) => kanaIncludes(move, token)),
	);
}

function renderGrid(): void {
	if (!masterList || !abilitiesMap || !learnsetMap) return;
	const filtered = masterList.filter(matchesSearch);
	const isMega = (entry: PokemonMasterEntry): boolean => entry.forme?.startsWith("Mega") ?? false;
	const nonMegaEntries = filtered.filter((entry) => !isMega(entry));
	const megaEntries = filtered.filter(isMega);
	let sortedNonMega = nonMegaEntries;

	if (sortMode === "kana") {
		sortedNonMega = [...nonMegaEntries].sort((a, b) => a.name.localeCompare(b.name, "ja"));
	} else if (sortMode === "popularity") {
		const rankedNames = readRankedSpecies().map(({ name }) => name);
		const orderedNames = orderPokemonEntriesForDatalist(filtered, rankedNames);
		const entryByName = new Map(filtered.map((entry) => [entry.name, entry]));
		const orderedButtons = orderedNames.flatMap((name) => {
			const entry = entryByName.get(name);
			return entry ? [entry] : [];
		});
		const buttons = orderedButtons.flatMap((entry) => {
			const cell = cellByName.get(entry.name);
			return cell ? [cell] : [];
		});
		gridEl.hidden = buttons.length === 0;
		emptyEl.hidden = buttons.length !== 0;
		if (buttons.length > 0) gridEl.replaceChildren(...buttons);
		return;
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

async function openDialog(): Promise<void> {
	await ensureData();
	// 開くたびに前回の検索語を持ち越さない(モーダルを閉じてもDOM上の<input>値は
	// 残るため、明示的にクリアしてからrenderGridする)。
	searchQuery = "";
	searchInput.value = "";
	backdropEl.hidden = false;
	dialogEl.hidden = false;
	renderGrid();
	focusSearchAfterOpen();
}

document.addEventListener("game-screen-ocr:select-species", (event) => {
	const name = (event as CustomEvent<{ name?: string }>).detail?.name;
	if (name) selectSpecies(name);
});

function closeDialog(): void {
	cancelScheduledSearchFocus();
	backdropEl.hidden = true;
	dialogEl.hidden = true;
	closeAllPopovers();
	triggerButton.focus();
}

speciesInput.addEventListener("input", updateTriggerButton);
updateTriggerButton();
triggerButton.addEventListener("click", () => requestSettingsModal({ kind: "species" }));
document.addEventListener("box-settings:open", (event) => {
	if ((event as CustomEvent<{ kind?: string }>).detail?.kind === "species") void openDialog();
});
closeButton.addEventListener("click", closeDialog);
bindModalDismissal({ backdrop: backdropEl, dialog: dialogEl, isOpen: () => !dialogEl.hidden, onDismiss: closeDialog });

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
