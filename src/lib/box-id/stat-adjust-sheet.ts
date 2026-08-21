const sheet = document.getElementById("stat-adjust-sheet");
const toggle = document.getElementById("stat-adjust-sheet-toggle") as HTMLButtonElement | null;
const body = document.getElementById("stat-status-adjust-body");

const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const STAT_LABELS = ["H", "A", "B", "C", "D", "S"] as const;

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
	const remaining = document.createElement("span");
	remaining.className = "damage-stat-adjustment-remaining tnum";
	const rows = new Map<string, { range: HTMLInputElement; value: HTMLElement; real: HTMLElement }>();

	for (const [index, key] of STAT_KEYS.entries()) {
		const row = document.createElement("div");
		row.className = "damage-stat-adjustment-row";
		const label = document.createElement("span");
		label.className = "damage-stat-adjustment-label";
		label.textContent = STAT_LABELS[index];
		const nature = document.createElement("span");
		nature.className = "damage-stat-adjustment-nature";
		if (key !== "hp") {
			for (const direction of ["up", "down"] as const) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = `damage-stat-adjustment-nature-${direction}`;
				button.dataset.statKey = key;
				button.textContent = direction === "up" ? "▲" : "▼";
				button.setAttribute("aria-label", `${STAT_LABELS[index]}の性格補正を${direction === "up" ? "上昇" : "下降"}にする`);
				button.addEventListener("click", () => source.querySelector<HTMLButtonElement>(`#nature-${direction}-${key}`)?.click());
				nature.appendChild(button);
			}
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
		if (key === "hp") evValue.appendChild(remaining);
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
		let total = 0;
		for (const key of STAT_KEYS) {
			const sourceRange = source.querySelector<HTMLInputElement>(`#ev-${key}-range`);
			const sourceReal = source.querySelector<HTMLElement>(`#stat-${key}`);
			const sourceLabel = source.querySelector<HTMLElement>(`#nature-label-${key}`);
			const row = rows.get(key);
			if (!sourceRange || !row) continue;
			const ev = Number(sourceRange.value) || 0;
			total += ev;
			row.range.value = String(ev);
			row.value.textContent = String(ev);
			row.real.textContent = sourceReal?.textContent ?? "-";
			if (sourceLabel?.dataset.mod) row.value.dataset.mod = sourceLabel.dataset.mod;
			else delete row.value.dataset.mod;
			if (sourceReal?.dataset.mod) row.real.dataset.mod = sourceReal.dataset.mod;
			else delete row.real.dataset.mod;
			for (const direction of ["up", "down"] as const) {
				const sourceButton = source.querySelector<HTMLButtonElement>(`#nature-${direction}-${key}`);
				const sheetButton = root.querySelector<HTMLButtonElement>(`.damage-stat-adjustment-nature-${direction}[data-stat-key="${key}"]`);
				if (sheetButton) sheetButton.setAttribute("aria-pressed", String(sourceButton?.getAttribute("aria-pressed") === "true"));
			}
		}
		remaining.textContent = `残り${66 - total}`;
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
