// 右サイド(詳細設定サイドバー、#damage-detail-panel)専用のロジック一式。
//
// ダメージ計算(damage-calc.ts)とは scheduleRowSave/scheduleRowCalc/refreshRowConditionChips/
// selectColumn/renderDetailPanel/getSelectedRow/getSelectedColumn/clearSelection(いずれも
// shared-core.ts経由)に加え、DAMAGE_WEATHERS/DAMAGE_TERRAINS/DAMAGE_AILMENTS/
// DAMAGE_ATTACKER_VOLATILES/DAMAGE_DEFENDER_VOLATILES/clampInt(damage-calc.tsからexport、
// 後述)・deselectRowIfCurrent/renderDetailPanelEmpty/renderColumnLevelDetailPanel/
// openDetailPanelOverlayIfNarrow(このファイルからdamage-calc.tsへexport)という2方向の
// 依存がある(damage-calc.ts⇄right-panel.tsは相互import。いずれも関数宣言(hoistされ、
// 循環import下でも安全)またはモジュール top-level で即時評価されない値のみを跨いでいる
// ため、実行時の初期化順序に問題は無い)。
//
// このファイルは damage-calc.ts の #opponent-notes-section ガード内から
// `initRightPanel()` を1回呼ばれることで初期化される(#damage-detail-panel 等は
// #opponent-notes-section と常に同時にSSR描画されるため、ガードの共有は安全)。
import { el, readEv } from "../owned-pokemon-form";
import { bindModalDismissal } from "../modal-dismiss";
import { typeIconUrl } from "../sprite-urls";
import { kanaIncludes } from "../kana";
import {
	applySprite,
	scheduleRowCalc,
	scheduleRowSave,
	refreshRowConditionChips,
	getSelectedRow,
	getSelectedColumn,
	getSelectedIsBuild,
	clearSelection,
	renderDetailPanel,
	selectColumn,
	selectBuild,
	getDamageBuildDetailForm,
	configureDamageColumnMoveInput,
	getDamageColumnMoveCandidates,
	getDamageColumnMultiHitRange,
	refreshDamageColumnDisplay,
	natureNameFromBoosts,
	type DamageRowState,
	type DamageColumnState,
} from "./shared-core";
import {
	DAMAGE_WEATHERS,
	DAMAGE_TERRAINS,
	DAMAGE_AILMENTS,
	DAMAGE_ATTACKER_VOLATILES,
	DAMAGE_DEFENDER_VOLATILES,
	clampInt,
	buildTeraDropdown,
} from "./damage-calc";
// F: 「わざ」タブの相手側テラスタル欄の表示可否は、「相手ポケモン」タブに
// あった旧テラスタイプ欄(rowTeraFieldWraps)と同じ判定を使う。判定は必ずこの関数を使い、
// 自前ロジックを書かない(仕様: 未指定はtrue=表示・M-*はfalse=非表示・T-*はtrue=表示。
// src/lib/regulations.ts参照)。
import { isTerastalRegulation } from "../regulations";
import { STAT_KEYS, type StatKey } from "../stats";
import type { SolveResult, DurabilityCandidate } from "./bulk-adjust-solver";
import type { DurabilityIndexCandidate, DurabilityIndexKind, MaximizeResult } from "./durability-index";
import { renderDamageSuggestPanel } from "./damage-suggest";

let detailPanelEl: HTMLElement;
let detailPanelBodyEl: HTMLElement;
let detailPanelTitleEl: HTMLElement;
let detailBackdropEl: HTMLElement;
let detailPanelFooterEl: HTMLElement;
let detailPanelMatchupEl: HTMLElement;
let detailPanelTotalEl: HTMLElement;
let detailPanelTotalResultEl: HTMLElement;
let moveDropdownOutsideClickHandler: ((event: MouseEvent) => void) | null = null;
const DETAIL_PANEL_SWIPE_THRESHOLD_PX = 64;
const DETAIL_PANEL_SWIPE_AXIS_RATIO = 1.25;

type AutoInputState = {
	critical?: boolean;
	weather?: boolean;
	terrain?: boolean;
	automaticWeather?: string;
	automaticTerrain?: string;
};
const autoInputLocks = new WeakMap<DamageColumnState, AutoInputState>();
type MoveAutoInputDetail = { critRatio: number; type: string | null };
const moveAutoInputDetailsPromise: Promise<Map<string, MoveAutoInputDetail>> = fetch("/master-data/detail/moves.json")
	.then((response) => response.json())
	.then((moves: Array<{ name: string; critRatio?: number; type?: string | null }>) =>
		new Map(moves.map((move) => [move.name, { critRatio: move.critRatio ?? 0, type: move.type ?? null }])),
	)
	.catch((error) => {
		console.warn("技の急所・タイプ情報の読み込みに失敗しました", error);
		return new Map<string, MoveAutoInputDetail>();
	});
const abilityFieldMap: Record<string, { key: "weather" | "terrain"; value: string }> = {
	あめふらし: { key: "weather", value: "あめ" },
	ひでり: { key: "weather", value: "はれ" },
	すなおこし: { key: "weather", value: "すなあらし" },
	ゆきふらし: { key: "weather", value: "ゆき" },
	ハドロンエンジン: { key: "terrain", value: "エレキフィールド" },
	ひひいろのこどう: { key: "weather", value: "はれ" },
	エレキメイカー: { key: "terrain", value: "エレキフィールド" },
	グラスメイカー: { key: "terrain", value: "グラスフィールド" },
	サイコメイカー: { key: "terrain", value: "サイコフィールド" },
	ミストメイカー: { key: "terrain", value: "ミストフィールド" },
};

function applyAutomaticField(row: DamageRowState, column: DamageColumnState, abilityName: string): void {
	const field = abilityFieldMap[abilityName];
	if (!field) return;
	const state = autoInputLocks.get(column) ?? {};
	const automaticKey = field.key === "weather" ? "automaticWeather" : "automaticTerrain";
	if (state[field.key] || (column[field.key] !== "" && column[field.key] !== state[automaticKey])) return;
	column[field.key] = field.value;
	state[automaticKey] = field.value;
	autoInputLocks.set(column, state);
	scheduleRowCalc(row);
	scheduleRowSave(row);
	refreshRowConditionChips(row);
}

/** 技・相手特性の入力イベントからだけ呼び、自動入力が初期復元時に勝手に走らないようにする。 */
export async function notifyDetailMoveChanged(row: DamageRowState, column: DamageColumnState): Promise<void> {
	const ratio = (await moveAutoInputDetailsPromise).get(column.moveName.trim())?.critRatio ?? 0;
	// jpokeの急所ランク3は確率1。技名リストではなくマスターのcritRatioを正とする。
	if (ratio >= 3 && !autoInputLocks.get(column)?.critical) {
		column.critical = true;
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	}
}
export function notifyDetailAbilityChanged(row: DamageRowState, abilityName: string): void {
	for (const column of row.attacks) applyAutomaticField(row, column, abilityName);
}

export function isWideSidebarLayout(): boolean {
	return false;
}
// 1600px未満ではオーバーレイ(スライドイン+背景)として開閉する。
// 1600px以上は常時表示の3カラム目なので開閉操作自体が不要。
export function openDetailPanelOverlayIfNarrow(): void {
	detailPanelEl.classList.add("is-open");
	detailBackdropEl.hidden = false;
}
export function closeDetailPanelOverlay(): void {
	detailPanelEl.classList.remove("is-open");
	detailBackdropEl.hidden = true;
}

/** 3モードで共用する帯を更新する。本文側に見出しを重複させないため描画入口で必ず呼ぶ。 */
function setDetailPanelTitle(title: string | Node): void {
	detailPanelTitleEl.classList.remove("is-tab-bar");
	detailPanelTitleEl.removeAttribute("role");
	detailPanelTitleEl.removeAttribute("aria-label");
	detailPanelTitleEl.setAttribute("aria-live", "polite");
	detailPanelTitleEl.replaceChildren(title);
	detailPanelFooterEl.hidden = true;
}

function setSlideDetailPanelTitle(row: DamageRowState, positionIndex: number): void {
	detailPanelTitleEl.replaceChildren();
	detailPanelTitleEl.classList.add("is-tab-bar");
	detailPanelTitleEl.setAttribute("role", "tablist");
	detailPanelTitleEl.setAttribute("aria-label", "ダメージ詳細の表示切り替え");
	detailPanelTitleEl.removeAttribute("aria-live");
	const tabs = ["相手ポケモン", ...row.attacks.map((_, index) => `わざ${index + 1}`)];
	const selectTab = (index: number): void => {
		if (index === 0) {
			selectBuild(row);
			return;
		}
		const column = row.attacks[index - 1];
		if (column) selectColumn(row, column);
	};
	tabs.forEach((label, index) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "damage-detail-panel-tab";
		button.setAttribute("role", "tab");
		button.setAttribute("aria-selected", String(index === positionIndex));
		button.tabIndex = index === positionIndex ? 0 : -1;
		button.textContent = label;
		button.addEventListener("click", () => selectTab(index));
		button.addEventListener("keydown", (event) => {
			let nextIndex: number | null = null;
			if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
			if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
			if (event.key === "Home") nextIndex = 0;
			if (event.key === "End") nextIndex = tabs.length - 1;
			if (nextIndex == null) return;
			event.preventDefault();
			selectTab(nextIndex);
		});
		detailPanelTitleEl.appendChild(button);
	});
}

