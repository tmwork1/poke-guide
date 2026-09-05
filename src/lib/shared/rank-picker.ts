export type RankPickerPlacement = "above" | "below";

export interface RankPicker {
	picker: HTMLDivElement;
	setSelectedValue: (value: number) => void;
}

interface CreateRankPickerOptions {
	pickerButton: HTMLButtonElement;
	placement: RankPickerPlacement;
	onSelect: (value: number) => void;
	formatValue: (value: number) => string;
}

/** -6〜+6を選ぶ共通ポップアップ。ボタン本体の見た目と状態管理は呼び出し側が担う。 */
export function createRankPicker({ pickerButton, placement, onSelect, formatValue }: CreateRankPickerOptions): RankPicker {
	const picker = document.createElement("div");
	picker.className = "number-stepper-picker number-stepper-picker--rank";
	picker.hidden = true;
	picker.setAttribute("role", "dialog");
	for (let value = -6; value <= 6; value += 1) {
		const option = document.createElement("button");
		option.type = "button";
		option.className = "tnum";
		option.dataset.rankValue = String(value);
		option.textContent = formatValue(value);
		picker.append(option);
	}
	const closePicker = (): void => {
		picker.hidden = true;
		pickerButton.setAttribute("aria-expanded", "false");
	};
	const openPicker = (): void => {
		document.body.append(picker);
		picker.hidden = false;
		const anchor = pickerButton.getBoundingClientRect();
		const pickerRect = picker.getBoundingClientRect();
		picker.style.position = "fixed";
		const desiredTop = placement === "above" ? anchor.top - pickerRect.height - 4 : anchor.bottom + 4;
		picker.style.top = `${Math.max(8, Math.min(window.innerHeight - pickerRect.height - 8, desiredTop))}px`;
		picker.style.left = `${Math.max(8, Math.min(window.innerWidth - pickerRect.width - 8, anchor.left + (anchor.width - pickerRect.width) / 2))}px`;
		pickerButton.setAttribute("aria-expanded", "true");
	};
	pickerButton.addEventListener("click", () => {
		if (picker.hidden) openPicker();
		else closePicker();
	});
	picker.addEventListener("click", (event) => {
		const option = (event.target as Element).closest<HTMLButtonElement>("[data-rank-value]");
		if (!option) return;
		onSelect(Number(option.dataset.rankValue));
		closePicker();
		pickerButton.focus();
	});
	document.addEventListener("pointerdown", (event) => {
		if (picker.hidden || picker.contains(event.target as Node) || pickerButton.contains(event.target as Node)) return;
		closePicker();
	});
	return {
		picker,
		setSelectedValue: (value) => picker.querySelectorAll<HTMLButtonElement>("[data-rank-value]").forEach((option) => {
			option.setAttribute("aria-current", String(Number(option.dataset.rankValue) === value));
		}),
	};
}
