import { orderPokemonEntriesForDatalist } from "../owned-pokemon-form";
import { loadAbilitiesMap, loadLearnsetMap, loadPokemonMasterList, type PokemonMasterEntry } from "../pokemon-master-data";
import { kanaIncludes } from "../kana";
import { splitSearchTokens } from "../search-tokens";
import { bindModalDismissal } from "../modal-dismiss";
import { applySprite } from "./shared-core";
import { readJsonScriptRankedSpecies, type RankedSpeciesEntry } from "../json-script";

type SortMode = "popularity" | "dex" | "kana";

export interface SpeciesSelectDialogOptions {
	elements: { backdrop: HTMLElement; dialog: HTMLElement; closeButton: HTMLButtonElement; list: HTMLElement; listWrap: HTMLElement; empty: HTMLElement; searchInput: HTMLInputElement; sortButton: HTMLButtonElement; sortPanel: HTMLElement };
	variant: "grid" | "list";
	onSelect: (name: string) => void;
	onClose?: () => void;
}

export interface SpeciesSelectDialogController { open(): Promise<void>; close(): void; isOpen(): boolean; }

// マスターデータ・検索用インデックスは画面内のすべての選択ダイアログで共有する。
let masterList: PokemonMasterEntry[] | null = null;
let abilitiesMap: Map<string, string[]> | null = null;
let learnsetMap: Map<string, string[]> | null = null;
let dataPromise: Promise<void> | null = null;
let opggRankByName: Map<string, number | null> | null = null;

function readRankedSpecies(): RankedSpeciesEntry[] { return readJsonScriptRankedSpecies("box-opgg-ranked-species"); }
function getOpggRankByName(): Map<string, number | null> {
	if (!opggRankByName) opggRankByName = new Map(readRankedSpecies().map(({ name, rank }) => [name, rank]));
	return opggRankByName;
}
async function ensureData(): Promise<void> {
	if (!dataPromise) dataPromise = Promise.all([loadPokemonMasterList(), loadAbilitiesMap(), loadLearnsetMap()]).then(([master, abilities, learnset]) => {
		masterList = master; abilitiesMap = abilities; learnsetMap = learnset;
	});
	return dataPromise;
}
const sortLabels: Record<SortMode, string> = { popularity: "人気", dex: "番号", kana: "名前" };

