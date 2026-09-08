// 育成タブ(PokemonEditPanel.astro / stat-adjustment-panel.ts)と同じ操作感の努力値ステッパー
// (「− 値 +」の3ボタン+値タップで0〜32のピッカー+値の長押しで0⇔32トグル)を、
// 値の保持先に依存しない形で組み立てるビルダー。
//
// なぜ切り出したか: ダメージタブ下部の引き出し(stat-adjust-sheet.ts)は、育成タブの
// #stat-adjustment-section を「見に行って同期する」ミラー実装のため、育成タブのDOMを
// そのまま持ってこられない。値の読み書きだけを getValue/setValue で注入できるように
// することで、見た目と操作をミラー側でも同じにする。
import { bindPressAndHold } from "../press-and-hold";
import { markModalPortal } from "../modal-dismiss";
import { wrapToRange } from "./shared-core";

export interface EvStepperOptions {
	/** aria-label の組み立てに使う能力値の呼び名(例: "H") */
	label: string;
	min: number;
	max: number;
	getValue: () => number;
	/** 値の確定。呼び出し側が保持先を更新し、必要なら sync() を呼び戻す */
	setValue: (next: number) => void;
}

export interface EvStepper {
	root: HTMLElement;
	/** 外部で値が変わったときに表示(値ボタン・ピッカーの現在値)を追従させる */
	sync: () => void;
}

export function createEvStepper({ label, min, max, getValue, setValue }: EvStepperOptions): EvStepper {
	const root = document.createElement("span");
	root.className = "number-stepper";

	const decrement = document.createElement("button");
	decrement.type = "button";
	decrement.className = "btn-ghost";
	decrement.textContent = "−";
	decrement.setAttribute("aria-label", `${label}の努力値を1減らす`);

	const increment = document.createElement("button");
	increment.type = "button";
	increment.className = "btn-ghost";
	increment.textContent = "+";
	increment.setAttribute("aria-label", `${label}の努力値を1増やす`);

	const valueButton = document.createElement("button");
	valueButton.type = "button";
	valueButton.className = "number-stepper-value tnum";
	valueButton.setAttribute("aria-haspopup", "dialog");
	valueButton.setAttribute("aria-expanded", "false");
	valueButton.setAttribute("aria-label", `${label}の努力値`);

	const picker = document.createElement("div");
	picker.className = "number-stepper-picker";
	picker.hidden = true;
	picker.setAttribute("role", "dialog");
	// openPicker() で document.body 直下へ移すため、モーダルの背景クリック遮断に
	// 「外側」と誤判定されないよう印を付ける(stat-adjustment-panel.ts と同じ)。
	markModalPortal(picker);
	for (let value = min; value <= max; value += 1) {
		const option = document.createElement("button");
		option.type = "button";
		option.className = "tnum";
		option.dataset.evValue = String(value);
		option.textContent = String(value);
		picker.appendChild(option);
	}

	function closePicker(): void {
		picker.hidden = true;
		valueButton.setAttribute("aria-expanded", "false");
	}

	function openPicker(): void {
		document.body.appendChild(picker);
		picker.hidden = false;
		const anchor = valueButton.getBoundingClientRect();
		const pickerRect = picker.getBoundingClientRect();
		picker.style.position = "fixed";
		picker.style.top = `${Math.max(8, Math.min(window.innerHeight - pickerRect.height - 8, anchor.bottom + 4))}px`;
		picker.style.left = `${Math.max(8, Math.min(window.innerWidth - pickerRect.width - 8, anchor.left + (anchor.width - pickerRect.width) / 2))}px`;
		valueButton.setAttribute("aria-expanded", "true");
	}

	let holdTimer: number | undefined;
	let held = false;
	const stopHold = (): void => {
		if (holdTimer !== undefined) window.clearTimeout(holdTimer);
		holdTimer = undefined;
	};
	valueButton.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		held = false;
		holdTimer = window.setTimeout(() => {
			held = true;
			closePicker();
			setValue(getValue() > min ? min : max);
		}, 500);
	});
	valueButton.addEventListener("pointerup", stopHold);
	valueButton.addEventListener("pointercancel", stopHold);
	valueButton.addEventListener("lostpointercapture", stopHold);
	valueButton.addEventListener("click", (event) => {
		if (held) {
			event.preventDefault();
			event.stopImmediatePropagation();
			held = false;
			return;
		}
		if (picker.hidden) openPicker();
		else closePicker();
	});
	picker.addEventListener("click", (event) => {
		const option = (event.target as Element).closest<HTMLButtonElement>("[data-ev-value]");
		if (!option) return;
		// ピッカーは body へ一時的に移動するため、このクリックがモーダル外クリックとして
		// 扱われないようにする。
		event.stopPropagation();
		setValue(Number(option.dataset.evValue) || 0);
		closePicker();
		valueButton.focus();
	});
	document.addEventListener("pointerdown", (event) => {
		if (picker.hidden || picker.contains(event.target as Node) || valueButton.contains(event.target as Node)) return;
		closePicker();
	});

	const step = (amount: number): boolean => {
		const current = getValue();
		const next = wrapToRange(current + amount, min, max);
		if (next === current) return false;
		setValue(next);
		return true;
	};
	bindPressAndHold(decrement, () => step(-1));
	bindPressAndHold(increment, () => step(1));
	decrement.addEventListener("click", () => step(-1));
	increment.addEventListener("click", () => step(1));

	root.append(decrement, valueButton, increment, picker);

	function sync(): void {
		const value = getValue();
		valueButton.textContent = String(value);
		valueButton.classList.toggle("is-nonzero", value !== 0);
		for (const option of picker.querySelectorAll<HTMLButtonElement>("[data-ev-value]")) {
			option.setAttribute("aria-current", String(Number(option.dataset.evValue) === value));
		}
	}

	sync();
	return { root, sync };
}
