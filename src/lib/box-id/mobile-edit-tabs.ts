const mobileTrainingUi = document.getElementById("mobile-training-ui");
const mobileTrainingBar = document.getElementById("mobile-training-bar");
const editShell = document.getElementById("edit-shell");

if (mobileTrainingUi && mobileTrainingBar && editShell) {
	type MobileTab = "training" | "damage";
	let activeTab: MobileTab = "training";
	const narrowMedia = window.matchMedia("(max-width: 899px)");
	const tabButtons = mobileTrainingBar.querySelectorAll<HTMLButtonElement>("button[data-mobile-tab]");
	const bulkAdjustButton = document.getElementById("bulk-adjust-button");
	const mobileToolbarActions = document.getElementById("mobile-damage-toolbar-actions");
	// 耐久調整の実体とイベントを複製せず使うため、デスクトップでの親と挿入位置を保持する。
	const originalParent = bulkAdjustButton?.parentNode ?? null;
	const originalNextSibling = bulkAdjustButton?.nextSibling ?? null;

	function applyTab(): void {
		mobileTrainingUi.dataset.mobileTab = activeTab;
		editShell.dataset.mobileTab = activeTab;
		for (const button of tabButtons) {
			const isActive = button.dataset.mobileTab === activeTab;
			if (isActive) {
				button.dataset.active = "true";
				button.setAttribute("aria-current", "page");
			} else {
				button.removeAttribute("data-active");
				button.removeAttribute("aria-current");
			}
		}
		if (!bulkAdjustButton || !originalParent) return;
		if (narrowMedia.matches && activeTab === "damage" && mobileToolbarActions) {
			mobileToolbarActions.appendChild(bulkAdjustButton);
		} else {
			// 900px以上へ戻った場合も、元の兄弟位置へ必ず復帰させる。
			originalParent.insertBefore(bulkAdjustButton, originalNextSibling);
		}
	}

	for (const button of tabButtons) {
		button.addEventListener("click", () => {
			const nextTab = button.dataset.mobileTab;
			if (nextTab !== "training" && nextTab !== "damage") return;
			activeTab = nextTab;
			applyTab();
		});
	}
	narrowMedia.addEventListener("change", applyTab);
	applyTab();
}
