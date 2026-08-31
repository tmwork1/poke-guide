import { el } from "../owned-pokemon-form";
import { kanaIncludes } from "../kana";
import { bindModalDismissal } from "../modal-dismiss";
import { typeIconUrl } from "../sprite-urls";
import { applyItemImage } from "./shared-core";
import { requestSettingsModal } from "./settings-modal";
import { getItemSuggestionRatio } from "./left-panel";

type ItemAutocompleteEntry = { name?: unknown; regulations?: unknown };

/** Items that boost attacks of the indicated type. */
export const ITEM_TYPE_BOOST: Record<string, string> = {
	"シルクのスカーフ": "ノーマル", "もくたん": "ほのお", "しんぴのしずく": "みず", "じしゃく": "でんき",
	"きせきのタネ": "くさ", "とけないこおり": "こおり", "くろおび": "かくとう", "どくバリ": "どく",
	"やわらかいすな": "じめん", "するどいくちばし": "ひこう", "まがったスプーン": "エスパー", "ぎんのこな": "むし",
	"かたいいし": "いわ", "のろいのおふだ": "ゴースト", "りゅうのキバ": "ドラゴン", "くろいメガネ": "あく",
	"メタルコート": "はがね", "ようせいのハネ": "フェアリー",
};

/** Type-resist berries and their indicated type. */
export const ITEM_TYPE_RESIST_BERRY: Record<string, string> = {
	"ホズのみ": "ノーマル", "オッカのみ": "ほのお", "イトケのみ": "みず", "ソクノのみ": "でんき",
	"リンドのみ": "くさ", "ヤチェのみ": "こおり", "ヨプのみ": "かくとう", "ビアーのみ": "どく",
	"シュカのみ": "じめん", "バコウのみ": "ひこう", "ウタンのみ": "エスパー", "タンガのみ": "むし",
	"ヨロギのみ": "いわ", "カシブのみ": "ゴースト", "ハバンのみ": "ドラゴン", "ナモのみ": "あく",
	"リリバのみ": "はがね", "ロゼルのみ": "フェアリー",
};

function isBerryItemName(name: string): boolean {
	return name.endsWith("のみ");
}

export function isMegaStoneItemName(name: string): boolean {
	return /ナイト[XYZ]?$/.test(name);
}

const TYPE_ORDER = [
	"ノーマル", "ほのお", "みず", "でんき", "くさ", "こおり", "かくとう", "どく",
	"じめん", "ひこう", "エスパー", "むし", "いわ", "ゴースト", "ドラゴン", "あく",
	"はがね", "フェアリー",
];

function sortByTypeOrder(values: string[], typeOf: Record<string, string>): string[] {
	return [...values].sort((a, b) => TYPE_ORDER.indexOf(typeOf[a]) - TYPE_ORDER.indexOf(typeOf[b]));
}

// [採用率上位] -> [その他] -> [タイプ強化アイテム(タイプ順)] -> [きのみ] -> [タイプ半減実(タイプ順)] -> [メガストーン]
export function sortItemsByUsage(values: string[], ratioOf: (value: string) => number | undefined): string[] {
	const ranked = values.filter((value) => (ratioOf(value) ?? 0) > 0);
	ranked.sort((a, b) => (ratioOf(b) ?? 0) - (ratioOf(a) ?? 0));
	const rest = values.filter((value) => (ratioOf(value) ?? 0) <= 0);
	const megaStones = rest.filter((value) => isMegaStoneItemName(value));
	const berries = rest.filter((value) => !isMegaStoneItemName(value) && isBerryItemName(value));
	const others = rest.filter((value) => !isMegaStoneItemName(value) && !isBerryItemName(value));
	const typeBoosts = others.filter((value) => ITEM_TYPE_BOOST[value] !== undefined);
	const otherRest = others.filter((value) => ITEM_TYPE_BOOST[value] === undefined);
	const resistBerries = berries.filter((value) => ITEM_TYPE_RESIST_BERRY[value] !== undefined);
	const normalBerries = berries.filter((value) => ITEM_TYPE_RESIST_BERRY[value] === undefined);
	return [
		...ranked,
		...otherRest,
		...sortByTypeOrder(typeBoosts, ITEM_TYPE_BOOST),
		...normalBerries,
		...sortByTypeOrder(resistBerries, ITEM_TYPE_RESIST_BERRY),
		...megaStones,
	];
}

