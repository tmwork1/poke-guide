// 左サイド(ポケモン編集パネル、.panel-left)専用のロジック一式。
//
// このファイルは src/components/box-id/LeftPanel.astro の <script> から
// `import "../../lib/box-id/left-panel";` の形で副作用importされ、モジュール読み込み時に
// 即座に自身を初期化する。
//
// 共有コア(shared-core.ts)の buildAttackerSpec/recalcStats はこの左パネルの
// leftNatureUp/leftNatureDown・renderStatsUnavailable・updateEvRemaining を必要とするため、
// 起動時に registerLeftPanelBridge() で1回だけ登録する(shared-core.tsの設計メモ参照)。
import {
	el,
	loadAutocomplete,
	readEv,
	readMoveNames,
} from "../owned-pokemon-form";
import { bindModalDismissal } from "../modal-dismiss";
import {
	loadTypesMap,
	loadMoveTypeMap,
	loadLearnsetMap,
	loadAbilitiesMap,
	loadMoveDetailMap,
	type MoveDetail,
	type MoveCategory,
} from "../pokemon-master-data";
import { typeIconUrl, teraTypeIconUrl, itemIconUrl } from "../sprite-urls";
import { renderTeamMateSlots } from "../team-mate-card";
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from "../type-colors";
import { applyPreviewMoveTypeBar } from "./preview-move-type-bar";
import { bindPressAndHold } from "../press-and-hold";
import { autosizeTextarea } from "../shared/autosize-textarea";
import { type StatKey, STAT_KEYS, NATURE_STAT_MODIFIERS } from "../stats";
import { kanaIncludes } from "../kana";
import { classifyArchetype, type ArchetypeKey } from "../archetype";
import { renderTeamCard } from "../team-card";
import type { Team } from "../team";
import { getGuestPokemon, listGuestTeams } from "../data/guest-store";
import { isGuestMode } from "../data/guest-mode";
import { createOwnedPokemon, deleteOwnedPokemon, updateOwnedPokemon } from "../data/pokemon-repo";
import {
	attachKanaTypeAhead,
	applySprite,
	applyTeraImage,
	applyItemImage,
	resolveMegaStoneItem,
	flashAutofillHint,
	natureNameFromBoosts,
	nextNatureBoosts,
	recalcStats,
	baseStatsMapPromise,
	registerLeftPanelBridge,
	scheduleAllRowsCalc,
	wrapToRange,
} from "./shared-core";
// 「耐久指数最大化」ボタン(ステータス表の下、#durability-index-button)の配線。
// 計算(純JS、Pyodide不要)はdurability-index.ts、一覧表示はright-panel.tsの
// renderCandidateList()(耐久調整ポップアップと共用の汎用レンダラ)に委譲し、このファイルは
// 「現在の種族値・努力値・性格を渡して総合/物理/特殊の3指数を計算する」「3件を右パネルへ
// 一覧表示する」「クリックされた候補を左パネルへ反映する」の橋渡しだけを担う。押下時は
// 表示のみで、左パネルへの適用は一覧クリック時のみ行う。
import {
	maximizeDurabilityIndex,
	type DurabilityIndexKind,
	type DurabilityIndexCandidate,
} from "./durability-index";
// right-panel.ts と damage-calc.ts の初期化順を変えると循環参照で TDZ 例外になるため、
// 実行時の参照はページ初期化後まで遅延読み込みする。
let rightPanelModulePromise: Promise<typeof import("./right-panel")> | null = null;
function loadRightPanel(): Promise<typeof import("./right-panel")> {
	if (!rightPanelModulePromise) rightPanelModulePromise = import("./right-panel");
	return rightPanelModulePromise;
}

// 候補の並び替えはリスト構築後に行う必要があり、候補の二重追加も避けるため読み込み Promise を共有する。
// 純粋なsubject_key組み立てをNodeテストからimportできるよう、DOMの無い環境では副作用を起動しない。
const autocompleteReadyPromise = typeof document === "undefined" ? Promise.resolve() : loadAutocomplete();

const typesMapPromise = loadTypesMap();
const moveTypeMapPromise = loadMoveTypeMap();
const moveDetailMapPromise = loadMoveDetailMap();
const learnsetMapPromise = loadLearnsetMap();

// タイプ数は可変なのでバッジを動的に追加し、画像を取得できない場合は色表現へフォールバックする。
async function applyTypeBadge(container: HTMLElement, name: string): Promise<void> {
	container.innerHTML = "";
	const types = name ? (await typesMapPromise).get(name) : undefined;
	if (!types || types.length === 0) return;
	for (const t of types) {
		const imgEl = document.createElement("img");
		imgEl.className = "type-badge-img";
		// CSS側(.type-badge-img、20px)と一致させる
		// (width/height属性は実際の描画サイズをCSSが決めるまでの意図サイズヒント)。
		imgEl.width = 20;
		imgEl.height = 20;
		imgEl.alt = t;
		imgEl.title = t;
		imgEl.style.display = "none";
		const fallbackEl = document.createElement("span");
		fallbackEl.className = "type-badge-fallback";
		function showColorFallback(): void {
			imgEl.style.display = "none";
			fallbackEl.style.display = "block";
			fallbackEl.style.backgroundColor = TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;
		}
		const url = typeIconUrl(t);
		if (!url) {
			showColorFallback();
		} else {
			imgEl.onerror = showColorFallback;
			imgEl.onload = () => {
				imgEl.style.display = "";
				fallbackEl.style.display = "none";
			};
			imgEl.src = url;
		}
		container.append(imgEl, fallbackEl);
	}
}

// UI刷新: 努力値の数値入力とレンジ入力(スライダー)を双方向同期させる。
// range側の操作でnumber側の値をプログラム的に更新しても、numberInput自体の
// input/changeイベントは発火しない(ブラウザの仕様)ため、range側のリスナーで
// onSync()を明示的に呼び、既存の自動保存/実数値再計算をトリガーする。
function updateSliderProgress(rangeInput: HTMLInputElement): void {
	const value = Number(rangeInput.value) || 0;
	const percent = Math.min(100, Math.max(0, (value / 32) * 100));
	rangeInput.style.setProperty("--slider-progress", `${percent}%`);
}
function pairEvSlider(numberId: string, rangeId: string, onSync: () => void): void {
	const numberInput = el<HTMLInputElement>(numberId);
	const rangeInput = el<HTMLInputElement>(rangeId);
	const pickerButton = document.getElementById(`${numberId}-picker`) as HTMLButtonElement | null;
	const picker = document.getElementById(`${numberId}-options`);
	const syncPicker = (): void => {
		if (!pickerButton || !picker) return;
		pickerButton.textContent = rangeInput.value;
		for (const option of picker.querySelectorAll<HTMLButtonElement>("[data-ev-value]")) {
			option.setAttribute("aria-current", String(option.dataset.evValue === rangeInput.value));
		}
	};
	const closePicker = (): void => {
		if (!picker || !pickerButton) return;
		picker.hidden = true;
		pickerButton.setAttribute("aria-expanded", "false");
	};
	const openPicker = (): void => {
		if (!picker || !pickerButton) return;
		document.body.appendChild(picker);
		picker.hidden = false;
		const anchor = pickerButton.getBoundingClientRect();
		const pickerWidth = picker.getBoundingClientRect().width;
		picker.style.position = "fixed";
		picker.style.top = `${Math.max(8, Math.min(window.innerHeight - picker.getBoundingClientRect().height - 8, anchor.bottom + 4))}px`;
		picker.style.left = `${Math.max(8, Math.min(window.innerWidth - pickerWidth - 8, anchor.left + (anchor.width - pickerWidth) / 2))}px`;
		pickerButton.setAttribute("aria-expanded", "true");
	};
	let holdTimer: number | undefined;
	let held = false;
	const stopHold = (): void => {
		if (holdTimer !== undefined) window.clearTimeout(holdTimer);
		holdTimer = undefined;
	};
	pickerButton?.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		held = false;
		holdTimer = window.setTimeout(() => {
			held = true;
			closePicker();
			rangeInput.value = Number(rangeInput.value) > 0 ? rangeInput.min : rangeInput.max;
			rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
		}, 500);
	});
	pickerButton?.addEventListener("pointerup", stopHold);
	pickerButton?.addEventListener("pointercancel", stopHold);
	pickerButton?.addEventListener("lostpointercapture", stopHold);
	rangeInput.value = numberInput.value || "0";
	updateSliderProgress(rangeInput);
	syncPicker();
	rangeInput.addEventListener("input", () => {
		numberInput.value = rangeInput.value;
		updateSliderProgress(rangeInput);
		syncPicker();
		onSync();
	});
	// 数値入力は範囲外の値を渡し得るため、循環後の値を両入力へ書き戻す。
	numberInput.addEventListener("input", () => {
		const n = Number(numberInput.value);
		if (Number.isFinite(n)) {
			const wrapped = wrapToRange(Math.round(n), 0, 32);
			if (String(wrapped) !== numberInput.value) numberInput.value = String(wrapped);
			rangeInput.value = String(wrapped);
		}
		updateSliderProgress(rangeInput);
		syncPicker();
	});
	pickerButton?.addEventListener("click", (event) => {
		if (held) {
			event.preventDefault();
			event.stopImmediatePropagation();
			held = false;
			return;
		}
		picker?.hidden ? openPicker() : closePicker();
	});
	picker?.addEventListener("click", (event) => {
		const option = (event.target as Element).closest<HTMLButtonElement>("[data-ev-value]");
		if (!option) return;
		rangeInput.value = option.dataset.evValue ?? rangeInput.value;
		rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
		closePicker();
		pickerButton?.focus();
	});
	document.addEventListener("pointerdown", (event) => {
		if (!picker || picker.hidden || picker.contains(event.target as Node) || pickerButton?.contains(event.target as Node)) return;
		closePicker();
	});
}

function rankByProximity(optionValue: string, currentValue: string): number {
	if (optionValue === currentValue) return 0;
	if (optionValue.startsWith(currentValue)) return 1;
	if (optionValue.includes(currentValue)) return 2;
	return 3;
}
function sortDatalistByProximity(datalist: HTMLDataListElement, currentValue: string): void {
	if (!currentValue) return; // 値が空なら並べ替える意味が無い(元の並び=learnset優先等をそのまま保つ)
	const decorated = Array.from(datalist.options).map((option, index) => ({
		option,
		index,
		rank: rankByProximity(option.value, currentValue),
	}));
	// Array.prototype.sortはES2019以降で安定ソートが仕様上保証されているため、
	// 明示的なindexタイブレークは無くても同順位内の相対順序は保たれるが、
	// 意図を明確にするため保険として残す。
	decorated.sort((a, b) => a.rank - b.rank || a.index - b.index);
	const fragment = document.createDocumentFragment();
	for (const d of decorated) fragment.appendChild(d.option);
	datalist.appendChild(fragment);
}
// 実装上の注意(Playwrightでの実機検証で判明): 「フォーカスが変わった瞬間」を意味する
// focusイベント単体には2つの穴がある。
// (a) #species-nameはSSRで`autofocus`属性が付いており、ページ読み込み直後に(ユーザー操作を
//     伴わず)最初のfocusイベントが発火する。ここで無条件にクリアすると、ページを開いた
//     瞬間に種族名欄が空に見えてしまう(実際に検証して再現した)。
// (b) このラウンドが解決すべき本来のバグ(「一度選択した状態で再クリックしても…」)は、
//     まさに「既にフォーカスが当たっている入力欄を、フォーカスを外さないままもう一度
//     クリックする」操作であり、この場合ブラウザはfocusイベントを再発火しない
//     (フォーカス先が変わっていないため)。focusイベントだけに頼ると、報告された
//     バグの本丸である「再クリック」そのものを取りこぼす(これも実機検証で確認した)。
// そのため、クリック(mousedown、フォーカス有無に関係なく毎回発火する)を主トリガーにし、
// 新規フォーカス(a以外のケース)も拾えるようfocusイベントも併用するが、(a)を除外するため
// 「ページ読み込み直後の同期的なautofocus」だけを短いタイムアウトで見分けて無視する
// (ユーザーの実操作は最短でも数十ms以上かかるため、次のタスク(0ms後)まで生き残っている
// 「読み込み直後ウィンドウ」内のfocusだけを弾けば十分)。
function setupDatalistRefocus(input: HTMLInputElement, datalist: HTMLDataListElement): void {
	let savedValue = "";
	let awaitingUserInput = false;
	let earlyLoadWindowOpen = true;
	setTimeout(() => {
		earlyLoadWindowOpen = false;
	}, 0);
	function openWithFullList(): void {
		if (awaitingUserInput) return; // 既にクリア済み(直前のmousedown/focusで処理済み)なら二重に走らせない
		const currentValue = input.value;
		if (currentValue === "") return; // 未入力なら退避/クリアの必要が無い
		savedValue = currentValue;
		sortDatalistByProximity(datalist, savedValue);
		awaitingUserInput = true;
		// プログラムでの.value代入はinput/changeイベントを発火させないため、
		// updateSpeciesDisplay/updateItemNameDisplay/updateMoveTypeIcon等の
		// 既存リスナー(自動保存含む)は一切トリガーされない。
		input.value = "";
	}
	// mousedownはフォーカスの有無に関係なく毎回発火するため、上記(b)「フォーカスを
	// 外さないままの再クリック」を確実に拾う(クリック直後のfocusイベントより先に
	// 発火するため、値のクリア→ブラウザの候補フィルタ計算、の順序も自然に守られる)。
	input.addEventListener("mousedown", openWithFullList);
	// キーボード操作(Tabでのフォーカス移動)でも同じ体験にするためfocusも併用するが、
	// autofocusによる読み込み直後の1回だけは上記(a)の理由で除外する。
	input.addEventListener("focus", () => {
		if (earlyLoadWindowOpen) return;
		openWithFullList();
	});
	input.addEventListener("input", () => {
		// ユーザーが実際に打鍵/datalistから選択した(本物のinputイベント)ため、
		// blur時の書き戻しはもう不要。
		awaitingUserInput = false;
	});
	input.addEventListener("blur", () => {
		if (awaitingUserInput && input.value.trim() === "") {
			input.value = savedValue;
		}
		awaitingUserInput = false;
	});
}

type SuggestionOption = { value: string; count: number; ratio: number };
type SuggestionPayload = { sample_size: number; options: SuggestionOption[] };
type SuggestionRow = { payload?: SuggestionPayload };
type SuggestionApiResponse = { data?: SuggestionRow[] };