function buildSelectionHeadingRow(row: DamageRowState): HTMLElement {
	const heading = document.createElement("div");
	heading.className = "damage-detail-selection-heading";
	const opponentName = row.name.trim() || "(相手未設定)";
	const selfSpeciesName = el<HTMLInputElement>("species-name").value.trim();
	const selfName = selfSpeciesName || "(自分未設定)";
	const isSelfAttacking = row.direction !== "defense";

	const selfIcon = document.createElement("img");
	selfIcon.className = "damage-detail-selection-icon";
	selfIcon.alt = "";
	selfIcon.style.display = "none";
	const selfIconFallback = document.createElement("span");
	selfIconFallback.className = "damage-detail-selection-icon-fallback";
	void applySprite(selfIcon, selfIconFallback, selfSpeciesName);

	const arrowNs = "http://www.w3.org/2000/svg";
	const arrow = document.createElementNS(arrowNs, "svg");
	arrow.setAttribute("class", "damage-detail-selection-arrow");
	arrow.setAttribute("aria-hidden", "true");
	arrow.setAttribute("viewBox", "0 0 36 24");
	arrow.setAttribute("focusable", "false");
	if (!isSelfAttacking) arrow.classList.add("is-reversed");
	const arrowPath = document.createElementNS(arrowNs, "path");
	arrowPath.setAttribute("d", "M2 6L8 12L2 18M14 6L20 12L14 18M26 6L32 12L26 18");
	arrowPath.setAttribute("fill", "none");
	arrowPath.setAttribute("stroke", "currentColor");
	arrowPath.setAttribute("stroke-width", "2.5");
	arrowPath.setAttribute("stroke-linecap", "round");
	arrowPath.setAttribute("stroke-linejoin", "round");
	arrow.appendChild(arrowPath);

	const opponentIcon = document.createElement("img");
	opponentIcon.className = "damage-detail-selection-icon";
	opponentIcon.alt = "";
	opponentIcon.style.display = "none";
	const opponentIconFallback = document.createElement("span");
	opponentIconFallback.className = "damage-detail-selection-icon-fallback";
	void applySprite(opponentIcon, opponentIconFallback, row.name.trim());

	const attackerLabel = isSelfAttacking ? selfName : opponentName;
	const defenderLabel = isSelfAttacking ? opponentName : selfName;
	const fullText = `${attackerLabel} → ${defenderLabel}`;
	heading.title = fullText;
	heading.setAttribute("aria-label", fullText);
	heading.append(selfIcon, selfIconFallback, arrow, opponentIcon, opponentIconFallback);
	return heading;
}

function refreshDetailPanelFooter(row: DamageRowState): void {
	detailPanelMatchupEl.replaceChildren(buildSelectionHeadingRow(row));
	detailPanelFooterEl.hidden = false;
	syncDetailPanelTotal(row);
}

/** カード側の累計結果が更新された直後に、選択中の行だけ固定フッターへミラーする。 */
export function syncDetailPanelTotal(row: DamageRowState): void {
	if (!detailPanelTotalResultEl || getSelectedRow() !== row || detailPanelFooterEl.hidden) return;
	const source = row.totalResultEl;
	if (!source) return;
	detailPanelTotalResultEl.replaceChildren(...Array.from(source.childNodes, (node) => node.cloneNode(true)));
	const severity = source.dataset.severity ?? "none";
	detailPanelTotalResultEl.dataset.severity = severity;
	detailPanelTotalEl.dataset.severity = severity;
}

function initDetailPanelSwipe(): void {
	let gesture: { pointerId: number; startX: number; startY: number; deltaX: number; deltaY: number } | null = null;
	const interactiveSelector = "input, select, textarea, a, label, [contenteditable='true']";

	detailPanelBodyEl.addEventListener("pointerdown", (event) => {
		if (!event.isPrimary || event.button !== 0) return;
		if (event.target instanceof Element && event.target.closest(interactiveSelector)) return;
		gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, deltaX: 0, deltaY: 0 };
	});
	detailPanelBodyEl.addEventListener("pointermove", (event) => {
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		gesture.deltaX = event.clientX - gesture.startX;
		gesture.deltaY = event.clientY - gesture.startY;
		if (Math.abs(gesture.deltaX) > Math.abs(gesture.deltaY) * DETAIL_PANEL_SWIPE_AXIS_RATIO) {
			if (!detailPanelBodyEl.hasPointerCapture(event.pointerId)) detailPanelBodyEl.setPointerCapture(event.pointerId);
			event.preventDefault();
		}
	});
	const finishGesture = (event: PointerEvent, cancelled = false): void => {
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		const { deltaX, deltaY } = gesture;
		gesture = null;
		if (detailPanelBodyEl.hasPointerCapture(event.pointerId)) detailPanelBodyEl.releasePointerCapture(event.pointerId);
		if (cancelled || !detailPanelEl.classList.contains("is-open")) return;
		if (Math.abs(deltaX) < DETAIL_PANEL_SWIPE_THRESHOLD_PX) return;
		if (Math.abs(deltaX) <= Math.abs(deltaY) * DETAIL_PANEL_SWIPE_AXIS_RATIO) return;

		const row = getSelectedRow();
		const column = getSelectedColumn();
		if (!row) return;
		const currentIndex = getSelectedIsBuild()
			? 0
			: column
				? row.attacks.indexOf(column) + 1
				: -1;
		if (currentIndex < 0) return;
		const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
		if (nextIndex === 0) {
			selectBuild(row);
			return;
		}
		const nextColumn = row.attacks[nextIndex - 1];
		if (nextColumn) selectColumn(row, nextColumn);
	};
	detailPanelBodyEl.addEventListener("pointerup", (event) => finishGesture(event));
	detailPanelBodyEl.addEventListener("pointercancel", (event) => finishGesture(event, true));
}

export interface CandidateListItem {
	/** 1行に表示するセグメント(例: 性格名 / 努力値 / 実数値 / 指数)。 */
	segments: { label: string; value: string; emphasis?: boolean }[];
	/** ⚠マーク等の注記(例: 努力値上限66の超過、変更前の配分)。 */
	flags?: { icon: string; text: string; kind?: "warn" | "info" }[];
	/** 現在適用されている候補か(強調表示する)。 */
	isApplied?: boolean;
	/** クリックしたときの適用処理。 */
	onSelect: () => void;
}
export interface CandidateListView {
	heading: string;
	/** 並び順の意味を明示する補足(例:「合計努力値の少ない順」「耐久指数の大きい順」)。 */
	note?: string;
	/** 計算の前提(対象カード名・技・条件など)。一覧が陳腐化しても読み取れるように。 */
	context?: string;
	items: CandidateListItem[];
	/** 打ち切った件数など。黙って切り捨てないための表示。 */
	truncatedNote?: string;
	/** 候補が0件のときの文言。 */
	emptyMessage?: string;
}

// (B)(C)共通の候補一覧レンダラ。detailPanelBodyElへ直接描画するだけの「dumb」な関数で、
// 「選択中(A) > 最後の候補一覧 > 空」というフォールバック優先順位の管理
// (下のlastCandidateListRedraw)はこの関数の外側(renderBulkAdjustResults等の呼び出し元)が
// 担う。isApplied等の状態は呼び出しのたびに呼び出し元が計算し直して渡す前提
// (このファイル自身は「何が適用中か」の判定方法を知らない。renderBulkAdjustResultsの
// currentAppliedEvs参照)。
export function renderCandidateList(view: CandidateListView): void {
	detailPanelFooterEl.hidden = true;
	detailPanelBodyEl.innerHTML = "";
	const inner = document.createElement("div");
	inner.className = "damage-detail-panel-body-inner candidate-list-view";
	detailPanelBodyEl.appendChild(inner);

	const heading = document.createElement("p");
	heading.className = "candidate-list-heading";
	heading.textContent = view.heading;
	inner.appendChild(heading);

	if (view.context) {
		const contextEl = document.createElement("p");
		contextEl.className = "candidate-list-context";
		contextEl.textContent = view.context;
		inner.appendChild(contextEl);
	}
	if (view.note) {
		const noteEl = document.createElement("p");
		noteEl.className = "candidate-list-note";
		noteEl.textContent = view.note;
		inner.appendChild(noteEl);
	}
	if (view.truncatedNote) {
		const truncatedEl = document.createElement("p");
		truncatedEl.className = "candidate-list-truncated-note";
		truncatedEl.textContent = view.truncatedNote;
		inner.appendChild(truncatedEl);
	}

	if (view.items.length === 0) {
		const emptyEl = document.createElement("p");
		emptyEl.className = "candidate-list-empty-message";
		emptyEl.textContent = view.emptyMessage ?? "該当する候補がありません。";
		inner.appendChild(emptyEl);
		return;
	}

	const list = document.createElement("ul");
	list.className = "candidate-list";
	for (const item of view.items) {
		const li = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		button.className = "candidate-list-item";
		if (item.isApplied) button.classList.add("is-applied");
		// warn種別のflagを持つ候補(例: 努力値上限超過)は枠色でも軽く目立たせる
		// (テキスト自体はflagsのループでbutton内に必ず出すため、色は補助的な位置づけ。
		// WCAG 1.4.1: 色だけに依存しない情報はflagsのテキストが担う)。
		if (item.flags?.some((flag) => flag.kind === "warn")) button.classList.add("has-warn-flag");

		if (item.isApplied) {
			// 色だけで意味を伝えない(WCAG 1.4.1): 強調枠だけでなく記号+テキストを併記する。
			const appliedBadge = document.createElement("span");
			appliedBadge.className = "candidate-list-item-applied-badge";
			appliedBadge.textContent = "✓ 適用中";
			button.appendChild(appliedBadge);
		}

		for (const segment of item.segments) {
			const segEl = document.createElement("span");
			segEl.className = "candidate-list-item-segment tnum";
			if (segment.emphasis) segEl.classList.add("is-emphasis");
			const labelEl = document.createElement("span");
			labelEl.className = "candidate-list-item-segment-label";
			labelEl.textContent = segment.label;
			const valueEl = document.createElement("span");
			valueEl.className = "candidate-list-item-segment-value";
			valueEl.textContent = segment.value;
			segEl.append(labelEl, valueEl);
			button.appendChild(segEl);
		}

		for (const flag of item.flags ?? []) {
			const flagEl = document.createElement("span");
			flagEl.className = "candidate-list-item-flag";
			if (flag.kind) flagEl.classList.add(`is-${flag.kind}`);
			flagEl.textContent = `${flag.icon} ${flag.text}`;
			button.appendChild(flagEl);
		}

		button.addEventListener("click", item.onSelect);
		li.appendChild(button);
		list.appendChild(li);
	}
	inner.appendChild(list);
}