const ITEM_LABEL_BREAK_SUFFIXES = ["プレート", "メモリ", "レンズ", "ハーブ", "チョッキ", "ガード", "ジュエル", "エナジー", "グローブ", "ゴーグル", "マント", "コート", "サービス", "ダイス", "ブーツ", "チャーム", "メット", "バンド", "ほけん", "だま", "パック", "ボタン", "スカーフ", "ハチマキ", "メガネ"];
const ITEM_LABEL_BREAK_PREFIXES = ["こだわり", "だっしゅつ", "くろい", "おおきな", "きれいな", "するどい", "とけない", "まがった", "やわらかい", "だい"];
const ITEM_LABEL_OVERRIDES: Record<string, [string, string]> = {
	"のろいのおふだ": ["のろいの", "おふだ"], "ひのたまプレート": ["ひのたま", "プレート"], "ものしりメガネ": ["ものしり", "メガネ"], "もののけプレート": ["もののけ", "プレート"], "ものまねハーブ": ["ものまね", "ハーブ"],
};

function itemTypeBadgeType(name: string): string | null {
	return ITEM_TYPE_BOOST[name] ?? ITEM_TYPE_RESIST_BERRY[name] ?? null;
}

function decorateItemTypeBadge(iconWrap: HTMLElement, value: string): void {
	const type = itemTypeBadgeType(value);
	const url = type ? typeIconUrl(type) : null;
	if (!url) return;
	const badge = document.createElement("img");
	badge.className = "item-select-cell-type-badge";
	badge.src = url;
	badge.alt = "";
	iconWrap.appendChild(badge);
}

function splitItemLabel(name: string): [string, string] | null {
	const override = ITEM_LABEL_OVERRIDES[name];
	if (override) return override;
	const megaMatch = name.match(/^(.+?)(ナイト[XYZ]?)$/);
	if (megaMatch && megaMatch[1].length >= 1) return [megaMatch[1], megaMatch[2]];
	if (name.length < 7) return null;
	const noIndex = name.indexOf("の");
	if (noIndex >= 0) return [name.slice(0, noIndex + 1), name.slice(noIndex + 1)];
	for (const prefix of ITEM_LABEL_BREAK_PREFIXES) {
		if (name.startsWith(prefix) && name.length > prefix.length) return [prefix, name.slice(prefix.length)];
	}
	for (const suffix of ITEM_LABEL_BREAK_SUFFIXES) {
		if (name.endsWith(suffix) && name.length > suffix.length) return [name.slice(0, name.length - suffix.length), suffix];
	}
	return null;
}

function renderItemLabel(label: string, textEl: HTMLElement): void {
	const split = splitItemLabel(label);
	if (!split) {
		textEl.textContent = label;
		return;
	}
	textEl.replaceChildren(document.createTextNode(split[0]), document.createElement("br"), document.createTextNode(split[1]));
}

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
	/** trueを返した値は候補から除外する(「なし」は対象外)。例: もちもの表示モーダルのメガストーン除外。 */
	excludeValue?: (value: string) => boolean;
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
			const iconWrap = document.createElement("span");
			iconWrap.className = "item-select-cell-icon-wrap";
			const img = document.createElement("img");
			img.className = "item-select-cell-image";
			img.alt = "";
			void applyItemImage(img, value);
			iconWrap.appendChild(img);
			decorateItemTypeBadge(iconWrap, value);
			cell.appendChild(iconWrap);
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
		renderItemLabel(label, textEl);
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
				for (const name of names) {
					if (options.excludeValue?.(name)) continue;
					cellByValue.set(name, createCell(name, name));
				}
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
		sortRest: (values) => sortItemsByUsage(values, getItemSuggestionRatio),
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
	triggerButton.addEventListener("click", () => requestSettingsModal({ kind: "item" }));
	closeButton.addEventListener("click", closeDialog);
	bindModalDismissal({ backdrop: backdropEl, isOpen: () => !dialogEl.hidden, onDismiss: closeDialog });
	searchInput.addEventListener("input", () => {
		searchQuery = searchInput.value.trim();
		grid.render(searchQuery);
	});
}

if (document.getElementById("item-select-dialog")) initializeItemSelectDialog();
