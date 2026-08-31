// /box/[id] のテラスタイプ選択モーダル(SpeciesSelectDialog/species-select-dialog.tsと
// 同じ3ファイル構成だが、テラスタイプは19種+テラスタルなしの計20件のため検索欄は持たない)。
// #tera(hidden select)が値の実体であることは変えず、選択時にteraSelect.value=…;
// changeイベントを発火する既存の発火方式を維持する(LeftPanel.astro側の
// updateTeraDropdownButton/refreshTopBlockTeraImage等が#teraのchangeイベントに
// 依存しているため)。
import { el } from "../owned-pokemon-form";
import { bindModalDismissal } from "../modal-dismiss";
import { teraTypeIconUrl } from "../sprite-urls";
import { getTeraSuggestionRatio } from "./left-panel";
import { requestSettingsModal } from "./settings-modal";

const teraSelect = el<HTMLSelectElement>("tera");
const triggerButton = el<HTMLButtonElement>("tera-dropdown-button");
const backdropEl = el<HTMLElement>("tera-select-backdrop");
const dialogEl = el<HTMLElement>("tera-select-dialog");
const closeButton = el<HTMLButtonElement>("tera-select-close-button");
const gridEl = el<HTMLElement>("tera-select-grid");

let gridBuilt = false;
// value("" = テラスタルなし)→セル要素。#tera(<select>)のoption一覧からそのまま生成する
// (値・順序の実体は<select>側にあるため二重管理を避ける)。
const cellByValue = new Map<string, HTMLButtonElement>();

function closeDialog(): void {
	backdropEl.hidden = true;
	dialogEl.hidden = true;
	triggerButton.focus();
}

function selectTera(value: string): void {
	if (teraSelect.value !== value) {
		teraSelect.value = value;
		teraSelect.dispatchEvent(new Event("change"));
	}
	closeDialog();
}

function buildGridOnce(): void {
	if (gridBuilt) return;
	gridBuilt = true;
	// 各セルにaria-labelを付け、スクリーンリーダー・ホバー両方にタイプ名(日本語)を伝える
	// (画像だけでは伝わらないため)。
	for (const optionEl of Array.from(teraSelect.options)) {
		const value = optionEl.value;
		const label = value === "" ? "テラスタルなし" : value;
		const cell = document.createElement("button");
		cell.type = "button";
		cell.className = "tera-select-cell";
		cell.dataset.value = value;
		cell.setAttribute("role", "option");
		cell.setAttribute("aria-label", label);
		cell.title = label;
		if (value !== "") {
			const img = document.createElement("img");
			img.className = "tera-select-cell-image";
			img.alt = "";
			const url = teraTypeIconUrl(value);
			if (url) {
				img.onerror = () => { img.style.display = "none"; };
				img.src = url;
			} else {
				img.style.display = "none";
			}
			cell.appendChild(img);
		} else {
			// 「テラスタルなし」にはアイコンが無いため、同じ幅の空要素で場所を確保し、
			// 他セルとテキストの左端位置をそろえる。
			const spacer = document.createElement("span");
			spacer.className = "tera-select-cell-image-spacer";
			spacer.setAttribute("aria-hidden", "true");
			cell.appendChild(spacer);
		}
		const textEl = document.createElement("span");
		textEl.className = "tera-select-cell-text";
		textEl.textContent = label;
		cell.appendChild(textEl);
		cell.addEventListener("click", () => selectTera(value));
		cellByValue.set(value, cell);
	}
}

function renderGrid(): void {
	const noneCell = cellByValue.get("");
	const rest = Array.from(cellByValue.entries()).filter(([value]) => value !== "");
	// 「テラスタルなし」は常に先頭固定のまま、残りを人気順(データが無いものは元の順序の
	// まま)に並べ替える(旧applyTeraSuggestionOrderingと同じロジック)。
	rest.sort(([a], [b]) => {
		const ra = getTeraSuggestionRatio(a);
		const rb = getTeraSuggestionRatio(b);
		if (ra != null && rb != null) return rb - ra;
		if (ra != null) return -1;
		if (rb != null) return 1;
		return 0;
	});

	const ordered: HTMLButtonElement[] = [];
	if (noneCell) ordered.push(noneCell);
	for (const [, cell] of rest) ordered.push(cell);
	for (const cell of ordered) {
		cell.classList.toggle("is-active", cell.dataset.value === teraSelect.value);
	}
	gridEl.replaceChildren(...ordered);
}

function openDialog(): void {
	buildGridOnce();
	renderGrid();
	backdropEl.hidden = false;
	dialogEl.hidden = false;
}

// クリック時にモーダルを開く処理は、このファイルが#tera-dropdown-button(LeftPanel.astro側の
// トリガーボタン)へ直接バインドする(species-select-dialog.tsのtriggerButtonと同じパターン)。
triggerButton.addEventListener("click", () => requestSettingsModal({ kind: "tera" }));
document.addEventListener("box-settings:open", (event) => {
	if ((event as CustomEvent<{ kind?: string }>).detail?.kind === "tera") openDialog();
});
closeButton.addEventListener("click", closeDialog);
bindModalDismissal({ backdrop: backdropEl, isOpen: () => !dialogEl.hidden, onDismiss: closeDialog });