export interface StatCardRow {
	/** 例 "H" / "B" / "D" */
	label: string;
	/** 実数値 */
	real: number;
	/** 努力値(0〜32スケール、そのステータスの最終値。現在値+追加分) */
	ev: number;
}
export interface StatCardSpec {
	/** 通常はH/B/Dの3件。1行に収めて表示する(依頼4)。 */
	rows: StatCardRow[];
	/** カードのtitle属性(ホバーツールチップ)に出す内部スコアの説明(依頼4「整数表示」)。
	    指数を持たない候補(耐久調整モードの候補など)は省略する。 */
	scoreTooltip?: string;
	/** カード内の小さなバッジ(例: 耐久調整モードの性格名)。省略可。 */
	badge?: string;
	isApplied?: boolean;
	/** 基準ステータスカードかどうか。操作可否はonSelectの有無で決める。 */
	isCurrent?: boolean;
	/** カード外に見出しを置く場合だけfalseにする。 */
	showCurrentBadge?: boolean;
	flags?: { icon: string; text: string; kind?: "warn" | "info" }[];
	/** 省略時は表示専用div、指定時は候補と同じbuttonになる。 */
	onSelect?: () => void;
}
export interface StatCardGroup {
	/** 指数名等の見出し(依頼6、サブタイトルフォント)。 */
	title: string;
	/** 見出しホバー時に出す計算式などのヘルプ(依頼6)。 */
	titleHelp?: string;
	card: StatCardSpec;
}
export interface StatCardListView {
	heading: string;
	note?: string;
	context?: string;
	/** 「残り努力値以下のみ表示」等のトグル。一覧の最上部に表示する(依頼7)。 */
	filterToggle?: { label: string; checked: boolean; onChange: (checked: boolean) => void };
	/** 現在のステータスカード(先頭に固定表示、依頼5・9)。 */
	currentCard?: StatCardSpec;
	/** currentCardの直前に置く見出し。耐久最大化の「元のステータス」専用。 */
	currentCardHeading?: string;
	/** 見出し→カードの繰り返し(耐久最大化モード用、依頼6)。flatCardsと排他。 */
	groups?: StatCardGroup[];
	/** 見出し無しのフラットなカード列(耐久調整モード用、依頼7・8)。groupsと排他。 */
	flatCards?: StatCardSpec[];
	/** 耐久調整モードで、結果カード群の直前にだけ表示する見出し。 */
	flatCardsHeading?: string;
	truncatedNote?: string;
	emptyMessage?: string;
}

/** 現在左パネルに表示されている実数値(H/B/D)を、表示中のテキストからそのまま読む。
    calcHpStat/calcOtherStatで再計算すると性格補正等の取り違えで表示とズレる事故が
    起こり得るため、常に「今画面に出ている値」を正とする(#stat-{key}、left-panel.tsの
    renderStatsUnavailable/recalcStats参照。未計算時は"(未計算)"が入るためnullを返す)。 */
function readCurrentRealStat(key: "hp" | "def" | "spd"): number | null {
	const statEl = document.getElementById(`stat-${key}`);
	if (!statEl) return null;
	const n = Number(statEl.textContent);
	return Number.isFinite(n) ? n : null;
}

/** 「現在のステータス」カード(依頼5・9)。実数値が未計算(種族名未入力など)のときは
    作らない(呼び出し元はcurrentCardをundefinedのまま渡せばよい)。 */
function buildCurrentStatusStatCard(): StatCardSpec | undefined {
	const hp = readCurrentRealStat("hp");
	const def = readCurrentRealStat("def");
	const spd = readCurrentRealStat("spd");
	if (hp === null || def === null || spd === null) return undefined;
	return {
		rows: [
			{ label: "H", real: hp, ev: readEv("hp") },
			{ label: "B", real: def, ev: readEv("def") },
			{ label: "D", real: spd, ev: readEv("spd") },
		],
		isCurrent: true,
	};
}

function buildStatCardEl(spec: StatCardSpec): HTMLElement {
	// onSelectがある基準カードは候補と同じbuttonにし、無い表示専用カードだけdivにする。
	const card = document.createElement(spec.onSelect ? "button" : "div");
	if (spec.onSelect) (card as HTMLButtonElement).type = "button";
	card.className = "candidate-list-item stat-card";
	if (spec.isCurrent) card.classList.add("is-current");
	if (spec.isApplied) card.classList.add("is-applied");
	if (spec.onSelect) card.setAttribute("aria-current", spec.isApplied ? "true" : "false");
	if (spec.flags?.some((flag) => flag.kind === "warn")) card.classList.add("has-warn-flag");
	// 依頼4: 指数値はカード本文に出さずtitle属性のツールチップにする。
	if (spec.scoreTooltip) card.title = spec.scoreTooltip;

	if (spec.isCurrent && spec.showCurrentBadge !== false) {
		const currentBadge = document.createElement("span");
		currentBadge.className = "candidate-list-item-current-badge";
		currentBadge.textContent = "現在のステータス";
		card.appendChild(currentBadge);
	} else if (spec.badge) {
		const badgeEl = document.createElement("span");
		badgeEl.className = "candidate-list-item-badge";
		badgeEl.textContent = spec.badge;
		card.appendChild(badgeEl);
	}

	// 依頼4: <ラベル>実数値(努力値) をH/B/D 1行に収める。
	const statLine = document.createElement("span");
	statLine.className = "candidate-list-item-statline tnum";
	for (const row of spec.rows) {
		const statEl = document.createElement("span");
		statEl.className = "candidate-list-item-stat";
		statEl.textContent = `${row.label}${row.real}`;
		const evEl = document.createElement("span");
		evEl.className = "candidate-list-item-stat-ev";
		evEl.textContent = ` ${row.ev}`;
		statEl.appendChild(evEl);
		statLine.appendChild(statEl);
	}
	card.appendChild(statLine);

	for (const flag of spec.flags ?? []) {
		const flagEl = document.createElement("span");
		flagEl.className = "candidate-list-item-flag";
		if (flag.kind) flagEl.classList.add(`is-${flag.kind}`);
		flagEl.textContent = `${flag.icon} ${flag.text}`;
		card.appendChild(flagEl);
	}

	if (spec.onSelect) card.addEventListener("click", spec.onSelect);
	return card;
}

/** 依頼7: 「残り努力値以下のみ表示」等のトグルスイッチ。既存の.toggle-switch規格
    (LeftPanel.astroのis:global側で定義済み、box/[id].astro等で使用中の角丸トラック+
    丸いつまみ)をそのまま流用する(新色・新規格は作らない)。 */
function buildFilterToggleEl(toggle: NonNullable<StatCardListView["filterToggle"]>): HTMLElement {
	const row = document.createElement("label");
	row.className = "candidate-list-filter-row";
	const switchWrap = document.createElement("span");
	switchWrap.className = "toggle-switch";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.className = "toggle-switch-input";
	input.checked = toggle.checked;
	input.setAttribute("aria-label", toggle.label);
	const track = document.createElement("span");
	track.className = "toggle-switch-track";
	track.setAttribute("aria-hidden", "true");
	const thumb = document.createElement("span");
	thumb.className = "toggle-switch-thumb";
	track.appendChild(thumb);
	switchWrap.append(input, track);
	const labelText = document.createElement("span");
	labelText.className = "candidate-list-filter-row-label";
	labelText.textContent = toggle.label;
	row.append(switchWrap, labelText);
	input.addEventListener("change", () => toggle.onChange(input.checked));
	return row;
}

/** (B)(C)共通の「耐久カード一覧」レンダラ(依頼4〜9)。renderCandidateList()と同様、
    detailPanelBodyElへ直接描画するだけの「dumb」な関数。フィルタトグルの状態管理・
    「何が適用中か」の再計算は呼び出し元(redrawクロージャ)が担う。 */