export function createSpeciesSelectDialog(options: SpeciesSelectDialogOptions): SpeciesSelectDialogController {
	const { elements, variant, onSelect, onClose } = options;
	const { backdrop, dialog, closeButton, list, listWrap, empty, searchInput, sortButton, sortPanel } = elements;
	let sortMode: SortMode = "popularity";
	let searchQuery = "";
	let built = false;
	let spriteObserver: IntersectionObserver | null = null;
	let searchFocusFrame: number | null = null;
	const cellByName = new Map<string, HTMLButtonElement>();

	function cancelScheduledSearchFocus(): void { if (searchFocusFrame !== null) window.cancelAnimationFrame(searchFocusFrame); searchFocusFrame = null; }
	function focusSearchAfterOpen(): void {
		cancelScheduledSearchFocus();
		searchFocusFrame = window.requestAnimationFrame(() => { searchFocusFrame = window.requestAnimationFrame(() => {
			searchFocusFrame = null;
			if (!dialog.hidden) searchInput.focus({ preventScroll: true });
		}); });
	}
	function closeAllPopovers(): void { sortPanel.hidden = true; sortButton.setAttribute("aria-expanded", "false"); }
	function updateSortButton(): void {
		sortButton.textContent = `⇅ ${sortLabels[sortMode]}`;
		for (const option of sortPanel.querySelectorAll<HTMLButtonElement>("[data-sort]")) {
			const selected = option.dataset.sort === sortMode;
			option.classList.toggle("is-selected", selected);
			option.setAttribute("aria-pressed", String(selected));
		}
	}
	function getSpriteObserver(): IntersectionObserver {
		if (!spriteObserver) spriteObserver = new IntersectionObserver((observedEntries) => {
			for (const observedEntry of observedEntries) {
				if (!observedEntry.isIntersecting) continue;
				const cell = observedEntry.target as HTMLElement;
				const name = cell.dataset.name;
				const img = cell.querySelector<HTMLImageElement>(variant === "grid" ? ".species-select-cell-icon" : ".opponent-select-row-icon");
				const fallback = cell.querySelector<HTMLElement>(variant === "grid" ? ".species-select-cell-fallback" : ".opponent-select-row-fallback");
				// グリッド(育成画面)は従来どおり medium、1行リスト(相手ポケモン選択)は icon を使う。
				if (name && img && fallback) void applySprite(img, fallback, name, variant === "grid" ? "medium" : "icon");
				spriteObserver?.unobserve(cell);
			}
		}, { root: listWrap, rootMargin: "300px 0px", threshold: 0 });
		return spriteObserver;
	}
	function buildOnce(): void {
		if (built || !masterList) return;
		built = true;
		const rankByName = getOpggRankByName();
		const baseRankByDex = new Map<number, number>();
		for (const entry of masterList) {
			if (entry.forme?.startsWith("Mega")) continue;
			const rank = rankByName.get(entry.name);
			if (rank != null && !baseRankByDex.has(entry.dexNo)) baseRankByDex.set(entry.dexNo, rank);
		}
		for (const entry of masterList) {
			const cell = document.createElement("button");
			cell.type = "button"; cell.className = variant === "grid" ? "species-select-cell" : "opponent-select-row";
			cell.dataset.name = entry.name; cell.setAttribute("role", "option"); cell.setAttribute("aria-label", entry.name); cell.title = entry.name;
			const img = document.createElement("img");
			img.className = variant === "grid" ? "species-select-cell-icon" : "opponent-select-row-icon"; img.alt = "";
			// applySprite() は hidden 属性を切り替えて表示へ戻すため、style.displayで初期非表示にしない。
			img.hidden = true;
			const fallback = document.createElement("span");
			fallback.className = variant === "grid" ? "sprite-fallback species-select-cell-fallback" : "sprite-fallback opponent-select-row-fallback";
			const directRank = rankByName.get(entry.name);
			const rank = directRank ?? (entry.forme?.startsWith("Mega") ? baseRankByDex.get(entry.dexNo) : undefined);
			if (variant === "grid") {
				if (rank != null) { const usage = document.createElement("span"); usage.className = "species-select-cell-usage tnum"; usage.textContent = String(rank); cell.append(img, fallback, usage); }
				else cell.append(img, fallback);
			} else {
				const rankEl = document.createElement("span"); rankEl.className = "opponent-select-row-rank tnum"; rankEl.textContent = rank != null ? String(rank) : "";
				const nameEl = document.createElement("span"); nameEl.className = "opponent-select-row-name"; nameEl.textContent = entry.name;
				cell.append(rankEl, img, fallback, nameEl);
			}
			cell.addEventListener("click", () => { onSelect(entry.name); close(); });
			cellByName.set(entry.name, cell); getSpriteObserver().observe(cell);
		}
	}
	function matchesSearch(entry: PokemonMasterEntry): boolean {
		return splitSearchTokens(searchQuery).every((token) => kanaIncludes(entry.name, token)
			|| entry.types.some((type) => kanaIncludes(type, token))
			|| (abilitiesMap?.get(entry.name) ?? []).some((ability) => kanaIncludes(ability, token))
			|| (learnsetMap?.get(entry.name) ?? []).some((move) => kanaIncludes(move, token)));
	}
	function render(): void {
		if (!masterList || !abilitiesMap || !learnsetMap) return;
		const filtered = masterList.filter(matchesSearch);
		const isMega = (entry: PokemonMasterEntry): boolean => entry.forme?.startsWith("Mega") ?? false;
		const nonMegaEntries = filtered.filter((entry) => !isMega(entry));
		const megaEntries = filtered.filter(isMega);
		let sortedNonMega = nonMegaEntries;
		if (sortMode === "kana") sortedNonMega = [...nonMegaEntries].sort((a, b) => a.name.localeCompare(b.name, "ja"));
		else if (sortMode === "popularity") {
			const orderedNames = orderPokemonEntriesForDatalist(filtered, readRankedSpecies().map(({ name }) => name));
			const entryByName = new Map(filtered.map((entry) => [entry.name, entry]));
			const buttons = orderedNames.flatMap((name) => { const entry = entryByName.get(name); const cell = entry && cellByName.get(entry.name); return cell ? [cell] : []; });
			list.hidden = buttons.length === 0; empty.hidden = buttons.length !== 0;
			if (buttons.length > 0) list.replaceChildren(...buttons);
			return;
		}
		const megaByDex = new Map<number, PokemonMasterEntry[]>();
		for (const mega of megaEntries) { const megas = megaByDex.get(mega.dexNo) ?? []; megas.push(mega); megaByDex.set(mega.dexNo, megas); }
		const ordered: PokemonMasterEntry[] = []; const usedDex = new Set<number>();
		for (const entry of sortedNonMega) { ordered.push(entry); const megas = megaByDex.get(entry.dexNo); if (megas && !usedDex.has(entry.dexNo)) { ordered.push(...megas); usedDex.add(entry.dexNo); } }
		for (const [dexNo, megas] of megaByDex) if (!usedDex.has(dexNo)) ordered.push(...megas);
		const buttons = ordered.flatMap((entry) => { const cell = cellByName.get(entry.name); return cell ? [cell] : []; });
		list.hidden = buttons.length === 0; empty.hidden = buttons.length !== 0;
		if (buttons.length > 0) list.replaceChildren(...buttons);
	}
	async function open(): Promise<void> {
		await ensureData(); buildOnce(); searchQuery = ""; searchInput.value = "";
		backdrop.hidden = false; dialog.hidden = false; render(); focusSearchAfterOpen();
	}
	function close(): void {
		if (dialog.hidden) return;
		cancelScheduledSearchFocus(); backdrop.hidden = true; dialog.hidden = true; closeAllPopovers(); onClose?.();
	}
	closeButton.addEventListener("click", close);
	bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: close });
	sortButton.addEventListener("click", () => { const shouldOpen = sortPanel.hidden; closeAllPopovers(); if (shouldOpen) { sortPanel.hidden = false; sortButton.setAttribute("aria-expanded", "true"); } });
	for (const option of sortPanel.querySelectorAll<HTMLButtonElement>("[data-sort]")) option.addEventListener("click", () => {
		const mode = option.dataset.sort; if (mode === "popularity" || mode === "dex" || mode === "kana") sortMode = mode;
		updateSortButton(); closeAllPopovers(); render();
	});
	searchInput.addEventListener("input", () => { searchQuery = searchInput.value.trim(); render(); });
	updateSortButton();
	return { open, close, isOpen: () => !dialog.hidden };
}
