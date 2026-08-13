export const DATA_HUB_TABS = ['battle-data', 'top-builds'] as const;

export function resolveActiveTabIndex(scrollLeft: number, panelWidth: number, tabCount: number): number {
	if (panelWidth <= 0 || tabCount <= 0) return 0;

	return Math.min(Math.max(Math.round(scrollLeft / panelWidth), 0), tabCount - 1);
}