export function renderStatCardList(view: StatCardListView): void {
	setDetailPanelTitle(view.heading);
	detailPanelBodyEl.innerHTML = "";
	const inner = document.createElement("div");
	inner.className = "damage-detail-panel-body-inner candidate-list-view";
	detailPanelBodyEl.appendChild(inner);
	// 依頼7ではトグルを一覧最上部に配置していたが、今回の要件で耐久調整の「調整結果」見出し行へ移す。

	if (view.context) {
		const contextEl = document.createElement("p");
		contextEl.className = "candidate-list-context";
		contextEl.textContent = view.context;
		inner.appendChild(contextEl);
	}
	if (view.note) {
		const noteEl = document.createElement("p");
		noteEl.className = "candidate-list-note";
		noteEl.textContent = view.note;
		inner.appendChild(noteEl);
	}
	if (view.truncatedNote) {
		const truncatedEl = document.createElement("p");
		truncatedEl.className = "candidate-list-truncated-note";
		truncatedEl.textContent = view.truncatedNote;
		inner.appendChild(truncatedEl);
	}

	const hasCurrentCard = !!view.currentCard;
	const hasGroups = (view.groups?.length ?? 0) > 0;
	const hasFlat = (view.flatCards?.length ?? 0) > 0;

	if (!hasCurrentCard && !hasGroups && !hasFlat) {
		const emptyEl = document.createElement("p");
		emptyEl.className = "candidate-list-empty-message";
		emptyEl.textContent = view.emptyMessage ?? "該当する候補がありません。";
		inner.appendChild(emptyEl);
		return;
	}

	const listEl = document.createElement("div");
	listEl.className = "candidate-list";
	inner.appendChild(listEl);

	// 依頼5・9: 現在のステータスカードを一覧の先頭に固定表示する。
	if (view.currentCard) {
		if (view.currentCardHeading) {
			// 今回の要件: 耐久最大化ではラベルをカード内でなくカード直前に示す。
			const currentHeading = document.createElement("p");
			currentHeading.className = "field-label candidate-list-group-title";
			currentHeading.textContent = view.currentCardHeading;
			listEl.appendChild(currentHeading);
		}
		listEl.appendChild(buildStatCardEl(view.currentCard));
	}
	if (view.flatCardsHeading) {
		// 耐久調整だけ、結果見出しとフィルタを同じ段の左右へ配置する。
		const headingRow = document.createElement("div");
		headingRow.className = "candidate-list-result-heading-row";
		const resultHeading = document.createElement("p");
		resultHeading.className = "field-label candidate-list-group-title";
		resultHeading.textContent = view.flatCardsHeading;
		headingRow.appendChild(resultHeading);
		if (view.filterToggle) headingRow.appendChild(buildFilterToggleEl(view.filterToggle));
		listEl.appendChild(headingRow);
	}

	if (hasGroups) {
		// 依頼6: 見出し(指数名)→カードの繰り返し。
		for (const group of view.groups!) {
			const titleEl = document.createElement("p");
			titleEl.className = "field-label candidate-list-group-title";
			// 見出しには指数名だけを表示し、計算式はtitle属性へ分離する。
			titleEl.textContent = group.title;
			if (group.titleHelp) titleEl.title = group.titleHelp;
			listEl.appendChild(titleEl);
			listEl.appendChild(buildStatCardEl(group.card));
		}
	} else if (hasFlat) {
		for (const card of view.flatCards!) {
			listEl.appendChild(buildStatCardEl(card));
		}
	} else {
		// currentCardだけがあり候補が0件(例: 耐久調整が条件を満たさない/フィルタで全滅)。
		const emptyEl = document.createElement("p");
		emptyEl.className = "candidate-list-empty-message";
		emptyEl.textContent = view.emptyMessage ?? "該当する候補がありません。";
		listEl.appendChild(emptyEl);
	}
}

// 保持スロットを共有しないと、復元先が曖昧になる。
let lastCandidateListRedraw: (() => void) | null = null;

export function renderDetailPanelEmpty(): void {
	if (lastCandidateListRedraw) {
		lastCandidateListRedraw();
		return;
	}
	if (renderDamageSuggestPanel(detailPanelBodyEl, setDetailPanelTitle)) return;
	setDetailPanelTitle("");
	detailPanelBodyEl.innerHTML = "";
	const inner = document.createElement("div");
	inner.className = "damage-detail-panel-body-inner";
	detailPanelBodyEl.appendChild(inner);
}

function currentAppliedNatureKey(direction: "up" | "down"): StatKey | null {
	for (const key of STAT_KEYS) {
		if (key === "hp") continue;
		const btn = document.getElementById(`nature-${direction}-${key}`);
		if (btn?.getAttribute("aria-pressed") === "true") return key;
	}
	return null;
}
function currentAppliedNature(): string {
	return natureNameFromBoosts(currentAppliedNatureKey("up"), currentAppliedNatureKey("down"));
}

// 適用中判定は、候補ごとに性格が変わらない現在のソルバー契約に合わせH/B/D努力値だけで行う。
function currentAppliedEvs(): { hp: number; def: number; spd: number } {
	return {
		hp: readEv("hp"),
		def: readEv("def"),
		spd: readEv("spd"),
	};
}

// bulk-adjust.ts との呼び出しシグネチャを維持する。
export function renderBulkAdjustResults(
	result: SolveResult,
	onSelectCandidate: (candidate: DurabilityCandidate) => void,
): void {
	let filterRemainingOnly = false; // 依頼7: デフォルトOFF
	const originalApplied = currentAppliedEvs();
	const originalCandidate: DurabilityCandidate = {
		// natureは表示・適用中判定には使わないが、ソルバー戻り値との型互換と元配分の復元に必要。
		nature: currentAppliedNature(),
		evs: { hp: originalApplied.hp, def: originalApplied.def, spd: originalApplied.spd },
		searchedEvTotal: originalApplied.hp + originalApplied.def + originalApplied.spd,
		totalEv: STAT_KEYS.reduce((sum, key) => sum + readEv(key), 0),
		realStats: {
			hp: readCurrentRealStat("hp") ?? 0,
			def: readCurrentRealStat("def") ?? 0,
			spd: readCurrentRealStat("spd") ?? 0,
		},
		exceedsChampionsCap: STAT_KEYS.reduce((sum, key) => sum + readEv(key), 0) > 66,
	};
	// 候補クリック直後・トグル変更直後に再描画してisApplied(適用中マーク)や絞り込みを
	// 更新できるよう、redraw自身をクロージャの中で自己参照する(lastCandidateListRedrawに
	// 登録する値と、クリック/トグルハンドラから呼ぶ値が同じ関数になる)。
	const redraw = (): void => {
		lastCandidateListRedraw = redraw;
		renderStatCardList(
			buildBulkAdjustStatCardView(result, originalCandidate, onSelectCandidate, redraw, filterRemainingOnly, (checked) => {
				filterRemainingOnly = checked;
				redraw();
			}),
		);
	};
	redraw();
}

function buildBulkAdjustStatCardView(
	result: SolveResult,
	originalCandidate: DurabilityCandidate,
	onSelectCandidate: (candidate: DurabilityCandidate) => void,
	redraw: () => void,
	filterRemainingOnly: boolean,
	onFilterChange: (checked: boolean) => void,
): StatCardListView {
	const infeasible = result.infeasible || result.candidates.length === 0;
	const applied = currentAppliedEvs();
	// 依頼7: 「追加努力値合計(searchedEvTotal=探索したH+B+D)が残り努力値以下」は、
	// candidate.exceedsChampionsCap(totalEv=searchedEvTotal+固定A/C/S が66超か)の否定と
	// 数学的に同値(66-固定A/C/S = 残り努力値)。既存の判定を再利用し、同じ条件の
	// 実装を二重に持たない。
	const allCandidates = infeasible ? [] : result.candidates;
	const filteredCandidates = filterRemainingOnly
		? allCandidates.filter((c) => !c.exceedsChampionsCap)
		: allCandidates;
	const hiddenCount = allCandidates.length - filteredCandidates.length;
	const visibleCandidates = filteredCandidates.slice(0, 10);

	// 要件: 合計努力値の少ない順(solveDurability()側がsearchedEvTotal昇順で返す契約なので、
	// このファイルでの並び替えは不要。
	const flatCards: StatCardSpec[] = visibleCandidates.map((candidate) => {
		const flags: StatCardSpec["flags"] = [];
		if (candidate.exceedsChampionsCap) {
			// 色だけで意味を伝えない(WCAG 1.4.1): 記号+テキストを併記する。
			flags.push({ icon: "⚠", text: "努力値上限(66)を超過", kind: "warn" });
		}
		return {
			rows: [
				{ label: "H", real: candidate.realStats.hp, ev: candidate.evs.hp },
				{ label: "B", real: candidate.realStats.def, ev: candidate.evs.def },
				{ label: "D", real: candidate.realStats.spd, ev: candidate.evs.spd },
			],
			flags,
			isApplied:
				candidate.evs.hp === applied.hp &&
				candidate.evs.def === applied.def &&
				candidate.evs.spd === applied.spd,
			onSelect: () => {
				onSelectCandidate(candidate);
				// クリック直後、左パネルの値は同期的に書き換わる(applyEvToLeftPanel/
				// applyNatureToLeftPanelがinput.valueへの代入→dispatchEventを同期実行する、
				// bulk-adjust.ts参照)ため、ここで再描画すればisApplied(適用中マーク)が
				// 直ちに正しい候補へ移る。
				redraw();
			},
		};
	});

	return {
		heading: "耐久調整",
		filterToggle: {
			label: "残り努力値以下のみ",
			checked: filterRemainingOnly,
			onChange: onFilterChange,
		},
		currentCard: {
			rows: [
				{ label: "H", real: originalCandidate.realStats.hp, ev: originalCandidate.evs.hp },
				{ label: "B", real: originalCandidate.realStats.def, ev: originalCandidate.evs.def },
				{ label: "D", real: originalCandidate.realStats.spd, ev: originalCandidate.evs.spd },
			],
			isCurrent: true,
			showCurrentBadge: false,
			isApplied:
				originalCandidate.evs.hp === applied.hp &&
				originalCandidate.evs.def === applied.def &&
				originalCandidate.evs.spd === applied.spd,
			onSelect: () => {
				onSelectCandidate(originalCandidate);
				redraw();
			},
		},
		currentCardHeading: "元のステータス",
		flatCards,
		flatCardsHeading: "調整結果",
		truncatedNote: filterRemainingOnly && hiddenCount > 0
				? `努力値上限(66)超過のため ${hiddenCount} 件を隠しています。`
				: undefined,
		emptyMessage: infeasible
			? "条件を満たす組み合わせがありません。"
			: "残り努力値以下の候補がありません。",
	};
}

export interface DurabilityIndexResultGroup {
	kind: DurabilityIndexKind;
	/** 計算式を含まない指数名の見出し(例: "総合耐久指数")。 */
	heading: string;
	/** 見出しホバー時に出す計算式のヘルプ(依頼6)。 */
	headingHelp?: string;
	result: MaximizeResult;
}

