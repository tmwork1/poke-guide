const sheet = document.getElementById("stat-adjust-sheet");
const toggle = document.getElementById("stat-adjust-sheet-toggle") as HTMLButtonElement | null;
const body = document.getElementById("stat-status-adjust-body");

const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const STAT_LABELS = ["H", "A", "B", "C", "D", "S"] as const;

const remainingDisplay = document.getElementById("stat-adjust-sheet-remaining");

function updateRemainingDisplay(): void {
	if (!remainingDisplay) return;
	const source = document.getElementById("stat-adjustment-section");
	if (!source) return;
	let total = 0;
	for (const key of STAT_KEYS) {
		const sourceRange = source.querySelector<HTMLInputElement>(`#ev-${key}-range`);
		if (sourceRange) total += Number(sourceRange.value) || 0;
	}
	remainingDisplay.textContent = `残り${66 - total}`;
}

const remainingSource = document.getElementById("stat-adjustment-section");
if (remainingSource) {
	remainingSource.addEventListener("input", updateRemainingDisplay);
	remainingSource.addEventListener("change", updateRemainingDisplay);
	new MutationObserver(updateRemainingDisplay).observe(remainingSource, {
		subtree: true,
		childList: true,
		characterData: true,
		attributes: true,
	});
	updateRemainingDisplay();
}

export function resetStatAdjustSheet(): void {
	if (!sheet || !toggle) return;
	sheet.classList.remove("is-expanded");
	toggle.setAttribute("aria-expanded", "false");
}

function buildDamageStatAdjustmentSheet(): void {
	if (!body || body.childElementCount > 0) return;
	const source = document.getElementById("stat-adjustment-section");
	if (!source) return;

	const root = document.createElement("div");
	root.className = "damage-stat-adjustment";
	const rows = new Map<string, { range: HTMLInputElement; value: HTMLElement; real: HTMLElement }>();

	for (const [index, key] of STAT_KEYS.entries()) {
		if (key === "spe") continue;
		const row = document.createElement("div");
		row.className = "damage-stat-adjustment-row";
		const label = document.createElement("span");
		label.className = "damage-stat-adjustment-label";
		label.textContent = STAT_LABELS[index];
		const nature = document.createElement("span");
		nature.className = "damage-stat-adjustment-nature";
		if (key !== "hp") {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "damage-stat-adjustment-nature-btn";
			button.dataset.statKey = key;
			button.setAttribute("aria-label", `${STAT_LABELS[index]}の性格補正を切り替える`);
			button.addEventListener("click", () => source.querySelector<HTMLButtonElement>(`#nature-toggle-${key}`)?.click());
			nature.appendChild(button);
		}
		const decrement = document.createElement("button");
		decrement.type = "button";
		decrement.className = "damage-stat-adjustment-step";
		decrement.textContent = "−";
		decrement.setAttribute("aria-label", `${STAT_LABELS[index]}の努力値を減らす`);
		const increment = document.createElement("button");
		increment.type = "button";
		increment.className = "damage-stat-adjustment-step";
		increment.textContent = "+";
		increment.setAttribute("aria-label", `${STAT_LABELS[index]}の努力値を増やす`);
		const value = document.createElement("span");
		value.className = "damage-stat-adjustment-value tnum";
		const evValue = document.createElement("span");
		evValue.className = "damage-stat-adjustment-ev-value";
		evValue.appendChild(value);
		const range = document.createElement("input");
		range.type = "range";
		range.min = "0";
		range.max = "32";
		range.step = "1";
		range.className = "damage-stat-adjustment-slider";
		range.setAttribute("aria-label", `${STAT_LABELS[index]}の努力値`);
		const real = document.createElement("span");
		real.className = "damage-stat-adjustment-real tnum";

		const sourceRange = source.querySelector<HTMLInputElement>(`#ev-${key}-range`);
		const setSourceValue = (delta: number | null): void => {
			if (!sourceRange) return;
			const next = delta === null ? Number(range.value) : Math.max(0, Math.min(32, Number(sourceRange.value) + delta));
			sourceRange.value = String(next);
			sourceRange.dispatchEvent(new Event("input", { bubbles: true }));
		};
		decrement.addEventListener("click", () => setSourceValue(-1));
		increment.addEventListener("click", () => setSourceValue(1));
		range.addEventListener("input", () => setSourceValue(null));
		row.append(label, nature, decrement, range, increment, evValue, real);
		root.appendChild(row);
		rows.set(key, { range, value, real });
	}
	body.appendChild(root);

	const sync = (): void => {
		for (const key of STAT_KEYS) {
			const sourceRange = source.querySelector<HTMLInputElement>(`#ev-${key}-range`);
			const row = rows.get(key);
			if (!sourceRange || !row) continue;
			const sourceReal = source.querySelector<HTMLElement>(`#stat-${key}`);
			const sourceLabel = source.querySelector<HTMLElement>(`#nature-label-${key}`);
			const ev = Number(sourceRange.value) || 0;
			row.range.value = String(ev);
			const progressPercent = Math.min(100, Math.max(0, (ev / 32) * 100));
			row.range.style.setProperty("--slider-progress", `${progressPercent}%`);
			row.value.textContent = String(ev);
			row.real.textContent = sourceReal?.textContent ?? "-";
			if (sourceLabel?.dataset.mod) row.value.dataset.mod = sourceLabel.dataset.mod;
			else delete row.value.dataset.mod;
			if (sourceReal?.dataset.mod) row.real.dataset.mod = sourceReal.dataset.mod;
			else delete row.real.dataset.mod;
			const sourceButton = source.querySelector<HTMLButtonElement>(`#nature-toggle-${key}`);
			const sheetButton = root.querySelector<HTMLButtonElement>(`.damage-stat-adjustment-nature-btn[data-stat-key="${key}"]`);
			if (sheetButton) sheetButton.dataset.natureState = sourceButton?.dataset.natureState ?? "none";
		}
	};

	source.addEventListener("input", sync);
	source.addEventListener("change", sync);
	new MutationObserver(sync).observe(source, { subtree: true, childList: true, characterData: true, attributes: true });
	sync();
}

toggle?.addEventListener("click", () => {
	if (!sheet) return;
	const isExpanded = sheet.classList.toggle("is-expanded");
	toggle.setAttribute("aria-expanded", String(isExpanded));
	if (isExpanded) buildDamageStatAdjustmentSheet();
});
