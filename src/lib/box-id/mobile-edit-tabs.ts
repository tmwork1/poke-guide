import { resetStatAdjustSheet } from "./stat-adjust-sheet";

type MobileTab = "training" | "damage";

let activeTab: MobileTab = new URLSearchParams(window.location.search).get("tab") === "damage" ? "damage" : "training";

function isMobileTab(value: string | undefined): value is MobileTab {
	return value === "training" || value === "damage";
}

function getTabElements(): {
	mobileTrainingUi: HTMLElement;
	mobileTrainingBar: HTMLElement;
	editShell: HTMLElement;
} | null {
	const mobileTrainingUi = document.getElementById("mobile-training-ui");
	const mobileTrainingBar = document.getElementById("mobile-training-bar");
	const editShell = document.getElementById("edit-shell");
	if (!mobileTrainingUi || !mobileTrainingBar || !editShell) return null;
	return { mobileTrainingUi, mobileTrainingBar, editShell };
}

function updateStatAdjustmentSheetVisibility(): void {
	const sheet = document.getElementById("stat-adjust-sheet");
	if (!sheet) return;
	sheet.hidden = activeTab !== "damage";
	if (activeTab !== "damage") resetStatAdjustSheet();
}

function applyTab(): void {
	const elements = getTabElements();
	if (!elements) return;
	const { mobileTrainingUi, mobileTrainingBar, editShell } = elements;
	// 起動直後はSSR済みのdataset/aria-currentと同値のことが多いため、値が変わるときだけ書く
	// (クリック経由の切り替え挙動はそのまま)。
	if (mobileTrainingUi.dataset.mobileTab !== activeTab) mobileTrainingUi.dataset.mobileTab = activeTab;
	if (editShell.dataset.mobileTab !== activeTab) editShell.dataset.mobileTab = activeTab;
	for (const button of mobileTrainingBar.querySelectorAll<HTMLButtonElement>("button[data-mobile-tab]")) {
		const isActive = button.dataset.mobileTab === activeTab;
		// app-header.css は `[data-active="true"]` を選択状態としている。
		// toggleAttribute() は値なしの `data-active` にしてしまい、このセレクタから
		// 外れるため、リロード直後に背景ハイライトだけが消えていた。
		const activeValue = isActive ? "true" : "false";
		if (button.dataset.active !== activeValue) button.dataset.active = activeValue;
		if (isActive) {
			if (button.getAttribute("aria-current") !== "page") button.setAttribute("aria-current", "page");
		} else if (button.hasAttribute("aria-current")) {
			button.removeAttribute("aria-current");
		}
	}
	updateStatAdjustmentSheetVisibility();
}

// ヘッダーはプレビューのクライアント側再描画で差し替え可能であるため、初期DOMの
// buttonへ直接リスナを持たせない。documentへ委譲すれば、差し替え後のタブも同じ経路で
// 即座に処理でき、二重初期化時もリスナの付け直しが要らない。
document.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof Element)) return;
	const button = target.closest<HTMLButtonElement>("#mobile-training-bar button[data-mobile-tab]");
	if (!button || !isMobileTab(button.dataset.mobileTab)) return;
	activeTab = button.dataset.mobileTab;
	applyTab();
});

applyTab();