function buildDurabilityIndexStatCardView(
	groups: DurabilityIndexResultGroup[],
	currentEvs: { hp: number; def: number; spd: number },
	onSelectCandidate: (candidate: DurabilityIndexCandidate, kind: DurabilityIndexKind) => void,
	redraw: () => void,
): StatCardListView {
	return {
		heading: "耐久指数の最大化",
		// 依頼5: 現在のステータスも同じカードデザインで一覧の先頭に配置する。
		currentCard: buildCurrentStatusStatCard(),
		// 依頼6: 指数名(見出し)→カードの繰り返し。
		groups: groups.map(({ kind, heading, headingHelp, result }) => {
			const best = result.best;
			const isApplied =
				best.evs.hp === currentEvs.hp && best.evs.def === currentEvs.def && best.evs.spd === currentEvs.spd;
			// 努力値上限到達は候補そのものが示すため、警告表示は付けない。
			const card: StatCardSpec = {
				rows: [
					{ label: "H", real: best.realStats.hp, ev: best.evs.hp },
					{ label: "B", real: best.realStats.def, ev: best.evs.def },
					{ label: "D", real: best.realStats.spd, ev: best.evs.spd },
				],
				// 依頼4: 指数値はカード本文に出さずtitle属性で整数表示する。
				scoreTooltip: `指数値: ${Math.round(best.index)}`,
				isApplied,
				onSelect: () => {
					onSelectCandidate(best, kind);
					setTimeout(redraw, 0);
				},
			};
			return { title: heading, titleHelp: headingHelp, card };
		}),
		emptyMessage: "候補がありません。",
	};
}

/** 耐久指数最大化(durability-index.tsのmaximizeDurabilityIndex())の結果を右パネルへ
    統一カードで表示する(依頼4〜6)。buildGroups/getCurrentEvsはredrawのたびに(候補クリック
    後の再描画を含め)呼び直されるため、呼び出し元は「今の状態」を計算し直す関数を渡す
    (呼び出し元=left-panel.tsのrunDurabilityIndexMaximize参照)。 */
export function renderDurabilityIndexResults(
	buildGroups: () => DurabilityIndexResultGroup[],
	getCurrentEvs: () => { hp: number; def: number; spd: number },
	onSelectCandidate: (candidate: DurabilityIndexCandidate, kind: DurabilityIndexKind) => void,
): void {
	// 今回の要件: 一覧を開いた時点の配分・実数値を保持し、候補適用後も「元」に戻せるようにする。
	const originalEvs = getCurrentEvs();
	const originalStats = {
		hp: readCurrentRealStat("hp") ?? 0,
		def: readCurrentRealStat("def") ?? 0,
		spd: readCurrentRealStat("spd") ?? 0,
	};
	const redraw = (): void => {
		lastCandidateListRedraw = redraw;
		const current = getCurrentEvs();
		const view = buildDurabilityIndexStatCardView(buildGroups(), current, onSelectCandidate, redraw);
		view.currentCard = {
			rows: [
				{ label: "H", real: originalStats.hp, ev: originalEvs.hp },
				{ label: "B", real: originalStats.def, ev: originalEvs.def },
				{ label: "D", real: originalStats.spd, ev: originalEvs.spd },
			],
			isCurrent: true,
			showCurrentBadge: false,
			isApplied: originalEvs.hp === current.hp && originalEvs.def === current.def && originalEvs.spd === current.spd,
			onSelect: () => {
				// 警告は出さず、候補カードと同じ適用経路で元配分へ戻す。
				onSelectCandidate({ evs: originalEvs, realStats: originalStats, index: 0, addedEvTotal: 0, isCurrent: true }, "total");
				setTimeout(redraw, 0);
			},
		};
		view.currentCardHeading = "元のステータス";
		renderStatCardList(view);
	};
	redraw();
}

export function buildIconToggleGroup(
	options: Array<{ value: string; label: string; icon: string }>,
	current: string,
	onChange: (value: string) => void,
	ariaLabel?: string,
): HTMLElement {
	const group = document.createElement("div");
	group.className = "damage-detail-icon-group";
	group.setAttribute("role", "radiogroup");
	if (ariaLabel) group.setAttribute("aria-label", ariaLabel);
	for (const opt of options) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "damage-detail-icon-btn";
		button.setAttribute("aria-pressed", String(opt.value === current));
		button.title = opt.label;
		button.innerHTML = opt.icon;
		const labelSpan = document.createElement("span");
		labelSpan.textContent = opt.label;
		button.appendChild(labelSpan);
		button.addEventListener("click", () => {
			const wasPressed = button.getAttribute("aria-pressed") === "true";
			for (const child of Array.from(group.children)) {
				(child as HTMLElement).setAttribute("aria-pressed", "false");
			}
			if (wasPressed) {
				// 24-R1: 選択中のボタンの再クリックは「なし」(value: "")に戻す
				// (全ボタンaria-pressed=falseの状態を作る)。
				onChange("");
			} else {
				button.setAttribute("aria-pressed", "true");
				onChange(opt.value);
			}
		});
		group.appendChild(button);
	}
	return group;
}

export function buildToggleButton(
	label: string,
	pressed: boolean,
	onChange: (pressed: boolean) => void,
	options?: { title?: string; disabledTitle?: string },
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "damage-detail-icon-btn is-text-only";
	button.setAttribute("aria-pressed", String(pressed));
	button.textContent = label;
	if (options?.disabledTitle) {
		button.disabled = true;
		button.setAttribute("aria-disabled", "true");
		button.title = options.disabledTitle;
	} else if (options?.title) {
		button.title = options.title;
	}
	button.addEventListener("click", () => {
		const next = button.getAttribute("aria-pressed") !== "true";
		button.setAttribute("aria-pressed", String(next));
		onChange(next);
	});
	return button;
}

