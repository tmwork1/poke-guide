export type SortOrder = "asc" | "desc";

interface SortDirectionToggleOptions {
	select: HTMLSelectElement;
	selectWrap: HTMLElement;
	directionToggle: HTMLButtonElement;
	directionLabel: HTMLElement;
	defaultOrders: Readonly<Record<string, SortOrder>>;
	initialOrder?: SortOrder;
	onChange: (sortOrder: SortOrder) => void;
}

export interface SortDirectionToggle {
	getSortOrder: () => SortOrder;
}

/**
 * Keeps the sort direction state and the shared select/toggle UI in sync.
 * Sorting the page-specific data remains the caller's responsibility.
 */
export function initializeSortDirectionToggle({
	select,
	selectWrap,
	directionToggle,
	directionLabel,
	defaultOrders,
	initialOrder = "desc",
	onChange,
}: SortDirectionToggleOptions): SortDirectionToggle {
	let sortOrder = initialOrder;

	const updateUi = (): void => {
		selectWrap.dataset.order = sortOrder;
		directionToggle.dataset.order = sortOrder;
		const isAscending = sortOrder === "asc";
		directionToggle.setAttribute("aria-label", `並べ替えの向き: ${isAscending ? "昇順" : "降順"}`);
		directionLabel.textContent = isAscending ? "A→Z" : "Z→A";
	};

	select.addEventListener("change", () => {
		sortOrder = defaultOrders[select.value] ?? "asc";
		updateUi();
		onChange(sortOrder);
	});

	directionToggle.addEventListener("click", () => {
		sortOrder = sortOrder === "asc" ? "desc" : "asc";
		updateUi();
		onChange(sortOrder);
	});

	return { getSortOrder: () => sortOrder };
}
