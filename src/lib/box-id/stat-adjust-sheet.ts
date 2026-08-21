const sheet = document.getElementById("stat-adjust-sheet");
const toggle = document.getElementById("stat-adjust-sheet-toggle") as HTMLButtonElement | null;

export function resetStatAdjustSheet(): void {
	if (!sheet || !toggle) return;
	sheet.classList.remove("is-expanded");
	toggle.setAttribute("aria-expanded", "false");
}

toggle?.addEventListener("click", () => {
	if (!sheet) return;
	const isExpanded = sheet.classList.toggle("is-expanded");
	toggle.setAttribute("aria-expanded", String(isExpanded));
});