// テラスタイプは攻撃側・防御側それぞれの実値を渡す。
export function buildSideSection(
	parentEl: HTMLElement,
	row: DamageRowState,
	title: string,
	ariaSideLabel: string,
	rank: number,
	ailment: string,
	terastallized: boolean,
	teraTypeValue: string,
	onRankChange: (value: number) => void,
	onAilmentChange: (value: string) => void,
	onTeraChange: (value: boolean) => void,
	volatilesOptions: { value: string; label: string; title?: string }[],
	volatilesValue: string[],
	onVolatilesChange: (value: string[]) => void,
	mergeVolatileIntoChipRow: boolean,
	// F: この「側」(攻撃側/防御側)が相手を表しているか。trueならテラスタルの
	// on/offトグルではなく、育成タブと同じテラスタイプ選択UI(buildTeraDropdown)を使う
	// (相手ポケモンタブから移設したテラスタイプ欄の受け皿)。
	isOpponentTeraSide: boolean,
	// 相手側の場合のみ呼ばれる。row.teraTypeの更新はこのコールバックの責務。
	onOpponentTeraTypeChange: (value: string) => void,
): HTMLElement | null {
	const rankAilmentGroup = document.createElement("div");
	rankAilmentGroup.className = "damage-detail-group";
	parentEl.appendChild(rankAilmentGroup);

	// 1行目: 見出し(左)+能力ランクのスピンボックス(右)。
	const headingRow = document.createElement("div");
	headingRow.className = "damage-detail-side-heading-row";
	const heading2 = document.createElement("p");
	heading2.className = "damage-detail-section-heading";
// 色だけに意味を依存させない。
	heading2.append(document.createTextNode(title));
	headingRow.appendChild(heading2);

	const rankField = document.createElement("div");
	rankField.className = "rank-field damage-detail-rank-field";
	const rankLabel = document.createElement("span");
	rankLabel.textContent = "ランク";
	const rankInput = document.createElement("input");
	rankInput.type = "text";
	rankInput.inputMode = "numeric";
	rankInput.className = "damage-detail-rank-input";
	const formatRank = (value: number): string => value > 0 ? `+${value}` : String(value);
	rankInput.value = formatRank(rank);
	rankInput.setAttribute("aria-label", `${ariaSideLabel}の能力ランク`);
	const decrementButton = document.createElement("button");
	decrementButton.type = "button";
	decrementButton.className = "rank-stepper damage-detail-rank-stepper";
	decrementButton.textContent = "－";
	decrementButton.setAttribute("aria-label", `${ariaSideLabel}の能力ランクを1下げる`);
	const incrementButton = document.createElement("button");
	incrementButton.type = "button";
	incrementButton.className = "rank-stepper damage-detail-rank-stepper";
	incrementButton.textContent = "＋";
	incrementButton.setAttribute("aria-label", `${ariaSideLabel}の能力ランクを1上げる`);
	const updateEmphasis = () => {
		const n = Number(rankInput.value);
		rankInput.classList.toggle("is-nonzero", Number.isFinite(n) && n !== 0);
	};
	const updateStepperState = () => {
		const n = Number(rankInput.value);
		const current = Number.isFinite(n) ? clampInt(n, -6, 6) : 0;
		decrementButton.disabled = current <= -6;
		incrementButton.disabled = current >= 6;
	};
	updateEmphasis();
	updateStepperState();
	// 矢印クリック・キーボード編集どちらもcommitへ集約する。空欄・"-"単体(入力途中)は
	// まだ矯正しない(毎キー入力で値を書き戻すとユーザーが"-6"を打てなくなるため)。
	const commitRank = (fallbackToZeroIfEmpty: boolean): void => {
		const raw = rankInput.value.trim();
		if (!fallbackToZeroIfEmpty && (raw === "" || raw === "-" || raw === "+")) return;
		const n = raw === "" || raw === "-" || raw === "+" || !Number.isFinite(Number(raw)) ? 0 : Number(raw);
		const clamped = clampInt(n, -6, 6);
		const displayValue = formatRank(clamped);
		if (rankInput.value !== displayValue) rankInput.value = displayValue;
		onRankChange(clamped);
		updateEmphasis();
		updateStepperState();
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	};
	rankInput.addEventListener("input", () => commitRank(false));
	rankInput.addEventListener("change", () => commitRank(true));
	rankInput.addEventListener("blur", () => commitRank(true));
	const stepRank = (delta: -1 | 1): void => {
		const n = Number(rankInput.value);
		const current = Number.isFinite(n) ? n : 0;
		rankInput.value = formatRank(clampInt(current + delta, -6, 6));
		commitRank(true);
	};
	decrementButton.addEventListener("click", () => stepRank(-1));
	incrementButton.addEventListener("click", () => stepRank(1));
	// フォーカス中にホイールを回すと値が変わる事故を防ぐ(passiveだと
	// preventDefaultが効かないため { passive: false } で明示登録する)。
	rankInput.addEventListener(
		"wheel",
		(e) => {
			if (document.activeElement === rankInput) e.preventDefault();
		},
		{ passive: false },
	);
	const stepperGroup = document.createElement("span");
	stepperGroup.className = "rank-stepper-group";
	stepperGroup.append(decrementButton, rankInput, incrementButton);
	rankField.append(rankLabel, stepperGroup);
	rankAilmentGroup.appendChild(headingRow);

	const ailmentSelect = document.createElement("select");
	ailmentSelect.className = "damage-detail-ailment-select";
	ailmentSelect.setAttribute("aria-label", `${ariaSideLabel}の状態異常`);
	ailmentSelect.title = "状態異常";
	const ailmentPlaceholderOpt = document.createElement("option");
	ailmentPlaceholderOpt.value = "";
	ailmentPlaceholderOpt.textContent = "状態異常";
	ailmentPlaceholderOpt.hidden = true;
	ailmentPlaceholderOpt.selected = ailment === "";
	ailmentSelect.appendChild(ailmentPlaceholderOpt);
	for (const opt of DAMAGE_AILMENTS) {
		const optionEl = document.createElement("option");
		optionEl.value = opt.value;
		optionEl.textContent = opt.label;
		// value===""(DAMAGE_AILMENTSの先頭「なし」)は上のhiddenプレースホルダ側を
		// 既定選択にするため、ここではselectedにしない(二重にselectedを付けると
		// 後勝ちでこちらが選ばれてしまい、閉時表示が「なし」に戻ってしまう)。
		if (opt.value === ailment && opt.value !== "") optionEl.selected = true;
		ailmentSelect.appendChild(optionEl);
	}
	function updateAilmentPlaceholderState(): void {
		ailmentSelect.classList.toggle("is-ailment-unselected", ailmentSelect.value === "");
	}
	updateAilmentPlaceholderState();
	ailmentSelect.addEventListener("change", () => {
		onAilmentChange(ailmentSelect.value);
		// 28-R8: ユーザーがリストの「なし」(可視option、value="")を選んだ場合、
		// 選択状態をhiddenのプレースホルダ(index0、同じvalue="")に付け替えて、
		// 閉じているときの表示を常に「状態異常」に揃える(なし/状態異常のどちらを
		// 経由しても、value=""である限り閉時表示は一定にする)。selectedIndexの
		// 変更はchangeイベントを再発火しないため無限ループにはならない。
		if (ailmentSelect.value === "") ailmentSelect.selectedIndex = 0;
		updateAilmentPlaceholderState();
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	});
	const rankAilmentRow = document.createElement("div");
	rankAilmentRow.className = "damage-detail-rank-ailment-row";
	rankAilmentRow.append(rankField, ailmentSelect);
	rankAilmentGroup.appendChild(rankAilmentRow);

	// F: テラスタルは揮発状態(stateGrid)と別行にする。
	const teraRow = document.createElement("div");
	teraRow.className = "damage-detail-toggle-row damage-detail-tera-row";
	rankAilmentGroup.appendChild(teraRow);

	if (isOpponentTeraSide) {
		// 相手側は、レギュレーションでテラスタルが使える場合のみ、育成タブと同じ
		// テラスタイプ選択UIを出す(「テラスタルなし」を選べば非発動として扱う)。
		const regulationEl = document.getElementById("regulation") as HTMLSelectElement | null;
		const regulationValue = regulationEl ? regulationEl.value.trim() || null : null;
		if (isTerastalRegulation(regulationValue)) {
			const teraDropdown = buildTeraDropdown(teraTypeValue, `${ariaSideLabel}のテラスタイプ`, (newValue) => {
				onOpponentTeraTypeChange(newValue);
				onTeraChange(newValue !== "");
				scheduleRowCalc(row);
				scheduleRowSave(row);
				refreshRowConditionChips(row);
			});
			teraRow.appendChild(teraDropdown.wrap);
		} else {
			teraRow.hidden = true;
		}
	} else {
		const teraAvailable = teraTypeValue !== "";
		const teraButton = buildToggleButton(
			"テラスタル",
			teraAvailable && terastallized,
			(pressed) => {
				onTeraChange(pressed);
				scheduleRowCalc(row);
				scheduleRowSave(row);
				refreshRowConditionChips(row);
			},
			teraAvailable
				? { title: "テラスタル発動" }
				: {
					disabledTitle:
						"テラスタイプが未設定のため使用できません(未設定のままテラスタル発動すると、" +
						"元の第1タイプへ自動フォールバックし意図しない2倍のタイプ一致補正になるため)",
				},
		);
		teraRow.appendChild(teraButton);
		if (!teraAvailable) {
			const teraNote = document.createElement("span");
			teraNote.className = "damage-detail-tera-note";
			teraNote.textContent = "(未設定)";
			teraRow.appendChild(teraNote);
		}
	}

	const stateGrid = document.createElement("div");
	stateGrid.className = "damage-detail-chip-row damage-detail-state-grid damage-detail-volatile-group";
	stateGrid.setAttribute("role", "group");
	stateGrid.setAttribute("aria-label", `${ariaSideLabel}の状態`);
	rankAilmentGroup.appendChild(stateGrid);

	// 揮発状態同士は複数選択を維持する。
	if (volatilesOptions.length > 0) {
		for (const opt of volatilesOptions) {
			const optButton = buildToggleButton(
				opt.label,
				volatilesValue.includes(opt.value),
				() => {
					const next = Array.from(
						stateGrid.querySelectorAll<HTMLButtonElement>('button[data-volatile-value][aria-pressed="true"]'),
					).map((btn) => btn.dataset.volatileValue ?? "");
					onVolatilesChange(next);
					scheduleRowCalc(row);
					scheduleRowSave(row);
					refreshRowConditionChips(row);
				},
				{ title: opt.title },
			);
			optButton.dataset.volatileValue = opt.value;
			stateGrid.appendChild(optButton);
		}
	}
	return mergeVolatileIntoChipRow ? stateGrid : null;
}

export function renderBuildDetailPanel(row: DamageRowState): void {
	detailPanelBodyEl.innerHTML = "";
	const form = getDamageBuildDetailForm(row);
	if (!form) {
		clearSelection();
		renderDetailPanelEmpty();
		return;
	}

	setSlideDetailPanelTitle(row, 0);
	refreshDetailPanelFooter(row);
	detailPanelBodyEl.appendChild(form);
	detailPanelBodyEl.scrollTop = 0;
}

