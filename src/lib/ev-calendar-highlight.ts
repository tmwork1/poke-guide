import { calcOtherStat, type StatKey } from "./stats";

export interface EvCalendarHighlightInput {
	statKey: StatKey;
	baseStat: number | undefined;
	natureUp: StatKey | null;
	ev: number;
}

/** Whether an EV picker value should show the Lv.50 1.1x-nature 11-multiple cue. */
export function shouldHighlightEvCalendarValue({ statKey, baseStat, natureUp, ev }: EvCalendarHighlightInput): boolean {
	if (statKey === "hp" || natureUp !== statKey || !Number.isFinite(baseStat) || !Number.isFinite(ev)) return false;
	return calcOtherStat(50, baseStat, 31, ev, 1.1) % 11 === 0;
}
