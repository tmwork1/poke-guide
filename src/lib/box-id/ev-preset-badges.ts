import { STAT_KEYS, type StatKey } from "../stats";

export interface EvPreset { usageRate: number; evs: number[]; }
export interface EvPresetBadges {
	root: HTMLElement;
	load: (speciesName: string) => Promise<void>;
	syncCurrent: (evs: readonly number[]) => void;
}

type OpggUsageEvsResponse = { rows?: Array<{ usageRate: number; values: Record<string, number> }>; };

const OPGG_EV_KEY_BY_STAT_KEY: Record<StatKey, string> = {
	hp: "hp", atk: "attack", def: "defense", spa: "specialAttack", spd: "specialDefense", spe: "speed",
};
const STAT_SHORT_LABELS: Record<StatKey, string> = { hp: "H", atk: "A", def: "B", spa: "C", spd: "D", spe: "S" };

function clampEv(value: number): number { return Math.min(32, Math.max(0, Math.round(value))); }
function sameEvs(left: readonly number[], right: readonly number[]): boolean {
	return STAT_KEYS.every((_, index) => clampEv(left[index] ?? 0) === clampEv(right[index] ?? 0));
}

export function formatEvPresetLabel(evs: readonly number[]): string {
	const parts = STAT_KEYS.flatMap((key, index) => {
		const value = clampEv(evs[index] ?? 0);
		return value === 0 ? [] : [`${STAT_SHORT_LABELS[key]}${value}`];
	});
	return parts.join(" ") || "無振り";
}

export function buildEvPresetBadges(options: { onSelect: (evs: number[]) => void }): EvPresetBadges {
	const root = document.createElement("div");
	root.className = "ev-preset-badges";
	root.hidden = true;
	root.setAttribute("role", "group");
	root.setAttribute("aria-label", "努力値プリセット(OP.GG採用率順)");
	let presets: EvPreset[] = [];
	let currentEvs: number[] = [];
	let requestToken = 0;
	function syncCurrent(evs: readonly number[]): void {
		currentEvs = STAT_KEYS.map((_, index) => clampEv(evs[index] ?? 0));
		for (const button of root.querySelectorAll<HTMLButtonElement>(".ev-preset-badge")) {
			if (sameEvs(presets[Number(button.dataset.presetIndex)]?.evs ?? [], currentEvs)) button.setAttribute("aria-current", "true");
			else button.removeAttribute("aria-current");
		}
	}
	function render(): void {
		root.replaceChildren();
		root.hidden = presets.length === 0;
		for (const [index, preset] of presets.entries()) {
			const label = formatEvPresetLabel(preset.evs);
			const rate = Math.round(preset.usageRate);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "ev-preset-badge";
			button.dataset.presetIndex = String(index);
			button.setAttribute("aria-label", `努力値を${label}にする(採用率${rate}%)`);
			const evs = document.createElement("span"); evs.className = "ev-preset-badge-evs"; evs.textContent = label;
			const usageRate = document.createElement("span"); usageRate.className = "ev-preset-badge-rate"; usageRate.textContent = `${rate}%`;
			button.append(evs, usageRate);
			button.addEventListener("click", () => options.onSelect([...preset.evs]));
			root.appendChild(button);
		}
		syncCurrent(currentEvs);
	}
	async function load(speciesName: string): Promise<void> {
		const token = ++requestToken;
		const trimmed = speciesName.trim();
		if (!trimmed) { presets = []; render(); return; }
		try {
			const response = await fetch(`/api/opgg-usage-evs?species=${encodeURIComponent(trimmed)}`);
			if (!response.ok) throw new Error("Failed to fetch OP.GG EV usage");
			const payload = (await response.json()) as OpggUsageEvsResponse;
			if (token !== requestToken) return;
			presets = (payload.rows ?? []).slice(0, 5).map(({ usageRate, values }) => ({
				usageRate,
				evs: STAT_KEYS.map((key) => clampEv(values[OPGG_EV_KEY_BY_STAT_KEY[key]] ?? 0)),
			}));
			render();
		} catch {
			if (token !== requestToken) return;
			presets = []; render();
		}
	}
	return { root, load, syncCurrent };
}
