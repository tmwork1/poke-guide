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
		["bulk-adjust-button", "damage-rows-toolbar", true],
		["damage-collapse-toggle-button", "damage-rows-toolbar", true],
		["autosave-status", "mobile-edit-actions", false],
		["opponent-notes-save-alert", "mobile-edit-actions", false],
		["collection-opt-out-label", "mobile-edit-actions", false],
		["delete-button", "mobile-edit-actions", false],
	];

	function relocateControls(): void {
		for (const [elementId, hostId, damageTabOnly] of relocationSpecs) {
			if (damageTabOnly && activeTab !== "damage") continue;
			const element = document.getElementById(elementId);
			const host = document.getElementById(hostId);
			if (element && host && element.parentElement !== host) host.appendChild(element);
		}
	}

	function applyTab(): void {
		mobileTrainingUi.dataset.mobileTab = activeTab;
		editShell.dataset.mobileTab = activeTab;
		for (const button of tabButtons) {
			const isActive = button.dataset.mobileTab === activeTab;
			button.toggleAttribute("data-active", isActive);
			if (isActive) button.setAttribute("aria-current", "page");
			else button.removeAttribute("aria-current");
		}
		relocateControls();
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