export function renderColumnLevelDetailPanel(row: DamageRowState, column: DamageColumnState): void {
// 選択中の技がない場合は、表示できる技を優先順位どおりに選ぶ。
	detailPanelBodyEl.innerHTML = "";
	const idx = row.attacks.indexOf(column);
	if (idx === -1) {
		// 選択していた技列がすでに削除されている(削除ボタン連打等の取りこぼし対策)。
		// 選択自体を解除して空状態に戻す(カード全体設定という代替表示先はもう無い)。
		// selectedRow/selectedColumnはshared-core.tsへ移設したため、clearSelection()
		// 経由で解除する(構造分割ラウンド・フェーズ1。ロジック自体は変えていない)。
		clearSelection();
		renderDetailPanelEmpty();
		return;
	}

	// この技カード1枚だけを書き換えてから再計算・保存する共通ヘルパー。
	function applyToColumnField(mutate: () => void): void {
		mutate();
		scheduleRowCalc(row);
		scheduleRowSave(row);
		refreshRowConditionChips(row);
	}

	const contentWrap = document.createElement("div");
	contentWrap.className = "damage-detail-panel-body-inner";
	detailPanelBodyEl.appendChild(contentWrap);
	detailPanelBodyEl.scrollTop = 0;


	// D: 急所固定は、このアプリの標準チェックボックス(global.cssのinput[type="checkbox"])
	// +ラベルに変更した(旧: ピル型トグルボタン)。
	function buildCriticalField(): { field: HTMLLabelElement; checkbox: HTMLInputElement } {
		const field = document.createElement("label");
		field.className = "damage-detail-critical-field";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = column.critical;
		const title = "急所固定で計算する(攻撃側だけの設定です)";
		checkbox.title = title;
		checkbox.setAttribute("aria-label", title);
		checkbox.addEventListener("change", () => {
			const pressed = checkbox.checked;
			autoInputLocks.set(column, { ...autoInputLocks.get(column), critical: true });
			applyToColumnField(() => { column.critical = pressed; });
		});
		const text = document.createElement("span");
		text.textContent = "急所";
		field.append(checkbox, text);
		return { field, checkbox };
	}
	setSlideDetailPanelTitle(row, idx + 1);
	refreshDetailPanelFooter(row);

	const { field: criticalField, checkbox: criticalCheckbox } = buildCriticalField();
	const refreshMoveEditorDisplay = (): void => {
		criticalCheckbox.checked = column.critical;
	};
	const moveSelectInput = document.createElement("input");
	moveSelectInput.type = "text";
	moveSelectInput.className = "damage-detail-move-input";
	configureDamageColumnMoveInput(moveSelectInput, row, column);
	moveSelectInput.removeAttribute("list");
	moveSelectInput.setAttribute("aria-haspopup", "listbox");
	moveSelectInput.setAttribute("aria-expanded", "false");

	const moveComboWrap = document.createElement("div");
	moveComboWrap.className = "damage-detail-move-combo";
	const moveDropdownList = document.createElement("ul");
	moveDropdownList.className = "damage-detail-move-dropdown-list";
	moveDropdownList.setAttribute("role", "listbox");
	moveDropdownList.hidden = true;

	function closeMoveDropdown(): void {
		moveDropdownList.hidden = true;
		moveSelectInput.setAttribute("aria-expanded", "false");
	}
	function renderMoveDropdown(): void {
		const query = moveSelectInput.value;
		const candidates = getDamageColumnMoveCandidates(row, column)
			.filter((candidateName) => query === "" || kanaIncludes(candidateName, query))
			.slice(0, 30);
		moveDropdownList.replaceChildren();
		if (candidates.length === 0) {
			const emptyOption = document.createElement("li");
			emptyOption.className = "damage-detail-move-dropdown-option";
			emptyOption.setAttribute("role", "option");
			emptyOption.setAttribute("aria-disabled", "true");
			const emptyText = document.createElement("span");
			emptyText.className = "damage-detail-move-dropdown-option-text";
			emptyText.textContent = "一致する技がありません";
			emptyOption.appendChild(emptyText);
			moveDropdownList.appendChild(emptyOption);
		} else {
			const fragment = document.createDocumentFragment();
			for (const candidateName of candidates) {
				const option = document.createElement("li");
				option.className = "damage-detail-move-dropdown-option";
				option.setAttribute("role", "option");
				option.setAttribute("aria-label", candidateName);
				const icon = document.createElement("img");
				icon.className = "damage-detail-move-dropdown-option-icon";
				icon.alt = "";
				icon.hidden = true;
				void moveAutoInputDetailsPromise.then((details) => {
					const type = details.get(candidateName)?.type;
					const url = type ? typeIconUrl(type) : null;
					if (!url) return;
					icon.src = url;
					icon.hidden = false;
				});
				icon.addEventListener("error", () => { icon.hidden = true; });
				const text = document.createElement("span");
				text.className = "damage-detail-move-dropdown-option-text";
				text.textContent = candidateName;
				option.append(icon, text);
				option.addEventListener("mousedown", (event) => event.preventDefault());
				option.addEventListener("click", (event) => {
					// inputイベントで候補DOMを差し替えるため、元のclickがdocumentまで到達すると
					// 「詳細パネル外のクリック」と誤判定される。選択クリックはここで完結させる。
					event.stopPropagation();
					moveSelectInput.value = candidateName;
					moveSelectInput.dispatchEvent(new Event("input", { bubbles: true }));
					closeMoveDropdown();
				});
				fragment.appendChild(option);
			}
			moveDropdownList.appendChild(fragment);
		}
		moveDropdownList.hidden = false;
		moveSelectInput.setAttribute("aria-expanded", "true");
	}
	moveSelectInput.addEventListener("focus", renderMoveDropdown);
	moveSelectInput.addEventListener("input", renderMoveDropdown);
	moveSelectInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeMoveDropdown();
	});
	moveSelectInput.addEventListener("blur", () => {
		window.setTimeout(() => {
			if (!moveComboWrap.contains(document.activeElement)) closeMoveDropdown();
		}, 0);
	});
	if (moveDropdownOutsideClickHandler) {
		document.removeEventListener("click", moveDropdownOutsideClickHandler);
	}
	moveDropdownOutsideClickHandler = (event) => {
		if (moveDropdownList.hidden || moveComboWrap.contains(event.target as Node)) return;
		closeMoveDropdown();
	};
	document.addEventListener("click", moveDropdownOutsideClickHandler);
	moveComboWrap.append(moveSelectInput, moveDropdownList);

	const hitRow = document.createElement("div");
	hitRow.className = "damage-column-hitcount-row damage-detail-hitcount-row";
	const hitCountInput = document.createElement("input");
	hitCountInput.type = "number";
	hitCountInput.className = "damage-detail-hitcount-input";
	hitCountInput.step = "1";
	hitCountInput.value = String(column.hitCount ?? 1);
	const hitCountUnit = document.createElement("span");
	hitCountUnit.className = "damage-column-hitcount-unit damage-detail-hitcount-unit";
	hitCountUnit.textContent = "ヒット";
	hitRow.append(hitCountInput, hitCountUnit);

	let hitCountRange: [number, number] = [1, 10];
	async function refreshHitCountVisibility(options?: { silent?: boolean; preferMax?: boolean }): Promise<void> {
		const name = column.moveName.trim();
		const range = await getDamageColumnMultiHitRange(name);
		if (!row.attacks.includes(column) || column.moveName.trim() !== name) return;
		const applyCorrection = (value: number): void => {
			const changed = column.hitCount !== value;
			column.hitCount = value;
			hitCountInput.value = String(value);
			refreshDamageColumnDisplay(row, column);
			refreshMoveEditorDisplay();
			if (!changed || options?.silent) return;
			scheduleRowCalc(row);
			scheduleRowSave(row);
		};
		if (!range) {
			hitCountRange = [1, 1];
			hitRow.hidden = true;
			applyCorrection(1);
			return;
		}
		hitCountRange = range;
		hitRow.hidden = false;
		hitCountInput.min = String(range[0]);
		hitCountInput.max = String(range[1]);
		const label = range[0] === range[1]
			? `ヒット数(${range[0]}回固定)`
			: `ヒット数(${range[0]}〜${range[1]}回)`;
		const hitCountNote = name === "ふくろだたき"
			? "実際のヒット数はパーティの生存数(状態異常でない数)で決まります。乱数ではありません。"
			: "実際のヒット数は技ごとの確率で決まる乱数です。";
		hitCountInput.title = range[0] === range[1]
			? label
			: `${label}。${hitCountNote}ここでは指定した回数ヒットした場合を計算します。`;
		hitCountInput.setAttribute("aria-label", label);
		const desired = options?.preferMax ? range[1] : column.hitCount;
		applyCorrection(clampInt(desired, range[0], range[1]));
	}

	moveSelectInput.addEventListener("input", () => {
		column.moveName = moveSelectInput.value;
		refreshDamageColumnDisplay(row, column);
		refreshMoveEditorDisplay();
		void notifyDetailMoveChanged(row, column).then(refreshMoveEditorDisplay);
		void refreshHitCountVisibility({ preferMax: true });
		scheduleRowCalc(row);
		scheduleRowSave(row);
	});
	hitCountInput.addEventListener("input", () => {
		const n = Number(hitCountInput.value);
		column.hitCount = Number.isFinite(n) ? clampInt(n, hitCountRange[0], hitCountRange[1]) : hitCountRange[0];
		hitCountInput.value = String(column.hitCount);
		refreshDamageColumnDisplay(row, column);
		refreshMoveEditorDisplay();
		scheduleRowCalc(row);
		scheduleRowSave(row);
	});
	hitRow.hidden = true;
	void refreshHitCountVisibility({ silent: true });

	const moveEditorGroup = document.createElement("div");
	moveEditorGroup.className = "damage-detail-move-editor";
	const moveControls = document.createElement("div");
	moveControls.className = "damage-detail-move-controls";
	const moveField = document.createElement("div");
	moveField.className = "damage-detail-move-field";
	moveField.appendChild(moveComboWrap);
	moveControls.append(moveField, criticalField);
	moveEditorGroup.append(moveControls, hitRow);
	contentWrap.appendChild(moveEditorGroup);

	const sidesWrap = document.createElement("div");
	sidesWrap.className = "damage-detail-sides";
	const attackerSide = document.createElement("div");
	attackerSide.className = "damage-detail-side";
	const defenderSide = document.createElement("div");
	defenderSide.className = "damage-detail-side";
	sidesWrap.append(attackerSide, defenderSide);
	contentWrap.appendChild(sidesWrap);

	const selfIsAttackerForDialog = row.direction !== "defense";
