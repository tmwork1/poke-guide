import {
	calcHpStat,
	calcOtherStat,
	type StatKey,
	STAT_KEYS,
} from "../stats";
import {
	natureNameFromBoosts,
	normalizedNatureBoosts,
	wrapToRange,
} from "./shared-core";

export interface StatAdjustmentPanelOptions {
	baseStats: number[];
	evs: number[];
	nature: string;
	natureUp: StatKey | null;
	natureDown: StatKey | null;
	onChange: () => void;
}

export interface StatAdjustmentPanel {
	root: HTMLElement;
	refresh: () => void;
}

const STAT_LABELS: Array<{ key: StatKey; label: string; short: string }> = [
	{ key: "hp", label: "HP", short: "H" },
	{ key: "atk", label: "攻撃", short: "A" },
	{ key: "def", label: "防御", short: "B" },
	{ key: "spa", label: "特攻", short: "C" },
	{ key: "spd", label: "特防", short: "D" },
	{ key: "spe", label: "素早さ", short: "S" },
];

const EV_MIN = 0;
const EV_MAX = 32;
const EV_TOTAL_MAX = 66;
const LEVEL = 50;
const IV = 31;

function makeSpan(className?: string, text?: string): HTMLSpanElement {
	const span = document.createElement("span");
	if (className) span.className = className;
	if (text !== undefined) span.textContent = text;
	return span;
}

function makeEndpointIcon(): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	for (const d of ["m17 11-5-5-5 5", "m17 18-5-5-5 5"]) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.appendChild(path);
	}
	return svg;
}

/**
 * 育成タブのステータス表と同じDOM・操作を、ページ内IDに依存せず生成する。
 * optionsは状態コンテナも兼ね、性格操作時にはnature/natureUp/natureDownを書き換える。
 */
