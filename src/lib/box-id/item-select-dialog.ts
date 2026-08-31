// /box/[id] のもちもの選択モーダル(SpeciesSelectDialog/species-select-dialog.tsと同じ
// 3ファイル構成)。#item(hidden text input)が値の実体であることは変えず、選択時に
// itemInput.value=…; input/changeイベントを発火する既存のselectItem()と同じ発火方式を
// 維持する(LeftPanel.astro側のupdateItemImage/updateItemTitle/updateItemNameDisplay/
// updateItemDropdownButton等がこのイベントに依存しているため)。
import { el } from "../owned-pokemon-form";
import { kanaIncludes } from "../kana";
import { bindModalDismissal } from "../modal-dismiss";
import { applyItemImage } from "./shared-core";
import { getItemOptionNames, getItemSuggestionRatio } from "./left-panel";

const itemInput = el<HTMLInputElement>("item");
const triggerButton = el<HTMLButtonElement>("item-dropdown-button");
const backdropEl = el<HTMLElement>("item-select-backdrop");
const dialogEl = el<HTMLElement>("item-select-dialog");
const closeButton = el<HTMLButtonElement>("item-select-close-button");
const gridEl = el<HTMLElement>("item-select-grid");
const emptyEl = el<HTMLElement>("item-select-empty");
const searchInput = el<HTMLInputElement>("item-select-search-input");

let searchQuery = "";
let gridBuilt = false;
let buildPromise: Promise<void> | null = null;
// value("" = もちものなし)→セル要素。1度作ったセルは使い回し、開くたびに並べ替えるだけにする
// (species-select-dialog.tsのcellByNameと同じ方針)。
const cellByValue = new Map<string, HTMLButtonElement>();

function closeDialog(): void {
	backdropEl.hidden = true;
	dialogEl.hidden = true;
	triggerButton.focus();
}

function selectItem(value: string): void {
	if (itemInput.value !== value) {
		itemInput.value = value;
		// textInputIds(scheduleSave)・statAffectingIds(recalcStats)の両方に"item"が登録されて
		// いるため(left-panel.ts参照)、input/changeの両方を発火させる必要がある。
		itemInput.dispatchEvent(new Event("input"));
		itemInput.dispatchEvent(new Event("change"));
	}
	closeDialog();
}

function createCell(value: string, label: string): HTMLButtonElement {
	const cell = document.createElement("button");
	cell.type = "button";
	cell.className = "item-select-cell";
	cell.dataset.value = value;
	cell.setAttribute("role", "option");
	cell.setAttribute("aria-label", label);
	cell.title = label;
	if (value !== "") {
		const img = document.createElement("img");
		img.className = "item-select-cell-image";
		img.alt = "";
		void applyItemImage(img, value);
		cell.appendChild(img);
	} else {
		// 「もちものなし」にはアイコンが無いため、同じ幅の空要素で場所を確保し、
		// 他セルとテキストの左端位置をそろえる。
		const spacer = document.createElement("span");
		spacer.className = "item-select-cell-image-spacer";
		spacer.setAttribute("aria-hidden", "true");
		cell.appendChild(spacer);
	}
	const textEl = document.createElement("span");
	textEl.className = "item-select-cell-text";
	textEl.textContent = label;
	cell.appendChild(textEl);
	cell.addEventListener("click", () => selectItem(value));
	return cell;
}

// #item-listのdatalistはloadAutocomplete()が非同期でoptionを流し込むため、left-panel.tsの
// getItemOptionNames()(同じキャッシュ)を経由して一度だけ読み取る。
async function ensureGridBuilt(): Promise<void> {
	if (gridBuilt) return;
	if (!buildPromise) {
		buildPromise = getItemOptionNames().then((names) => {
			gridBuilt = true;
			// テラスの「テラスタルなし」と同じ扱いで、持ち物を外す選択肢を先頭固定で置く。
			cellByValue.set("", createCell("", "もちものなし"));
			for (const name of names) {
				cellByValue.set(name, createCell(name, name));
			}
		});
	}
	return buildPromise;
}

function matchesSearch(label: string): boolean {
	// 表示値は変えず、比較だけかな・文字幅・英字大小を正規化する。
	return searchQuery === "" || kanaIncludes(label, searchQuery);
}

function renderGrid(): void {
	const noneCell = cellByValue.get("");
	const rest = Array.from(cellByValue.entries()).filter(([value]) => value !== "");
	// 「もちものなし」は常に先頭固定のまま、残りを人気順(データが無いものは元の順序のまま)
	// に並べ替える(旧applyItemSuggestionOrderingと同じロジック)。
	rest.sort(([a], [b]) => {
		const ra = getItemSuggestionRatio(a);
		const rb = getItemSuggestionRatio(b);
		if (ra != null && rb != null) return rb - ra;
		if (ra != null) return -1;
		if (rb != null) return 1;
		return 0;
	});

	const currentValue = itemInput.value.trim();
	const visible: HTMLButtonElement[] = [];
	if (noneCell && matchesSearch("もちものなし")) {
		noneCell.classList.toggle("is-active", currentValue === "");
		visible.push(noneCell);
	}
	for (const [value, cell] of rest) {
		if (!matchesSearch(value)) continue;
		cell.classList.toggle("is-active", value === currentValue);
		visible.push(cell);
	}
	gridEl.hidden = visible.length === 0;
	emptyEl.hidden = visible.length !== 0;
	if (visible.length > 0) gridEl.replaceChildren(...visible);
}

async function openDialog(): Promise<void> {
	await ensureGridBuilt();
	searchQuery = "";
	searchInput.value = "";
	renderGrid();
	backdropEl.hidden = false;
	dialogEl.hidden = false;
	// 開いた直後に検索欄へキャレットを置かない。検索を始めたい場合だけ利用者が
	// 明示的にフォーカスすることで、現在の選択項目をまず確認できるようにする。
	dialogEl.focus();
}

// クリック時にモーダルを開く処理は、このファイルが#item-dropdown-button(LeftPanel.astro側の
// トリガーボタン)へ直接バインドする(species-select-dialog.tsの
// triggerButton.addEventListener("click", …)と同じパターン)。メガストーン確定時は
// left-panel.tsのsetItemLockedがこのボタン自体をdisabledにするため、ここで個別に
// ロック状態を意識する必要はない(disabledボタンはclickイベントを発火しない)。
triggerButton.addEventListener("click", () => { void openDialog(); });
closeButton.addEventListener("click", closeDialog);
bindModalDismissal({ backdrop: backdropEl, isOpen: () => !dialogEl.hidden, onDismiss: closeDialog });

searchInput.addEventListener("input", () => {
	searchQuery = searchInput.value.trim();
	renderGrid();
});
