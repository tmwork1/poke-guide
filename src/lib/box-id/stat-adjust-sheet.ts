// ダメージタブ下部の引き出し「ステータス調整」。育成タブの #stat-adjustment-section を
// 正とし、そこへ値を書き戻す/そこから値を読むミラーとして動く。
//
// レイアウト: 3行2列。左列 H/B/D、右列 A/C/S(STAT_KEYS の並びのまま2列グリッドに流す)。
// 各セルはラベルが外側・ステッパーが内側の鏡写し配置で、左右の親指どちらでも
// ステッパーへ届くようにする(右列は CSS の row-reverse)。
//
// ラベルは性格補正の切替ボタンを兼ねる(タップで未設定→上昇→下降を循環し、文字色と▲▼で
// 状態を示す)。性格補正だけの列を持つと2列がシート幅に収まらないため、育成タブのように
// 独立した三角ボタンは置かない。実数値はラベルの直下に小さく添える。
import { createEvStepper } from "./ev-stepper";

const sheet = document.getElementById("stat-adjust-sheet");
const toggle = document.getElementById("stat-adjust-sheet-toggle") as HTMLButtonElement | null;
const body = document.getElementById("stat-status-adjust-body");

const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const STAT_LABELS = ["H", "A", "B", "C", "D", "S"] as const;
const EV_MIN = 0;
const EV_MAX = 32;
const EV_TOTAL = 66;

function updateRemainingDisplay(): void {
	// 「残り」はシートのつまみ側に出すため、シートを開く前(=中身を組み立てる前)から更新する。
	const remainingDisplay = document.getElementById("stat-adjust-sheet-remaining");
	if (!remainingDisplay) return;
	const source = document.getElementById("stat-adjustment-section");
	if (!source) return;
	let total = 0;
	for (const key of STAT_KEYS) {
		const sourceRange = source.querySelector<HTMLInputElement>(`#ev-${key}-range`);
		if (sourceRange) total += Number(sourceRange.value) || 0;
	}
	remainingDisplay.textContent = `残り ${EV_TOTAL - total}`;
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
	// 残り努力値は常設の子要素としてbody内に置く。子要素の有無で判定すると
	// 初回展開時にも既に生成済みと誤認するため、調整表そのものだけを確認する。
	if (!body || body.querySelector(".damage-stat-adjustment")) return;
	const source = document.getElementById("stat-adjustment-section");
	if (!source) return;

	const root = document.createElement("div");
	root.className = "damage-stat-adjustment";
	const cells = new Map<string, { label: HTMLElement; name: HTMLElement; real: HTMLElement; sync: () => void }>();

	for (const [index, key] of STAT_KEYS.entries()) {
		const shortLabel = STAT_LABELS[index];
		const sourceRange = source.querySelector<HTMLInputElement>(`#ev-${key}-range`);

		const cell = document.createElement("div");
		cell.className = "damage-stat-adjustment-cell";

		// HPには性格補正が無いので、ラベルはボタンにせず同じ見た目の静的セルにする。
		const label = document.createElement(key === "hp" ? "span" : "button") as HTMLElement;
		label.className = "damage-stat-adjustment-label";
		if (key === "hp") {
			label.classList.add("is-static");
		} else {
			const button = label as HTMLButtonElement;
			button.type = "button";
			button.dataset.statKey = key;
			button.dataset.natureState = "none";
			button.setAttribute("aria-label", `${shortLabel}の性格補正を切り替える`);
			button.addEventListener("click", () => source.querySelector<HTMLButtonElement>(`#nature-toggle-${key}`)?.click());
		}
		const name = document.createElement("span");
		name.className = "damage-stat-adjustment-label-name";
		name.textContent = shortLabel;
		const real = document.createElement("span");
		real.className = "damage-stat-adjustment-real tnum";
		real.textContent = "-";
		label.append(name, real);

		const stepper = createEvStepper({
			label: shortLabel,
			min: EV_MIN,
			max: EV_MAX,
			getValue: () => Number(sourceRange?.value) || 0,
			setValue: (next) => {
				if (!sourceRange) return;
				if (String(next) === sourceRange.value) return;
				sourceRange.value = String(next);
				sourceRange.dispatchEvent(new Event("input", { bubbles: true }));
			},
		});
		stepper.root.classList.add("damage-stat-adjustment-stepper");

		cell.append(label, stepper.root);
		root.appendChild(cell);
		cells.set(key, { label, name, real, sync: stepper.sync });
	}
	body.appendChild(root);

	const sync = (): void => {
		for (const key of STAT_KEYS) {
			const cell = cells.get(key);
			if (!cell) continue;
			cell.sync();
			const sourceReal = source.querySelector<HTMLElement>(`#stat-${key}`);
			cell.real.textContent = sourceReal?.textContent ?? "-";
			if (sourceReal?.dataset.mod) cell.real.dataset.mod = sourceReal.dataset.mod;
			else delete cell.real.dataset.mod;
			if (key === "hp") continue;
			const sourceButton = source.querySelector<HTMLButtonElement>(`#nature-toggle-${key}`);
			cell.label.dataset.natureState = sourceButton?.dataset.natureState ?? "none";
		}
	};

	source.addEventListener("input", sync);
	source.addEventListener("change", sync);
	new MutationObserver(sync).observe(source, { subtree: true, childList: true, characterData: true, attributes: true });
	sync();
	updateRemainingDisplay();
}

toggle?.addEventListener("click", () => {
	if (!sheet) return;
	const isExpanded = sheet.classList.toggle("is-expanded");
	toggle.setAttribute("aria-expanded", String(isExpanded));
	if (isExpanded) buildDamageStatAdjustmentSheet();
});