// テラスタイプは攻撃側・防御側それぞれの実値を渡す。
	const selfTeraTypeValue = el<HTMLSelectElement>("tera").value;
	const opponentTeraTypeValue = row.teraType;
	buildSideSection(
		attackerSide,
		row,
		"攻撃側",
		selfIsAttackerForDialog ? "攻撃側(自分)" : "攻撃側(相手)",
		column.attackerRank,
		column.attackerAilment,
		column.attackerTerastallized,
		selfIsAttackerForDialog ? selfTeraTypeValue : opponentTeraTypeValue,
		(value) => { column.attackerRank = value; },
		(value) => { column.attackerAilment = value; },
		(value) => { column.attackerTerastallized = value; },
		DAMAGE_ATTACKER_VOLATILES,
		column.attackerVolatiles,
		(value) => { column.attackerVolatiles = value; },
		true,
		// 攻撃側が相手を表すのは、自分が攻撃していない(=自分は防御側)ときだけ。
		!selfIsAttackerForDialog,
		(value) => { row.teraType = value; },
	);
	buildSideSection(
		defenderSide,
		row,
		"防御側",
		selfIsAttackerForDialog ? "防御側(相手)" : "防御側(自分)",
		column.defenderRank,
		column.defenderAilment,
		column.defenderTerastallized,
		selfIsAttackerForDialog ? opponentTeraTypeValue : selfTeraTypeValue,
		(value) => { column.defenderRank = value; },
		(value) => { column.defenderAilment = value; },
		(value) => { column.defenderTerastallized = value; },
		DAMAGE_DEFENDER_VOLATILES,
		column.defenderVolatiles,
		(value) => { column.defenderVolatiles = value; },
		false,
		// 防御側が相手を表すのは、自分が攻撃している(=自分は攻撃側)ときだけ。
		selfIsAttackerForDialog,
		(value) => { row.teraType = value; },
	);

	const wallText = "かべ";
	const wallButton = buildToggleButton(
		wallText,
		column.wallEnabled,
		(pressed) => {
			applyToColumnField(() => { column.wallEnabled = pressed; });
		},
		// 32-R5「title属性の説明文は残すこと」により、可視ラベルが「かべ」1語まで
		// 短くなってもtitleの説明文は変更しない。
		{ title: "リフレクター/ひかりのかべを技の分類に応じて自動選択して壁を張る" },
	);
	const wallHint = document.createElement("p");
	wallHint.className = "damage-detail-toggle-hint";
	wallHint.textContent = "技の分類で自動選択";
	defenderSide.appendChild(wallHint);
	const defenderVolatileGroup = defenderSide.querySelector(".damage-detail-volatile-group");
	if (defenderVolatileGroup) {
		defenderVolatileGroup.appendChild(wallButton);
	} else {
		// DAMAGE_DEFENDER_VOLATILESは通常1件以上を持つためここには来ないが、
		// 将来の変更に備えてフォールバックを用意する(かべチップ自体は必ず
		// 防御側に出す)。
		const fallbackRow = document.createElement("div");
		fallbackRow.className = "damage-detail-toggle-row";
		fallbackRow.appendChild(wallButton);
		defenderSide.appendChild(fallbackRow);
	}

	const hazardsGroup = document.createElement("div");
	hazardsGroup.className = "damage-detail-group";
	const hazardsHeading = document.createElement("p");
	hazardsHeading.className = "damage-detail-section-heading";
	hazardsHeading.textContent = "設置物";
	hazardsGroup.appendChild(hazardsHeading);

	const hazardsControls = document.createElement("div");
	hazardsControls.className = "damage-detail-toggle-row";
	const stealthRockButton = buildToggleButton(
		"ステルスロック",
		column.stealthRock,
		(pressed) => applyToColumnField(() => { column.stealthRock = pressed; }),
		{ title: "ステルスロックを1回踏んだ状態で計算する" },
	);

	const spikesField = document.createElement("div");
	spikesField.className = "rank-field damage-detail-rank-field";
	const spikesLabel = document.createElement("span");
	spikesLabel.textContent = "まきびし";
	const spikesInput = document.createElement("input");
	spikesInput.type = "number";
	spikesInput.min = "0";
	spikesInput.max = "3";
	spikesInput.step = "1";
	spikesInput.inputMode = "numeric";
	spikesInput.className = "damage-detail-rank-input";
	spikesInput.value = String(clampInt(column.spikes, 0, 3));
	const spikesDecrementButton = document.createElement("button");
	spikesDecrementButton.type = "button";
	spikesDecrementButton.className = "rank-stepper damage-detail-rank-stepper";
	spikesDecrementButton.textContent = "－";
	spikesDecrementButton.setAttribute("aria-label", "まきびしを1層減らす");
	const spikesIncrementButton = document.createElement("button");
	spikesIncrementButton.type = "button";
	spikesIncrementButton.className = "rank-stepper damage-detail-rank-stepper";
	spikesIncrementButton.textContent = "＋";
	spikesIncrementButton.setAttribute("aria-label", "まきびしを1層増やす");
	const updateSpikesDisplay = (): void => {
		const n = Number(spikesInput.value);
		const current = Number.isFinite(n) ? clampInt(n, 0, 3) : 0;
		spikesInput.classList.toggle("is-nonzero", current > 0);
		spikesInput.setAttribute("aria-label", `まきびし${current}層`);
		spikesDecrementButton.disabled = current <= 0;
		spikesIncrementButton.disabled = current >= 3;
	};
	const commitSpikes = (fallbackToZeroIfEmpty: boolean): void => {
		const raw = spikesInput.value.trim();
		if (!fallbackToZeroIfEmpty && raw === "") return;
		const n = raw === "" || !Number.isFinite(Number(raw)) ? 0 : Number(raw);
		const clamped = clampInt(n, 0, 3);
		if (spikesInput.value !== String(clamped)) spikesInput.value = String(clamped);
		applyToColumnField(() => { column.spikes = clamped; });
		updateSpikesDisplay();
	};
	spikesInput.addEventListener("input", () => commitSpikes(false));
	spikesInput.addEventListener("change", () => commitSpikes(true));
	spikesInput.addEventListener("blur", () => commitSpikes(true));
	const stepSpikes = (delta: -1 | 1): void => {
		const n = Number(spikesInput.value);
		const current = Number.isFinite(n) ? n : 0;
		spikesInput.value = String(clampInt(current + delta, 0, 3));
		commitSpikes(true);
	};
	spikesDecrementButton.addEventListener("click", () => stepSpikes(-1));
	spikesIncrementButton.addEventListener("click", () => stepSpikes(1));
	spikesInput.addEventListener(
		"wheel",
		(e) => {
			if (document.activeElement === spikesInput) e.preventDefault();
		},
		{ passive: false },
	);
	const spikesStepperGroup = document.createElement("span");
	spikesStepperGroup.className = "rank-stepper-group";
	spikesStepperGroup.append(spikesDecrementButton, spikesInput, spikesIncrementButton);
	const spikesUnit = document.createElement("span");
	spikesUnit.textContent = "層";
	spikesField.append(spikesLabel, spikesStepperGroup, spikesUnit);
	updateSpikesDisplay();
	hazardsControls.append(stealthRockButton, spikesField);
	hazardsGroup.appendChild(hazardsControls);
	sidesWrap.appendChild(hazardsGroup);

	const weatherRow = document.createElement("div");
	weatherRow.className = "damage-detail-field-row";
	const weatherLabel = document.createElement("span");
	weatherLabel.className = "damage-detail-field-row-label";
	weatherLabel.textContent = "天候";
	weatherRow.appendChild(weatherLabel);
	const weatherGroup = buildIconToggleGroup(
		DAMAGE_WEATHERS,
		column.weather,
		(value) => {
			autoInputLocks.set(column, { ...autoInputLocks.get(column), weather: true });
			applyToColumnField(() => { column.weather = value; });
		},
		"天候",
	);
	weatherGroup.classList.add("is-row4");
	weatherRow.appendChild(weatherGroup);
	contentWrap.appendChild(weatherRow);

	const terrainRow = document.createElement("div");
	terrainRow.className = "damage-detail-field-row";
	const terrainLabel = document.createElement("span");
	terrainLabel.className = "damage-detail-field-row-label";
	terrainLabel.textContent = "フィールド";
	terrainRow.appendChild(terrainLabel);
	const terrainGroup = buildIconToggleGroup(
		DAMAGE_TERRAINS,
		column.terrain,
		(value) => {
			autoInputLocks.set(column, { ...autoInputLocks.get(column), terrain: true });
			applyToColumnField(() => { column.terrain = value; });
		},
		"フィールド",
	);
	terrainGroup.classList.add("is-row4");
	terrainRow.appendChild(terrainGroup);
	contentWrap.appendChild(terrainRow);
}

// renderDetailPanel/clearSelectionMarks/applySelectionMarks/selectColumnは
// 構造分割ラウンド(フェーズ1)でshared-core.tsへ移設した(ロジックは一切
// 変更していない。renderDetailPanelがrenderDetailPanelEmpty/
// renderColumnLevelDetailPanelを呼ぶ処理・selectColumnがopenDetailPanelOverlay
// IfNarrowを呼ぶ処理はregisterDamageCalcBridge経由になる。上のimport参照)。

// 行が削除されたときに選択状態を解除する(削除された行の設定が
// サイドバーに残り続けるのを防ぐ)。selectedRow/selectedColumnはshared-core.tsへ
// 移設したため、getSelectedRow/clearSelection経由で読み書きする(構造分割
// ラウンド・フェーズ1。ロジック自体は変えていない)。
export function deselectRowIfCurrent(row: DamageRowState): void {
	if (getSelectedRow() === row) {
		clearSelection();
		renderDetailPanel();
	}
}

// 構造分割ラウンド(フェーズ2): 元はこのファイルの内容がモジュール読み込み時に
// 即座に実行されていた(DOM取得→閉じるボタン/背景クリックのイベント登録→初期状態の
// 空パネル描画)。damage-calc.ts側の#opponent-notes-sectionガードが真になった直後に
// 1回だけ呼ぶ形にする(damage-calc.tsのif (opponentNotesSection) { ... }内、
// registerDamageCalcBridge呼び出しの直後を参照)。実行内容・順序は変えていない。
export function initRightPanel(): void {
	detailPanelEl = el<HTMLElement>("damage-detail-panel");
	detailPanelBodyEl = el<HTMLElement>("damage-detail-panel-body");
	detailPanelTitleEl = el<HTMLElement>("damage-detail-panel-title");
	detailBackdropEl = el<HTMLElement>("damage-detail-backdrop");
	detailPanelFooterEl = el<HTMLElement>("damage-detail-panel-footer");
	detailPanelMatchupEl = el<HTMLElement>("damage-detail-panel-matchup");
	detailPanelTotalEl = el<HTMLElement>("damage-detail-panel-total");
	detailPanelTotalResultEl = el<HTMLElement>("damage-detail-panel-total-result");
	initDetailPanelSwipe();
	bindModalDismissal({
		backdrop: detailBackdropEl,
		isOpen: () => !detailBackdropEl.hidden,
		onDismiss: closeDetailPanelOverlay,
	});
	// 初期状態は何も選択されていない(空状態を表示)。
	renderDetailPanelEmpty();
}
