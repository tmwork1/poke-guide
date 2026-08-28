import { resetStatAdjustSheet } from "./stat-adjust-sheet";

const mobileTrainingUi = document.getElementById("mobile-training-ui");
const mobileTrainingBar = document.getElementById("mobile-training-bar");
const editShell = document.getElementById("edit-shell");

if (mobileTrainingUi && mobileTrainingBar && editShell) {
	type MobileTab = "training" | "damage";
	let activeTab: MobileTab = new URLSearchParams(window.location.search).get("tab") === "damage" ? "damage" : "training";
	const tabButtons = mobileTrainingBar.querySelectorAll<HTMLButtonElement>("button[data-mobile-tab]");

	// The page is mobile-only, so controls can be moved once instead of being
	// shuttled between the hidden desktop header on every viewport change.
	const relocationSpecs: ReadonlyArray<readonly [elementId: string, hostId: string, damageTabOnly: boolean]> = [
		["autosave-status", "mobile-edit-actions", false],
		["opponent-notes-save-alert", "mobile-edit-actions", false],
	];

	function relocateControls(): void {
		for (const [elementId, hostId, damageTabOnly] of relocationSpecs) {
			if (damageTabOnly && activeTab !== "damage") continue;
			const element = document.getElementById(elementId);
			const host = document.getElementById(hostId);
			if (element && host && element.parentElement !== host) host.appendChild(element);
		}
	}

	function updateStatAdjustmentSheetVisibility(): void {
		const sheet = document.getElementById("stat-adjust-sheet");
		if (!sheet) return;
		sheet.hidden = activeTab !== "damage";
		if (activeTab !== "damage") resetStatAdjustSheet();
	}

	function applyTab(): void {
		mobileTrainingUi.dataset.mobileTab = activeTab;
		editShell.dataset.mobileTab = activeTab;
		for (const button of tabButtons) {
			const isActive = button.dataset.mobileTab === activeTab;
			// app-header.css は `[data-active="true"]` を選択状態としている。
			// toggleAttribute() は値なしの `data-active` にしてしまい、このセレクタから
			// 外れるため、リロード直後に背景ハイライトだけが消えていた。
			button.dataset.active = isActive ? "true" : "false";
			if (isActive) button.setAttribute("aria-current", "page");
			else button.removeAttribute("aria-current");
		}
		relocateControls();
		updateStatAdjustmentSheetVisibility();
	}

	for (const button of tabButtons) {
		button.addEventListener("click", () => {
			const nextTab = button.dataset.mobileTab;
			if (nextTab !== "training" && nextTab !== "damage") return;
			activeTab = nextTab;
			applyTab();
		});
	}

	applyTab();
}