function suggestionRatioText(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

// レギュレーション未指定(null/空)なら横断集計、指定されていればそのレギュレーション限定の
// subject_key('種族名|M-A')を引く。区切り文字 '|' は種族名に現れない(migrations/013参照)。
function suggestionSubjectKey(speciesName: string, regulation: string | null): string {
	return regulation ? `${speciesName}|${regulation}` : speciesName;
}
// 型キーはarchetype_idではなく、クライアントで分類した3要素をDBと同じ順序で連結する。
// 規制指定時は型規制別→型横断→種族規制別→種族横断、未指定時は横断2段だけを返す。
export function popularMoveSubjectKeys(
	speciesName: string,
	regulation: string | null,
	archetype: ArchetypeKey | null,
): { kind: string; subjectKey: string }[] {
	const keys: { kind: string; subjectKey: string }[] = [];
	if (archetype) {
		const base = `${archetype.speciesName}|${archetype.itemName}|${archetype.role}`;
		if (regulation) keys.push({ kind: "popular_move_archetype", subjectKey: `${base}|${regulation}` });
		keys.push({ kind: "popular_move_archetype", subjectKey: base });
	}
	if (regulation) keys.push({ kind: "popular_move", subjectKey: `${speciesName}|${regulation}` });
	keys.push({ kind: "popular_move", subjectKey: speciesName });
	return keys;
}

async function fetchSuggestionPayload(
	kind: string,
	speciesName: string,
	regulation: string | null,
): Promise<SuggestionPayload | undefined> {
	if (!speciesName) return undefined;
	async function fetchBySubjectKey(subjectKey: string): Promise<SuggestionPayload | undefined> {
		try {
			const res = await fetch(`/api/suggestions?kind=${kind}&subject_key=${encodeURIComponent(subjectKey)}&limit=1`);
			if (!res.ok) return undefined;
			const json = (await res.json()) as SuggestionApiResponse;
			return json.data?.[0]?.payload;
		} catch {
			return undefined;
		}
	}
	const scoped = await fetchBySubjectKey(suggestionSubjectKey(speciesName, regulation));
	if (!regulation || (scoped?.options.length ?? 0) > 0) return scoped;
	// 規制別が空の場合だけAPI契約を変えず、subject_keyを種族名にして横断集計を再取得する。
	return fetchBySubjectKey(speciesName);
}

async function fetchPopularMovePayload(
	speciesName: string,
	regulation: string | null,
	archetype: ArchetypeKey | null,
): Promise<SuggestionPayload | undefined> {
	if (!speciesName) return undefined;
	// 先に見つかった「optionsが非空」の集計だけを採用する。404/空payloadは次段へ進む。
	for (const candidate of popularMoveSubjectKeys(speciesName, regulation, archetype)) {
		try {
			const res = await fetch(`/api/suggestions?kind=${candidate.kind}&subject_key=${encodeURIComponent(candidate.subjectKey)}&limit=1`);
			if (!res.ok) continue;
			const json = (await res.json()) as SuggestionApiResponse;
			const payload = json.data?.[0]?.payload;
			if ((payload?.options.length ?? 0) > 0) return payload;
		} catch {
			// 一段の通信失敗でも従来の種族集計までフォールバックできるよう継続する。
		}
	}
	return undefined;
}

type OpggUsageResponse = { options: { name: string; usageRate: number | null }[] };
type OpggUsageCategory = "moves" | "items" | "abilities" | "natures";

// バトルデータタブと同じOP.GG使用率データを、わざ/持ち物/特性/性格の「人気」表示にも使う。
// suggestionsテーブル(ランクマ記事抽出由来)よりカバレッジが広いため優先し、
// OP.GGにデータが無い種族だけ従来のsuggestions取得へフォールバックする。
async function fetchOpggUsagePayload(speciesName: string, category: OpggUsageCategory): Promise<SuggestionPayload | undefined> {
	if (!speciesName) return undefined;
	try {
		const res = await fetch(`/api/opgg-usage?species=${encodeURIComponent(speciesName)}&category=${category}`);
		if (!res.ok) return undefined;
		const json = (await res.json()) as OpggUsageResponse;
		const options: SuggestionOption[] = json.options
			.filter((row): row is { name: string; usageRate: number } => row.usageRate != null)
			.map((row) => ({ value: row.name, count: 0, ratio: row.usageRate / 100 }));
		return options.length > 0 ? { sample_size: 0, options } : undefined;
	} catch {
		return undefined;
	}
}

// OP.GG使用率1位の努力値スプレッド専用API(/api/opgg-usage-evs)。EvRankedRow.valuesは
// RankedRowと形が違う(nameベースの配列ではなくステータス名→値のレコード)ため、
// fetchOpggUsagePayload/SuggestionPayloadの型には乗せず専用の戻り値で返す。
// キーはOP.GG側の英語フルネーム、値は標準スケール(0〜252)のまま。
type OpggUsageEvsResponse = { values: Record<string, number> | null };

// STAT_KEYS(hp/atk/def/spa/spd/spe)とOP.GGのEVスプレッドのキー(英語フルネーム)の対応。
const OPGG_EV_KEY_BY_STAT_KEY: Record<StatKey, string> = {
	hp: "hp",
	atk: "attack",
	def: "defense",
	spa: "specialAttack",
	spd: "specialDefense",
	spe: "speed",
};

async function fetchOpggTopEvs(speciesName: string): Promise<Record<string, number> | undefined> {
	if (!speciesName) return undefined;
	try {
		const res = await fetch(`/api/opgg-usage-evs?species=${encodeURIComponent(speciesName)}`);
		if (!res.ok) return undefined;
		const json = (await res.json()) as OpggUsageEvsResponse;
		return json.values ?? undefined;
	} catch {
		return undefined;
	}
}

// 種族が変わるたびに最新のペイロードで上書きするキャッシュ。もちもの/テラスタイプ選択
// モーダル(item-select-dialog.ts/tera-select-dialog.ts)は開く/再描画するたびに
// getItemSuggestionRatio/getTeraSuggestionRatio(このファイルのexport)経由でプル型に読みに来る。
let lastNatureSuggestion: SuggestionPayload | undefined;
let lastItemSuggestion: SuggestionPayload | undefined;
let lastTeraSuggestion: SuggestionPayload | undefined;
let lastMoveSuggestion: SuggestionPayload | undefined;
let lastAbilitySuggestion: SuggestionPayload | undefined;

// value(候補のキー)→ratioのMapを使い、(a) 人気の高いものを先頭に、(b) データが無いものは
// 元の並び順のまま残す、という候補リスト共通の並び替えを行う。Array.prototype.sortは
// ECMAScript仕様上stable(同順位は入力順を維持)なので、「データ無し同士の相対順序を
// 変えない」がこのcompareだけで自然に成り立つ。
function suggestionCompare(ratioMap: Map<string, number>, valueA: string, valueB: string): number {
	const ra = ratioMap.get(valueA);
	const rb = ratioMap.get(valueB);
	if (ra != null && rb != null) return rb - ra;
	if (ra != null) return -1;
	if (rb != null) return 1;
	return 0;
}

// --- 性格: #nature-list<datalist>(25件、静的にSSR描画済み)を並び替え、labelに作用率を
//     持たせる。datalistのoption.valueを書き換えると入力欄への反映値そのものが変わって
//     しまう(#nature-readout-valueのchangeハンドラがNATURE_STAT_MODIFIERSとの完全一致で
//     検証しているため、"ようき(47%)"のような値は不正値として弾かれてしまう)ため、
//     表示専用のlabel属性(HTMLOptionElement.label)だけを使う。対応ブラウザ(Chromium/
//     Firefox)はvalueとlabelを併記した候補を出す。 ---
function applyNatureSuggestionOrdering(): void {
	const datalist = document.getElementById("nature-list") as HTMLDataListElement | null;
	if (!datalist) return;
	const ratioMap = new Map((lastNatureSuggestion?.options ?? []).map((o) => [o.value, o.ratio] as const));
	const options = Array.from(datalist.options);
	options.sort((a, b) => suggestionCompare(ratioMap, a.value, b.value));
	for (const opt of options) {
		const ratio = ratioMap.get(opt.value);
		opt.label = ratio != null ? suggestionRatioText(ratio) : "";
		datalist.appendChild(opt); // 既存ノードの再appendChildは「末尾へ移動」になる
	}
}

// --- 持ち物: もちもの選択モーダル(item-select-dialog.ts)がグリッドを開く/再描画する
//     たびにこのgetterを引いて人気順に並べ替える(プル型。値の実体である#itemの変更を
//     監視するプッシュ型は使わない)。「持ち物なし」(value="")は常にモーダル側で先頭固定。 ---
export function getItemSuggestionRatio(value: string): number | undefined {
	return lastItemSuggestion?.options.find((o) => o.value === value)?.ratio;
}

// --- テラスタイプ: テラスタイプ選択モーダル(tera-select-dialog.ts)が同じくプル型で
//     参照する。「テラスタルなし」(value="")は常にモーダル側で先頭固定。 ---
export function getTeraSuggestionRatio(value: string): number | undefined {
	return lastTeraSuggestion?.options.find((o) => o.value === value)?.ratio;
}

// --- 持ち物の全候補名(#item-listのdatalist)。loadAutocomplete()(autocompleteReadyPromise)
//     が非同期でoptionを流し込むため一度だけ読み取ってキャッシュする。もちもの選択モーダル
//     (item-select-dialog.ts)からも同じキャッシュを使うためexportする。 ---
let itemOptionNamesCache: string[] | null = null;
export async function getItemOptionNames(): Promise<string[]> {
	await autocompleteReadyPromise;
	if (!itemOptionNamesCache) {
		itemOptionNamesCache = Array.from(
			(document.getElementById("item-list") as HTMLDataListElement).options,
		).map((o) => o.value);
	}
	return itemOptionNamesCache;
}

// --- 技: setupMovePickerWindow()内のテーブル(このファイル下部、別スコープ)が参照する。
//     同関数はモジュールスコープのlastMoveSuggestionを直接読みに行く。 ---
function getMovePopularityRatio(moveName: string): number | undefined {
	return lastMoveSuggestion?.options.find((o) => o.value === moveName)?.ratio;
}

// より新しい呼び出し(種族名が続けて変更された等)に古いレスポンスが追い越して上書きしない
// ようにするトークン(rebuildAbilityOptionsのabilityRequestTokenと同じパターン)。
let popularBuildSuggestionsToken = 0;

// 技のサジェストが更新されたとき、技選択ウィンドウが開いていれば再描画するためのフック。
// setupMovePickerWindow()が自分自身をここへ登録する(ウィンドウ未生成/未オープン時はno-op)。
let onMoveSuggestionUpdated: (() => void) | null = null;

// 特性のサジェストが更新されたとき、#ability(select)の並びを最新化するためのフック。
// rebuildAbilityOptionsが自分自身をここへ登録する(species未確定時はno-op)。
let onAbilitySuggestionUpdated: (() => void) | null = null;

// regulation: 編集中の個体のレギュレーション(#regulation の値。未指定は null)。
// 種族が変わったときだけでなくレギュレーションが変わったときにも呼び直す必要がある。
export async function loadPopularBuildSuggestions(
	speciesName: string,
	regulation: string | null,
	archetype: ArchetypeKey | null = null,
): Promise<boolean> {
	const name = speciesName.trim();
	const token = ++popularBuildSuggestionsToken;
	if (!name) {
		lastNatureSuggestion = lastItemSuggestion = lastTeraSuggestion = lastMoveSuggestion = lastAbilitySuggestion = undefined;
		applyNatureSuggestionOrdering();
		onMoveSuggestionUpdated?.();
		onAbilitySuggestionUpdated?.();
		return false;
	}
	// 5種類の候補取得は速度が大きく異なる(例: OP.GG使用率のKV lookupはmoves/abilitiesだけ
	// 該当シーズンが見つかるまでの逐次フェッチが伸び、数秒〜規定タイムアウトまで詰まることが
	// ある)。Promise.allでまとめて待つと、1つでも遅い候補が残りのlastXxxSuggestion反映まで
	// 道連れにしてしまう(item-select-dialog.ts/tera-select-dialog.tsのgetter・
	// もちもの選択モーダルの並び替えが、無関係なmoves/abilitiesの遅延で止まっていた実例あり)。
	// 各fetchが届き次第、自分の担当分だけ即座に反映する(プル型のitem/teraはgetterが
	// 次回参照時に最新値を返すだけで足りるため専用フックは無い。natureは開いたままの
	// datalistを都度書き換える必要があるためapplyNatureSuggestionOrderingを個別に呼ぶ)。
	const naturePromise = fetchSuggestionPayload("popular_nature", name, regulation).then((payload) => {
		if (token !== popularBuildSuggestionsToken) return payload; // より新しい呼び出しに追い越された
		lastNatureSuggestion = payload;
		applyNatureSuggestionOrdering();
		return payload;
	});
	const itemPromise = fetchOpggUsagePayload(name, "items")
		.then((payload) => payload ?? fetchSuggestionPayload("popular_item", name, regulation))
		.then((payload) => {
			if (token !== popularBuildSuggestionsToken) return payload;
			lastItemSuggestion = payload;
			return payload;
		});
	const teraPromise = fetchSuggestionPayload("popular_tera", name, regulation).then((payload) => {
		if (token !== popularBuildSuggestionsToken) return payload;
		lastTeraSuggestion = payload;
		return payload;
	});
	const movePromise = fetchOpggUsagePayload(name, "moves")
		.then((payload) => payload ?? fetchPopularMovePayload(name, regulation, archetype))
		.then((payload) => {
			if (token !== popularBuildSuggestionsToken) return payload;
			lastMoveSuggestion = payload;
			onMoveSuggestionUpdated?.();
			return payload;
		});
	const abilityPromise = fetchOpggUsagePayload(name, "abilities").then((payload) => {
		if (token !== popularBuildSuggestionsToken) return payload;
		lastAbilitySuggestion = payload;
		onAbilitySuggestionUpdated?.();
		return payload;
	});
	await Promise.all([naturePromise, itemPromise, teraPromise, movePromise, abilityPromise]);
	if (token !== popularBuildSuggestionsToken) return false; // より新しい呼び出しに追い越された
	return true;
}

let hasBaseStatsForDurabilityIndex = false;
const form = typeof document === "undefined" ? null : document.getElementById("edit-form") as HTMLFormElement | null;
if (form) {
	const guestPokemonIdForHydration = form.dataset.id ?? "";
	const shouldHydrateGuestPokemon = isGuestMode() && guestPokemonIdForHydration !== "";
	if (shouldHydrateGuestPokemon) {
		const guestPokemon = getGuestPokemon(guestPokemonIdForHydration);
		if (!guestPokemon) {
			window.location.href = "/box";
		} else {
			// レベル・タグ・性格は直接の入力UIが無いため、buildPayload()/性格初期化より先に
			// SSR用data属性を実データへ差し替える。
			form.dataset.level = guestPokemon.level == null ? "" : String(guestPokemon.level);
			form.dataset.tags = JSON.stringify(guestPokemon.tags);
			form.dataset.nature = guestPokemon.nature ?? "";
		}
	}
	let isGuestHydrating = false;
	/** Keep the mobile training preview synchronized with the training form. */
	function syncPokemonPreview(): void {
		const setText = (targetId: string, value: string): void => {
			const target = document.getElementById(targetId);
			if (target) target.textContent = value || "-";
		};
		const inputValue = (id: string): string =>
			(document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? "";

		const sourceSprite = document.getElementById("species-sprite") as HTMLImageElement | null;
		const previewSprite = document.getElementById("pokemon-preview-species-sprite") as HTMLImageElement | null;
		const sourceFallback = document.getElementById("species-sprite-fallback");
		const previewFallback = document.getElementById("pokemon-preview-species-sprite-fallback");
		if (sourceSprite && previewSprite && previewFallback) {
			const sourceVisible = sourceSprite.style.display !== "none" && sourceSprite.src !== "";
			previewSprite.src = sourceSprite.src;
			previewSprite.alt = sourceSprite.alt;
			previewSprite.style.display = sourceVisible ? "" : "none";
			previewFallback.style.display = sourceVisible ? "none" : "";
			previewFallback.textContent = sourceFallback?.textContent?.trim() || inputValue("species-name").slice(0, 1) || "-";
		}

		const ability = document.getElementById("ability") as HTMLSelectElement | null;
		setText("pokemon-preview-species-name", inputValue("species-name"));
		setText("pokemon-preview-ability", ability?.selectedOptions[0]?.textContent?.trim() || ability?.value.trim() || "-");
		const itemName = inputValue("item");
		setText("pokemon-preview-item", itemName || document.getElementById("item-dropdown-placeholder")?.textContent?.trim() || "もちものなし");
		const previewItem = document.getElementById("pokemon-preview-item");
		if (previewItem) previewItem.dataset.empty = String(itemName === "");
		const mirrorImage = (sourceId: string, targetId: string): void => {
			const source = document.getElementById(sourceId) as HTMLImageElement | null;
			const target = document.getElementById(targetId) as HTMLImageElement | null;
			if (!source || !target) return;
			const visible = source.style.display !== "none" && !source.hidden && source.src !== "";
			target.src = source.src;
			target.alt = source.alt;
			target.title = source.title;
			target.style.display = visible ? "" : "none";
		};
		mirrorImage("item-dropdown-image", "pokemon-preview-item-image");
		for (let slot = 1; slot <= 4; slot++) {
			const moveName = inputValue(`move-${slot}`);
			setText(`pokemon-preview-move-${slot}`, moveName);
			applyPreviewMoveTypeBar(slot, moveName, () => inputValue(`move-${slot}`) !== moveName);
		}
		for (const key of STAT_KEYS) {
			const sourceStat = document.getElementById(`stat-${key}`);
			const previewStat = document.getElementById(`pokemon-preview-stat-${key}`);
			if (previewStat) {
				previewStat.textContent = sourceStat?.textContent?.trim() || "-";
				if (sourceStat?.dataset.mod) previewStat.dataset.mod = sourceStat.dataset.mod;
				else delete previewStat.dataset.mod;
			}
			const ev = inputValue(`ev-${key}`);
			setText(`pokemon-preview-ev-${key}`, ev && Number(ev) !== 0 ? `+${ev}` : "-");
		}
	}
	const durabilityIndexButton = el<HTMLButtonElement>("durability-index-button");
	function updateDurabilityIndexButtonEnabled(): void {
		const remaining = 66 - STAT_KEYS.reduce((sum, k) => sum + readEv(k), 0);
		durabilityIndexButton.disabled = !hasBaseStatsForDurabilityIndex || remaining <= 0;
	}

	// UI刷新: 種族値の常時表示(実数値と同じ行に並べる)。
	async function applyBaseStats(name: string): Promise<void> {
		const base = name ? (await baseStatsMapPromise).get(name) : undefined;
		for (let i = 0; i < STAT_KEYS.length; i++) {
			const el2 = document.getElementById(`base-${STAT_KEYS[i]}`);
			if (!el2) continue;
			el2.textContent = base ? String(base[i]) : "-";
		}
		const hpFixedNoteEl = document.getElementById("hp-fixed-note");
		if (hpFixedNoteEl) hpFixedNoteEl.hidden = !(base && base[0] === 1);
		hasBaseStatsForDurabilityIndex = !!base;
		updateDurabilityIndexButtonEnabled();
	}

	const moveListEl = el<HTMLDataListElement>("move-list");
	// loadAutocomplete()が#move-listへ追記した「全技」の一覧(716件)は1度だけ読み取って
	// キャッシュする。この関数自身が#move-listの中身を並べ替えて書き換えるため、
	// 2回目以降の呼び出し時にDOMから読み直すと「前回の並び替え結果」を元に並べ替える
	// ことになってしまう(元の全件リストを保持し続ける必要がある)。
	let allMoveNamesCache: string[] | null = null;
	async function getAllMoveNames(): Promise<string[]> {
		await autocompleteReadyPromise;
		if (!allMoveNamesCache) {
			allMoveNamesCache = Array.from(moveListEl.options).map((o) => o.value);
		}
		return allMoveNamesCache;
	}
	// 種族名を連打で変更した場合、非同期のfetch/学習セット参照が前後することで古い応答が
	// 新しい応答を上書きしてしまう恐れがある(検索画面のsearchTokenパターンと同じ対策)。
	let moveListRequestToken = 0;
	async function rebuildMoveListForSpecies(name: string): Promise<void> {
		const token = ++moveListRequestToken;
		const [learnsetMap, allMoveNames] = await Promise.all([learnsetMapPromise, getAllMoveNames()]);
		if (token !== moveListRequestToken) return; // より新しい呼び出しに追い越された
		const learnset = name ? learnsetMap.get(name) : undefined;
		let ordered: string[];
		if (learnset && learnset.length > 0) {
			const learnsetSet = new Set(learnset);
			ordered = [...learnset, ...allMoveNames.filter((n) => !learnsetSet.has(n))];
		} else {
			ordered = allMoveNames;
		}
		moveListEl.innerHTML = "";
		const fragment = document.createDocumentFragment();
		for (const n of ordered) {
			const option = document.createElement("option");
			option.value = n;
			fragment.appendChild(option);
		}
		moveListEl.appendChild(fragment);
	}

	async function updateMoveTypeIcon(input: HTMLInputElement): Promise<void> {
		const wrap = input.closest<HTMLElement>(".move-input-group");
		const iconWrap = wrap?.querySelector<HTMLElement>(".move-type-icon");
		const img = iconWrap?.querySelector<HTMLImageElement>("img");
		if (!iconWrap || !img) return;
		const name = input.value.trim();
		const type = name ? (await moveTypeMapPromise).get(name) : undefined;
		if (!type) {
			iconWrap.hidden = true;
			return;
		}
		const url = typeIconUrl(type);
		if (!url) {
			iconWrap.hidden = true;
			return;
		}
		img.alt = type;
		img.title = type;
		img.src = url;
		iconWrap.hidden = false;
	}

	let leftNatureUp: StatKey | null = null;
	let leftNatureDown: StatKey | null = null;
	// 性格確定後に未選択能力を押したときの入れ替え先。無補正からの最初のタップは
	// nextNatureBoosts側が常に上昇として扱うため、ここでは確定済みの場合だけ下降から始める。
	let nextLeftNatureNeutralAssignment: "up" | "down" = "up";
	{
		const initial = NATURE_STAT_MODIFIERS[form.dataset.nature ?? ""] ?? { up: null, down: null };
		leftNatureUp = initial.up;
		leftNatureDown = initial.down;
		nextLeftNatureNeutralAssignment = initial.up && initial.down ? "down" : "up";
	}
	// 性格補正ボタンの初期状態を反映する(refreshNatureButtonsは関数宣言でホイスト
	// されているため、この時点で呼び出せる)。
	refreshNatureButtons();
	// 保存データ・pyodideエンジンに渡す性格名はこの関数で都度導出する
	// (buildPayload/buildAttackerSpecの両方から参照)。
	function currentLeftNature(): string {
		return natureNameFromBoosts(leftNatureUp, leftNatureDown);
	}

	// shared-core.ts の buildAttackerSpec/recalcStats がこの左パネルの状態・関数を
	// 呼べるようにする(shared-core.tsの設計メモ参照)。
	registerLeftPanelBridge({
		getLeftNatureBoosts: () => ({ up: leftNatureUp, down: leftNatureDown }),
		renderStatsUnavailable,
		updateEvRemaining,
	});

	let ownedPokemonId = form.dataset.id ?? "";
	const speciesInput = el<HTMLInputElement>("species-name");
	const statusEl = el<HTMLElement>("autosave-status");
	const statusTextEl = el<HTMLElement>("autosave-status-text");
	const retryButton = el<HTMLButtonElement>("retry-button");
	const deleteButton = el<HTMLButtonElement>("delete-button");

	const speciesSpriteImg = el<HTMLImageElement>("species-sprite");
	const speciesSpriteFallback = el<HTMLElement>("species-sprite-fallback");
	const speciesTypeBadge = el<HTMLElement>("species-type-badge");

	// 「図鑑で見る」リンクは要件により廃止(種族名の変更に追随するのは画像と種族値のみ)。
	function updateSpeciesDisplay(): void {
		const name = speciesInput.value.trim();
		void applySprite(speciesSpriteImg, speciesSpriteFallback, name);
		void applyTypeBadge(speciesTypeBadge, name);
		void applyBaseStats(name);
		void rebuildMoveListForSpecies(name);
	}
	speciesInput.addEventListener("input", updateSpeciesDisplay);
	updateSpeciesDisplay();
	void recalcStats();

	// UI刷新(Pokemon.png): アイテム画像(入力の横)。アイテム名が変わるたびに差し替える。
	const itemImageEl = el<HTMLImageElement>("item-image");
	const itemInput = el<HTMLInputElement>("item");
	function updateItemImage(): void {
		void applyItemImage(itemImageEl, itemInput.value.trim());
	}
	function updateItemTitle(): void {
		itemInput.title = itemInput.value.trim();
	}
	const itemNameDisplayEl = el<HTMLElement>("item-name-display");
	function updateItemNameDisplay(): void {
		const name = itemInput.value.trim();
		itemNameDisplayEl.textContent = name || "もちものなし";
		itemNameDisplayEl.title = name;
		itemNameDisplayEl.classList.toggle("is-empty", name === "");
	}
	itemInput.addEventListener("input", updateItemImage);
	itemInput.addEventListener("input", updateItemTitle);
	itemInput.addEventListener("input", updateItemNameDisplay);
	updateItemImage();
	updateItemTitle();
	updateItemNameDisplay();
	setupDatalistRefocus(itemInput, el<HTMLDataListElement>("item-list"));
	attachKanaTypeAhead(itemInput, el<HTMLDataListElement>("item-list"));

	const itemDropdownButton = el<HTMLButtonElement>("item-dropdown-button");
	const itemDropdownImage = el<HTMLImageElement>("item-dropdown-image");
	const itemDropdownPlaceholder = el<HTMLElement>("item-dropdown-placeholder");

	// 実際の選択操作(検索・候補一覧のクリック)はもちもの選択モーダル
	// (item-select-dialog.ts、#item-dropdown-buttonのクリックで開く)へ切り出した。
	// このselectItemは「人気順自動選択」(下記applyTopOpggBuild)専用に残す薄いヘルパーで、
	// #itemの値を書き換えてinput/changeを発火するだけ(モーダル側のselectItemと同じ発火方式)。
	function selectItem(value: string): void {
		if (itemInput.value !== value) {
			itemInput.value = value;
			// textInputIds(scheduleSave)・statAffectingIds(recalcStats)の両方に"item"が
			// 登録されているため(下記参照)、input/changeの両方を発火させる必要がある。
			itemInput.dispatchEvent(new Event("input"));
			itemInput.dispatchEvent(new Event("change"));
		}
	}

	// ボタン(閉じた状態)に現在選択中の持ち物を表示する(テラスのupdateTeraDropdownButtonと
	// 同じ役割)。クリック時にモーダルを開く処理自体はitem-select-dialog.tsが
	// #item-dropdown-buttonへ直接バインドする(#species-select-trigger-buttonと同じパターン)。
	function updateItemDropdownButton(): void {
		const value = itemInput.value.trim();
		const isUnselected = value === "";
		itemDropdownButton.classList.toggle("is-item-unselected", isUnselected);
		// 読み上げ時も表示上の名称と同じ「アイテム」を使う。
		itemDropdownButton.setAttribute("aria-label", value ? `もちもの: ${value}` : "もちもの: 未選択");
		itemDropdownPlaceholder.classList.toggle("is-item-value-text", !isUnselected);
		if (isUnselected) {
			itemDropdownImage.style.display = "none";
			itemDropdownPlaceholder.textContent = "もちものなし";
			return;
		}
		itemDropdownPlaceholder.textContent = value;
		void applyItemImage(itemDropdownImage, value);
	}
	itemInput.addEventListener("input", updateItemDropdownButton);
	updateItemDropdownButton();

	const abilitySelectEl = el<HTMLSelectElement>("ability");
	let abilityRequestToken = 0;
	async function rebuildAbilityOptions(name: string): Promise<void> {
		const token = ++abilityRequestToken;
		const abilitiesMap = await loadAbilitiesMap();
		if (token !== abilityRequestToken) return; // より新しい呼び出しに追い越された
		// OP.GG使用率(lastAbilitySuggestion)の高い順に並べる。データが無い特性は元の順のまま残る。
		const abilityRatioMap = new Map((lastAbilitySuggestion?.options ?? []).map((o) => [o.value, o.ratio] as const));
		const abilities = name
			? [...(abilitiesMap.get(name) ?? [])].sort((a, b) => suggestionCompare(abilityRatioMap, a, b))
			: [];
		const previousValue = abilitySelectEl.value;
		abilitySelectEl.innerHTML = "";
		if (abilities.length === 0) {
			abilitySelectEl.disabled = true;
			const emptyOpt = document.createElement("option");
			emptyOpt.value = "";
			emptyOpt.textContent = "特性";
			abilitySelectEl.appendChild(emptyOpt);
			abilitySelectEl.value = "";
			abilitySelectEl.title = "";
			if (previousValue !== "") scheduleSave();
			return;
		}
		abilitySelectEl.disabled = false;
		for (const a of abilities) {
			const opt = document.createElement("option");
			opt.value = a;
			opt.textContent = a;
			abilitySelectEl.appendChild(opt);
		}
		abilitySelectEl.value = abilities.includes(previousValue) ? previousValue : abilities[0];
		abilitySelectEl.title = abilitySelectEl.value;
		if (abilitySelectEl.value !== previousValue) scheduleSave();
	}
	abilitySelectEl.addEventListener("change", () => {
		abilitySelectEl.title = abilitySelectEl.value;
	});
	// 特性の選択は、保存処理の完了を待たずにモバイル用プレビューへ反映する。
	// select は操作中に input、確定時に change が発火するため、どちらからも同期する。
	abilitySelectEl.addEventListener("input", syncPokemonPreview);
	abilitySelectEl.addEventListener("change", syncPokemonPreview);
	// OP.GG使用率サジェストがrebuildAbilityOptionsより後に届いた場合に、並び順を最新化する。
	onAbilitySuggestionUpdated = () => {
		void rebuildAbilityOptions(speciesInput.value.trim());
	};
	const megaStoneLockedTitle = "メガシンカ中はもちものをメガストーンに固定します";
	function setItemLocked(locked: boolean): void {
		itemDropdownButton.disabled = locked;
		itemDropdownButton.title = locked ? megaStoneLockedTitle : "";
	}
	let megaStoneAutofillToken = 0;
	async function applyLeftMegaStoneAutofill(speciesName: string): Promise<void> {
		const token = ++megaStoneAutofillToken;
		const stoneName = await resolveMegaStoneItem(speciesName);
		if (token !== megaStoneAutofillToken) return; // より新しい呼び出しに追い越された
		if (!stoneName) {
			setItemLocked(false);
			return;
		}
		if (itemInput.value.trim() === stoneName) {
			setItemLocked(true);
			return;
		}
		itemInput.value = stoneName;
		updateItemImage();
		updateItemTitle();
		updateItemNameDisplay();
		updateItemDropdownButton();
		scheduleSave();
		void recalcStats();
		// 自動補完も持ち物変更なので、現在の型に対応する技人気を更新する。
		schedulePopularBuildSuggestionsReload();
		flashAutofillHint(itemInput, () => updateItemTitle());
		itemDropdownButton.classList.add("is-autofilled");
		window.setTimeout(() => itemDropdownButton.classList.remove("is-autofilled"), 1400);
		setItemLocked(true);
	}
	async function currentArchetype(): Promise<ArchetypeKey | null> {
		// IV=31・Lv50は本アプリの育成ルール。現在の編集値を分類器へそのまま渡す。
		const [baseStatsMap, moveDetailMap] = await Promise.all([baseStatsMapPromise, moveDetailMapPromise]);
		return classifyArchetype({
			speciesName: speciesInput.value.trim(),
			itemName: itemInput.value.trim(),
			nature: currentLeftNature(),
			evs: STAT_KEYS.map((key) => readEv(key)),
			ivs: STAT_KEYS.map(() => 31),
			moveNames: readMoveNames(),
		}, baseStatsMap, (name) => moveDetailMap.get(name)?.category);
	}

	function topSuggestedValue(suggestion: SuggestionPayload | undefined): string | undefined {
		return suggestion?.options.reduce<SuggestionOption | undefined>((top, option) =>
			!top || option.ratio > top.ratio ? option : top,
		undefined,
		)?.value;
	}

	function setSuggestedMoves(): void {
		const moveNames = [...(lastMoveSuggestion?.options ?? [])]
			.sort((a, b) => b.ratio - a.ratio)
			.map((option) => option.value)
			.filter((name, index, names) => name !== "" && names.indexOf(name) === index)
			.slice(0, 4);
		for (let slot = 1; slot <= 4; slot++) {
			const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
			if (!input) continue;
			const value = moveNames[slot - 1] ?? "";
			if (input.value === value) continue;
			input.value = value;
			input.dispatchEvent(new Event("input"));
			input.dispatchEvent(new Event("change"));
		}
	}

	async function applyTopOpggBuild(speciesName: string): Promise<void> {
		// 特性は種族ごとの候補に再構築してから設定する。OP.GG側の表記ゆれなど、候補に
		// 存在しない値は採用しない。
		await rebuildAbilityOptions(speciesName);
		if (speciesInput.value.trim() !== speciesName) return;
		const ability = topSuggestedValue(lastAbilitySuggestion);
		if (ability && Array.from(abilitySelectEl.options).some((option) => option.value === ability)) {
			abilitySelectEl.value = ability;
			abilitySelectEl.dispatchEvent(new Event("input"));
			abilitySelectEl.dispatchEvent(new Event("change"));
		}

		const item = topSuggestedValue(lastItemSuggestion);
		if (item) selectItem(item);
		setSuggestedMoves();

		// 性格・努力値もOP.GG採用率1位を初期値として反映する。
		const [natureSuggestion, evValues] = await Promise.all([
			fetchOpggUsagePayload(speciesName, "natures"),
			fetchOpggTopEvs(speciesName),
		]);
		if (speciesInput.value.trim() !== speciesName) return;

		const natureName = topSuggestedValue(natureSuggestion);
		const natureModifier = natureName ? NATURE_STAT_MODIFIERS[natureName] : undefined;
		if (natureModifier) {
			leftNatureUp = natureModifier.up;
			leftNatureDown = natureModifier.down;
			refreshNatureButtons();
		}

		if (evValues) {
			for (const key of STAT_KEYS) {
				const rawValue = evValues[OPGG_EV_KEY_BY_STAT_KEY[key]];
				if (rawValue == null) continue;
				const input = document.getElementById(`ev-${key}`) as HTMLInputElement | null;
				if (!input) continue;
				// 実データ確認済み: このAPIの取得元(scripts/opgg/fetch-champions-usage.mjs、
				// op.gg/ja/pokemon-champions)は「ポケモンチャンピオンズ」専用ページで、
				// 表示される努力値は同ゲーム本来の0〜32スケールで既に本アプリと同じ形式
				// (0〜252スケールではない。ローカルKVの実データで複数種族分を確認し、値が
				// 常に0〜32に収まることを確認済み)。そのためlegacyToChmpEffort()による
				// 変換はせず、範囲外値だけ安全のためクランプしてそのまま使う。
				const value = String(Math.min(32, Math.max(0, Math.round(rawValue))));
				if (input.value === value) continue;
				input.value = value;
				input.dispatchEvent(new Event("input"));
				input.dispatchEvent(new Event("change"));
			}
		}

		await recalcStats();
	}

	async function reloadPopularBuildSuggestions(autoFill = false): Promise<void> {
		const speciesName = speciesInput.value.trim();
		// レギュレーション属性の廃止により母集団は常に横断(未指定)扱いになる。
		const loaded = await loadPopularBuildSuggestions(speciesName, null, await currentArchetype());
		if (autoFill && loaded && speciesName !== "" && speciesInput.value.trim() === speciesName) {
			await applyTopOpggBuild(speciesName);
		}
	}
	let suggestionReloadTimer: ReturnType<typeof setTimeout> | undefined;
	function schedulePopularBuildSuggestionsReload(): void {
		// スライダーや文字入力の連続操作ごとにAPIを叩かず、確定に近い最新値だけで型を再判定する。
		if (suggestionReloadTimer) clearTimeout(suggestionReloadTimer);
		suggestionReloadTimer = setTimeout(reloadPopularBuildSuggestions, 200);
	}

	speciesInput.addEventListener("change", () => {
		const speciesName = speciesInput.value.trim();
		// ゲスト個体のhydrationでは保存済みの構成を復元するため、種族選択時の
		// 人気構成による自動入力を行わない。通常のユーザー操作は従来どおり自動入力する。
		const shouldAutoFill = !isGuestHydrating;
		// 種族を確定したときだけ、OP.GG採用率の最上位構成を初期値として反映する。
		void reloadPopularBuildSuggestions(shouldAutoFill).then(() => {
			if (shouldAutoFill && speciesInput.value.trim() === speciesName) return applyLeftMegaStoneAutofill(speciesName);
		});
	});
	void rebuildAbilityOptions(speciesInput.value.trim());
	// ページ初期表示時点(SSRで埋め込まれた現在の種族名)で既にメガシンカ種族の場合、
	// 保存済みの持ち物が誤っていても正しいメガストーンへ補正しロックする。
	void applyLeftMegaStoneAutofill(speciesInput.value.trim());
	// 匿名集計サジェスト機能・第5段階: ページ初期化時(SSRで埋め込まれた現在の種族名)にも
	// 1回呼ぶ。
	reloadPopularBuildSuggestions();

	const teraSelect = el<HTMLSelectElement>("tera");
	const teraDropdownButton = el<HTMLButtonElement>("tera-dropdown-button");
	const teraDropdownImage = el<HTMLImageElement>("tera-dropdown-image");
	const teraDropdownPlaceholder = el<HTMLElement>("tera-dropdown-placeholder");

	// 候補一覧の構築・選択操作はテラスタイプ選択モーダル(tera-select-dialog.ts、
	// #tera-dropdown-buttonのクリックで開く)へ切り出した。同モーダルも#tera(<select>)の
	// option一覧からそのまま候補を作るため、値・順序の実体は引き続き<select>側にある
	// (二重管理は発生しない)。

	// ボタン(閉じた状態)に現在選択中のテラスタイプを表示する。クリック時にモーダルを開く
	// 処理自体はtera-select-dialog.tsが#tera-dropdown-buttonへ直接バインドする
	// (#species-select-trigger-buttonと同じパターン)。
	function updateTeraDropdownButton(): void {
		const value = teraSelect.value;
		const isUnselected = value === "";
		teraDropdownButton.classList.toggle("is-tera-unselected", isUnselected);
		teraDropdownButton.setAttribute("aria-label", value ? `テラスタイプ: ${value}` : "テラスタイプ: 未選択");
		teraDropdownPlaceholder.classList.toggle("is-tera-value-text", !isUnselected);
		teraDropdownPlaceholder.hidden = false;
		if (isUnselected) {
			teraDropdownImage.style.display = "none";
			teraDropdownPlaceholder.textContent = "テラスタルなし";
			return;
		}
		teraDropdownPlaceholder.textContent = value;
		const url = teraTypeIconUrl(value);
		if (!url) {
			teraDropdownImage.style.display = "none";
			return;
		}
		teraDropdownImage.alt = value;
		teraDropdownImage.onload = () => {
			teraDropdownImage.style.display = "";
		};
		teraDropdownImage.onerror = () => {
			teraDropdownImage.style.display = "none";
		};
		teraDropdownImage.src = url;
	}
	teraSelect.addEventListener("change", updateTeraDropdownButton);
	updateTeraDropdownButton();

	const topBlockTeraImage = el<HTMLImageElement>("top-block-tera-image");
	const topBlockTeraFallback = el<HTMLElement>("top-block-tera-image-fallback");
	function refreshTopBlockTeraImage(): void {
		void applyTeraImage(topBlockTeraImage, topBlockTeraFallback, teraSelect.value);
	}
	teraSelect.addEventListener("change", refreshTopBlockTeraImage);
	refreshTopBlockTeraImage();

	for (let slot = 1; slot <= 4; slot++) {
		const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
		if (!input) continue;
		input.addEventListener("input", () => void updateMoveTypeIcon(input));
		input.addEventListener("change", () => void updateMoveTypeIcon(input));
		void updateMoveTypeIcon(input);
		setupDatalistRefocus(input, moveListEl);
		attachKanaTypeAhead(input, moveListEl);
	}

	// レベル・タグ・ピン留めの入力UIは廃止したが、PUT /api/owned-pokemon/:id は
	// 全項目上書きの契約なので、送らないとサーバ側の既存値が消えてしまう。
	// SSRで埋め込んだ現在値(data-level / data-tags / data-pinned)をそのまま送り返す。
	const preservedLevel: number | null = (() => {
		const raw = (form.dataset.level ?? "").trim();
		if (raw === "") return null;
		const n = Number(raw);
		return Number.isFinite(n) ? n : null;
	})();
	const preservedTags: string[] = (() => {
		try {
			const parsed: unknown = JSON.parse(form.dataset.tags ?? "[]");
			return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
		} catch {
			return [];
		}
	})();
	function buildPayload() {
		return {
			species_name: speciesInput.value.trim(),
			level: preservedLevel,
			nature: currentLeftNature(),
			ability_name: el<HTMLSelectElement>("ability").value.trim(),
			item_name: el<HTMLInputElement>("item").value.trim(),
			tera_type: el<HTMLSelectElement>("tera").value,
			evs: STAT_KEYS.map((k) => readEv(k)),
			ivs: STAT_KEYS.map(() => 31),
			move_names: readMoveNames(),
			memo: el<HTMLTextAreaElement>("memo").value.trim(),
			tags: preservedTags,
		};
	}

	function refreshNatureButtons(): void {
		// NATURE_TOGGLE_KEYS(下方で const 宣言)はこの関数がページ表示直後に呼ばれる
		// (TDZでまだ初期化されていない)ため、ここではSTAT_KEYSから都度フィルタする。
		for (const key of STAT_KEYS) {
			if (key === "hp") continue;
			const button = document.getElementById(`nature-toggle-${key}`);
			const labelEl = document.getElementById(`nature-label-${key}`);
			const statLabel = labelEl?.getAttribute("aria-label") ?? key;
			const state = leftNatureUp === key ? "up" : leftNatureDown === key ? "down" : "none";
			if (button) {
				button.dataset.natureState = state;
				button.setAttribute("aria-label", `${statLabel}の性格補正: ${state === "up" ? "上昇" : state === "down" ? "下降" : "未設定"}`);
				button.setAttribute("title", `クリックで性格補正を切り替える (現在: ${state === "up" ? "上昇" : state === "down" ? "下降" : "未設定"})`);
			}
			if (labelEl) {
				if (leftNatureUp === key) labelEl.dataset.mod = "up";
				else if (leftNatureDown === key) labelEl.dataset.mod = "down";
				else delete labelEl.dataset.mod;
			}
		}
		const natureReadoutEl = document.getElementById("nature-readout-value");
		if (natureReadoutEl) natureReadoutEl.textContent = currentLeftNature();
	}

	function updateEvRemaining(): void {
		const remainEl = document.getElementById("ev-remaining");
		const indicatorEl = document.getElementById("hp-16n-indicator");
		const total = STAT_KEYS.reduce((sum, k) => sum + readEv(k), 0);
		const remaining = 66 - total;
		const state = remaining < 0 ? "over" : remaining === 0 ? "zero" : undefined;
		updateDurabilityIndexButtonEnabled();
		if (remainEl) {
			remainEl.textContent = `残り${remaining}`;
			if (state) remainEl.dataset.state = state;
			else delete remainEl.dataset.state;
		}
		// 16n+mも同じ残数行の表示なので、非同期の実数値再計算を待たずに状態色を同期する。
		if (indicatorEl) {
			if (state) indicatorEl.dataset.state = state;
			else delete indicatorEl.dataset.state;
		}
	}

	// UI刷新: 実数値の常時表示(努力値・個体値・実数値グリッド)。
	function renderStatsUnavailable(): void {
		updateEvRemaining();
		for (const key of STAT_KEYS) {
			const valueEl = document.getElementById(`stat-${key}`);
			if (!valueEl) continue;
			valueEl.textContent = "-";
			delete valueEl.dataset.mod;
		}
		const indicatorEl = document.getElementById("hp-16n-indicator");
		if (indicatorEl) {
			indicatorEl.textContent = "";
			delete indicatorEl.dataset.state;
		}
	}

	// デバウンス付き即時自動保存 + 楽観的UI更新(計画書§6.2)。
	const DEBOUNCE_MS = 700;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;
	let pendingRetry = false;

	async function saveNow(): Promise<void> {
		if (isGuestHydrating) return;
		if (saving) {
			pendingRetry = true;
			return;
		}
		const payload = buildPayload();
		if (!ownedPokemonId && payload.species_name === "") {
			statusEl.dataset.state = "empty";
			statusTextEl.textContent = "種族を入力すると保存されます";
			retryButton.classList.remove("visible");
			pendingRetry = false;
			return;
		}
		saving = true;
		statusEl.dataset.state = "saving";
		// 進行中表示は画面内で表記を揃えるため全角の三点リーダーを使う。
		statusTextEl.textContent = "保存中…";
		retryButton.classList.remove("visible");

		try {
			if (!ownedPokemonId) {
				const { id } = await createOwnedPokemon(payload);
				window.location.href = `/box/${encodeURIComponent(id)}`;
				return;
			}
			await updateOwnedPokemon(ownedPokemonId, payload);
			statusEl.dataset.state = "saved";
			statusTextEl.textContent = "保存済み";
		} catch (err) {
			console.error(err);
			statusEl.dataset.state = "error";
			statusTextEl.textContent = "保存に失敗しました。";
			retryButton.classList.add("visible");
		} finally {
			saving = false;
			if (pendingRetry) {
				pendingRetry = false;
				void saveNow();
			}
		}
	}

	function scheduleSave(): void {
		syncPokemonPreview();
		if (isGuestHydrating) return;
		statusEl.dataset.state = "saving";
		// 進行中表示は画面内で表記を揃えるため全角の三点リーダーを使う。
		statusTextEl.textContent = "編集中…";
		retryButton.classList.remove("visible");
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void saveNow();
		}, DEBOUNCE_MS);
	}

	retryButton.addEventListener("click", () => {
		void saveNow();
	});

	const textInputIds = ["species-name", "item", "memo", ...STAT_KEYS.map((k) => `ev-${k}`), "move-1", "move-2", "move-3", "move-4"];
	for (const id of textInputIds) {
		const target = document.getElementById(id);
		if (!target) continue;
		target.addEventListener("input", scheduleSave);
	}
	for (const id of STAT_KEYS.map((key) => `ev-${key}`)) {
		document.getElementById(id)?.addEventListener("input", scheduleAllRowsCalc);
	}
	const memoInput = document.getElementById("memo") as HTMLTextAreaElement | null;
	if (memoInput) autosizeTextarea(memoInput);
	// 型判定に使う持ち物・努力値・技が変わったら、技人気だけを新しい型で取り直す。
	for (const id of ["item", ...STAT_KEYS.map((k) => `ev-${k}`), "move-1", "move-2", "move-3", "move-4"]) {
		document.getElementById(id)?.addEventListener("input", schedulePopularBuildSuggestionsReload);
	}
	const changeInputIds = ["tera", "ability"];
	for (const id of changeInputIds) {
		const target = document.getElementById(id);
		if (!target) continue;
		target.addEventListener("change", scheduleSave);
	}

	// UI刷新: ポケモン名/特性/持ち物/テラス/努力値のいずれかが変更されたら
	// 実数値を再計算する(change イベントで十分。入力のたびの再計算は不要。
	// IVは「チャンピオンズ」ルールで常に31固定のため変更対象から除外)。
	// 性格の変更(クリックによる未設定・上昇・下降の循環)は下のnature-toggleクリックハンドラ側で
	// 個別にscheduleSave/recalcStatsを呼ぶ(選択UIが無いのでchangeイベントが無い)。
	const statAffectingIds = [
		"species-name",
		"ability",
		"item",
		"tera",
		...STAT_KEYS.map((k) => `ev-${k}`),
	];
	for (const id of statAffectingIds) {
		const target = document.getElementById(id);
		if (!target) continue;
		target.addEventListener("change", () => {
			void recalcStats();
		});
	}

	const NATURE_TOGGLE_KEYS = STAT_KEYS.filter((k) => k !== "hp");
	for (const key of NATURE_TOGGLE_KEYS) {
		const button = document.getElementById(`nature-toggle-${key}`);
		button?.addEventListener("click", async () => {
			const next = nextNatureBoosts(
				{ up: leftNatureUp, down: leftNatureDown },
				key,
				nextLeftNatureNeutralAssignment,
			);
			leftNatureUp = next.up;
			leftNatureDown = next.down;
			nextLeftNatureNeutralAssignment = next.nextNeutralAssignment;
			refreshNatureButtons();
			await recalcStats();
			scheduleSave();
			schedulePopularBuildSuggestionsReload();
		});
	}

	for (const k of STAT_KEYS) {
		pairEvSlider(`ev-${k}`, `ev-${k}-range`, () => {
			scheduleSave();
			void recalcStats();
			schedulePopularBuildSuggestionsReload();
			scheduleAllRowsCalc();
		});
	}
	for (const button of document.querySelectorAll<HTMLButtonElement>(".stat-ev-step-button")) {
		const stepEv = (): boolean => {
			const rangeInput = document.getElementById(button.dataset.evTarget ?? "") as HTMLInputElement | null;
			if (!rangeInput) return false;
			const step = Number(button.dataset.evStep);
			if (!Number.isFinite(step)) return false;
			const min = Number(rangeInput.min) || 0;
			const max = Number(rangeInput.max) || 32;
			const current = Number(rangeInput.value) || 0;
			const next = Math.min(max, Math.max(min, current + step));
			if (next === current) return false;
			rangeInput.value = String(next);
			rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		};
		bindPressAndHold(button, stepEv);
		button.addEventListener("click", stepEv);
	}

	deleteButton.addEventListener("click", () => {
		void (async () => {
			if (!ownedPokemonId) return;
			if (!window.confirm("この個体を削除します。よろしいですか?")) return;
			deleteButton.disabled = true;
			try {
				await deleteOwnedPokemon(ownedPokemonId);
				window.location.href = "/box";
			} catch (err) {
				console.error(err);
				window.alert("削除に失敗しました。時間をおいて再度お試しください。");
				deleteButton.disabled = false;
			}
		})();
	});

	const collectionOptOutToggle = document.getElementById("collection-opt-out-toggle") as HTMLInputElement | null;
	const collectionOptOutStatusEl = document.getElementById("collection-opt-out-status");

	if (collectionOptOutToggle) {
		collectionOptOutToggle.addEventListener("change", () => {
			void (async () => {
				const nextOptOut = collectionOptOutToggle.checked; // 「非公開」ON = 収集拒否
				collectionOptOutToggle.disabled = true;
				try {
					const res = await fetch(`/api/owned-pokemon/${encodeURIComponent(ownedPokemonId)}`, {
						method: "PATCH",
						credentials: "same-origin",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ collection_opt_out: nextOptOut }),
					});
					if (!res.ok) throw new Error(`更新に失敗しました (status=${res.status})`);
					if (collectionOptOutStatusEl) {
						collectionOptOutStatusEl.hidden = true;
						delete collectionOptOutStatusEl.dataset.state;
					}
				} catch (err) {
					console.error(err);
					// 失敗時: チェック状態を元に戻し、#autosave-status[data-state="error"]と同じ
					// 温度感(最小限の赤字テキストのみ)でエラーを示す。
					collectionOptOutToggle.checked = !nextOptOut;
					if (collectionOptOutStatusEl) {
						collectionOptOutStatusEl.textContent = "更新に失敗しました";
						collectionOptOutStatusEl.hidden = false;
						collectionOptOutStatusEl.dataset.state = "error";
					}
				} finally {
					collectionOptOutToggle.disabled = false;
				}
			})();
		});
	}

	function applyDurabilityEvToLeftPanel(key: "hp" | "def" | "spd", value: number): void {
		const input = document.getElementById(`ev-${key}`) as HTMLInputElement | null;
		if (!input) return;
		input.value = String(value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	}
	function applyDurabilityCandidateToLeftPanel(candidate: DurabilityIndexCandidate): void {
		applyDurabilityEvToLeftPanel("hp", candidate.evs.hp);
		applyDurabilityEvToLeftPanel("def", candidate.evs.def);
		applyDurabilityEvToLeftPanel("spd", candidate.evs.spd);
	}

	const DURABILITY_INDEX_KINDS: { kind: DurabilityIndexKind; heading: string; headingHelp: string }[] = [
		{ kind: "total", heading: "総合耐久指数", headingHelp: "H×B×D÷(B+D)" },
		{ kind: "physical", heading: "物理耐久指数", headingHelp: "H×B" },
		{ kind: "special", heading: "特殊耐久指数", headingHelp: "H×D" },
	];

	async function runDurabilityIndexMaximize(): Promise<void> {
		const name = speciesInput.value.trim();
		if (!name) return; // ボタンは種族名が空のときdisabledのはずだが、念のための防御
		if (66 - STAT_KEYS.reduce((sum, k) => sum + readEv(k), 0) <= 0) return;
		const base = (await baseStatsMapPromise).get(name);
		if (!base) return;
		const { renderDurabilityIndexResults, openDetailPanelOverlayIfNarrow } = await loadRightPanel();
		const nature = currentLeftNature();

		renderDurabilityIndexResults(
			() =>
				DURABILITY_INDEX_KINDS.map(({ kind, heading, headingHelp }) => ({
					kind,
					heading,
					headingHelp,
					result: maximizeDurabilityIndex({ kind, baseStats: base, currentEvs: STAT_KEYS.map((k) => readEv(k)), nature }),
				})),
			() => ({ hp: readEv("hp"), def: readEv("def"), spd: readEv("spd") }),
			(candidate) => applyDurabilityCandidateToLeftPanel(candidate),
		);
		openDetailPanelOverlayIfNarrow();
	}

	durabilityIndexButton.addEventListener("click", () => {
		void runDurabilityIndexMaximize();
	});

	setupMovePickerWindow(speciesInput);

	setupMoveReorderDrag();

	// 実数値計算と画像読み込みは非同期なので、入力イベントでの即時同期に加えて
	// 表示元のDOM更新も監視し、計算・画像反映の完了後にプレビューへ転記する。
	const mobilePreviewSources = [
		document.getElementById("species-sprite"),
		document.getElementById("species-sprite-fallback"),
		document.getElementById("item-dropdown-image"),
		...Array.from(document.querySelectorAll<HTMLElement>(".move-input-group .move-type-icon")),
		...STAT_KEYS.map((key) => document.getElementById(`stat-${key}`)),
	].filter((node): node is HTMLElement => node instanceof HTMLElement);
	if (document.querySelector(".pokemon-preview")) {
		const mobilePreviewObserver = new MutationObserver(syncPokemonPreview);
		for (const source of mobilePreviewSources) {
			mobilePreviewObserver.observe(source, { attributes: true, childList: true, characterData: true, subtree: true });
		}
	}
	syncPokemonPreview();

	void loadOwnedPokemonTeams();

	async function hydrateGuestPokemon(): Promise<void> {
		if (!shouldHydrateGuestPokemon) return;
		const guestPokemon = getGuestPokemon(guestPokemonIdForHydration);
		if (!guestPokemon) {
			window.location.href = "/box";
			return;
		}

		isGuestHydrating = true;
		try {
			// 保存経路にある既存リスナーへ通知して、候補再構築・画像・実数値・プレビュー更新を
			// 通常の種族選択と同じ順路で動かす。hydration中のscheduleSaveは上で抑止する。
			form.dataset.level = guestPokemon.level == null ? "" : String(guestPokemon.level);
			form.dataset.tags = JSON.stringify(guestPokemon.tags);
			form.dataset.nature = guestPokemon.nature ?? "";
			speciesInput.value = guestPokemon.species_name;
			speciesInput.dispatchEvent(new Event("input", { bubbles: true }));
			speciesInput.dispatchEvent(new Event("change", { bubbles: true }));

			// 種族に応じた候補が非同期で作られるため、完了後に保存済み特性を戻す。マスターに
			// 無い表記でも、SSR時の既存個体と同様に選択肢を1件足して値を失わせない。
			await rebuildAbilityOptions(guestPokemon.species_name);
			const abilityValue = guestPokemon.ability_name ?? "";
			if (!Array.from(abilitySelectEl.options).some((option) => option.value === abilityValue)) {
				const option = document.createElement("option");
				option.value = abilityValue;
				option.textContent = abilityValue || "特性";
				abilitySelectEl.appendChild(option);
			}
			abilitySelectEl.value = abilityValue;
			abilitySelectEl.dispatchEvent(new Event("input", { bubbles: true }));
			abilitySelectEl.dispatchEvent(new Event("change", { bubbles: true }));

			itemInput.value = guestPokemon.item_name ?? "";
			itemInput.dispatchEvent(new Event("input", { bubbles: true }));
			itemInput.dispatchEvent(new Event("change", { bubbles: true }));

			teraSelect.value = guestPokemon.tera_type ?? "";
			teraSelect.dispatchEvent(new Event("change", { bubbles: true }));

			for (let slot = 1; slot <= 4; slot++) {
				const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
				if (!input) continue;
				input.value = guestPokemon.move_names[slot - 1] ?? "";
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}

			const memoInput = el<HTMLTextAreaElement>("memo");
			memoInput.value = guestPokemon.memo ?? "";
			memoInput.dispatchEvent(new Event("input", { bubbles: true }));

			const natureModifier = NATURE_STAT_MODIFIERS[guestPokemon.nature ?? ""] ?? { up: null, down: null };
			leftNatureUp = natureModifier.up;
			leftNatureDown = natureModifier.down;
			nextLeftNatureNeutralAssignment = natureModifier.up && natureModifier.down ? "down" : "up";
			refreshNatureButtons();

			for (let index = 0; index < STAT_KEYS.length; index++) {
				const key = STAT_KEYS[index];
				const rawValue = guestPokemon.evs[index];
				const value = Number.isFinite(rawValue) ? Math.min(32, Math.max(0, Math.round(rawValue))) : 0;
				const input = el<HTMLInputElement>(`ev-${key}`);
				const range = el<HTMLInputElement>(`ev-${key}-range`);
				input.value = String(value);
				range.value = String(value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}

			await recalcStats();
	} finally {
		isGuestHydrating = false;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		pendingRetry = false;
		statusEl.dataset.state = "saved";
		statusTextEl.textContent = "保存済み";
		retryButton.classList.remove("visible");
	}
	}

	void hydrateGuestPokemon();
}

// 持ち物アイコン(team/[id].astroのapplyItemIconと同じ実装)。renderTeamMateSlotsの
// applyItemIconはvisibilityElのhidden切り替えを前提とするため、shared-core.tsの
// applyItemImage(バッジをclosest()で探す実装)とは互換性が無く、ここで個別に持つ。
function applyItemIcon(
	imgEl: HTMLImageElement,
	itemName: string,
	visibilityEl?: HTMLElement,
): void {
	if (!itemName) {
		imgEl.style.display = "none";
		if (visibilityEl) visibilityEl.hidden = true;
		return;
	}
	imgEl.onerror = () => {
		imgEl.style.display = "none";
		if (visibilityEl) visibilityEl.hidden = true;
	};
	imgEl.onload = () => {
		imgEl.style.display = "";
		if (visibilityEl) visibilityEl.hidden = false;
	};
	imgEl.src = itemIconUrl(itemName);
}

// メモ欄の下に、この個体が所属しているチーム一覧を表示する(読み取り専用。カードクリックで
// /team/[id]へ遷移するだけで、このパネルからチーム編集はしない)。GET /api/teamsはログイン中
// ユーザーの全チーム(members込み)を返すため、members[].owned_pokemon.id(TeamMemberの型、
// src/lib/team.ts参照)がこの個体のidと一致するチームだけをクライアント側で抽出する。
// 新規個体(保存前、ownedPokemonIdが空)はどのチームにも所属し得ないため呼ばない。
async function loadOwnedPokemonTeams(): Promise<void> {
	const listEl = document.getElementById("pokemon-team-list");
	const sectionEl = document.getElementById("pokemon-team-section");
	const ownedPokemonId = (document.getElementById("edit-form") as HTMLFormElement | null)?.dataset.id ?? "";
	if (!listEl || !sectionEl || !ownedPokemonId) return;
	try {
		const allTeams: Team[] = isGuestMode()
			? listGuestTeams()
			: await (async () => {
				const res = await fetch("/api/teams", { credentials: "same-origin" });
				if (!res.ok) return [];
				const body = (await res.json().catch(() => ({}))) as { teams?: Team[] };
				return body.teams ?? [];
			})();
		const teams = allTeams.filter((t) =>
			t.members.some((m) => m.owned_pokemon.id === ownedPokemonId),
		);
		listEl.replaceChildren();
		if (teams.length === 0) {
			sectionEl.hidden = true;
			return;
		}
		for (const t of teams) {
			const membersBySlot = new Map(t.members.map((m) => [m.slot, m]));
			const memoText = (t.memo ?? "").trim();
			// 表示内容はteam/index.astroのrenderCard()の圧縮表示(displayMode: "compressed")と
			// 同じ組み立て(体数バッジ・メモ絵文字・team-mate-cardの6列簡易表示)だが、読み取り専用
			// のためonDeleteは一切渡さない(削除ボタン無し)。
			const card = renderTeamCard({
				href: `/team/${encodeURIComponent(t.id)}`,
				ariaLabel: "チームを見る",
				name: "",
				memo: memoText ? { text: "📝", title: memoText, ariaLabel: `メモ: ${memoText}` } : {},
				badges: [{ className: "badge tnum card-team-count-badge", text: `${t.members.length}/6` }],
				membersBySlot,
				toCardContent: (member) => {
					const pokemonName = member.owned_pokemon.species_name?.trim() || "ポケモン";
					return {
						pokemon: member.owned_pokemon,
						displayName: pokemonName,
						ariaLabel: pokemonName,
					};
				},
				renderMembers: (container) => {
					container.className = "team-mate-grid";
					const mateMembersBySlot = new Map(t.members.map((m) => [m.slot, m.owned_pokemon]));
					renderTeamMateSlots({
						root: container,
						membersBySlot: mateMembersBySlot,
						displayName: (p) => p.species_name || "ポケモン",
						applySprite,
						applyItemIcon,
					});
				},
			});
			listEl.appendChild(card);
		}
		sectionEl.hidden = false;
	} catch (err) {
		console.error(err);
	}
}

function setupMoveReorderDrag(): void {
	const groups = ([1, 2, 3, 4] as const)
		.map((slot) => {
			const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
			const group = input?.closest<HTMLElement>(".move-input-group") ?? null;
			const handle = group?.querySelector<HTMLElement>(".move-drag-handle") ?? null;
			return input && group && handle ? { slot, input, group, handle } : null;
		})
		.filter((g): g is { slot: number; input: HTMLInputElement; group: HTMLElement; handle: HTMLElement } => g !== null);
	if (groups.length !== 4) return; // 想定外のマークアップでは何もしない(安全側)

	// ドラッグ元(fromSlot)の値を抜き取り、ドロップ先(toSlot)の直前に挿入する形で
	// 4値の配列を並べ替え、#move-1〜#move-4へ書き戻す。書き戻しはプログラムでの
	// .value代入(input/changeイベントを発火させない)なので、既存のupdateMoveTypeIcon
	// (タイプアイコン反映)・scheduleSave(自動保存、textInputIds参照)がそのまま動くよう
	// 明示的にinput/changeイベントをdispatchする(choose()関数と同じ手法)。
	function moveValueTo(fromSlot: number, toSlot: number): void {
		if (fromSlot === toSlot) return;
		const values = groups.map((g) => g.input.value);
		const [moved] = values.splice(fromSlot - 1, 1);
		values.splice(toSlot - 1, 0, moved);
		groups.forEach((g, i) => {
			if (g.input.value === values[i]) return;
			g.input.value = values[i];
			g.input.dispatchEvent(new Event("input", { bubbles: true }));
			g.input.dispatchEvent(new Event("change", { bubbles: true }));
		});
	}

	for (const g of groups) {
		g.handle.addEventListener("mousedown", (downEvent) => {
			// 既定のテキスト選択・フォーカス移動を防ぐ(ハンドルは<span>なので実害は
			// 小さいが、ドラッグ中に隣接テキストが選択されるちらつきを避ける)。
			downEvent.preventDefault();
			let hoverSlot: number | null = null;
			g.group.classList.add("is-dragging");

			function onMove(moveEvent: MouseEvent): void {
				const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
				const hoveredGroup = (target as HTMLElement | null)?.closest<HTMLElement>(".move-input-group") ?? null;
				for (const other of groups) other.group.classList.remove("is-drag-over");
				hoverSlot = null;
				if (hoveredGroup && hoveredGroup !== g.group) {
					hoveredGroup.classList.add("is-drag-over");
					const found = groups.find((o) => o.group === hoveredGroup);
					hoverSlot = found ? found.slot : null;
				}
			}
			function onUp(): void {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				for (const other of groups) other.group.classList.remove("is-dragging", "is-drag-over");
				if (hoverSlot != null) moveValueTo(g.slot, hoverSlot);
			}
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});
	}
}

function setupMovePickerWindow(speciesInput: HTMLInputElement): void {
	const moveInputEls = ([1, 2, 3, 4] as const)
		.map((slot) => document.getElementById(`move-${slot}`) as HTMLInputElement | null)
		.filter((input): input is HTMLInputElement => input !== null);
	if (moveInputEls.length === 0) return; // #move-1〜#move-4が無いページでは何もしない(安全側)

	type SortKey = "popularity" | "name" | "type" | "category" | "power" | "accuracy" | "pp";
	type SortDir = "asc" | "desc";

	const CATEGORY_LABELS: Record<MoveCategory, string> = { physical: "物理", special: "特殊", status: "変化" };
	const CATEGORY_RANK: Record<MoveCategory, number> = { physical: 0, special: 1, status: 2 };

	let activeSlot: number | null = null;
	// 技スロットタブのドラッグ&ドロップ入れ替え用(team/[id].astroのrenderSlots()の
	// draggedMemberSlotと同じ考え方)。dragstart側で持ち上げ中のスロット番号を記録し、
	// drop側でswapMoveSlots()を呼んで2つのスロットの技を入れ替える。
	let draggedSlot: number | null = null;
	let learnsetOnly = true; // 37-2: 既定ON
	// 初期表示は人気順(sortDir="desc"=ratio降順)。ユーザーがどれかの列ヘッダを1回でも
	// クリックした時点でこの初期値は上書きされ、以後はユーザーの選択がそのまま残り続ける
	// (このウィンドウはページ内で使い回されるシングルトンで、開閉のたびにリセットしない)。
	let sortKey: SortKey = "popularity";
	let sortDir: SortDir = "desc";
	const filters = { name: "" };

	let allMoves: MoveDetail[] = [];
	let allMovesReady = false;
	let currentPool: MoveDetail[] = [];
	let moveTypesByName: Map<string, string> | null = null;

	// --- DOM構築(1回だけ。document.body直下にappendする理由は
	//     LeftPanel.astro側の<style is:global>直前コメント参照) ---
	const windowEl = document.createElement("div");
	windowEl.id = "move-picker-window";
	windowEl.className = "move-picker-window";
	windowEl.hidden = true;
	windowEl.setAttribute("role", "dialog");
	windowEl.setAttribute("aria-label", "わざ選択");
	windowEl.setAttribute("aria-modal", "false");

	const backdropEl = document.createElement("div");
	backdropEl.className = "move-picker-backdrop";
	backdropEl.hidden = true;

	const headerEl = document.createElement("div");
	headerEl.className = "move-picker-header";
	const titleEl = document.createElement("span");
	titleEl.className = "move-picker-title";
	titleEl.textContent = "わざ選択";
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "move-picker-close";
	closeButton.setAttribute("aria-label", "わざ選択を閉じる");
	closeButton.textContent = "×";
	headerEl.append(titleEl, closeButton);

	const toggleLabel = document.createElement("label");
	toggleLabel.className = "move-picker-toggle";
	const toggleSwitchEl = document.createElement("span");
	toggleSwitchEl.className = "toggle-switch";
	const toggleInput = document.createElement("input");
	toggleInput.type = "checkbox";
	toggleInput.className = "toggle-switch-input";
	toggleInput.checked = true;
	toggleInput.setAttribute("aria-label", "覚える技のみ表示");
	const toggleTrackEl = document.createElement("span");
	toggleTrackEl.className = "toggle-switch-track";
	toggleTrackEl.setAttribute("aria-hidden", "true");
	const toggleThumbEl = document.createElement("span");
	toggleThumbEl.className = "toggle-switch-thumb";
	toggleTrackEl.appendChild(toggleThumbEl);
	toggleSwitchEl.append(toggleInput, toggleTrackEl);
	const toggleTextEl = document.createElement("span");
	toggleTextEl.textContent = "覚える技のみ表示";
	toggleLabel.append(toggleSwitchEl, toggleTextEl);


	windowEl.appendChild(headerEl);

	const slotTabsEl = document.createElement("div");
	slotTabsEl.className = "move-picker-slot-tabs";
	// スロットの並べ替えは長押し+ドラッグで行う(team/[id].astroのrenderSlots()の
	// カード並べ替えと同じ「持ち上げ中スロットを記録し、ドロップ先でswapする」考え方)。
	// ネイティブHTML5 D&D(draggable属性)はタッチ操作時、ブラウザ既定の長押し判定
	// (Android Chromeで概ね500ms前後、機種依存)に頼っておりJS側から短縮できないため、
	// 判定時間を明示的に制御できるポインタイベントベースの実装にする(card-delete-mode.tsの
	// LONG_PRESS_MS、team/[id].astroのLONG_PRESS_MSと同じ考え方。体感を優先し450msにする)。
	const SLOT_DRAG_LONG_PRESS_MS = 450;
	const SLOT_DRAG_MOVE_CANCEL_PX = 8; // 長押し確定前にこれ以上動いたらタップ/スクロールとみなし打ち切る
	let slotPressTimer: ReturnType<typeof window.setTimeout> | undefined;
	let slotDragActive = false;
	let suppressSlotClick = false;
	let slotDragStartX = 0;
	let slotDragStartY = 0;
	function clearSlotPressTimer(): void {
		if (slotPressTimer !== undefined) window.clearTimeout(slotPressTimer);
		slotPressTimer = undefined;
	}
	function findSlotButtonAt(x: number, y: number): HTMLButtonElement | null {
		const target = document.elementFromPoint(x, y);
		return (target as HTMLElement | null)?.closest<HTMLButtonElement>(".move-picker-slot-tab") ?? null;
	}
	function clearSlotDropTargets(): void {
		for (const btn of slotTabsEl.querySelectorAll<HTMLButtonElement>(".move-picker-slot-tab")) {
			btn.classList.remove("is-drop-target");
		}
	}
	for (const slot of [1, 2, 3, 4]) {
		const slotButton = document.createElement("button");
		slotButton.type = "button";
		slotButton.className = "move-picker-slot-tab";
		slotButton.dataset.slot = String(slot);
		slotButton.textContent = `技${slot}`;
		slotButton.addEventListener("click", () => {
			if (suppressSlotClick) {
				// 長押しドラッグ確定後に発生する合成clickを1回だけ握りつぶす
				// (card-delete-mode.tsのsuppressNextClickと同じ考え方)。
				suppressSlotClick = false;
				return;
			}
			activeSlot = slot;
			updateSlotTabs();
			renderRows();
		});
		// スロットを空にするのはダブルタップ／ダブルクリック時だけにする。
		// clickでは選択を切り替えるだけで、技の内容は変更しない。
		slotButton.addEventListener("dblclick", () => {
			clearMoveSlot(slot);
		});
		function onSlotDragMove(moveEvent: PointerEvent): void {
			clearSlotDropTargets();
			const hovered = findSlotButtonAt(moveEvent.clientX, moveEvent.clientY);
			if (hovered && hovered !== slotButton) hovered.classList.add("is-drop-target");
		}
		function endSlotDrag(commitEvent: PointerEvent | null): void {
			document.removeEventListener("pointermove", onSlotDragMove);
			document.removeEventListener("pointerup", onSlotDragEnd);
			document.removeEventListener("pointercancel", onSlotDragCancel);
			slotDragActive = false;
			slotButton.classList.remove("is-dragging");
			clearSlotDropTargets();
			const fromSlot = draggedSlot;
			draggedSlot = null;
			if (!commitEvent || fromSlot == null) return;
			const target = findSlotButtonAt(commitEvent.clientX, commitEvent.clientY);
			const toSlot = target ? Number(target.dataset.slot) : NaN;
			if (target && target !== slotButton && Number.isFinite(toSlot)) swapMoveSlots(fromSlot, toSlot);
		}
		function onSlotDragEnd(upEvent: PointerEvent): void {
			endSlotDrag(upEvent);
		}
		function onSlotDragCancel(): void {
			endSlotDrag(null);
		}
		slotButton.addEventListener("pointerdown", (event) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			suppressSlotClick = false;
			slotDragStartX = event.clientX;
			slotDragStartY = event.clientY;
			clearSlotPressTimer();
			slotPressTimer = window.setTimeout(() => {
				slotPressTimer = undefined;
				slotDragActive = true;
				suppressSlotClick = true;
				draggedSlot = slot;
				slotButton.classList.add("is-dragging");
				document.addEventListener("pointermove", onSlotDragMove);
				document.addEventListener("pointerup", onSlotDragEnd);
				document.addEventListener("pointercancel", onSlotDragCancel);
			}, SLOT_DRAG_LONG_PRESS_MS);
		});
		slotButton.addEventListener("pointermove", (event) => {
			if (slotDragActive || slotPressTimer === undefined) return;
			const dx = event.clientX - slotDragStartX;
			const dy = event.clientY - slotDragStartY;
			// 長押し確定前の移動はタップ/スクロールの意図とみなし、ドラッグ開始をキャンセルする。
			if (Math.hypot(dx, dy) > SLOT_DRAG_MOVE_CANCEL_PX) clearSlotPressTimer();
		});
		slotButton.addEventListener("pointerup", () => {
			clearSlotPressTimer();
		});
		slotButton.addEventListener("pointercancel", () => {
			clearSlotPressTimer();
		});
		slotTabsEl.appendChild(slotButton);
	}
	windowEl.appendChild(slotTabsEl);

	const noteEl = document.createElement("p");
	noteEl.className = "move-picker-note";
	noteEl.hidden = true;
	windowEl.appendChild(noteEl);
	const tableControlsEl = document.createElement("div");
	tableControlsEl.className = "move-picker-table-controls";
	tableControlsEl.appendChild(toggleLabel);
	windowEl.appendChild(tableControlsEl);

	const tableWrap = document.createElement("div");
	tableWrap.className = "move-picker-table-wrap";
	const table = document.createElement("table");
	table.className = "move-picker-table";
	const thead = document.createElement("thead");
	const headerRow = document.createElement("tr");

	function makeSortButton(label: string, key: SortKey, iconOnly = false): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "move-picker-sort-btn";
		btn.dataset.sortKey = key;
		btn.textContent = iconOnly ? "" : label;
		if (iconOnly) btn.setAttribute("aria-label", `${label}で並び替え`);
		btn.addEventListener("click", () => {
			if (key === "popularity") {
				sortKey = "popularity";
				sortDir = "desc";
				updateSortButtonIndicators();
				renderRows();
				return;
			}
			if (sortKey === key) {
				sortDir = sortDir === "asc" ? "desc" : "asc";
			} else {
				sortKey = key;
				sortDir = "asc";
			}
			updateSortButtonIndicators();
			renderRows();
		});
		return btn;
	}

	function makeHeaderCell(label: string, key: SortKey, filterEl: HTMLElement | null): HTMLTableCellElement {
		const th = document.createElement("th");
		const top = document.createElement("div");
		top.className = "move-picker-th";
		const iconOnlySort = key === "type" || key === "category";
		const sortButton = makeSortButton(label, key, iconOnlySort);
		if (filterEl) {
			const filterWrap = document.createElement("div");
			filterWrap.className = "move-picker-th-filter";
			filterWrap.appendChild(filterEl);
			if (iconOnlySort) top.append(filterWrap, sortButton);
			else top.append(sortButton, filterWrap);
		} else {
			top.appendChild(sortButton);
		}
		th.appendChild(top);
		return th;
	}

	const nameFilterInput = document.createElement("input");
	nameFilterInput.type = "text";
	nameFilterInput.placeholder = "";
	nameFilterInput.setAttribute("aria-label", "わざ名で絞り込み");
	nameFilterInput.addEventListener("input", () => {
		filters.name = nameFilterInput.value.trim();
		renderRows();
	});

	const nameHeaderCell = document.createElement("th");
	const nameHeader = document.createElement("div");
	nameHeader.className = "move-picker-th";
	const nameFilterWrap = document.createElement("div");
	nameFilterWrap.className = "move-picker-th-filter search-input-wrap";
	const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	searchIcon.classList.add("search-icon");
	searchIcon.setAttribute("width", "15");
	searchIcon.setAttribute("height", "15");
	searchIcon.setAttribute("viewBox", "0 0 24 24");
	searchIcon.setAttribute("fill", "none");
	searchIcon.setAttribute("stroke", "currentColor");
	searchIcon.setAttribute("stroke-width", "2.2");
	searchIcon.setAttribute("stroke-linecap", "round");
	searchIcon.setAttribute("stroke-linejoin", "round");
	searchIcon.setAttribute("aria-hidden", "true");
	const searchIconCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	searchIconCircle.setAttribute("cx", "11");
	searchIconCircle.setAttribute("cy", "11");
	searchIconCircle.setAttribute("r", "7");
	const searchIconLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
	searchIconLine.setAttribute("x1", "21");
	searchIconLine.setAttribute("y1", "21");
	searchIconLine.setAttribute("x2", "16.65");
	searchIconLine.setAttribute("y2", "16.65");
	searchIcon.append(searchIconCircle, searchIconLine);
	nameFilterWrap.append(searchIcon, nameFilterInput);
	nameHeader.append(nameFilterWrap, makeSortButton("わざ名", "name", true));
	nameHeaderCell.appendChild(nameHeader);
	headerRow.appendChild(nameHeaderCell);
	// 人気列は値の意味が自明なので、見出しラベルを出さず並べ替えボタンだけを置く。
	const popularityHeaderCell = document.createElement("th");
	const popularityHeader = document.createElement("div");
	popularityHeader.className = "move-picker-th";
	popularityHeader.appendChild(makeSortButton("人気", "popularity", true));
	popularityHeaderCell.appendChild(popularityHeader);
	headerRow.appendChild(popularityHeaderCell);
	headerRow.appendChild(makeHeaderCell("タイプ", "type", null));
	headerRow.appendChild(makeHeaderCell("分類", "category", null));
	headerRow.appendChild(makeHeaderCell("威力", "power", null));
	headerRow.appendChild(makeHeaderCell("命中", "accuracy", null));
	// PPは比較・並び替え用の列として残し、フィルタUIだけを削除する。
	headerRow.appendChild(makeHeaderCell("PP", "pp", null));

	thead.appendChild(headerRow);
	table.appendChild(thead);
	const tbody = document.createElement("tbody");
	table.appendChild(tbody);
	tableWrap.appendChild(table);
	windowEl.appendChild(tableWrap);

	const emptyMessageEl = document.createElement("p");
	emptyMessageEl.className = "move-picker-empty";
	emptyMessageEl.textContent = "条件に一致する技がありません";
	emptyMessageEl.hidden = true;
	// 空表示をtable直後の同じスクロール領域へ置けば、theadを常時残したままフィルタ行の
	// 直下にメッセージを出せる。入力DOMを作り直さないため、0件になってもフォーカスを保てる。
	tableWrap.appendChild(emptyMessageEl);

	// 37-1: LeftPanel.astro側の<style is:global>直前コメントで詳述した実測結果により、
	// z-index:-1ではなくauto(position:fixedのみ)を使う。このウィンドウをbodyの
	// 「先頭の子」として挿入することで、box/[id].astroがSSRで描画する`.card-damage`
	// (position:relative、同じCSS区分(6))よりも必ずDOM順で先(=同区分内比較で背面)になる。
	document.body.insertBefore(backdropEl, document.body.firstChild);
	document.body.insertBefore(windowEl, backdropEl.nextSibling);

	function updateSlotTabs(): void {
		for (const tab of Array.from(slotTabsEl.querySelectorAll<HTMLButtonElement>(".move-picker-slot-tab"))) {
			const slot = Number(tab.dataset.slot);
			const selected = slot === activeSlot;
			const moveName = (document.getElementById(`move-${slot}`) as HTMLInputElement | null)?.value.trim();
			tab.replaceChildren();
			const type = moveName ? moveTypesByName?.get(moveName) : undefined;
			const iconUrl = type ? typeIconUrl(type) : undefined;
			if (iconUrl) {
				const icon = document.createElement("img");
				icon.className = "move-picker-slot-type-icon";
				icon.src = iconUrl;
				icon.alt = "";
				icon.title = type;
				tab.appendChild(icon);
			}
			tab.append(moveName || `技${slot}`);
			tab.setAttribute("aria-label", `技${slot}: ${moveName || "未選択"}`);
			tab.classList.toggle("is-selected", selected);
			tab.setAttribute("aria-pressed", String(selected));
		}
	}

	void moveTypeMapPromise.then((moveTypes) => {
		moveTypesByName = moveTypes;
		updateSlotTabs();
	});

	function updateSortButtonIndicators(): void {
		for (const btn of Array.from(table.querySelectorAll<HTMLButtonElement>(".move-picker-sort-btn"))) {
			const key = btn.dataset.sortKey as SortKey;
			btn.classList.toggle("is-active", key === sortKey);
			btn.dataset.sortDir = key === sortKey ? sortDir : "";
		}
	}

	async function ensureAllMovesLoaded(): Promise<void> {
		if (allMovesReady) return;
		const map = await loadMoveDetailMap();
		allMoves = [...map.values()];
		allMovesReady = true;
	}

	function comparator(a: MoveDetail, b: MoveDetail): number {
		let result = 0;
		switch (sortKey) {
			case "popularity": {
				// getMovePopularityRatio(left-panel.ts上部、モジュールスコープ)は種族確定時に
				// loadPopularBuildSuggestionsが更新するlastMoveSuggestionを直接読む。データが
				// 無い技はpower/accuracyと同じ慣習(?? -1)で扱う——asc(小さい順)なら先頭、
				// desc(大きい順、既定)なら末尾に集まる。
				const ra = getMovePopularityRatio(a.name);
				const rb = getMovePopularityRatio(b.name);
				if (ra == null && rb == null) {
					// 両方データ無し: 名前のあいうえお順で安定させる。sortDirの符号反転
					// (下のreturn文)を打ち消して、desc(既定)でも常にあ→ん順を保つ。
					const alpha = a.name.localeCompare(b.name, "ja");
					result = sortDir === "desc" ? -alpha : alpha;
				} else {
					result = (ra ?? -1) - (rb ?? -1);
				}
				break;
			}
			case "name":
				result = a.name.localeCompare(b.name, "ja");
				break;
			case "type":
				result = (a.type ?? "").localeCompare(b.type ?? "", "ja");
				break;
			case "category":
				result = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
				break;
			case "power":
				result = (a.power ?? -1) - (b.power ?? -1);
				break;
			case "accuracy":
				result = (a.accuracy ?? -1) - (b.accuracy ?? -1);
				break;
			case "pp":
				result = a.pp - b.pp;
				break;
		}
		return sortDir === "asc" ? result : -result;
	}

	async function refreshPool(): Promise<void> {
		await ensureAllMovesLoaded();
		const speciesName = speciesInput.value.trim();
		if (learnsetOnly && speciesName) {
			const learnsetMap = await learnsetMapPromise;
			const learnset = learnsetMap.get(speciesName);
			if (learnset && learnset.length > 0) {
				const learnsetSet = new Set(learnset);
				currentPool = allMoves.filter((m) => learnsetSet.has(m.name));
				noteEl.hidden = true;
				renderRows();
				return;
			}
		}
		currentPool = allMoves;
		if (learnsetOnly) {
			noteEl.hidden = false;
			noteEl.textContent = speciesName
				? "このポケモンの覚え技情報が見つからないため、全件表示しています。"
				: "種族が未選択のため、全件表示しています。";
		} else {
			noteEl.hidden = true;
		}
		renderRows();
	}

	function passesFilters(m: MoveDetail): boolean {
		// 技名中のひらがな/カタカナ混在を保ったまま表記違いを吸収する。
		if (filters.name && !kanaIncludes(m.name, filters.name)) return false;
		return true;
	}

	function choose(move: MoveDetail): void {
		if (activeSlot == null) return;
		const targetInput = document.getElementById(`move-${activeSlot}`) as HTMLInputElement | null;
		if (!targetInput) return;
		targetInput.value = move.name;
		// プログラムでの.value代入はinput/changeイベントを発火させないため明示的にdispatchする。
		// これで既存のupdateMoveTypeIcon(input/changeリスナー)・scheduleSave(textInputIdsの
		// inputリスナー、buildPayload経由の自動保存)がそのまま動く(左パネル側のコードは
		// 一切変更していない)。
		targetInput.dispatchEvent(new Event("input", { bubbles: true }));
		targetInput.dispatchEvent(new Event("change", { bubbles: true }));
		const nextEmptySlot = [1, 2, 3, 4].find((slot) => {
			const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
			return !input?.value.trim();
		});
		if (nextEmptySlot != null) activeSlot = nextEmptySlot;
		updateSlotTabs();
		renderRows();
	}

	function clearMoveSlot(slot: number): void {
		const targetInput = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
		if (!targetInput) return;
		targetInput.value = "";
		// choose()と同様に既存のアイコン更新・自動保存用リスナーへ通知する。
		targetInput.dispatchEvent(new Event("input", { bubbles: true }));
		targetInput.dispatchEvent(new Event("change", { bubbles: true }));
		updateSlotTabs();
		renderRows();
	}

	// 技スロットタブのドラッグ&ドロップ用: fromSlot/toSlotの技を入れ替える。
	function swapMoveSlots(fromSlot: number, toSlot: number): void {
		const fromInput = document.getElementById(`move-${fromSlot}`) as HTMLInputElement | null;
		const toInput = document.getElementById(`move-${toSlot}`) as HTMLInputElement | null;
		if (!fromInput || !toInput) return;
		const fromValue = fromInput.value;
		const toValue = toInput.value;
		if (fromValue === toValue) return;
		fromInput.value = toValue;
		toInput.value = fromValue;
		// choose()/clearMoveSlot()と同様に既存のアイコン更新・自動保存用リスナーへ通知する。
		for (const input of [fromInput, toInput]) {
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		}
		activeSlot = toSlot;
		updateSlotTabs();
		renderRows();
	}

	function renderRows(): void {
		const rows = currentPool.filter(passesFilters).slice().sort(comparator);
		tbody.innerHTML = "";
		const fragment = document.createDocumentFragment();
		const currentValue = activeSlot != null ? (document.getElementById(`move-${activeSlot}`) as HTMLInputElement | null)?.value.trim() : "";
		for (const m of rows) {
			const tr = document.createElement("tr");
			tr.tabIndex = 0;
			tr.setAttribute("role", "button");
			tr.className = "move-picker-row";
			tr.dataset.moveName = m.name;
			if (m.name === currentValue) tr.classList.add("is-selected");

			const nameTd = document.createElement("td");
			nameTd.className = "move-picker-cell-name";
			nameTd.textContent = m.name;
			tr.appendChild(nameTd);

			// 匿名集計サジェスト機能: 「人気」列。データが無い技は他の数値列(威力/命中)と
			// 同じ慣習で"-"を表示する。
			const popularityTd = document.createElement("td");
			popularityTd.className = "move-picker-cell-num";
			const popularityRatio = getMovePopularityRatio(m.name);
			popularityTd.textContent = popularityRatio != null ? suggestionRatioText(popularityRatio) : "-";
			tr.appendChild(popularityTd);

			const typeTd = document.createElement("td");
			typeTd.className = "move-picker-cell-type";
			if (m.type) {
				const iconUrl = typeIconUrl(m.type);
				if (iconUrl) {
					const img = document.createElement("img");
					img.src = iconUrl;
					img.alt = m.type;
					img.width = 16;
					img.height = 16;
					img.className = "move-picker-type-icon";
					typeTd.appendChild(img);
				}
			} else {
				typeTd.textContent = "-";
			}
			tr.appendChild(typeTd);

			const categoryTd = document.createElement("td");
			categoryTd.textContent = CATEGORY_LABELS[m.category];
			tr.appendChild(categoryTd);

			const powerTd = document.createElement("td");
			powerTd.className = "move-picker-cell-num";
			powerTd.textContent = m.power == null ? "-" : String(m.power);
			tr.appendChild(powerTd);

			const accuracyTd = document.createElement("td");
			accuracyTd.className = "move-picker-cell-num";
			accuracyTd.textContent = m.accuracy == null ? "-" : String(m.accuracy);
			tr.appendChild(accuracyTd);

			const ppTd = document.createElement("td");
			ppTd.className = "move-picker-cell-num";
			ppTd.textContent = String(m.pp);
			tr.appendChild(ppTd);

			tr.addEventListener("click", () => choose(m));
			tr.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					choose(m);
				}
			});

			fragment.appendChild(tr);
		}
		tbody.appendChild(fragment);
		const isEmpty = rows.length === 0;
		emptyMessageEl.hidden = !isEmpty;
	}

	// .panel-leftの右端に外付けする配置は、.edit-layout-right(ダメージカード列)の
	// 真上に重なる位置になり得る。実測したジオメトリ:
	//   .panel-left        x: 256.0 〜 696.0  (position:static、レイヤー3)
	//   .edit-layout-right x: 718.4 〜 1537.6 (position:static、レイヤー3。ただしこの中の
	//                                          .card-damage自体はposition:relativeでレイヤー6)
	//   .card-damage       x: 738.4 〜 1517.6 (position:relative、レイヤー6。z-index:auto)
	//   .edit-layout-detail(#damage-detail-panel) x: 1560 〜 1920
	//                      (1600px以上でposition:sticky、z-index:60=レイヤー7、常に最前面)
	//   .app-sidebar       x: 0 〜 256 (position:fixed、z-index:30=レイヤー7、常に最前面)
	// このウィンドウ自身はposition:fixed・z-index:auto(レイヤー6)。CSS2.1 Appendix Eの
	// スタッキング順では「レイヤー3(position指定なし)」は「レイヤー6(position指定+
	// z-index:auto)」より必ず背面になるため、.panel-left自体や.edit-layout-right自身の
	// 余白部分(グリッドgap・padding、position指定なし)は、このウィンドウと重なっても
	// **常にこのウィンドウの背面**になる(=重なってもウィンドウが操作可能)。
	// 一方.card-damage(レイヤー6)とはDOM順のタイブレークになるため、
	// このウィンドウをdocument.bodyの先頭子として挿入していることで、重なる部分は
	// 引き続きカードが前面になる。.damage-detail-panel/.app-sidebarはレイヤー7(正のz-index)
	// で常に最前面のため、この2つの矩形とだけは重ねてはいけない(重ねてもウィンドウ側が
	// 常に埋もれて一切操作できなくなるだけで、「一部は操作できる」にすらならない)。
	//
	// 幅が確保できない場合は、.panel-left自身の列
	// (position:staticなので重ねてもこのウィンドウが前面になる)に重ねる。
	// 具体的には、left = anchorRect.left(.panel-leftの左端に揃える。.app-sidebarの右端と
	// 一致するため.app-sidebarへの食い込みも起きない)。右端は「実在する.card-damageの中で
	// 最も左の座標」の直前までに制限する(.edit-layout-right自身の左paddingぶんの余白
	// (.panel-left右端〜カード左端、実測で約42px)まではレイヤー3同士なので安全に使える)。
	// .card-damageが1つも無いフィクスチャ、または(900〜1199px幅の縦積みレイアウトのように)
	// カードがこのウィンドウの左位置とほぼ同じx(=真下にあるだけで隣り合っていない)の場合は、
	// この制限を適用せず画面右端近くまで幅を確保してよい(「隣り合っていないカード」に
	// 合わせて幅を潰してしまう回帰を防ぐガード。 left + 200 未満のカードは「隣ではなく下」と
	// みなす)。
	//
	// 縦位置(top)は「今フォーカスしている技入力欄の上端」ではなく、以下の実測に基づく
	// 下限を使う。.panel-leftへ重ねる方式には次の罠がある: .panel-left内は
	// 全体がposition:staticではなく、アイコン画像を添える入力欄だけ`.field-with-image`系の
	// ラッパー(.species-icon-box/.tera-dropdown-wrap/.move-input-group、いずれも
	// position:relative・z-index:auto)がある。これらはこのウィンドウと同じレイヤー6のため、
	// DOM順のタイブレークで(このウィンドウがbody先頭子=DOM順で先=背面のため)これらの
	// ラッパーがこのウィンドウより前面になり、重なるとクリックを奪われる
	// (実測: #move-1をクリックして開いたウィンドウの先頭行(トグル)が、隣の#move-2の
	// `.move-input-group`(同じ行の別スロット)に重なりクリック不能だった)。
	// .panel-left内でposition:relative/absoluteなのはこの少数の「アイコン付き入力欄」
	// ラッパー群だけで、いずれも上部(種族名・テラス・技1〜4の行)に集中しており、その他大部分
	// (能力値テーブル・メモ欄等)はposition:staticであることを実測(全descendantsの
	// computedStyleを走査)で確認済み。そのため、ウィンドウのtopをこれらポジション付き
	// ラッパー群の最下端より下に固定できれば、ウィンドウの全域(ヘッダー行含む)がその後
	// 一切衝突しなくなる。特定のピクセル値を決め打ちにせず、実行時に
	// `.panel-left`配下のposition!=staticな要素をすべて洗い出し、その最下端(bottom)の
	// 最大値をtopの下限にする(将来.panel-left側にアイコン付き入力欄が増減しても
	// 追随できるようにするため)。
	// 技選択テーブルは既定では左パネルの右側に外付けする。「.panel-left自体に重ねる」設計に
	// 戻す際に問題だった「ダメージカード列に重なると背面に埋もれて操作不能になる」点は、
	// `.move-picker-window`にz-index:10を明示指定したことで解消している(このファイル
	// 冒頭のCSSコメント参照。`.card-damage`(position:relative・z-index:auto)に確実に勝つ)。
	// ただし900〜1199px幅(1200px未満)は.edit-layoutが2カラムグリッド化されず.panel-leftが
	// 全幅ブロックになるため、右側に外付けする余地(最低320px)が無い。この場合は
	// 「.panel-left自体に重ねる」動作にフォールバックする(z-index:10が.move-input-group等の
	// レイヤー6ラッパーには引き続き確実に勝つため、重ねても操作不能にはならない)。
	function reposition(inputEl: HTMLInputElement): void {
		const anchor = document.querySelector<HTMLElement>(".panel-left") ?? document.getElementById("edit-form");
		if (!anchor) return;
		const anchorRect = anchor.getBoundingClientRect();
		const inputRect = inputEl.getBoundingClientRect();
		const gap = 8;
		const rightEdge = window.innerWidth - gap;
		const dockedLeft = anchorRect.right + gap;
		const canDockRight = dockedLeft + 320 <= rightEdge;
		const left = canDockRight ? dockedLeft : Math.max(gap, anchorRect.left);
		const width = Math.max(320, Math.min(640, rightEdge - left));

		// .panel-left配下でposition:static以外の要素を避けてtopを下げる以下の座標回避は、
		// 「.panel-left自体に重ねる」(canDockRight===false のフォールバック時)にのみ意味がある。
		// 右へ外付けする(canDockRight===true)場合はそもそも.panel-leftと水平に重ならないため、
		// この回避は不要かつ有害(隣接表示のはずがinputの行より大きく下にずれてしまう)。
		let positionedBottom = 0;
		if (!canDockRight) {
			// .panel-left配下でposition:static以外(=このウィンドウと同じレイヤー6でDOM順が
			// このウィンドウより後になり得る)要素の最下端を求め、そこより下にウィンドウ全体を
			// 逃がす。該当が無ければ0(=inputRect.top基準のみで決まる)。
			for (const el of Array.from(anchor.querySelectorAll<HTMLElement>("*"))) {
				const pos = getComputedStyle(el).position;
				if (pos === "static") continue;
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				if (r.bottom > positionedBottom) positionedBottom = r.bottom;
			}
		}
		if (!canDockRight) {
			for (const el of Array.from(anchor.querySelectorAll<HTMLElement>(".stat-nature-btn"))) {
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				if (r.bottom > positionedBottom) positionedBottom = r.bottom;
			}
		}
		const desiredTop = Math.max(inputRect.top, positionedBottom > 0 ? positionedBottom + gap : 0);
		const top = Math.max(8, Math.min(desiredTop, window.innerHeight - 240));
		windowEl.style.left = `${left}px`;
		windowEl.style.top = `${top}px`;
		windowEl.style.width = `${width}px`;
		const maxHeight = window.innerHeight - top - 16;
		windowEl.style.maxHeight = `${Math.max(240, maxHeight)}px`;
	}

	function onScrollOrResize(): void {
		if (activeSlot == null) return;
		const activeInput = document.getElementById(`move-${activeSlot}`) as HTMLInputElement | null;
		if (activeInput) reposition(activeInput);
	}

	// モバイルモーダルの高さは--move-picker-dialog-height(既定75dvh、move-picker-dialog.css)。
	// dvh(動的ビューポート高)はモーダルを開いたあとに技一覧テーブル内の絞り込み入力/セレクトへ
	// フォーカスしてソフトキーボードが開くと、キーボード分だけ縮んだビューポート高に追随して
	// しまい、モーダル自体が縮んで見えるバグの原因になっていた(Android Chrome等はフォーカス時に
	// レイアウトビューポートをリサイズするため)。モーダルを開いた瞬間(キーボードが閉じている
	// 状態)の高さをpxで一度だけ確定し、以後キーボードの開閉に関わらず維持する。
	function lockMobileModalHeight(): void {
		const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
		windowEl.style.setProperty("--move-picker-dialog-height", `${Math.round(viewportHeight * 0.75)}px`);
	}
	function unlockMobileModalHeight(): void {
		windowEl.style.removeProperty("--move-picker-dialog-height");
	}

	function openPicker(slot: number, inputEl: HTMLInputElement, mobileModal = false): void {
		// 幅の狭い画面(デスクトップ2カラム構成が成立しない1200px未満相当)では
		// 「左パネルの右側に外付け」という前提が成立しない。この場合は開かず、
		// 既存のdatalist(直接タイプ)による絞り込みだけを使ってもらう(壊さない)。
		if (!mobileModal) return;
		activeSlot = slot;
		windowEl.classList.toggle("is-mobile-modal", mobileModal);
		windowEl.setAttribute("aria-modal", String(mobileModal));
		backdropEl.hidden = !mobileModal;
		updateSlotTabs();
		lockMobileModalHeight();
		windowEl.hidden = false;
		if (!mobileModal) reposition(inputEl);
		window.addEventListener("resize", onScrollOrResize);
		window.addEventListener("scroll", onScrollOrResize, true);
		void refreshPool();
	}

	function closePicker(): void {
		windowEl.hidden = true;
		windowEl.classList.remove("is-mobile-modal");
		windowEl.setAttribute("aria-modal", "false");
		backdropEl.hidden = true;
		unlockMobileModalHeight();
		window.removeEventListener("resize", onScrollOrResize);
		window.removeEventListener("scroll", onScrollOrResize, true);
	}
	closeButton.addEventListener("click", closePicker);
	bindModalDismissal({
		backdrop: backdropEl,
		isOpen: () => !windowEl.hidden && windowEl.getAttribute("aria-modal") === "true",
		onDismiss: closePicker,
	});
	toggleInput.addEventListener("change", () => {
		learnsetOnly = toggleInput.checked;
		void refreshPool();
	});
	windowEl.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closePicker();
	});
	// リストの外側をクリックしたら閉じる(#tera-dropdown-listと同じ一般的な挙動)。
	// ただし#move-1〜#move-4のいずれかのクリックは「別スロットへの切り替え」を意味するため
	// (各inputのmousedownリスナーが先にactiveSlotを切り替える。バブリング順序により
	// documentのこのリスナーはその後に実行されるため、対象に含めて早期returnする)。
	document.addEventListener("mousedown", (e) => {
		if (windowEl.hidden) return;
		const target = e.target as Node;
		if (windowEl.contains(target)) return;
		if (moveInputEls.some((input) => input.contains(target))) return;
		closePicker();
	});
	// 種族名を編集中にウィンドウが開いていたら、覚え技プールを追随させる。
	speciesInput.addEventListener("input", () => {
		if (!windowEl.hidden) void refreshPool();
	});

	for (const input of moveInputEls) {
		const slot = Number(input.id.replace("move-", ""));
		input.addEventListener("focus", () => openPicker(slot, input));
		input.addEventListener("mousedown", () => openPicker(slot, input));
	}

	// detail.slotが指定されていれば(preview-quick-open.tsがプレビューの技タップから
	// そのスロットを指定する)そのスロットを直接開く。未指定時(.mobile-move-toggle)は
	// 従来どおり最初の空きスロットを開く。
	const openRequestedMovePicker = (event: Event): void => {
		const requestedSlot = (event as CustomEvent<{ slot?: number }>).detail?.slot;
		const targetSlot = requestedSlot && [1, 2, 3, 4].includes(requestedSlot)
			? requestedSlot
			: [1, 2, 3, 4].find((slot) => {
				const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
				return !input?.value.trim();
			}) ?? 1;
		const input = document.getElementById(`move-${targetSlot}`) as HTMLInputElement | null;
		if (input) openPicker(targetSlot, input, true);
	};
	document.addEventListener("move-picker:open", openRequestedMovePicker);
	document.addEventListener("box-settings:open", (event) => {
		const detail = (event as CustomEvent<{ kind?: string; slot?: number }>).detail;
		if (detail?.kind === "move") openRequestedMovePicker(event);
	});

	// 匿名集計サジェスト機能: 種族変更に伴いloadPopularBuildSuggestionsがlastMoveSuggestionを
	// 更新したとき、このウィンドウが開いていれば「人気」列・並び順を最新化する
	// (refreshPool自体は別経路(speciesInputのinputイベント)で覚え技プールの絞り込みを
	// 追随させているが、サジェスト取得は独立した非同期fetchのため別途フックが要る)。
	onMoveSuggestionUpdated = () => {
		if (!windowEl.hidden) renderRows();
	};

	updateSortButtonIndicators();
}