export function buildStatAdjustmentPanel(options: StatAdjustmentPanelOptions): StatAdjustmentPanel {
	const root = document.createElement("div");
	root.className = "stat-adjustment-section";
	const table = document.createElement("div");
	table.className = "stat-table";
	root.appendChild(table);

	const header = document.createElement("div");
	header.className = "stat-table-header";
	const headerLabelPlaceholder = makeSpan("stat-table-header-label");
	headerLabelPlaceholder.setAttribute("aria-hidden", "true");
	header.appendChild(headerLabelPlaceholder);
	const natureHeader = makeSpan("stat-table-header-nature");
	const natureReadout = makeSpan();
	natureReadout.setAttribute("aria-label", "性格");
	natureHeader.appendChild(natureReadout);
	header.appendChild(natureHeader);
	header.appendChild(makeSpan(undefined, "種族値"));
	header.appendChild(makeSpan("stat-table-header-ev-label", "努力値"));
	const remainingHeader = makeSpan("stat-table-header-ev-remaining");
	const remaining = makeSpan("ev-remaining tnum");
	remainingHeader.appendChild(remaining);
	header.appendChild(remainingHeader);
	header.appendChild(makeSpan("stat-table-header-real-label", "実数値"));
	table.appendChild(header);

	const natureButtons = new Map<StatKey, { up: HTMLButtonElement; down: HTMLButtonElement; label: HTMLElement }>();
	const baseValueEls = new Map<StatKey, HTMLElement>();
	const numberInputs = new Map<StatKey, HTMLInputElement>();
	const rangeInputs = new Map<StatKey, HTMLInputElement>();
	const realValueEls = new Map<StatKey, HTMLElement>();

	function updateSliderProgress(rangeInput: HTMLInputElement): void {
		const value = Number(rangeInput.value) || 0;
		const percent = Math.min(100, Math.max(0, (value / EV_MAX) * 100));
		rangeInput.style.setProperty("--slider-progress", `${percent}%`);
	}

	function setEv(index: number, value: number): void {
		const next = Math.min(EV_MAX, Math.max(EV_MIN, Math.round(value)));
		options.evs[index] = next;
		const key = STAT_KEYS[index];
		const numberInput = numberInputs.get(key);
		const rangeInput = rangeInputs.get(key);
		if (numberInput) numberInput.value = String(next);
		if (rangeInput) {
			rangeInput.value = String(next);
			updateSliderProgress(rangeInput);
		}
		refresh();
		options.onChange();
	}

	STAT_LABELS.forEach(({ key, label, short }, index) => {
		const row = document.createElement("div");
		row.className = "stat-row";

		// 育成タブ(LeftPanel.astro)と同じく、短縮ラベル(.stat-row-label)と性格補正の
		// ▲▼ボタン(.stat-row-nature)を別セルに分ける。同じ構造にすることで
		// stat-adjustment-panel.cssの列幅(--stat-grid-template-columns等)を両タブで
		// 共通にでき、HP行(ボタン無し)だけラベルのX位置がずれる問題を解消する。
		const labelWrap = makeSpan("stat-row-label", short);
		labelWrap.setAttribute("aria-label", label);
		labelWrap.title = label;
		row.appendChild(labelWrap);

		const natureWrap = makeSpan("stat-row-nature");
		if (key === "hp") {
			natureWrap.setAttribute("aria-hidden", "true");
		} else {
			const up = document.createElement("button");
			up.type = "button";
			up.className = "stat-nature-btn stat-nature-up";
			up.setAttribute("aria-pressed", "false");
			up.setAttribute("aria-label", `${label}を性格補正で上昇させる`);
			up.title = `${label}を上昇に設定`;
			up.textContent = "▲";
			const down = document.createElement("button");
			down.type = "button";
			down.className = "stat-nature-btn stat-nature-down";
			down.setAttribute("aria-pressed", "false");
			down.setAttribute("aria-label", `${label}を性格補正で下降させる`);
			down.title = `${label}を下降に設定`;
			down.textContent = "▼";
			up.addEventListener("click", () => {
				options.natureUp = options.natureUp === key ? null : key;
				if (options.natureUp === key && options.natureDown === key) options.natureDown = null;
				options.nature = natureNameFromBoosts(options.natureUp, options.natureDown);
				refresh();
				options.onChange();
			});
			down.addEventListener("click", () => {
				options.natureDown = options.natureDown === key ? null : key;
				if (options.natureDown === key && options.natureUp === key) options.natureUp = null;
				options.nature = natureNameFromBoosts(options.natureUp, options.natureDown);
				refresh();
				options.onChange();
			});
			natureButtons.set(key, { up, down, label: labelWrap });
			natureWrap.append(up, down);
		}
		row.appendChild(natureWrap);

		const baseValue = makeSpan("stat-row-base tnum", "-");
		baseValueEls.set(key, baseValue);
		row.appendChild(baseValue);

		const inputControls = document.createElement("div");
		inputControls.className = "stat-input-controls";
		const rangeControls = document.createElement("div");
		rangeControls.className = "stat-ev-range-controls";

		const decrement = document.createElement("button");
		decrement.type = "button";
		decrement.className = "btn-ghost stat-ev-step-button";
		decrement.dataset.evStep = "-1";
		decrement.setAttribute("aria-label", `${short}の努力値を1減らす`);
		decrement.textContent = "−";

		const range = document.createElement("input");
		range.type = "range";
		range.min = String(EV_MIN);
		range.max = String(EV_MAX);
		range.step = "1";
		range.setAttribute("aria-label", `${label}の努力値(スライダー)`);
		rangeInputs.set(key, range);

		const increment = document.createElement("button");
		increment.type = "button";
		increment.className = "btn-ghost stat-ev-step-button";
		increment.dataset.evStep = "1";
		increment.setAttribute("aria-label", `${short}の努力値を1増やす`);
		increment.textContent = "+";

		const endpoint = document.createElement("button");
		endpoint.type = "button";
		endpoint.className = "btn-ghost stat-ev-endpoint-button";
		endpoint.dataset.evEndpoint = "max";
		endpoint.setAttribute("data-ev-toggle", "");
		endpoint.setAttribute("aria-label", `${short}の努力値を最大にする`);
		endpoint.appendChild(makeEndpointIcon());

		const number = document.createElement("input");
		number.type = "number";
		number.step = "1";
		number.className = "tnum";
		number.setAttribute("aria-label", `${label}の努力値`);
		numberInputs.set(key, number);

		range.addEventListener("input", () => setEv(index, Number(range.value) || 0));
		number.addEventListener("input", () => {
			const parsed = Number(number.value);
			if (!Number.isFinite(parsed)) return;
			setEv(index, wrapToRange(Math.round(parsed), EV_MIN, EV_MAX));
		});
		decrement.addEventListener("click", () => setEv(index, (options.evs[index] ?? 0) - 1));
		increment.addEventListener("click", () => setEv(index, (options.evs[index] ?? 0) + 1));
		endpoint.addEventListener("click", () => {
			const endpointName = endpoint.dataset.evEndpoint === "min" ? "min" : "max";
			setEv(index, endpointName === "max" ? EV_MAX : EV_MIN);
			const nextEndpoint = endpointName === "max" ? "min" : "max";
			endpoint.dataset.evEndpoint = nextEndpoint;
			endpoint.setAttribute("aria-label", `${short}の努力値を${nextEndpoint === "max" ? "最大" : "最小"}にする`);
		});

		rangeControls.append(decrement, range, increment, endpoint);
		inputControls.append(rangeControls, number);
		row.appendChild(inputControls);

		const realWrap = makeSpan("stat-row-real-wrap");
		const realValue = makeSpan("stat-row-real stat-value tnum", "-");
		realValueEls.set(key, realValue);
		realWrap.appendChild(realValue);
		row.appendChild(realWrap);
		table.appendChild(row);
	});

	function refresh(): void {
		options.nature = natureNameFromBoosts(options.natureUp, options.natureDown);
		natureReadout.textContent = options.nature;
		for (const [key, controls] of natureButtons) {
			controls.up.setAttribute("aria-pressed", String(options.natureUp === key));
			controls.down.setAttribute("aria-pressed", String(options.natureDown === key));
			if (options.natureUp === key) controls.label.dataset.mod = "up";
			else if (options.natureDown === key) controls.label.dataset.mod = "down";
			else delete controls.label.dataset.mod;
		}

		const evTotal = STAT_KEYS.reduce((sum, _key, index) => sum + (options.evs[index] ?? 0), 0);
		const evRemaining = EV_TOTAL_MAX - evTotal;
		remaining.textContent = `残り${evRemaining}`;
		if (evRemaining < 0) remaining.dataset.state = "over";
		else if (evRemaining === 0) remaining.dataset.state = "zero";
		else delete remaining.dataset.state;

		const natureMod = normalizedNatureBoosts(options.natureUp, options.natureDown);
		STAT_KEYS.forEach((key, index) => {
			const ev = options.evs[index] ?? 0;
			const number = numberInputs.get(key);
			const range = rangeInputs.get(key);
			if (number && document.activeElement !== number) number.value = String(ev);
			if (range) {
				range.value = String(ev);
				updateSliderProgress(range);
			}
			const base = options.baseStats[index];
			const baseValue = baseValueEls.get(key);
			const realValue = realValueEls.get(key);
			if (baseValue) baseValue.textContent = Number.isFinite(base) ? String(base) : "-";
			if (!realValue) return;
			if (!Number.isFinite(base)) {
				realValue.textContent = "-";
				delete realValue.dataset.mod;
				return;
			}
			const mod = natureMod.up === key ? "up" : natureMod.down === key ? "down" : null;
			const value = key === "hp"
				? calcHpStat(LEVEL, base, IV, ev)
				: calcOtherStat(LEVEL, base, IV, ev, mod === "up" ? 1.1 : mod === "down" ? 0.9 : 1);
			realValue.textContent = String(value);
			if (mod) realValue.dataset.mod = mod;
			else delete realValue.dataset.mod;
		});
	}

	refresh();
	return { root, refresh };
}
