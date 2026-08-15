// ダメージ計算(#opponent-notes-section)専用のロジック一式。
//
// 右サイド(詳細設定サイドバー)専用のロジックは right-panel.ts に分離している。
// このファイルと right-panel.ts は import/export で相互依存している(deselectRowIfCurrent/
// renderDetailPanelEmpty/renderColumnLevelDetailPanel/openDetailPanelOverlayIfNarrow は
// right-panel.tsからimportし、DAMAGE_WEATHERS等の選択肢配列・clampIntは逆にright-panel.ts
// がこのファイルからimportする)。いずれも関数宣言(hoistされるため循環import下でも安全)、
// または実際に使われるのが両モジュールの評価が完了した後(ユーザー操作時)のみの値なので、
// 初期化順序の問題は無い。
//
// DAMAGE_WEATHERS/DAMAGE_TERRAINS/DAMAGE_AILMENTS/DAMAGE_ATTACKER_VOLATILES/
// DAMAGE_DEFENDER_VOLATILES/clampIntの6つはトップレベル(#opponent-notes-sectionのガードの
// 外)で定義してexportしている。right-panel.tsから参照する必要があり、どちらも
// #opponent-notes-sectionの有無に依存しない純粋なデータ/ユーティリティのため。
import { el } from "../owned-pokemon-form";
import {
	initEngine,
	calcStats,
	calcLethalSequence,
	isEngineReady,
	registerOfflineCache,
	type EngineProgress,
	type PokemonSpec,
	type CalcDamagesOptions,
	type SequenceAttack,
	type LethalResult,
} from "../pyodide-engine";
import type { OpponentNoteRecord } from "../opponent-notes";
import type {
	OpponentBuildInput,
	OpponentFieldInput,
	OpponentAttackInput,
	OpponentClientResultInput,
} from "../opponent-notes-validation";
import {
	loadMultiHitMoveMap,
	loadAbilitiesMap,
	spriteUrl,
} from "../pokemon-master-data";
import { type StatKey, STAT_KEYS, NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from "../stats";
import { TERA_TYPES } from "../tera-types";
// テラス選択ボックスを左パネルと共通化するために使う。shared-core.tsは"../sprite-urls"から
// teraTypeIconUrlをimportしているが再exportしていないため、ここで直接importする。
import { teraTypeIconUrl, typeIconUrl } from "../sprite-urls";
import { initializeCardDeleteMode } from "../card-delete-mode";
// レギュレーションに応じてテラスタル選択ボックスの表示ON/OFFを切り替えるために使う。
// 判定は必ずこの関数を使い、自前ロジックを書かない
// (仕様: 未指定はtrue=表示・M-*はfalse=非表示・T-*はtrue=表示。src/lib/regulations.ts参照)。
import { isTerastalRegulation } from "../regulations";
import {
	attachKanaTypeAhead,
	applySprite,
	applyTeraImage,
	applyItemImage,
	resolveMegaStoneItem,
	flashAutofillHint,
	natureNameFromBoosts,
	normalizedNatureBoosts,
	buildAttackerSpec,
	recalcStats,
	baseStatsMapPromise,
	registerDamageCalcBridge,
	registerBulkAdjustBridge,
	type BulkAdjustRowSnapshot,
	getSelectedRow,
	getSelectedColumn,
	getSelectedIsBuild,
	clearSelection,
	scheduleRowSave,
	scheduleRowCalc,
	refreshRowConditionChips,
	renderDetailPanel,
	selectColumn,
	selectBuild,
	applySelectionMarks,
	applyBuildSelectionMark,
	clearSelectionAndMarks,
	type DamageRowState,
	type DamageColumnState,
} from "./shared-core";
import {
	buildStatAdjustmentPanel,
	type StatAdjustmentPanel,
	type StatAdjustmentPanelOptions,
} from "./stat-adjustment-panel";
import {
	deselectRowIfCurrent,
	renderDetailPanelEmpty,
	renderColumnLevelDetailPanel,
	renderBuildDetailPanel,
	openDetailPanelOverlayIfNarrow as openRightPanelOverlayIfNarrow,
	closeDetailPanelOverlay,
	initRightPanel,
	notifyDetailMoveChanged,
	notifyDetailAbilityChanged,
	syncDetailPanelTotal,
} from "./right-panel";
// ダメージ計算のサジェスト。描画は右パネル側(damage-suggest.ts)に
// あり、このファイルは「いま画面にどんな計算があるか」と「1件を新しいカードにする」の
// 2つだけをブリッジとして提供する(shared-core.tsのregisterDamageCalcBridgeと同じ登録パターン)。
import { initDamageSuggest, registerDamageSuggestBridge, type DamageCalcSuggestion } from "./damage-suggest";
import { damageCalcSuggestionKey } from "../damage-calc-suggest";

// public/master-data/detail/moves.json(src/pages/moves/[name].astroが表示に使っている
// のと同じ静的データ)を技名でMap化するローダー。下のgetMoveCategory()
// (壁・ランク補正の自動判定に技の物理/特殊/変化区分を使う)が参照しているため、
// ローダー自体とMoveDetailEntry型を保持している。
interface MoveDetailEntry {
	name: string;
	type: string | null;
	category: "physical" | "special" | "status";
	power: number | null;
	accuracy: number | null;
	pp: number;
}
let moveDetailMapPromise: Promise<Map<string, MoveDetailEntry>> | null = null;
function loadMoveDetailMap(): Promise<Map<string, MoveDetailEntry>> {
	if (!moveDetailMapPromise) {
		moveDetailMapPromise = fetch("/master-data/detail/moves.json")
			.then((res) => res.json())
			.then((raw: Record<string, MoveDetailEntry>) => new Map(Object.values(raw).map((m) => [m.name, m])))
			.catch((err) => {
				console.warn("技データの読み込みに失敗しました", err);
				moveDetailMapPromise = null;
				return new Map<string, MoveDetailEntry>();
			});
	}
	return moveDetailMapPromise;
}
void loadMoveDetailMap(); // 表示直後に一度だけfetchしておく(imageIdMapPromise等と同じ方針)

// 技名から物理/特殊/変化を同期的に引けるキャッシュ。moveDetailMapPromiseは非同期のため、
// 入力のたびに壁・ランクの派生値(resolveColumnDerivedFields)を即座に再計算したい
// UI操作からは同期関数として使いたい。ローカルの静的JSONなので、ページ表示直後の
// void loadMoveDetailMap()呼び出しからほぼ即座に解決し、実運用上ユーザーが
// ダメージ計算カードを操作する時点には解決済みになっている。
let moveDetailMapCache: Map<string, MoveDetailEntry> | null = null;
loadMoveDetailMap().then((m) => {
	moveDetailMapCache = m;
});
function getMoveCategory(name: string): MoveDetailEntry["category"] | null {
	const trimmed = name.trim();
	if (!trimmed || !moveDetailMapCache) return null;
	return moveDetailMapCache.get(trimmed)?.category ?? null;
}

// calc_lethal経路(pyodide-engine.ts)はカウンター・ちきゅうなげ・OHKO技等の固定/割合
// ダメージ技も正しく計算する(vendor/jpoke/src/jpoke/core/lethal.py・handlers/lethal.pyに
// 専用ハンドラがある。.claude/skills/jpoke/references/damage-calc.md参照)。
// 唯一「はきだす」だけは、威力が「ためこむ」の回数で決まりその回数決定が
// Event.ON_TRY_MOVE_1(実戦の技実行フロー)でのみ行われるため、そのフローを通らない
// calc_lethalでは対象外(handlers/lethal.pyのはきだす_reset_stockpileは使用後のランク
// 巻き戻しのみを担当し、ダメージ自体を設定するハンドラが無い)。
function isUnsupportedLethalMove(name: string): boolean {
	return name.trim() === "はきだす";
}
const UNSUPPORTED_LETHAL_NOTE =
	"この技は威力が「ためこむ」を使った回数によって変わる特殊な計算式のため、ダメージを算出できません。";

// 変化技(まもる等)は実際のダメージが0だが、「10発以上 0(0%)」という表示は
// 「あと少しで倒せる」ように誤読されうるため、isUnsupportedLethalMoveと同じ仕組み
// (理由を示して数値を出さない)に合流させる。
// 変化技(category === "status")はゲーム仕様として直接ダメージを一切発生させない
// (物理/特殊技との違いはこの1点)ため、getMoveCategory()の結果だけで判定できる。
// ⚠️ moveDetailMapCacheがまだ解決していない初期の一瞬はgetMoveCategoryがnullを返し
// falseになる(=通常のダメージ計算経路を通る)が、キャッシュ解決後の再描画で
// isStatusMove側に切り替わる(loadMoveDetailMap()は表示直後に一度だけfetchする
// 既存方針のとおり、実運用上ほぼ即座に解決する)。
function isStatusMove(name: string): boolean {
	return getMoveCategory(name) === "status";
}
const STATUS_MOVE_NOTE = "変化技のため、ダメージは発生しません。";

// OHKO技(一撃必殺技)4件は、jpokeのcalc_lethalが命中率を一切考慮しない設計
// (対象の残りHPそのものを固定ダメージとして与える。命中すれば必ず倒す前提で計算する)
// ため、「確定1発」という表示だけでは実際の命中率30%が伝わらない。この性質自体は
// 全ての技に共通するlethal計算の仕様だが、多くの技は命中率85〜100%で表示との
// ギャップが小さいのに対し、OHKO技は30%と際立って低いためここだけ補足を添える。
const OHKO_MOVE_NAMES = new Set(["じわれ", "ハサミギロチン", "ぜったいれいど", "つのドリル"]);
const OHKO_NOTE = "一撃必殺技のため、命中すれば相手の残りHPに関わらず倒します(命中率30%。この計算は命中を前提にしています)。";
function ohkoNoteSuffixFor(name: string): string {
	return OHKO_MOVE_NAMES.has(name.trim()) ? ` ${OHKO_NOTE}` : "";
}
const UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME =
	"技列に「はきだす」を含むため、算出できる技だけを合算した参考値です(はきだすは0ダメージとして計算されています)。";
const UNSUPPORTED_LETHAL_TOTAL_NOTE_ALL =
	"技列がすべて「はきだす」のため、合計のダメージを算出できません。";
// 変化技は0ダメージが「近似値」ではなく仕様として確定した値なので(はきだすのような
// 「未知の値を0扱いしている」ケースとは異なる)、一部だけ変化技を含む場合の断り書きは
// 不要(他の技の実ダメージがそのまま正しく合算される)。「全技列が変化技(または
// 変化技+はきだすの組み合わせ)」のときだけ理由を示す。
const STATUS_MOVE_TOTAL_NOTE_ALL = "技列がすべて変化技のため、合計のダメージを算出できません。";
const STATUS_AND_UNSUPPORTED_TOTAL_NOTE_ALL =
	"技列がすべて変化技または「はきだす」のため、合計のダメージを算出できません。";

// 構造分割ラウンド(フェーズ2)でこのファイル先頭へ引き上げた6つ(right-panel.tsへexportするため。
// 上のファイル冒頭コメント参照)。
export const DAMAGE_WEATHERS = [
	{ value: "はれ", label: "はれ", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/><line x1="4" y1="4" x2="5.8" y2="5.8"/><line x1="18.2" y1="18.2" x2="20" y2="20"/><line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/><line x1="4" y1="20" x2="5.8" y2="18.2"/><line x1="18.2" y1="5.8" x2="20" y2="4"/></svg>` },
	{ value: "あめ", label: "あめ", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 18 0Z"/><path d="M12 12v6.5a2.5 2.5 0 0 0 5 0"/><path d="M12 3V1.5"/></svg>` },
	{ value: "すなあらし", label: "すなあらし", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 5c4 1.6 9 1.6 13 .3s4.5-1 4 .5"/><path d="M6 9.5c3 1.2 6.5 1.2 9.5 0s3.5-.9 3.7.2"/><path d="M8.5 14c2 1 4.2 1 6 0s2.6-.8 2.7.2"/><path d="M10.5 18.3c1.2.6 2.4.6 3.4 0"/><path d="M12 21.5v.8"/></svg>` },
	{ value: "ゆき", label: "ゆき", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="22"/><line x1="4" y1="7" x2="20" y2="17"/><line x1="4" y1="17" x2="20" y2="7"/></svg>` },
];
export const DAMAGE_TERRAINS = [
	{ value: "エレキフィールド", label: "エレキ", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>` },
	{ value: "グラスフィールド", label: "グラス", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 4 13c0-6 7-11 7-11s7 5 7 11a7 7 0 0 1-7 7z"/><line x1="11" y1="20" x2="11" y2="11"/></svg>` },
	{ value: "サイコフィールド", label: "サイコ", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>` },
	{ value: "ミストフィールド", label: "ミスト", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g fill="currentColor" stroke="none"><circle cx="5" cy="7" r="1.45"/><circle cx="11" cy="5.3" r="1.25"/><circle cx="17.5" cy="7.5" r="1.45"/><circle cx="4" cy="13" r="1.25"/><circle cx="10.5" cy="12" r="1.55"/><circle cx="17" cy="12.8" r="1.25"/><circle cx="7" cy="18.3" r="1.35"/><circle cx="13.5" cy="18.7" r="1.35"/><circle cx="19.5" cy="17.5" r="1.15"/></g></svg>` },
];
export const DAMAGE_AILMENTS = [
	{ value: "", label: "なし" },
	{ value: "どく", label: "どく" },
	{ value: "もうどく", label: "もうどく" },
	{ value: "まひ", label: "まひ" },
	{ value: "やけど", label: "やけど" },
	{ value: "ねむり", label: "ねむり" },
	{ value: "こおり", label: "こおり" },
];
// 各項目のtitleはvendor/jpoke実装(src/jpoke/data/volatile.py・src/jpoke/handlers/volatile.py)
// を確認して書いた説明文。数値(割合・倍率)を変更する場合は必ずjpoke skill(.claude/skills/jpoke)
// 経由で実装を確認し直すこと(ダメージ計算に影響する数値のため誤記厳禁)。
export const DAMAGE_ATTACKER_VOLATILES = [
	{ value: "じゅうでん", label: "じゅうでん", title: "次に出すでんきタイプの技の威力が2倍になる(技を1回使うと解除される)" },
];
export const DAMAGE_DEFENDER_VOLATILES = [
	{ value: "のろい", label: "のろい", title: "毎ターン最大HPの1/4のダメージを受ける" },
	{ value: "やどりぎのタネ", label: "やどりぎのタネ", title: "毎ターン最大HPの1/8のダメージを受け、そのぶん相手のHPが回復する" },
	{ value: "しおづけ", label: "しおづけ", title: "毎ターン最大HPの1/16(みず・はがねタイプは1/8)のダメージを受ける" },
	{ value: "バインド", label: "バインド", title: "毎ターン最大HPの1/8のダメージを受ける" },
	{ value: "アクアリング", label: "アクアリング", title: "毎ターン最大HPの1/16のHPが回復する" },
	{ value: "ねをはる", label: "ねをはる", title: "毎ターン最大HPの1/16のHPが回復する" },
	{ value: "ちいさくなる", label: "ちいさくなる", title: "ふみつけ等の一部の技が必ず命中し、威力が2倍になる" },
];
export function clampInt(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(n)));
}

// 相手ビルドの情報を種族ごとにローカルに記録しておき、次に同じ種族をビルドする際に
// デフォルト値として設定する。DBの opponent_notes.opponent_build はカード単位の保存のみで、
// 同じ種族を別カードで再入力するたびに性格・特性・持ち物・テラス・努力値を打ち直す必要が
// あったため、ブラウザの localStorage に「種族名→最後に使ったビルド」を記録する
// (DBへの新規カラム追加はしない)。他機能と衝突しない名前空間にする。
const OPPONENT_BUILD_PRESET_KEY_PREFIX = "poke-commons:opponent-build-preset:";

interface OpponentBuildPreset {
	nature: string;
	natureUp: StatKey | null;
	natureDown: StatKey | null;
	abilityName: string;
	itemName: string;
	teraType: string;
	evs: number[];
}

function opponentBuildPresetKey(speciesName: string): string {
	return `${OPPONENT_BUILD_PRESET_KEY_PREFIX}${speciesName}`;
}

// localStorageが使用不可(プライベートブラウジング等で例外を投げる環境)でもページ全体が
// 壊れないよう、読み書きは必ずtry/catchで包む。失敗時はこの機能が使えないだけにする。
function saveOpponentBuildPreset(speciesName: string, preset: OpponentBuildPreset): void {
	try {
		window.localStorage.setItem(opponentBuildPresetKey(speciesName), JSON.stringify(preset));
	} catch {
		// 使用不可環境では何もしない(他の動作に影響させない)。
	}
}

function loadOpponentBuildPreset(speciesName: string): OpponentBuildPreset | null {
	try {
		const raw = window.localStorage.getItem(opponentBuildPresetKey(speciesName));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<OpponentBuildPreset> | null;
		if (!parsed || !Array.isArray(parsed.evs) || parsed.evs.length !== STAT_KEYS.length) return null;
		return {
			nature: typeof parsed.nature === "string" ? parsed.nature : "まじめ",
			natureUp: STAT_KEYS.includes(parsed.natureUp as StatKey) ? (parsed.natureUp as StatKey) : null,
			natureDown: STAT_KEYS.includes(parsed.natureDown as StatKey) ? (parsed.natureDown as StatKey) : null,
			abilityName: typeof parsed.abilityName === "string" ? parsed.abilityName : "",
			itemName: typeof parsed.itemName === "string" ? parsed.itemName : "",
			teraType: typeof parsed.teraType === "string" ? parsed.teraType : "",
			evs: parsed.evs.map((v) => (typeof v === "number" && Number.isFinite(v) ? clampInt(v, 0, 32) : 0)),
		};
	} catch {
		return null;
	}
}

// 「相手ビルド5項目がすべて未設定」の判定(A-4の適用条件)。DBから読み込んだ既存カードは
// 通常これらのどれかが埋まっているため、この判定を通らずプリセット適用の対象外になる
// (=既存の値を勝手に上書きしない)。
function isOpponentBuildUnset(row: DamageRowState): boolean {
	return (
		row.natureUp === null &&
		row.natureDown === null &&
		row.abilityName.trim() === "" &&
		row.itemName.trim() === "" &&
		row.teraType.trim() === "" &&
		row.evs.every((v) => v === 0)
	);
}

// box/[id].astro(SSR)がDamageCalcSection.astro経由で埋め込んだJSON
// (<script type="application/json" id="damage-calc-move-adoption-data">)を読むヘルパー。
// src/lib/speed-chart/chart-table.tsのreadEmbeddedJson(小さな汎用ヘルパー)と同じロジックだが、
// importできないファイルのため自前実装している。
function readEmbeddedJson<T>(elementId: string): T | null {
	const el = document.getElementById(elementId);
	if (!el || !el.textContent) return null;
	try {
		return JSON.parse(el.textContent) as T;
	} catch {
		return null;
	}
}
// モジュール冒頭付近で1回だけ読み込みキャッシュする(埋め込みJSONはページ読み込み時に
// 確定しており、実行中に変わらない)。形は { [種族名]: { [レギュレーションキー
// (全レギュレーション横断は"all")]: { [技名]: ratio } } }。
const moveAdoptionBySpecies =
	readEmbeddedJson<Record<string, Record<string, Record<string, number>>>>("damage-calc-move-adoption-data") ?? {};

const opponentNotesSection = document.getElementById("opponent-notes-section");
if (opponentNotesSection) {
	const ownedPokemonId = opponentNotesSection.dataset.ownedPokemonId ?? "";
	const selfSpeciesName = document.querySelector<HTMLElement>(".pokemon-preview")?.dataset.speciesName?.trim() ?? "";
	const rowBuildDetailForms = new WeakMap<DamageRowState, HTMLElement>();
	const rowStatAdjustmentPanels = new WeakMap<DamageRowState, {
		panel: StatAdjustmentPanel;
		options: StatAdjustmentPanelOptions;
	}>();
	const rowReadonlyNatureLabelEls = new WeakMap<DamageRowState, Partial<Record<string, HTMLElement>>>();

	// #regulation(LeftPanel.astro/left-panel.ts)はこのファイルからは値を読むだけに留め、
	// left-panel.ts側の既存changeリスナー(syncTeraFieldVisibility/syncRegulationPlaceholder等)は
	// 変更しない。同じ要素へ別のリスナーを追加するだけ(DOM標準のイベント購読は同一要素に
	// 何個でも独立して登録できる)で追随できる。
	const regulationSelectEl = document.getElementById("regulation") as HTMLSelectElement | null;
	function currentIndividualRegulation(): string | null {
		if (!regulationSelectEl) return null;
		const value = regulationSelectEl.value.trim();
		return value === "" ? null : value;
	}
	// 行(相手)ごとに1個生成されるテラスタイプ選択ボックス(buildTeraDropdown()のwrap、
	// 下方参照)への参照。DamageRowState自体にフィールドを追加せず、WeakMapで対応付ける。
	const rowTeraFieldWraps = new WeakMap<DamageRowState, HTMLElement>();
	function syncTeraFieldVisibility(): void {
		const show = isTerastalRegulation(currentIndividualRegulation());
		for (const row of rows) {
			const wrap = rowTeraFieldWraps.get(row);
			if (wrap) wrap.hidden = !show;
		}
	}
	regulationSelectEl?.addEventListener("change", syncTeraFieldVisibility);

	// shared-core.tsのscheduleRowSave/scheduleRowCalc/refreshRowConditionChips/renderDetailPanel/
	// selectColumnは、このブロック内で下に定義するsetRowSaveStatus/saveRow/recalcRow/
	// renderConditionChipsInto/renderDetailPanelEmpty/renderColumnLevelDetailPanel/
	// openDetailPanelOverlayIfNarrowを呼ぶ。関数宣言はこのブロック内でホイストされるため、
	// 実際に定義される行より前のこの位置で登録しても問題ない(呼び出しは実際にユーザー操作等が
	// 起きた後になる)。
	registerDamageCalcBridge({
		recalcRow: (row) => recalcRow(row),
		saveRow: (row) => saveRow(row),
		setRowSaveStatus: (row, state, text) => setRowSaveStatus(row, state, text),
		renderConditionChipsInto: (container, attack) => renderConditionChipsInto(container, attack),
		configureColumnMoveInput: (input, row, column) => configureColumnMoveInput(input, row, column),
		getColumnMoveCandidates: (row, column) => getColumnMoveCandidates(row, column),
		getColumnMultiHitRange: (moveName) => getColumnMultiHitRange(moveName),
		refreshColumnDisplay: (row, column) => refreshColumnDisplay(row, column),
		renderDetailPanelEmpty: () => {
			renderDetailPanelEmpty();
			closeDetailPanelOverlay();
			refreshMobileDetailPlacement();
		},
		renderColumnLevelDetailPanel: (row, column) => {
			renderColumnLevelDetailPanel(row, column);
			refreshMobileDetailPlacement();
		},
		renderBuildDetailPanel: (row) => {
			renderBuildDetailPanel(row);
			refreshMobileDetailPlacement();
		},
		getBuildDetailForm: (row) => rowBuildDetailForms.get(row) ?? null,
		openDetailPanelOverlayIfNarrow: () => {
			if (isNarrowLayout()) {
				refreshMobileDetailPlacement();
			}
			openRightPanelOverlayIfNarrow();
		},
	});
	// 右サイド(詳細設定サイドバー)専用のDOM参照・イベント登録・初期空状態描画は
	// right-panel.ts へ分離している。right-panel.ts側は#damage-detail-panel等が必ず存在する
	// (=opponentNotesSectionが存在する)ことを保証できないため、initRightPanel()という
	// 明示的な初期化関数に包み、ここ(#opponent-notes-sectionが存在すると判明した直後)から
	// 1回だけ呼ぶ。
	initRightPanel();

	// ダメージ計算カードは行(相手)ごとに独立して自動保存されるため、カード自身のfooter
	// (失敗時のみ表示)は画面外にスクロールすると見えなくなる。AppLayoutのトップバー
	// (position:sticky)は常時可視なので、失敗している行数だけをここに出す
	// (setRowSaveStatus/deleteRowの呼び出し箇所からupdateOpponentNotesFailureAlert()を呼ぶ。
	// rowsは下方で `let rows: DamageRowState[] = []` として宣言される変数を参照するが、
	// この関数は実際に保存イベントが起きた時点で初めて呼ばれるため、スクリプト初期化順の
	// 問題は無い)。
	const opponentNotesSaveAlertEl = document.getElementById("opponent-notes-save-alert");
	function updateOpponentNotesFailureAlert(): void {
		if (!opponentNotesSaveAlertEl) return;
		const failedCount = rows.filter((r) => r.saveStatusEl?.dataset.state === "error").length;
		if (failedCount > 0) {
			opponentNotesSaveAlertEl.textContent = `⚠ ${failedCount}件保存に失敗`;
			opponentNotesSaveAlertEl.hidden = false;
		} else {
			opponentNotesSaveAlertEl.textContent = "";
			opponentNotesSaveAlertEl.hidden = true;
		}
	}

	// 相手ビルドselect用のTERA_TYPESはこの<script>タグ冒頭でsrc/lib/tera-types.tsからimportした
	// ものをそのまま使う。性格の<select>(NATURES一覧)は廃止しており、努力値/実数値グリッドの
	// H/A/B/C/D/S見出しクリックで性格を決める(左パネルと同じnatureNameFromBoosts/
	// NATURE_STAT_MODIFIERSを使う)。
	// 天候/地形の選択肢はsrc/pages/damage-calc/index.astro の WEATHERS/TERRAINSと同じ選択肢で
	// 同期させること(jpoke側の定義が正)。ただし、個体編集の詳細設定パネルのみ強天候3種
	// (おおひでり/おおあめ/らんきりゅう)を選択肢から除外している(damage-calc側は対象外)。
	// 天候・フィールドはセレクトではなくアイコン選択式で、AppSidebar.astroのlucide風インラインSVG
	// (24x24 viewBox)と同じ流儀で簡易アイコンを用意している。
	// 「なし」の選択肢は配列に含めない。「なし」相当はbuildIconToggleGroup()側のトグルオフ
	// (選択中のボタンの再クリックでvalue: ""に戻す、下記参照)で表現する。

	// 壁は種類を持たずon/offの1トグルで、実際にどちらを立てるかはresolveColumnDerivedFields()が
	// 技の物理/特殊分類から自動判定する。状態異常の選択肢はjpokeのAilmentNameと一致させる
	// (空は「状態異常なし」)。ゆめうつつは選択肢から除外している(6種+なし)。

	const STAT_KANJI: Record<string, string> = { hp: "H", atk: "A", def: "B", spa: "C", spd: "D", spe: "S" };
	// 連続技(1ターンに複数回ヒットする技)の技名 -> [最小ヒット数, 最大ヒット数]。
	// 要件「連続回数の指定は連続技のときだけ表示する」の判定に使う。
	// loadMultiHitMoveMap()自身がモジュールスコープでPromiseをキャッシュし、失敗時は
	// 空Mapを返す(=ヒット数入力が出ないだけで他の計算は続行できる)ので、
	// 技カードごとに何度呼んでも fetch は1回で済む。
	const multiHitMapPromise = loadMultiHitMoveMap;
	// ダメージ量(打点)と確N判定は参照している値の性質が違う。
	// 打点(perAttackDamages / cumulativeDamage)はjpokeのdamage_distから求めた
	// 「与えたダメージの合計」で、たべのこしの回復やどく・やけどの継続ダメージを含まない。
	// 一方、判定(lethal / perAttackLethal)はhp_dist由来なのでそれらも反映している。
	// そのため「打点はHPを超えているのに確定的な致死判定にならない」という表示が
	// 正しく成立しうるので、数字だけを見て矛盾と誤読されないようツールチップで補足する
	// (pyodide-engine.tsのCalcLethalSequenceResult.cumulativeDamageのコメント参照)。
	const TOTAL_RESULT_HINT =
		"ダメージ量は与えた打点の合計です(たべのこし等の回復やどく・やけどの継続ダメージは含みません)。" +
		"確Nの判定はそれらも反映した実際の致死率なので、打点がHPを超えていても確定的な致死判定にならないことがあります。";
	// 技列(加算条件)は最大3つまでしか追加できない(カードの高さを技列3つぶんでちょうど
	// 収まるようにするため)。この上限は「追加」操作にのみ効く上限であり、既存データを
	// 削らない: 過去に保存されたメモが4件以上のattacksを持っていても(サーバ側
	// opponent-notes-validation.ts のMAX_ATTACK_COUNT=6までは元々許容されている)、
	// renderColumnsはrow.attacksを全件そのまま描画する(=表示はする)。「＋」ボタンを
	// row.attacks.length>=3で無効化するだけなので、4件以上の既存行はカードが少し縦に
	// 伸びるが、データが消えたり保存が壊れたりすることはない。
	const MAX_COLUMNS_TO_ADD = 3;
	// 899px以下では技列セクションを固定2列(grid-template-columns: 1fr 1fr、
	// DamageCalcSection.astro参照)にして技カードがカード幅の半分ずつを占めるため、
	// 3枚目は必ず2行目へ折り返してカードの高さが跳ねる。追加操作の上限だけをモバイルで
	// 2に下げる(上と同じく既存データは削らない)。
	const MAX_COLUMNS_TO_ADD_NARROW = 2;
	// isNarrowLayout()はこのブロック内の関数宣言(下方)なのでホイストされ、実際に
	// 呼ばれるのは行の描画・ユーザー操作の時点=定義行より後になるため前方参照で問題ない
	// (既存のregisterDamageCalcBridge等と同じ考え方)。
	function currentMaxColumnsToAdd(): number {
		return isNarrowLayout() ? MAX_COLUMNS_TO_ADD_NARROW : MAX_COLUMNS_TO_ADD;
	}

	// 1列 = 技カード1枚。天候・地形・壁・急所・ランク補正・状態異常・テラスタル発動は
	// すべてこのDamageColumnState(技カードごと)に持たせる。エンジン側は攻撃1件ごとに
	// 独立したBattleを構築するため、これらは技カード間で完全に独立して効く
	// (pyodide-engine.ts の calc_lethal_sequence_json 参照)。
	// 天候・フィールド・壁を含む全項目は、技列をクリックしたときのサイドバー
	// (renderColumnLevelDetailPanel)からその技カード1枚だけを書き換える、単純な1階層の設計。
	// 行レベルにしか保存されていなかった古いメモは、noteToRowStateの互換ロジックがその値を
	// 各技カードの初期値として引き継ぐ。
	// attacker/defender は「攻撃側/防御側という役割」を指し、row.direction によって
	// どちらが所持ポケモンかが入れ替わる(attacker=常に所持ポケモン、ではない)。

	// 技カード1枚分の初期状態。詳細設定の既定値は「何も起きていない状態」。
	// legacyには、カード共通の詳細設定を持つ形式の既存メモから引き継ぐ値を渡す。
	function createEmptyColumn(legacy?: Partial<DamageColumnState>): DamageColumnState {
		return {
			moveName: "",
			hitCount: 1,
			critical: false,
			weather: "",
			terrain: "",
			wallEnabled: false,
			stealthRock: false,
			spikes: 0,
			defenderSideFields: [],
			attackerRank: 0,
			defenderRank: 0,
			attackerBoosts: STAT_KEYS.map(() => 0),
			attackerAilment: "",
			attackerTerastallized: false,
			attackerVolatiles: [],
			defenderBoosts: STAT_KEYS.map(() => 0),
			defenderAilment: "",
			defenderTerastallized: false,
			defenderVolatiles: [],
			...legacy,
		};
	}

	// 「技を追加」で2個目以降の技カラムを増やすとき、直前のカラムの「詳細設定」
	// (天候・フィールド・壁・急所・ランク補正・状態異常・じゅうでん等のvolatile・
	// テラスタル発動)を引き継ぐ。技名・ヒット回数は技固有の値のため引き継がない
	// (moveName/hitCountをこの戻り値に含めない)。createEmptyColumn()の`legacy`引数
	// (上のコメント参照)をそのまま再利用し、この関数が作るPartial<DamageColumnState>を
	// 渡す形にする(createEmptyColumnの引数自体は増やさない)。
	function inheritedColumnDetailDefaults(previous: DamageColumnState): Partial<DamageColumnState> {
		return {
			critical: previous.critical,
			weather: previous.weather,
			terrain: previous.terrain,
			wallEnabled: previous.wallEnabled,
			stealthRock: previous.stealthRock,
			spikes: clampInt(previous.spikes, 0, 3),
			defenderSideFields: [...previous.defenderSideFields],
			attackerRank: previous.attackerRank,
			defenderRank: previous.defenderRank,
			attackerBoosts: [...previous.attackerBoosts],
			attackerAilment: previous.attackerAilment,
			attackerTerastallized: previous.attackerTerastallized,
			attackerVolatiles: [...previous.attackerVolatiles],
			defenderBoosts: [...previous.defenderBoosts],
			defenderAilment: previous.defenderAilment,
			defenderTerastallized: previous.defenderTerastallized,
			defenderVolatiles: [...previous.defenderVolatiles],
		};
	}

	function resolveColumnDerivedFields(column: DamageColumnState): void {
		const category = getMoveCategory(column.moveName);
		const atkBoosts = STAT_KEYS.map(() => 0);
		const defBoosts = STAT_KEYS.map(() => 0);
		if (category === "physical") {
			atkBoosts[STAT_KEYS.indexOf("atk")] = column.attackerRank;
			defBoosts[STAT_KEYS.indexOf("def")] = column.defenderRank;
		} else if (category === "special") {
			atkBoosts[STAT_KEYS.indexOf("spa")] = column.attackerRank;
			defBoosts[STAT_KEYS.indexOf("spd")] = column.defenderRank;
		}
		column.attackerBoosts = atkBoosts;
		column.defenderBoosts = defBoosts;
		if (!column.wallEnabled || category == null) {
			column.defenderSideFields = [];
		} else {
			column.defenderSideFields = category === "physical" ? ["リフレクター"] : ["ひかりのかべ"];
		}
	}

	// 後方互換: 既存メモに保存されていた能力ごとのランク配列(attackerBoosts/
	// defenderBoosts)から、UI上のスカラー値(attackerRank/defenderRank)を復元する。
	// 「どれか1つでも立っていればON」の考え方と同様に、攻撃側はatk→spaの順、
	// 防御側はdef→spdの順で最初に非ゼロの値を採用する(両方非ゼロという通常は
	// 起こらない組み合わせのときはatk/defを優先する、という決め打ちの解釈)。
	function rankFromLegacyBoosts(boosts: number[] | undefined, primaryKey: StatKey, secondaryKey: StatKey): number {
		if (!Array.isArray(boosts)) return 0;
		const primary = boosts[STAT_KEYS.indexOf(primaryKey)] ?? 0;
		if (primary !== 0) return primary;
		return boosts[STAT_KEYS.indexOf(secondaryKey)] ?? 0;
	}
	// 後方互換: 個別の壁(リフレクター/ひかりのかべ/オーロラベール)のうち
	// 「どれか1つでも立っていればON」と解釈する。

	// 1行 = 相手1体分の状態。opponent_notesの1レコードに対応する
	// (id: null は「まだPOSTしていない=ローカルのみの新規行」を表す)。

	function createEmptyRow(): DamageRowState {
		return {
			id: null,
			direction: "attack",
			name: "",
			nature: "まじめ",
			natureUp: null,
			natureDown: null,
			abilityName: "",
			itemName: "",
			teraType: "",
			evs: STAT_KEYS.map(() => 0),
			seedRaw: "",
			attacks: [createEmptyColumn()],
			memo: "",
			clientResult: null,
			root: null,
			columnsEl: null,
			addColumnSlotEl: null,
			columnResultEls: [],
			columnChipEls: [],
			totalResultEl: null,
			totalBlockEl: null,
			saveStatusEl: null,
			retryButtonEl: null,
			footerEl: null,
			statValueEls: {},
			natureColLabelEls: {},
			saveTimer: null,
			calcTimer: null,
			saving: false,
			pendingSave: false,
		};
	}

	// 保存済みopponent_notesレコード -> 行の状態への変換。
	// 既存データ(attacksを持たずmove_nameだけの旧メモ)は1列に変換する
	// (既存メモを壊さない)。
	// DAMAGE_WEATHERS/DAMAGE_AILMENTSの選択肢配列に無い値(おおひでり/ゆめうつつ等)が
	// 既に保存済みの個体データに残っている場合がある。アイコン群は選択肢配列にない値を
	// 「どれも選択されていない」ようにしか描画できないため、描画前にこの関数で選択肢配列に
	// 存在しない値を空文字へ正規化する(正規化した行はfetchAndRenderRows側でscheduleRowSave()を
	// 呼び、正規化後の値で保存し直す。アイコンは全部非選択なのにエンジン計算だけ古い値を使う、
	// という不整合を防ぐ)。
	function sanitizeColumnChoices(column: DamageColumnState): boolean {
		let changed = false;
		if (column.weather !== "" && !DAMAGE_WEATHERS.some((w) => w.value === column.weather)) {
			column.weather = "";
			changed = true;
		}
		if (column.attackerAilment !== "" && !DAMAGE_AILMENTS.some((a) => a.value === column.attackerAilment)) {
			column.attackerAilment = "";
			changed = true;
		}
		if (column.defenderAilment !== "" && !DAMAGE_AILMENTS.some((a) => a.value === column.defenderAilment)) {
			column.defenderAilment = "";
			changed = true;
		}
		// 揮発状態も選択肢配列(DAMAGE_ATTACKER_VOLATILES/DAMAGE_DEFENDER_VOLATILES)に
		// 無い値は同じ理屈で正規化する。
		const sanitizedAttackerVolatiles = column.attackerVolatiles.filter((v) =>
			DAMAGE_ATTACKER_VOLATILES.some((opt) => opt.value === v),
		);
		if (sanitizedAttackerVolatiles.length !== column.attackerVolatiles.length) {
			column.attackerVolatiles = sanitizedAttackerVolatiles;
			changed = true;
		}
		const sanitizedDefenderVolatiles = column.defenderVolatiles.filter((v) =>
			DAMAGE_DEFENDER_VOLATILES.some((opt) => opt.value === v),
		);
		if (sanitizedDefenderVolatiles.length !== column.defenderVolatiles.length) {
			column.defenderVolatiles = sanitizedDefenderVolatiles;
			changed = true;
		}
		return changed;
	}

	// 戻り値のneedsResaveは、上のsanitizeColumnChoices()が1つでも値を書き換えたことを表す
	// (=保存済みデータに廃止済みの選択肢が残っていた)。呼び出し側(fetchAndRenderRows)は
	// これがtrueの行だけscheduleRowSave()して正規化後の値をサーバへ書き戻す。
	// opponent_notesには並び順カラムが無いため、field(jsonb)にorder?: number(分数キー方式)を
	// 持たせている(src/lib/opponent-notes-validation.tsのOpponentFieldInput参照)。戻り値に
	// orderを足し、呼び出し元(fetchAndRenderRows)がrowSortOrderへ登録する形にする。
	function noteToRowState(note: OpponentNoteRecord): { row: DamageRowState; needsResave: boolean; order?: number } {
		const row = createEmptyRow();
		let needsResave = false;
		row.id = note.id;
		const build = (note.opponent_build ?? {}) as unknown as OpponentBuildInput;
		const field = (note.field ?? {}) as unknown as OpponentFieldInput;
		// direction未指定の既存メモは、従来の解釈どおり「この所持ポケモンが攻撃側」とみなす。
		row.direction = field.direction === "defense" ? "defense" : "attack";
		row.name = build.name ?? "";
		// 保存済みの性格名からnatureUp/natureDownを正引きして復元する
		// (いじっぱり→atk上昇/spa下降、等)。
		{
			const mod = NATURE_STAT_MODIFIERS[build.nature ?? ""] ?? { up: null, down: null };
			row.natureUp = mod.up;
			row.natureDown = mod.down;
			row.nature = natureNameFromBoosts(mod.up, mod.down);
		}
		row.abilityName = build.abilityName ?? "";
		row.itemName = build.itemName ?? "";
		row.teraType = (build.teraType as string) ?? "";
		row.evs = STAT_KEYS.map((_, i) => build.evs?.[i] ?? 0);
		row.seedRaw = field.seed != null ? String(field.seed) : "";

		// 後方互換: 詳細設定がカード共通(field直下)に保存されている形式のメモは、
		// その値を全ての技カードの初期値として引き継ぐ(既存メモを壊さない)。引き継いだ後は
		// 技カードごとに保存されるため、field直下のこれらのキーは書き戻さない。
		const legacyConditions: Partial<DamageColumnState> = {
			critical: field.critical ?? false,
			weather: field.weather ?? "",
			terrain: field.terrain ?? "",
			defenderSideFields: field.defenderSideFields ?? [],
			attackerBoosts: field.attackerBoosts ?? STAT_KEYS.map(() => 0),
			attackerAilment: field.attackerAilment ?? "",
			attackerTerastallized: field.attackerTerastallized ?? false,
			defenderBoosts: field.defenderBoosts ?? STAT_KEYS.map(() => 0),
			defenderAilment: field.defenderAilment ?? "",
			defenderTerastallized: field.defenderTerastallized ?? false,
		};
		// 後方互換: 壁は「個別の3フラグのどれか1つでも
		// 立っていればON」、ランクは「該当する2能力(atk/spa、def/spd)のうち
		// 最初に非ゼロの値」をスカラーとして復元する(rankFromLegacyBoosts参照)。
		// 実際にAPI保存・エンジン呼び出しに使う配列は、この復元したスカラー値から
		// resolveColumnDerivedFields()が技名の物理/特殊分類に応じて都度算出し直す
		// (recalcRow/saveRowが呼び出し直前に実行する)ため、ここではスカラー値の
		// 復元だけを行えばよい。
		function deriveScalarsFromArrays(column: DamageColumnState): void {
			column.wallEnabled = column.defenderSideFields.length > 0;
			column.attackerRank = rankFromLegacyBoosts(column.attackerBoosts, "atk", "spa");
			column.defenderRank = rankFromLegacyBoosts(column.defenderBoosts, "def", "spd");
		}

		// 技カードごとの値(新形式)が入っていればそちらを優先し、無い項目だけ旧値で埋める。
		const columnFromAttack = (attack: OpponentAttackInput): DamageColumnState => {
			const column = createEmptyColumn(legacyConditions);
			column.moveName = attack.moveName;
			column.hitCount = attack.hitCount ?? 1;
			if (attack.critical !== undefined) column.critical = attack.critical;
			if (attack.weather !== undefined) column.weather = attack.weather;
			if (attack.terrain !== undefined) column.terrain = attack.terrain;
			if (attack.stealthRock !== undefined) column.stealthRock = attack.stealthRock;
			if (attack.spikes !== undefined) column.spikes = clampInt(attack.spikes, 0, 3);
			if (attack.defenderSideFields !== undefined) column.defenderSideFields = attack.defenderSideFields;
			if (attack.attackerBoosts !== undefined) column.attackerBoosts = attack.attackerBoosts;
			if (attack.attackerAilment !== undefined) column.attackerAilment = attack.attackerAilment;
			if (attack.attackerTerastallized !== undefined) column.attackerTerastallized = attack.attackerTerastallized;
			if (attack.attackerVolatiles !== undefined) column.attackerVolatiles = attack.attackerVolatiles;
			if (attack.defenderBoosts !== undefined) column.defenderBoosts = attack.defenderBoosts;
			if (attack.defenderAilment !== undefined) column.defenderAilment = attack.defenderAilment;
			if (attack.defenderTerastallized !== undefined) column.defenderTerastallized = attack.defenderTerastallized;
			if (attack.defenderVolatiles !== undefined) column.defenderVolatiles = attack.defenderVolatiles;
			deriveScalarsFromArrays(column);
			if (sanitizeColumnChoices(column)) needsResave = true;
			return column;
		};

		if (field.attacks && field.attacks.length > 0) {
			row.attacks = field.attacks.map(columnFromAttack);
		} else if (note.move_name) {
			// 後方互換: move_nameのみのメモを1列に変換する。
			row.attacks = [columnFromAttack({ moveName: note.move_name })];
		} else {
			const column = createEmptyColumn(legacyConditions);
			deriveScalarsFromArrays(column);
			if (sanitizeColumnChoices(column)) needsResave = true;
			row.attacks = [column];
		}

		row.memo = note.memo ?? "";
		row.clientResult = (note.client_result as unknown as OpponentClientResultInput | null) ?? null;
		const order = typeof field.order === "number" && Number.isFinite(field.order) ? field.order : undefined;
		return { row, needsResave, order };
	}

	function parseSeed(raw: string): number | undefined {
		const trimmed = raw.trim();
		if (trimmed === "") return undefined;
		const n = Number(trimmed);
		return Number.isFinite(n) ? Math.round(n) : undefined;
	}

	// 保存対象/計算対象となる有効な攻撃列(技名が空の列は除く)。
	// field.attacks(サーバ保存)とcalcLethalSequence()への引き渡しの両方でこれを使うことで、
	// 「列の並び順」と「結果配列の並び順」が常に一致するようにする。
	// 技カードごとの詳細設定もここで一緒に載せる(保存とエンジン呼び出しで同じ値を使う)。
	function validAttacksOf(row: DamageRowState): OpponentAttackInput[] {
		return row.attacks
			.filter((a) => a.moveName.trim() !== "")
			.map((a) => ({
				moveName: a.moveName.trim(),
				hitCount: a.hitCount,
				critical: a.critical,
				weather: a.weather,
				terrain: a.terrain,
				stealthRock: a.stealthRock,
				spikes: clampInt(a.spikes, 0, 3),
				defenderSideFields: a.defenderSideFields,
				attackerBoosts: a.attackerBoosts,
				attackerAilment: a.attackerAilment,
				attackerTerastallized: a.attackerTerastallized,
				attackerVolatiles: a.attackerVolatiles,
				defenderBoosts: a.defenderBoosts,
				defenderAilment: a.defenderAilment,
				defenderTerastallized: a.defenderTerastallized,
				defenderVolatiles: a.defenderVolatiles,
			}));
	}

	// カードの相手ポケモンのspec(実数値計算用。ランク補正・状態異常・テラスタル発動は含まない)。
	// 「相手 = 防御側」とは限らない(攻守切り替えがあるため)ので、バトル状態を載せた
	// specの組み立ては recalcRow() 側でdirectionを見ながら行う。
	function buildDefenderStatsSpec(row: DamageRowState): PokemonSpec {
		return {
			name: row.name.trim(),
			nature: row.nature || undefined,
			abilityName: row.abilityName || undefined,
			itemName: row.itemName || undefined,
			teraType: row.teraType || undefined,
			evs: row.evs,
			ivs: STAT_KEYS.map(() => 31),
		};
	}

	// 判定は「確実に倒せるのは何発目か」の1つだけを返す。10発以内に確殺
	// (probability>=0.9999、浮動小数の誤差込み)に到達する最初の位置があれば「確N」のみを返し、
	// そこへ至る前段の乱数確率は一切表示しない。10発以内に到達しなければ、呼び出し元から
	// 渡されたnoLethalLabel(技列側/加算後側のいずれも「10発以上」相当の文字列を渡す。
	// describeExtendedTotalNoLethalLabel参照)を返す。severityは.severity-barの色分け
	// (lethal=確1/risky=確2/safe=確3以降・10発以上)に使う。
	// 技列側(.damage-column-result)と加算後側(renderTotalDisplay)の両方がこの共有関数を
	// 経由するため、ここを直せば両方に反映される。
	function describeSeriesVerdict(
		series: LethalResult[] | undefined,
		noLethalLabel: string,
	): { label: string; severity: "lethal" | "risky" | "safe" | "none" } {
		if (!Array.isArray(series) || series.length === 0) return { label: "-", severity: "none" };
		const confirmed = series.find((l) => l.probability >= 0.9999);
		if (!confirmed) return { label: noLethalLabel, severity: "safe" };
		const severity: "lethal" | "risky" | "safe" =
			confirmed.attackCount === 1 ? "lethal" : confirmed.attackCount === 2 ? "risky" : "safe";
		return { label: `確${confirmed.attackCount}`, severity };
	}

	// 「技ごとの致死率」のフォールバック実装。
	// 通常はエンジンが返す perAttackLethal(jpokeのLethalHitResult.__add__による分布合成。
	// たべのこし回復・きあいのタスキ等も反映済み)を使う。この関数は、エンジンを積む前に
	// 保存された古い client_result スナップショットを表示するときだけ使われる
	// (perAttackLethal が無い時代のレコード)。エンジン初期化後の再計算で上書きされる。
	//
	// 計算はHP分布(残りHP -> 頻度カウント)を保持し、ダメージ値それぞれで分岐させながら
	// 0で下限クリップする(jpokeのsubtract_dist(minimum=0)と同じ)。頻度は確率ではなく
	// 整数カウントなので、最後に必ず合計で割って正規化する。
	// hitCountは掛けない: perAttackDamagesは「その攻撃1回ぶん(全ヒット合計)」に
	// 意味が変わっている(pyodide-engine.tsのCalcLethalSequenceResult参照)。
	// describeSeriesVerdictと同じく、「一部の乱数分岐だけが致死する(zero > 0だが
	// zero !== total)」段階では確定と言えないため、全分岐が致死(zero === total)に
	// なるまで確定数として採用しない。
	const MAX_STANDALONE_ATTACKS = 10;
	function describeStandaloneLethal(
		damages: number[] | undefined,
		defenderHp: number | undefined,
	): { label: string; severity: "lethal" | "risky" | "safe" | "none" } {
		if (!damages || damages.length === 0 || !defenderHp || defenderHp <= 0) {
			return { label: "-", severity: "none" };
		}
		let dist = new Map<number, number>([[defenderHp, 1]]);
		for (let attack = 1; attack <= MAX_STANDALONE_ATTACKS; attack += 1) {
			const next = new Map<number, number>();
			for (const [remain, freq] of dist) {
				for (const d of damages) {
					const value = Math.max(0, remain - d);
					next.set(value, (next.get(value) ?? 0) + freq);
				}
			}
			dist = next;
			let total = 0;
			for (const freq of dist.values()) total += freq;
			const zero = dist.get(0) ?? 0;
			if (total > 0 && zero === total) {
				const severity: "lethal" | "risky" | "safe" =
					attack === 1 ? "lethal" : attack === 2 ? "risky" : "safe";
				return { label: `確${attack}`, severity };
			}
		}
		// 10発当てても全分岐が致死に至らない = 実質的に倒せない組み合わせ。
		return { label: `${MAX_STANDALONE_ATTACKS}発以上`, severity: "safe" };
	}

	// describeSeriesVerdict(result.lethal, ...)は、設定済みの攻撃列(最大3枚)の範囲内で
	// 一度も確殺(致死率100%)に到達しなかったときにこの第2引数(noLethalLabel)をそのまま
	// 表示する。この関数は「設定済みの攻撃列を先頭から繰り返し当て続けたら何発で倒せるか」を、
	// 技列側(describeStandaloneLethal)と同じ分布演算(1発ごとにHP分布から差し引き0で
	// クリップする)で見積もり、その結果をdescribeSeriesVerdict自身にもう一度通したlabelを
	// 返す。実際の攻撃列の範囲内(result.lethalが担保する区間)はエンジンの厳密な値
	// (たべのこし等のターン終了時処理を含む)をそのまま使い、この関数が呼ばれるのは範囲内で
	// 確殺に未到達のときだけなので、精度が落ちるのは「まだ確認できていない延長部分」に
	// 限られる(describeStandaloneLethalと同じ精度レベルで、ターン終了時処理を含まない
	// 近似値)。ただし有効な攻撃列が1件だけの行では、技列側と同じperAttackLethal[0]
	// (エンジンの厳密値)をそのまま使うため近似は発生しない(技列側の「確N」と加算後側の
	// 数値が食い違わない)。
	function describeExtendedTotalNoLethalLabel(
		row: DamageRowState,
		result: OpponentClientResultInput,
	): string {
		// 有効な攻撃列が1件だけの行は、エンジンが返す perAttackLethal[0](その技を
		// 最大10回連発した場合の厳密な確定数系列。たべのこし等のターン終了時処理も
		// 反映済み)がそのまま「攻撃列を繰り返し当て続けた場合」と一致するため、
		// 下の近似計算より優先して使う(技列側の表示と数値が食い違わないようにする)。
		const validAttacks = validAttacksOf(row);
		if (validAttacks.length === 1 && Array.isArray(result.perAttackLethal?.[0])) {
			return describeSeriesVerdict(result.perAttackLethal[0], `${MAX_STANDALONE_ATTACKS}発以上`).label;
		}
		const per = result.perAttackDamages;
		const hp = result.defenderHp;
		if (!Array.isArray(per) || per.length === 0 || !hp || hp <= 0) {
			return `${MAX_STANDALONE_ATTACKS}発以上`;
		}
		const extendedSeries: LethalResult[] = [];
		let dist = new Map<number, number>([[hp, 1]]);
		for (let attack = 1; attack <= MAX_STANDALONE_ATTACKS; attack += 1) {
			const damages = per[(attack - 1) % per.length];
			if (!Array.isArray(damages) || damages.length === 0) continue;
			const next = new Map<number, number>();
			for (const [remain, freq] of dist) {
				for (const d of damages) {
					const value = Math.max(0, remain - d);
					next.set(value, (next.get(value) ?? 0) + freq);
				}
			}
			dist = next;
			let total = 0;
			for (const freq of dist.values()) total += freq;
			const zero = dist.get(0) ?? 0;
			extendedSeries.push({ attackCount: attack, probability: total > 0 ? zero / total : 0 });
		}
		return describeSeriesVerdict(extendedSeries, `${MAX_STANDALONE_ATTACKS}発以上`).label;
	}

	// 「加算後のダメ・致死率」(DamageCard.pngの左パネル最下段)の累計ダメージ。
	// 通常はエンジンが返す cumulativeDamage(LethalHitResult.__add__ による分布合成から
	// 求めた厳密な最小/最大)を使う。この関数は、cumulativeDamage が無い時代の
	// client_result スナップショットを表示するときのフォールバック
	// (各攻撃の最小同士・最大同士を単純加算した近似値)。
	function formatCumulativeDamage(
		row: DamageRowState,
		result: OpponentClientResultInput,
	): { text: string; pctMin?: number; pctMax?: number } {
		const valid = validAttacksOf(row);
		const per = result.perAttackDamages;
		const exact = result.cumulativeDamage;
		let min: number;
		let max: number;
		if (exact && Number.isFinite(exact.min) && Number.isFinite(exact.max)) {
			min = exact.min;
			max = exact.max;
		} else {
			if (!Array.isArray(per) || valid.length === 0) return { text: "" };
			min = 0;
			max = 0;
			for (let i = 0; i < valid.length; i += 1) {
				const damages = per[i];
				if (!Array.isArray(damages) || damages.length === 0) return { text: "" };
				min += Math.min(...damages);
				max += Math.max(...damages);
			}
		}
		const hp = result.defenderHp;
		if (hp && hp > 0) {
			const pctMin = Math.floor((min / hp) * 100);
			const pctMax = Math.ceil((max / hp) * 100);
			const pct = pctMin === pctMax ? `${pctMin}%` : `${pctMin}〜${pctMax}%`;
			return { text: `${min}〜${max} (${pct})`, pctMin, pctMax };
		}
		return { text: `${min}〜${max}` };
	}

	function formatDamageRange(damages: number[] | undefined, defenderHp: number | undefined): string {
		if (!damages || damages.length === 0) return "";
		const min = Math.min(...damages);
		const max = Math.max(...damages);
		const range = min === max ? `${min}` : `${min}〜${max}`;
		if (defenderHp && defenderHp > 0) {
			const pctMin = Math.floor((min / defenderHp) * 100);
			const pctMax = Math.ceil((max / defenderHp) * 100);
			const pct = pctMin === pctMax ? `${pctMin}%` : `${pctMin}〜${pctMax}%`;
			return `${range} (${pct})`;
		}
		return range;
	}

	// 累計(加算後)で既に確殺に到達している位置(=それ以降の技は撃つ前提が崩れている)を
	// 求める。result.lethalはcalcLethalSequenceの累計致死率
	// 系列で、probability>=0.9999になった最初のattackCountが「そこで確実に倒せる」
	// 位置。数値自体(技ごとの独立判定)は変えず、視覚的に控えめにする材料としてのみ使う。
	function computeConfirmedKillAttackCount(result: OpponentClientResultInput | null): number | null {
		if (!result || !Array.isArray(result.lethal)) return null;
		const confirmed = result.lethal.find((l) => l.probability >= 0.9999);
		return confirmed ? confirmed.attackCount : null;
	}

	// 判定(確N/乱N等)を大きく太字で左に、ダメージ量の詳細を小さく右に配置する2分割構造。
	// is:global側の.damage-row-total-result(grid auto 1fr)/.damage-column-result
	// (横並びflex-direction:row)と組み合わせて使う。severity(背景色・左罫線の色)は
	// 引き続き.severity-bar[data-severity]が要素全体に適用するため、ここでは中身のDOM構造
	// だけを変える。
	// describeStandaloneLethal/describeSeriesVerdictが10発当てても確殺に至らないケースで
	// 返すラベルは`${MAX_STANDALONE_ATTACKS}発以上`(="10発以上")の1種類だけ(上の
	// MAX_STANDALONE_ATTACKS定義・両関数参照)。この値と一致するときだけverdictSpan
	// (太字の確定数ラベル)自体を生成・appendしない(detailSpanのみ残す)。呼び出し元
	// (renderColumnDisplays=個別技カード側/renderTotalDisplay=累計結果側、いずれもこの関数を
	// 経由する)を区別する必要はなく、この1関数を直せば両方に適用される。
	const TEN_OR_MORE_LABEL = `${MAX_STANDALONE_ATTACKS}発以上`;
	function setResultVerdict(el: HTMLElement, detailText: string, label: string): void {
		el.innerHTML = "";
		if (label !== TEN_OR_MORE_LABEL) {
			const verdictSpan = document.createElement("span");
			verdictSpan.className = "damage-result-verdict";
			verdictSpan.textContent = label;
			el.appendChild(verdictSpan);
		}
		if (detailText !== "") {
			const detailSpan = document.createElement("span");
			detailSpan.className = "damage-result-detail";
			detailSpan.textContent = detailText;
			el.appendChild(detailSpan);
		}
	}
	// 「(計算前)」「技名を入力」のような単一メッセージ用(2分割にしない)。
	function setResultPlain(el: HTMLElement, text: string): void {
		el.innerHTML = "";
		el.textContent = text;
	}

	// DamageCard.pngの結果表示は2箇所に分かれている。
	//  - 各技列の最下段 = 「技ごとのダメ・致死率」(その技だけを繰り返した場合の独立した判定)
	//  - 左パネルの最下段 = 「加算後のダメ・致死率」(全ての技列を順に当てた合計)
	// row.clientResultのperAttackDamagesは「有効な攻撃列(validAttacksOf)」の順に並んで
	// いるため、技名が空の列を飛ばしながら1始まりの位置を数えて対応させる。
	function renderColumnDisplays(row: DamageRowState): void {
		const result = row.clientResult;
		const confirmedKillAt = computeConfirmedKillAttackCount(result);
		let validPos = 0;
		row.attacks.forEach((attack, index) => {
			const target = row.columnResultEls[index];
			if (!target) return;
			const colEl = target.closest<HTMLElement>(".damage-column");
			const overkillNote = colEl?.querySelector<HTMLElement>(".damage-column-overkill-note");
			const applyOverkill = (isOverkill: boolean): void => {
				colEl?.classList.toggle("is-overkill", isOverkill);
				if (overkillNote) {
					overkillNote.hidden = !isOverkill;
					if (isOverkill && confirmedKillAt != null) overkillNote.textContent = `${confirmedKillAt}発目で撃破済`;
				}
			};
			const hasMove = attack.moveName.trim() !== "";
			if (!hasMove) {
				setResultPlain(target, "技名を入力");
				target.dataset.severity = "none";
				applyOverkill(false);
				return;
			}
			validPos += 1;
			// 累計で既に確殺に到達した位置より後ろの列は「1発目で撃破済」のような撃破済み
			// キャプションを添えて控えめにする(数値自体は変えない)。
			applyOverkill(confirmedKillAt != null && validPos > confirmedKillAt);
			// 変化技(まもる等)は静的な技データの時点で判定できる(category==="status"は
			// ゲーム仕様として常にダメージ0のため、エンジンの計算結果を待つ必要が無い)。
			// 「10発以上 0(0%)」のような誤解を招く表示を出さず、はきだすと同じ仕組みで
			// 理由だけを示す。⚠️ OHKO技(じわれ等)・はきだすは変化技ではない(物理技)ため、
			// この分岐には入らずこれまでどおり通常のダメージ表示/はきだす専用の断り書きに進む。
			if (isStatusMove(attack.moveName)) {
				setResultPlain(target, STATUS_MOVE_NOTE);
				target.dataset.severity = "none";
				return;
			}
			// 「はきだす」だけはエンジンの計算結果を待たず(静的な技データだけで判定できる
			// ため)、確N/10発以上のような「0ダメージ」に見える表示を出さず理由を示す。
			// 他の技(カウンター・ちきゅうなげ・OHKO技等)はエンジンが正しく計算するため、
			// 以下の通常経路をそのまま通す。
			if (isUnsupportedLethalMove(attack.moveName)) {
				setResultPlain(target, UNSUPPORTED_LETHAL_NOTE);
				target.dataset.severity = "none";
				return;
			}
			if (!result || !Array.isArray(result.perAttackDamages)) {
				setResultPlain(target, isEngineReady() ? "(計算前)" : "(計算エンジンの初期化待ち)");
				target.dataset.severity = "none";
				return;
			}
			const damages = result.perAttackDamages[validPos - 1];
			const rangeText = formatDamageRange(damages, result.defenderHp) + ohkoNoteSuffixFor(attack.moveName);
			// 技ごとの判定はエンジンが返す perAttackLethal(その技だけを連発した場合の
			// 確定数系列)を使う。無い場合(古いスナップショット)だけTS側で概算する。
			const series = result.perAttackLethal?.[validPos - 1];
			const { label, severity } = Array.isArray(series)
				? describeSeriesVerdict(series, `${MAX_STANDALONE_ATTACKS}発以上`)
				: describeStandaloneLethal(damages, result.defenderHp);
			setResultVerdict(target, rangeText, label);
			target.dataset.severity = severity;
		});
		renderTotalDisplay(row);
		syncDetailPanelTotal(row);
	}

	// 左パネル最下段の「加算後のダメ・致死率」を更新する。技列が1つだけのときは
	// 加算する意味が無いので、その旨だけを出して数字は技列側に任せる。
	function renderTotalDisplay(row: DamageRowState): void {
		const target = row.totalResultEl;
		if (!target) return;
		const setSeverity = (value: string): void => {
			target.dataset.severity = value;
			if (!row.totalBlockEl) return;
			row.totalBlockEl.dataset.severity = value;
			if (value === "none") {
				row.totalBlockEl.style.removeProperty("--gauge-min");
				row.totalBlockEl.style.removeProperty("--gauge-max");
			}
		};
		const setGauge = (pctMin: number | undefined, pctMax: number | undefined): void => {
			if (!row.totalBlockEl || pctMin == null || pctMax == null) {
				row.totalBlockEl?.style.removeProperty("--gauge-min");
				row.totalBlockEl?.style.removeProperty("--gauge-max");
				return;
			}
			row.totalBlockEl.style.setProperty("--gauge-min", `${Math.min(Math.max(pctMin, 0), 100)}%`);
			row.totalBlockEl.style.setProperty("--gauge-max", `${Math.min(Math.max(pctMax, 0), 100)}%`);
		};
		const result = row.clientResult;
		const validAttacks = validAttacksOf(row);
		if (validAttacks.length === 0) {
			setResultPlain(target, "");
			setSeverity("none");
			return;
		}
		// 技列に「はきだす」を含む場合、エンジン(calc_lethal_sequence_json)はその技の
		// 寄与を0として他の技と合成した値をそのまま返す。全技がその対象(合算しても常に0)
		// なら、素の確N表示は「0ダメージに見える」誤解を再現するため、静的な技データの
		// 時点で数値を出さず理由だけ示す。
		const hasUnsupported = validAttacks.some((a) => isUnsupportedLethalMove(a.moveName));
		// 変化技(まもる等)も同じ扱いにする。単独では技列側(renderColumnDisplays)の
		// isStatusMove分岐で処理されるが、全技列が変化技(または変化技+はきだすの組み合わせ)
		// だと合計側も「10発以上 0(0%)」のような誤解を招く表示になるため、こちらでも判定する。
		const hasStatus = validAttacks.some((a) => isStatusMove(a.moveName));
		const allNoDamage = validAttacks.every(
			(a) => isStatusMove(a.moveName) || isUnsupportedLethalMove(a.moveName),
		);
		if (allNoDamage && (hasStatus || hasUnsupported)) {
			const note = hasStatus && hasUnsupported
				? STATUS_AND_UNSUPPORTED_TOTAL_NOTE_ALL
				: hasStatus
					? STATUS_MOVE_TOTAL_NOTE_ALL
					: UNSUPPORTED_LETHAL_TOTAL_NOTE_ALL;
			setResultPlain(target, note);
			setSeverity("none");
			return;
		}
		if (!result || !Array.isArray(result.perAttackDamages)) {
			setResultPlain(target, isEngineReady() ? "(計算前)" : "(計算エンジンの初期化待ち)");
			setSeverity("none");
			return;
		}
		const hasOhko = validAttacks.some((a) => OHKO_MOVE_NAMES.has(a.moveName.trim()));
		const cumulativeDamage = formatCumulativeDamage(row, result);
		const damageText = cumulativeDamage.text + (hasOhko ? ` ${OHKO_NOTE}` : "");
		const { label, severity } = describeSeriesVerdict(
			result.lethal,
			describeExtendedTotalNoLethalLabel(row, result),
		);
		if (hasUnsupported) {
			// 数値自体は「算出できる技だけを合算した値」として意味があるため隠さず表示し、
			// 断り書きを添えて過信(色による確定的な印象)を防ぐ(severityは中立のnoneに)。
			const detail = damageText ? `${damageText} ${UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME}` : UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME;
			setResultVerdict(target, detail, label);
			setSeverity("none");
			return;
		}
		setResultVerdict(target, damageText, label);
		setSeverity(severity);
		if (severity === "none") setGauge(undefined, undefined);
		else setGauge(cumulativeDamage.pctMin, cumulativeDamage.pctMax);
	}

	// H/A/B/C/D/S見出し自体が「無補正→上昇→下降→無補正」を巡回する1個のボタンになっている。
	// 状態を反映する対象はキーごとの1ボタン(row.natureColLabelEls[key])だけなので、
	// 「実際にクリックして選ばれている生の状態」(row.natureUp/row.natureDown)をもとに
	// data-mod(色分け。既存の.damage-ev-col-label[data-mod]と共有) / 小さな▲▼インジケータ
	// (.damage-ev-nature-indicator、色だけに頼らないWCAG 1.4.1対応) / aria-label・titleの
	// 3つをこの1関数でまとめて書き戻す(片方だけ更新すると表示と状態がズレるため)。
	function describeNatureCycleState(
		key: StatKey,
		mod: "up" | "down" | null,
	): { indicator: string; description: string } {
		const kanji = STAT_KANJI[key];
		if (mod === "up") {
			return { indicator: "▲", description: `相手の${kanji}は性格補正で上昇中です(クリックで下降に切り替え)` };
		}
		if (mod === "down") {
			return { indicator: "▼", description: `相手の${kanji}は性格補正で下降中です(クリックで無補正に戻します)` };
		}
		return { indicator: "", description: `相手の${kanji}は性格補正なしです(クリックで上昇に設定します)` };
	}
	function refreshRowNatureButtons(row: DamageRowState): void {
		for (const key of STAT_KEYS) {
			if (key === "hp") continue;
			const mod = row.natureUp === key ? "up" : row.natureDown === key ? "down" : null;
			const { indicator, description } = describeNatureCycleState(key, mod);
			const targets = [row.natureColLabelEls[key], rowReadonlyNatureLabelEls.get(row)?.[key]];
			for (const target of targets) {
				if (!target) continue;
				if (mod) target.dataset.mod = mod;
				else delete target.dataset.mod;
				const indicatorEl = target.querySelector<HTMLElement>(".damage-ev-nature-indicator");
				if (indicatorEl) indicatorEl.textContent = indicator;
				target.setAttribute("aria-label", description);
				target.title = description;
			}
		}
	}

	// 実数値グリッド(H/A/B/C/D/S)のみを更新する。ダメージ計算(攻撃列)とは独立に、
	// 相手ビルドの入力(性格・特性・持ち物・テラスタイプ・努力値)が変わるたびに呼ぶ。
	// 左パネルのrecalcStats()と同様、エンジン非依存の純JS計算に切り替える
	// (calcHpStat/calcOtherStatはモジュールスコープで定義済み)。ダメージ計算(recalcRow内の
	// この先の処理)は引き続きisEngineReady()待ちのまま。
	async function recalcRowStatsOnly(row: DamageRowState): Promise<void> {
		const name = row.name.trim();
		const base = name ? (await baseStatsMapPromise).get(name) : undefined;
		const panelState = rowStatAdjustmentPanels.get(row);
		if (panelState) {
			panelState.options.evs = row.evs;
			panelState.options.nature = row.nature;
			panelState.options.natureUp = row.natureUp;
			panelState.options.natureDown = row.natureDown;
			panelState.options.baseStats.splice(0, panelState.options.baseStats.length, ...(base ?? []));
			panelState.panel.refresh();
		}
		if (!base) {
			for (const key of STAT_KEYS) {
				const target = row.statValueEls[key];
				if (!target) continue;
				target.textContent = "-";
				delete target.dataset.mod;
			}
			return;
		}
		const level = 50;
		// 性格<select>は廃止しており、row.natureUp/natureDownを使う。片方だけ選択中の
		// 不完全な状態はnormalizedNatureBoostsで「まじめ」に正規化してから使う
		// (保存されるnatureと表示を一致させるため)。
		const natureMod = normalizedNatureBoosts(row.natureUp, row.natureDown);
		STAT_KEYS.forEach((key, i) => {
			const target = row.statValueEls[key];
			const mod = natureMod.up === key ? "up" : natureMod.down === key ? "down" : null;
			const iv = 31;
			const ev = row.evs[i] ?? 0;
			const value = key === "hp"
				? calcHpStat(level, base[i], iv, ev)
				: calcOtherStat(level, base[i], iv, ev, mod === "up" ? 1.1 : mod === "down" ? 0.9 : 1.0);
			if (!target) return;
			target.textContent = String(value);
			if (mod) target.dataset.mod = mod;
			else delete target.dataset.mod;
			// row.natureColLabelEls[key]の見た目(data-mod・▲▼インジケータ・aria-label/title)は
			// クリック直後の「生の状態」(row.natureUp/row.natureDown)を反映する
			// refreshRowNatureButtons()が単独で担当する。ここ(recalcRowStatsOnly)は
			// normalizedNatureBoosts(上昇/下降が両方揃って初めて有効という正規化)を使うため、
			// 片方だけ選択中の直後にここで上書きすると、クリックした瞬間に見えたはずの色/▲▼表示が
			// 一瞬で消えてしまう。実数値の数字側(statValueEls)は正規化された値のままで正しい
			// (実際の計算に使う値と一致させる必要があるため)。
		});
	}

	// キー順に依存しない構造比較用の正規化文字列化。
	// オブジェクトのキーをソートしてから再帰的にJSON化するため、Postgres jsonbのキー
	// 並び替え(実測で確認: サーバから返るclient_resultはJS側の挿入順と異なる順で
	// 返ってくる)があっても値が同じなら同じ文字列になる。null/数値/文字列/配列/
	// プレーンオブジェクトだけを想定(client_resultの構造で十分)。
	function canonicalStringify(value: unknown): string {
		if (value === null || typeof value !== "object") return JSON.stringify(value);
		if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(",")}}`;
	}

	// recalcRow() がcalcLethalSequence()/calcStats() を呼ぶ直前に組み立てている値
	// (攻守切り替え・テラスタルのクランプ・乱数シード)は、耐久調整ブリッジ
	// (下のregisterBulkAdjustBridge呼び出し・getDefenseRows)からも同じ手順で取得する必要が
	// あるため、この1関数に集約している。カードの確N表示(recalcRow)と耐久調整の計算対象
	// (getDefenseRows)が別々のロジックで値を組み立てると、両者が食い違う(画面は確1なのに
	// 耐久調整では耐える、といった不整合)おそれがあるため、必ずこの1関数だけから両方が
	// 導出されるようにする。
	function buildSequenceInputs(
		row: DamageRowState,
		attacks: OpponentAttackInput[],
	): {
		selfIsAttacker: boolean;
		attackerSpec: PokemonSpec;
		defenderSpec: PokemonSpec;
		safeAttacks: SequenceAttack[];
		options: CalcDamagesOptions;
	} {
		// 攻守切り替え: どちらのspecを攻撃側としてエンジンに渡すかだけを入れ替える。
		// ランク補正・状態異常・テラスタル発動は技カードごとの値(attacks[i]の
		// attacker*/defender*)としてエンジンに渡すため、specには載せない。
		// attacker* は「攻撃側という役割」に対する値であり、ここで攻撃側として渡した
		// specに適用される = directionによって適用先が自動的に入れ替わる。
		// 相手が攻撃側になる場合、相手のspecにはmoveNamesを積まないが、エンジン側の
		// _resolve_move()が技リストに無い技名からMoveを新規生成するため計算できる
		// (pyodide-engine.tsの_resolve_move参照)。
		const selfIsAttacker = row.direction !== "defense";
		const selfSpec = buildAttackerSpec();
		const opponentSpec: PokemonSpec = buildDefenderStatsSpec(row);
		const attackerSpec = selfIsAttacker ? selfSpec : opponentSpec;
		const defenderSpec = selfIsAttacker ? opponentSpec : selfSpec;
		// jpokeはteraType未指定でも
		// テラスタル発動すると自身の第1タイプへ黙ってフォールバックし、無警告で
		// 2.0倍のタイプ一致補正がかかる(`.claude/skills/jpoke/references/ruleset.md`
		// §4・`damage-calc.md` 3補参照)。サイドバーのチェックボックスはテラスタイプが
		// 空のとき既にdisabledにしているが(buildSideSection参照)、それだけでは
		// 「サイドバーを一度も開いていない既存データにattacker/defenderTerastallized:
		// trueが残っている」ケースを救えない。計算に使う直前でも、対応する側の
		// specにteraTypeが無ければterastallizedを強制的にfalseへ落とし、
		// 保存データの状態に関わらず無警告2倍が絶対に起きないようにする
		// (このクランプは「保存データの補正」ではなく「テラスタル発動は有効な
		// テラスタイプがあって初めて意味を持つ」という仕様の一貫した適用)。
		const attackerTeraAvailable = !!attackerSpec.teraType;
		const defenderTeraAvailable = !!defenderSpec.teraType;
		const safeAttacks: SequenceAttack[] = (attacks as SequenceAttack[]).map((a) => ({
			...a,
			attackerTerastallized: (a.attackerTerastallized ?? false) && attackerTeraAvailable,
			defenderTerastallized: (a.defenderTerastallized ?? false) && defenderTeraAvailable,
		}));
		// 場の状態・急所も技カードごとの値なので、カード共通のoptionsには
		// 乱数シード(UIからは廃止済みだが既存メモの値は尊重する)だけを渡す。
		const options: CalcDamagesOptions = {
			seed: parseSeed(row.seedRaw),
		};
		return { selfIsAttacker, attackerSpec, defenderSpec, safeAttacks, options };
	}

	// 実数値グリッド + ダメージ計算(攻撃列の加算ダメージ・累計致死率)をまとめて再計算する。
	// エンジン未初期化・相手名未入力の場合は計算せず、保存済みのclientResult(あれば)を
	// そのまま表示し続ける。
	async function recalcRow(row: DamageRowState): Promise<void> {
		await recalcRowStatsOnly(row);
		// 壁on/off・攻守ランクのスカラー値から、実際にエンジンへ渡す配列
		// (attackerBoosts/defenderBoosts/defenderSideFields)を技名の物理/特殊分類にもとづいて
		// 算出し直す(resolveColumnDerivedFields参照)。
		for (const a of row.attacks) resolveColumnDerivedFields(a);
		const name = row.name.trim();
		if (name === "" || !isEngineReady()) {
			renderColumnDisplays(row);
			return;
		}
		const attacks = validAttacksOf(row);
		if (attacks.length === 0) {
			row.clientResult = null;
			renderColumnDisplays(row);
			return;
		}
		// Pyodide初期化完了時にcombinedDamageEngineProgress()が全行を一括recalcRow()する
		// たびに、内容が1バイトも変わらなくてもscheduleRowSave(row)を無条件で呼ぶとPUTが
		// 飛んでupdated_atだけが無意味に更新されてしまう。
		// 直前の保存済みclientResultを控えておき、再計算後に実際に値が変わったときだけ
		// scheduleRowSave()を呼ぶ。ユーザーが実際に技/努力値/ランク等を変更した場合は
		// 必ず数値が変わる(=保存される)ため、自動保存の仕組み自体は変えていない。
		const previousClientResult = row.clientResult;
		try {
			// 攻守切り替え・テラスタルのクランプ・乱数シードの組み立ては
			// buildSequenceInputs()(上で定義)に切り出した(耐久調整ブリッジと共通化するため。
			// 詳細は同関数のコメント参照)。
			const { attackerSpec, defenderSpec, safeAttacks, options } = buildSequenceInputs(row, attacks);
			const [seqResult, statsResult] = await Promise.all([
				calcLethalSequence(attackerSpec, defenderSpec, safeAttacks, options),
				calcStats(defenderSpec),
			]);
			row.clientResult = {
				// 累計致死率は先頭の有効技列から始まるため、カード単位の表示分母も
				// その列のステルスロック適用後HPに揃える。OFFなら最大HPと同値。
				defenderHp: seqResult.defenderHp || statsResult.stats.hp,
				perAttackDamages: seqResult.perAttackDamages,
				lethal: seqResult.lethal,
				perAttackLethal: seqResult.perAttackLethal,
				cumulativeDamage: seqResult.cumulativeDamage,
			};
			renderColumnDisplays(row);
			// エンジン初期化直後の再計算(要件: 保存済みclientResultはページ再読み込み直後の
			// スナップショット表示用。エンジン初期化後は再計算して上書きする)を含め、
			// 再計算後の値が以前の保存値と実際に異なるときだけ保存する。
			// ⚠️ PostgresのjsonbはキーをJS側の挿入順とは異なる順で返す(実測で確認済み。
			// 例: サーバは{lethal,defenderHp,perAttackLethal,...}の順で返すが、この関数の
			// オブジェクトリテラルはdefenderHpが先頭)。単純なJSON.stringify比較はキー順の
			// 違いだけで「変わった」と誤判定するため、キーをソートしてから比較する
			// canonicalStringify()を使う。
			if (canonicalStringify(previousClientResult) !== canonicalStringify(row.clientResult)) {
				scheduleRowSave(row);
			}
		} catch (err) {
			console.error(err);
			const failureTargets = [...row.columnResultEls, row.totalResultEl];
			for (const elx of failureTargets) {
				if (!elx) continue;
				elx.textContent = "エラー: 計算に失敗しました";
				elx.dataset.severity = "none";
			}
		}
	}

	// DOMと.damage-row-footer/.damage-row-save-statusクラスはJS/E2Eが参照する可能性が
	// あるため残したまま、保存失敗(state==="error")のとき以外は常に視覚的に隠す
	// (再試行導線が必要な失敗時だけは残す)。row.saveStatusEl/textContentの更新箇所を
	// この1関数に集約する。
	function setRowSaveStatus(row: DamageRowState, state: string, text: string): void {
		if (row.saveStatusEl) {
			row.saveStatusEl.dataset.state = state;
			row.saveStatusEl.textContent = text;
		}
		if (row.footerEl) row.footerEl.hidden = state !== "error";
		// この行の保存状態が変わるたびに、常時可視なトップバーの失敗件数表示も更新する。
		updateOpponentNotesFailureAlert();
	}

	// デバウンス付き即時自動保存(左パネルのsaveNow()と同じ流儀)。
	// 相手ポケモン名が空のうちはPOSTしない(サーバ検証でopponent_build.nameが必須のため)。
	async function saveRow(row: DamageRowState): Promise<void> {
		const name = row.name.trim();
		if (name === "") {
			setRowSaveStatus(row, "idle", "未保存(相手ポケモン名を入力すると保存されます)");
			return;
		}
		// 相手ポケモン名が非空で保存が起きるたびに、相手ビルド(性格・特性・持ち物・テラス・
		// 努力値)を種族名キーでlocalStorageへ上書き記録する(「最後に使ったビルド」が
		// その種族の既定値になる)。
		saveOpponentBuildPreset(name, {
			nature: row.nature,
			natureUp: row.natureUp,
			natureDown: row.natureDown,
			abilityName: row.abilityName,
			itemName: row.itemName,
			teraType: row.teraType,
			evs: [...row.evs],
		});
		if (row.saving) {
			row.pendingSave = true;
			return;
		}
		row.saving = true;
		// 進行中表示は画面全体の表記規約に合わせて三点リーダーを使う。
		setRowSaveStatus(row, "saving", "保存中…");
		row.retryButtonEl?.classList.remove("visible");
		try {
			// 保存前にも壁on/off・攻守ランクから配列を算出し直す(recalcRowと同じ理由)。
			for (const a of row.attacks) resolveColumnDerivedFields(a);
			const attacks = validAttacksOf(row);
			const opponentBuild: OpponentBuildInput = {
				name,
				nature: row.nature || undefined,
				abilityName: row.abilityName || undefined,
				itemName: row.itemName || undefined,
				teraType: row.teraType || undefined,
				evs: row.evs,
				ivs: STAT_KEYS.map(() => 31),
			};
			// 詳細設定は attacks[i](技カードごと)に入っているため、field直下の
			// カード共通キー(weather/critical/attackerBoosts等)はもう書き出さない。
			// 読み込み側(noteToRowState)は以前の保存形式のキーがあれば技カードの初期値として
			// 引き継ぐので、既存メモの内容が失われることはない。
			const field: OpponentFieldInput = {
				direction: row.direction,
				attacks,
			};
			const seed = parseSeed(row.seedRaw);
			if (seed !== undefined) field.seed = seed;
			// カード並び順(rowSortOrder、上方参照)。保存済み順序の復元と新規追加時の
			// 挿入位置を維持する。値が無い行はサーバーに送らず既存データと互換にする。
			const sortOrder = rowSortOrder.get(row);
			if (sortOrder !== undefined) field.order = sortOrder;

			// move_name(トップレベル列)には必ずattacks[0].moveNameを入れる
			// (空だと匿名化された二次記録がスキップされる既存仕様のため)。
			const moveName = attacks[0]?.moveName ?? null;

			const payload: Record<string, unknown> = {
				opponent_build: opponentBuild,
				field,
				move_name: moveName,
				client_result: row.clientResult,
				// メモ欄はUIから廃止したが、既存メモに入っている文章は保ったまま送り返す
				// (PUTは全項目上書きの契約なので、送らないと黙って消える)。
				memo: row.memo.trim() === "" ? null : row.memo.trim(),
			};

			let res: Response;
			if (row.id) {
				res = await fetch(`/api/opponent-notes/${encodeURIComponent(row.id)}`, {
					method: "PUT",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
			} else {
				payload.owned_pokemon_id = ownedPokemonId;
				res = await fetch("/api/opponent-notes", {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
			}
			if (!res.ok) {
				const errBody = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(errBody.error ?? `保存に失敗しました (status=${res.status})`);
			}
			if (!row.id) {
				const created = (await res.json()) as { data: OpponentNoteRecord };
				row.id = created.data.id;
			}
			setRowSaveStatus(row, "saved", "保存済み");
		} catch (err) {
			console.error(err);
			setRowSaveStatus(row, "error", "保存に失敗しました。");
			row.retryButtonEl?.classList.add("visible");
		} finally {
			row.saving = false;
			if (row.pendingSave) {
				row.pendingSave = false;
				void saveRow(row);
			}
		}
	}

	async function deleteRow(row: DamageRowState): Promise<void> {
		if (row.id) {
			if (!window.confirm("この相手のダメージ計算カードを削除します。よろしいですか?")) return;
			try {
				const res = await fetch(`/api/opponent-notes/${encodeURIComponent(row.id)}`, {
					method: "DELETE",
					credentials: "same-origin",
				});
				if (!res.ok) throw new Error(`削除に失敗しました (status=${res.status})`);
			} catch (err) {
				console.error(err);
				window.alert("削除に失敗しました。時間をおいて再度お試しください。");
				return;
			}
		}
		const idx = rows.indexOf(row);
		if (idx !== -1) rows.splice(idx, 1);
		deselectRowIfCurrent(row);
		rebuildRowsList();
		// 保存失敗中だった行を削除した場合、失敗件数から除外する。
		updateOpponentNotesFailureAlert();
	}

	// 攻撃側(row.direction === "attack"、このポケモン自身が攻撃する行)の技候補は、種族の
	// 覚え技全体(#move-listの並び、left-panel.tsのrebuildMoveListForSpeciesが管理)ではなく、
	// 左パネルの技1〜4欄に現在入力されている値(=このポケモン固有の実際の選択)を最上位に
	// 表示する。共有<datalist id="move-list">自体を書き換えると左パネル本体・受け(defense)側の
	// 技候補まで巻き込むため、この専用の<datalist id="move-list-self-first">を新設し、
	// 攻撃側のmoveInputだけlist属性をこちらに向ける(left-panel.ts/LeftPanel.astroは
	// 一切編集しない。#move-1〜#move-4のvalueをDOM経由で読むだけ)。
	// 変化技(category === "status")は仕様上ダメージを一切発生させず、選んでも
	// 「変化技のため、ダメージは発生しません。」(STATUS_MOVE_NOTE)が出るだけなので、
	// ダメージカードの技名候補(datalist)からは最初から外す。
	// ⚠️ datalistは候補の提示にすぎないので、この除外で入力できなくなる技は無い
	// (手入力すれば従来どおり技列に置ける。既存メモの変化技もそのまま表示・保存される)。
	// ⚠️ moveDetailMapCacheが未解決の一瞬はisStatusMove()が常にfalseを返すため何も
	// 除外されない。両datalistは技名inputのfocusごとに作り直すので、解決後の再フォーカスで
	// 正しい候補に揃う(isStatusMoveの定義部コメントと同じ前提)。
	function withoutStatusMoves(names: string[]): string[] {
		return names.filter((name) => !isStatusMove(name));
	}
	const SELF_FIRST_MOVE_DATALIST_ID = "move-list-self-first";
	function ensureSelfFirstMoveDatalist(): HTMLDataListElement {
		let list = document.getElementById(SELF_FIRST_MOVE_DATALIST_ID) as HTMLDataListElement | null;
		if (!list) {
			list = document.createElement("datalist");
			list.id = SELF_FIRST_MOVE_DATALIST_ID;
			document.body.appendChild(list);
		}
		return list;
	}
	// 呼ばれるたびに現在の#move-1〜#move-4の値・#move-listの中身から最新の候補順を作り直す
	// (技名inputにフォーカスするたび=編集を始める直前に呼べば十分新しい)。
	function refreshSelfFirstMoveDatalist(): void {
		const list = ensureSelfFirstMoveDatalist();
		const learnedMoves = ["move-1", "move-2", "move-3", "move-4"]
			.map((id) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "")
			.filter((name) => name !== "");
		const baseList = document.getElementById("move-list") as HTMLDataListElement | null;
		const baseOptions = baseList ? Array.from(baseList.options).map((o) => o.value) : [];
		const seen = new Set<string>();
		const ordered: string[] = [];
		for (const name of withoutStatusMoves([...learnedMoves, ...baseOptions])) {
			if (seen.has(name)) continue;
			seen.add(name);
			ordered.push(name);
		}
		list.innerHTML = "";
		for (const name of ordered) {
			const option = document.createElement("option");
			option.value = name;
			list.appendChild(option);
		}
	}

	// 上のSELF_FIRST_MOVE_DATALIST_ID(攻撃側=自分の技1〜4を最上位にする)と
	// 対になる、防御側(row.direction === "defense"、相手が攻撃してくる技を入力する列)専用の
	// datalist。#move-list(覚え技優先の並び)のoptionsをベースに、モジュール冒頭で読み込んだ
	// moveAdoptionBySpecies(box/[id].astroがSSRで埋め込んだsuggestions由来の使用率)で
	// 安定ソートし直す。
	const OPPONENT_POPULARITY_MOVE_DATALIST_ID = "move-list-opponent-popularity";
	function ensureOpponentPopularityMoveDatalist(): HTMLDataListElement {
		let list = document.getElementById(OPPONENT_POPULARITY_MOVE_DATALIST_ID) as HTMLDataListElement | null;
		if (!list) {
			list = document.createElement("datalist");
			list.id = OPPONENT_POPULARITY_MOVE_DATALIST_ID;
			document.body.appendChild(list);
		}
		return list;
	}
	// 呼ばれるたびに現在の#move-listの中身・現在のレギュレーション(#regulation、
	// currentIndividualRegulation()参照)から最新の候補順を作り直す(技名inputに
	// フォーカスするたび=編集を始める直前に呼べば十分新しい)。
	function refreshOpponentPopularityMoveDatalist(speciesName: string): void {
		const list = ensureOpponentPopularityMoveDatalist();
		const baseList = document.getElementById("move-list") as HTMLDataListElement | null;
		// 変化技はダメージが出ないので候補から外す(上のwithoutStatusMoves参照)。
		const baseOptions = withoutStatusMoves(baseList ? Array.from(baseList.options).map((o) => o.value) : []);
		// 個体の#regulationセレクトの現在値が指定されていればそのレギュレーションキー、
		// 未指定(プレースホルダー)なら全レギュレーション横断の"all"キーを使う。
		const regulationKey = currentIndividualRegulation() ?? "all";
		const ratioMap = moveAdoptionBySpecies[speciesName]?.[regulationKey];
		let ordered = baseOptions;
		if (ratioMap && Object.keys(ratioMap).length > 0) {
			// Array.prototype.sortは安定ソートなので、データの無い技(ratio未定義=-1扱い)・
			// 同ratioの技は元の順序(覚え技優先)のまま保たれる。マップが存在しない/空なら
			// baseOptionsをそのまま使う(フォールバック)。
			ordered = [...baseOptions].sort((a, b) => (ratioMap[b] ?? -1) - (ratioMap[a] ?? -1));
		}
		list.innerHTML = "";
		for (const name of ordered) {
			const option = document.createElement("option");
			option.value = name;
			list.appendChild(option);
		}
	}

	// 新規カード・新規列と、空欄のまま攻守を切り替えた列だけ候補先頭を初期値にする。
	// 復元処理では呼ばないため、保存済みの空欄を勝手に書き換えない。
	function fillFirstMoveCandidate(row: DamageRowState, column: DamageColumnState): void {
		if (column.moveName.trim() !== "") return;
		const list = row.direction === "defense"
			? (refreshOpponentPopularityMoveDatalist(row.name), ensureOpponentPopularityMoveDatalist())
			: (refreshSelfFirstMoveDatalist(), ensureSelfFirstMoveDatalist());
		column.moveName = list.options[0]?.value ?? "";
	}

	// 技列(加算条件)を1つ追加する処理を共通関数にまとめる。
	function addAttackColumn(row: DamageRowState): void {
		if (row.attacks.length >= currentMaxColumnsToAdd()) return;
		// 直前のカラム(row.attacks末尾)があれば、その詳細設定を引き継ぐ。
		const previousColumn = row.attacks[row.attacks.length - 1];
		const column = createEmptyColumn(previousColumn ? inheritedColumnDetailDefaults(previousColumn) : undefined);
		fillFirstMoveCandidate(row, column);
		row.attacks.push(column);
		renderColumns(row);
		scheduleRowCalc(row);
		scheduleRowSave(row);
	}

	const columnDisplayRefreshers = new WeakMap<DamageColumnState, () => void>();

	function refreshColumnDisplay(_row: DamageRowState, column: DamageColumnState): void {
		columnDisplayRefreshers.get(column)?.();
	}

	function configureColumnMoveInput(
		moveInput: HTMLInputElement,
		row: DamageRowState,
		column: DamageColumnState,
	): void {
		const attackerIsOpponent = row.direction === "defense";
		if (attackerIsOpponent) {
			ensureOpponentPopularityMoveDatalist();
			moveInput.setAttribute("list", OPPONENT_POPULARITY_MOVE_DATALIST_ID);
			moveInput.addEventListener("focus", () => refreshOpponentPopularityMoveDatalist(row.name));
			refreshOpponentPopularityMoveDatalist(row.name);
			attachKanaTypeAhead(moveInput, ensureOpponentPopularityMoveDatalist());
		} else {
			ensureSelfFirstMoveDatalist();
			moveInput.setAttribute("list", SELF_FIRST_MOVE_DATALIST_ID);
			moveInput.addEventListener("focus", refreshSelfFirstMoveDatalist);
			refreshSelfFirstMoveDatalist();
			attachKanaTypeAhead(moveInput, ensureSelfFirstMoveDatalist());
		}
		const columnNumber = Math.max(0, row.attacks.indexOf(column)) + 1;
		moveInput.placeholder = attackerIsOpponent ? "相手の技" : "技";
		moveInput.setAttribute(
			"aria-label",
			attackerIsOpponent ? `相手が${columnNumber}番目に当ててくる技` : `${columnNumber}番目に当てる技`,
		);
		moveInput.autocomplete = "off";
		moveInput.value = column.moveName;
	}

	function getColumnMoveCandidates(row: DamageRowState, _column: DamageColumnState): string[] {
		const attackerIsOpponent = row.direction === "defense";
		if (attackerIsOpponent) {
			refreshOpponentPopularityMoveDatalist(row.name);
			return Array.from(ensureOpponentPopularityMoveDatalist().options, (option) => option.value);
		}
		refreshSelfFirstMoveDatalist();
		return Array.from(ensureSelfFirstMoveDatalist().options, (option) => option.value);
	}

	async function getColumnMultiHitRange(moveName: string): Promise<[number, number] | undefined> {
		const name = moveName.trim();
		return name === "" ? undefined : (await multiHitMapPromise()).get(name);
	}

	const DAMAGE_COLUMN_LONG_PRESS_MS = 600;
	function attachColumnLongPressDelete(
		columnEl: HTMLElement,
		row: DamageRowState,
		column: DamageColumnState,
	): void {
		let pressTimer: ReturnType<typeof window.setTimeout> | undefined;
		const clearPress = (): void => {
			if (pressTimer !== undefined) window.clearTimeout(pressTimer);
			pressTimer = undefined;
			columnEl.classList.remove("is-pressing");
		};
		columnEl.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			if (event.target instanceof Element && event.target.closest("button, input, textarea, select, option, label, a, [contenteditable='true']")) return;
			// 親のカード削除モードとは別操作なので、同じ長押しで両方が発火しないようにする。
			event.stopPropagation();
			if (row.attacks.length <= 1) return;
			columnEl.classList.add("is-pressing");
			pressTimer = window.setTimeout(() => {
				pressTimer = undefined;
				const index = row.attacks.indexOf(column);
				if (index === -1 || row.attacks.length <= 1) {
					columnEl.classList.remove("is-pressing");
					return;
				}
				row.attacks.splice(index, 1);
				renderColumns(row);
				scheduleRowCalc(row);
				scheduleRowSave(row);
			}, DAMAGE_COLUMN_LONG_PRESS_MS);
		});
		columnEl.addEventListener("pointerup", clearPress);
		columnEl.addEventListener("pointercancel", clearPress);
		columnEl.addEventListener("pointerleave", clearPress);
		columnEl.addEventListener("contextmenu", (event) => {
			if (pressTimer !== undefined) event.preventDefault();
		});
	}

	// --- 列(攻撃)のDOM構築 ---
	function renderColumns(row: DamageRowState): void {
		if (!row.columnsEl) return;
		row.columnsEl.innerHTML = "";
		if (row.addColumnSlotEl) row.addColumnSlotEl.innerHTML = "";
		row.columnResultEls = [];
		row.columnChipEls = [];
		row.attacks.forEach((attack, index) => {
			const col = document.createElement("div");
			col.className = "damage-column";
			// クリック委譲(renderRow内のroot.addEventListener)がクリックされた技列を
			// 特定するために使う。列は加算/削除のたびに作り直されるため、都度この時点の
			// indexで振り直す。
			col.dataset.columnIndex = String(index);

			// 技列を横に連結する=加算という関係が伝わりにくいため、「1発目」「2発目」…の
			// 順序キャプションを添える。orderLabelは左側の狭い帯として残し、それ以外
			// (技名行・ヒット回数行・条件・結果表示)は新設のcolBody(.damage-column-body、
			// 右側)にまとめる。
			const orderLabel = document.createElement("span");
			orderLabel.className = "damage-column-order-label";
			orderLabel.textContent = `${index + 1}`;
			col.appendChild(orderLabel);
			const colBody = document.createElement("div");
			colBody.className = "damage-column-body";
			col.appendChild(colBody);
			const moveAndChips = document.createElement("div");
			moveAndChips.className = "damage-column-move-and-chips";
			colBody.appendChild(moveAndChips);

			// 通常カードは表示専用とし、編集は技列クリックで開く詳細パネルへ集約する。
			const moveRow = document.createElement("div");
			moveRow.className = "damage-column-move-row";
			const moveIdentity = document.createElement("div");
			moveIdentity.className = "damage-column-move-identity";
			const moveTypeIcon = document.createElement("img");
			moveTypeIcon.className = "damage-column-move-type-icon";
			moveTypeIcon.alt = "";
			moveTypeIcon.hidden = true;
			moveTypeIcon.addEventListener("error", () => { moveTypeIcon.hidden = true; });
			const moveText = document.createElement("span");
			moveText.className = "damage-column-move-text";
			const hitText = document.createElement("span");
			hitText.className = "damage-column-hitcount-text";
			hitText.hidden = true;
			moveIdentity.append(moveTypeIcon, moveText, hitText);
			moveRow.appendChild(moveIdentity);
			moveAndChips.appendChild(moveRow);
			const refreshDisplay = (): void => {
				const name = attack.moveName.trim();
				moveText.textContent = name || "技未設定";
				moveText.classList.toggle("is-placeholder", name === "");
				const type = moveDetailMapCache?.get(name)?.type ?? null;
				const iconUrl = type ? typeIconUrl(type) : null;
				moveTypeIcon.hidden = !iconUrl;
				if (iconUrl) moveTypeIcon.src = iconUrl;
				else moveTypeIcon.removeAttribute("src");
				hitText.hidden = true;
				if (!name) {
					attack.hitCount = 1;
					return;
				}
				void multiHitMapPromise().then((multiHitMap) => {
					if (!row.attacks.includes(attack) || attack.moveName.trim() !== name) return;
					const range = multiHitMap.get(name);
					if (!range) {
						attack.hitCount = 1;
						return;
					}
					attack.hitCount = clampInt(attack.hitCount, range[0], range[1]);
					if (attack.hitCount < 2) return;
					hitText.textContent = `${attack.hitCount}ヒット`;
					hitText.hidden = false;
				});
			};
			columnDisplayRefreshers.set(attack, refreshDisplay);
			refreshDisplay();
			void loadMoveDetailMap().then(() => {
				if (row.attacks.includes(attack)) refreshDisplay();
			});

			// この技に実際に効いている条件(天候・フィールド・壁も、この技だけの急所・ランク
			// 補正等も区別せず)をまとめて一覧するチップ。.damage-row-condition-chipsを
			// 技列1枚につき1個生成する(collectConditionChips/refreshRowConditionChips参照。
			// ONの項目だけを出し、既定値のものは出さない)。
			const conditionChips = document.createElement("div");
			conditionChips.className = "damage-row-condition-chips";
			conditionChips.hidden = true;
			row.columnChipEls.push(conditionChips);

			// 技名と同じ行の右側に、現在有効な詳細条件のチップをまとめる。
			const conditions = document.createElement("div");
			conditions.className = "damage-column-conditions";
			conditions.appendChild(conditionChips);
			moveRow.appendChild(conditions);

			// 累計で既に撃破済みになった以降の列を控えめに示すキャプション
			// (renderColumnDisplaysのcomputeConfirmedKillAttackCount参照。数値自体は
			// 変えない=列は独立判定のまま)。
			const overkillNote = document.createElement("p");
			overkillNote.className = "damage-column-overkill-note";
			overkillNote.hidden = true;
			moveAndChips.appendChild(overkillNote);

			attachColumnLongPressDelete(col, row, attack);

			// 最下段(区切り線の下)に「技ごとのダメ・致死率」。margin-top:autoで
			// 箱の下端に固定されるため、上の条件欄が増えても位置が変わらない。
			const footer = document.createElement("div");
			footer.className = "damage-column-footer";
			const resultP = document.createElement("p");
			resultP.className = "severity-bar damage-column-result tnum";
			resultP.textContent = "(計算前)";
			resultP.dataset.severity = "none";
			resultP.title = TOTAL_RESULT_HINT;
			footer.appendChild(resultP);
			colBody.appendChild(footer);
			row.columnResultEls.push(resultP);

			row.columnsEl!.appendChild(col);
		});

		// 「加算条件追加ボタン」(DamageCard.pngの右下)。
		// 技列は最大3つまで。3つに達したら押せなくするだけでなく、ラベル文言そのものを
		// 理由の説明に差し替える(titleのhoverだけに頼らない = 見ただけで「なぜ押せないか」が
		// 分かる状態にする)。
		const addButton = document.createElement("button");
		addButton.type = "button";
		addButton.className = "damage-add-column-button";
		// 上限はレイアウト幅で変わる(モバイルは2、デスクトップは3。currentMaxColumnsToAdd参照)。
		const maxColumns = currentMaxColumnsToAdd();
		const isAtMax = row.attacks.length >= maxColumns;
		// 上限到達時の説明文はホバー用title向けに残しつつ、スロット自体を
		// data-max="true"でCSS側から隠す(DOMは残す。下のCSS
		// .damage-add-column-slot[data-max="true"]参照)。
		if (row.addColumnSlotEl) row.addColumnSlotEl.dataset.max = String(isAtMax);
		if (isAtMax) {
			addButton.disabled = true;
			addButton.textContent = `技列は最大${maxColumns}つまでです`;
			addButton.title = `技列(加算条件)は最大${maxColumns}つまでしか追加できません`;
		} else {
			// DamageCard.pngの「加算条件追加ボタン」にあたる。
			addButton.textContent = "＋ 技を追加";
			addButton.title = "加算する技を追加する(上から順に当てた加算ダメージ計算になります)";
		}
		// 実際に技を1つ追加する処理はaddAttackColumn(row)(fillFirstMoveCandidateの直後で定義)
		// へ切り出している。
		addButton.addEventListener("click", () => addAttackColumn(row));
		(row.addColumnSlotEl ?? row.columnsEl).appendChild(addButton);

		renderColumnDisplays(row);
		// 列を作り直すと条件チップの器(.damage-row-condition-chips)も作り直されるため、
		// 中身をここで再描画する。
		refreshRowConditionChips(row);
		// 列を作り直すとis-selectedマーカーも失われるため(columnsEl.innerHTMLを丸ごと
		// 差し替えているため)、選択中ならここで再適用する。選択されていた技列自体が
		// 削除された場合は選択を完全に解除する(サイドバーは空状態に戻る。既存データ自体は
		// 失われない)。selectedRow/selectedColumnはshared-core.tsへ移設したため、
		// getSelectedRow/getSelectedColumn/clearSelection経由で読み書きする。
		if (getSelectedRow() === row) {
			const currentSelectedColumn = getSelectedColumn();
			if (getSelectedIsBuild()) {
				applyBuildSelectionMark(row);
			} else if (currentSelectedColumn && row.attacks.includes(currentSelectedColumn)) {
				applySelectionMarks(row, currentSelectedColumn);
			} else {
				clearSelection();
			}
			renderDetailPanel();
		}
	}

	// --- 詳細設定サイドバーに表示する内容 ---
	// 天候・地形・壁・急所・ランク補正・状態異常・テラスタル発動は、実装上はすべて
	// DamageColumnStateとして技カード(攻撃列)ごとに保持している。全項目は技列をクリック
	// したときのサイドバー(renderColumnLevelDetailPanel)からその技カード1枚だけを書き換える、
	// 単純な1階層の設計になっている。保存フォーマット(技カードごとのフィールド)は
	// opponent-notes-validation.ts側と一致している。
	// ステルスロック等の設置技はcalc_damages/calc_lethalではイベントが発火せず効果ゼロと
	// 判明しているため、ここには置かない。
	// 壁・ランクの判定はUI上のスカラー値(wallEnabled/attackerRank/defenderRank)で行う。
	// attackerBoosts等の配列はresolveColumnDerivedFields()が技名の分類判明後に算出する
	// 派生値なので、値がまだ0のまま(技名未入力・分類不明の間)でもスカラー側は即座に
	// 正しい状態を反映できる。

	// 既定以外の条件を短いラベルの配列にする(技列ごとのONチップ表示用)。
	// 天候・フィールド・壁・急所・ランク補正・状態異常・テラスタル発動のうち、
	// 既定でない値がすべて漏れなくここに出ること。この関数は1つのDamageColumnStateだけを
	// 見る実装で、カード全体/技ごとを区別する必要はない。
	type ConditionGroup = { label: "攻撃側" | "防御側" | null; chips: string[] };

	function collectConditionGroups(a: DamageColumnState, showTera: boolean): ConditionGroup[] {
		const attacker: string[] = [];
		const defender: string[] = [];
		const field: string[] = [];
		if (a.critical) attacker.push("急所");
		if (a.attackerAilment) attacker.push(a.attackerAilment);
		if (showTera && a.attackerTerastallized) attacker.push("テラスタル");
		if (a.wallEnabled) defender.push("壁");
		if (a.stealthRock) defender.push("ステルスロック");
		const spikes = clampInt(a.spikes, 0, 3);
		if (spikes > 0) defender.push(`まきびし${spikes}`);
		if (a.defenderAilment) defender.push(a.defenderAilment);
		if (showTera && a.defenderTerastallized) defender.push("テラスタル");
		if (a.weather) field.push(a.weather);
		if (a.terrain) field.push(a.terrain);
		if (a.attackerRank !== 0) attacker.push(`ランク${a.attackerRank > 0 ? "+" : ""}${a.attackerRank}`);
		if (a.defenderRank !== 0) defender.push(`ランク${a.defenderRank > 0 ? "+" : ""}${a.defenderRank}`);
		return [
			{ label: "攻撃側", chips: attacker },
			{ label: "防御側", chips: defender },
			{ label: null, chips: field },
		].filter((group) => group.chips.length > 0);
	}

	// 1枚の技列チップ器(.damage-row-condition-chips)の中身を、その技カードの
	// 現在値で作り直す。
	function renderConditionChipsInto(container: HTMLElement, attack: DamageColumnState): void {
		container.innerHTML = "";
		// 非テラスレギュレーションでも計算に残っているテラスタル設定を
		// ユーザーが把握できるよう常に表示する。
		const groups = collectConditionGroups(attack, true);
		container.hidden = groups.length === 0;
		groups.forEach((group) => {
			if (group.label) {
				const groupLabel = document.createElement("span");
				groupLabel.className = "damage-condition-group-label";
				groupLabel.textContent = group.label;
				container.appendChild(groupLabel);
			}
			for (const label of group.chips) {
				const span = document.createElement("span");
				span.className = "badge badge-muted damage-condition-chip";
				span.textContent = label;
				container.appendChild(span);
			}
		});
	}

	function isNarrowLayout(): boolean {
		return true;
	}
	// ドット絵(モバイル)と公式アートワーク(デスクトップ)の切り替えは
	// 画像URLの差でしかないため、幅の境界をまたいだ瞬間に各行のrefreshSprite()を呼び直す
	// 必要がある。renderRowのクロージャ内の関数をWeakMapで
	// 行に紐づけておき、下方のmatchMediaリスナーがrows(表示中の行)を回して呼ぶ
	// (行ごとにリスナーを足すと、削除した行のクロージャがリスナー経由で残ってしまう)。
	const rowSpriteRefreshers = new WeakMap<DamageRowState, () => void>();

	// テラスタイプ選択ボックスはLeftPanel.astro
	// 226〜249行目・left-panel.ts 500〜613行目の#tera-dropdown-button/#tera-dropdown-list
	// (ボタン+リストボックスのカスタムドロップダウン)と同じ見た目・挙動を持つが、左パネル側は
	// ページに1個しか無い前提でid固定のgetElementById()を使っているのに対し、ダメージカードは
	// 1枚につき1個・複数枚同時に存在しうるため、idを一切使わずクロージャで状態を閉じ込める
	// ファクトリ関数として書き直した(コピーではなく複数インスタンス生成できる形に再実装)。
	// CSSは#opponent-notes-section .tera-dropdown-button/.tera-dropdown-list/
	// .tera-dropdown-image/.tera-dropdown-placeholder/.tera-dropdown-option等
	// (DamageCalcSection.astroの<style is:global>、左パネルの#edit-form接頭辞ルールと
	// 値を共有)を参照する。
	function buildTeraDropdown(
		initialValue: string,
		ariaLabelPrefix: string,
		onChange: (value: string) => void,
	): { wrap: HTMLElement; setValue: (value: string) => void } {
		const wrap = document.createElement("div");
		wrap.className = "damage-row-tera-field tera-dropdown-wrap";

		const button = document.createElement("button");
		button.type = "button";
		button.className = "tera-dropdown-button";
		button.setAttribute("aria-haspopup", "listbox");
		button.setAttribute("aria-expanded", "false");

		const image = document.createElement("img");
		image.className = "tera-dropdown-image";
		image.alt = "";
		image.style.display = "none";
		const placeholder = document.createElement("span");
		placeholder.className = "tera-dropdown-placeholder";
		placeholder.textContent = "テラスタルなし";
		button.append(image, placeholder);

		const list = document.createElement("ul");
		list.className = "tera-dropdown-list";
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", `${ariaLabelPrefix}を選択`);
		list.hidden = true;

		let value = initialValue;
		const optionEls: { value: string; li: HTMLLIElement }[] = [];

		function updateButton(): void {
			const isUnselected = value === "";
			button.classList.toggle("is-tera-unselected", isUnselected);
			button.setAttribute("aria-label", value ? `${ariaLabelPrefix}: ${value}` : `${ariaLabelPrefix}: 未選択`);
			placeholder.classList.toggle("is-tera-value-text", !isUnselected);
			if (isUnselected) {
				image.style.display = "none";
				placeholder.textContent = "テラスタルなし";
				return;
			}
			placeholder.textContent = value;
			const url = teraTypeIconUrl(value);
			if (!url) {
				image.style.display = "none";
				return;
			}
			image.alt = value;
			image.onload = () => {
				image.style.display = "";
			};
			image.onerror = () => {
				image.style.display = "none";
			};
			image.src = url;
		}

		function closeList(): void {
			list.hidden = true;
			button.setAttribute("aria-expanded", "false");
		}
		function openList(): void {
			for (const opt of optionEls) opt.li.classList.toggle("is-active", opt.value === value);
			list.hidden = false;
			button.setAttribute("aria-expanded", "true");
		}
		button.addEventListener("click", () => {
			if (list.hidden) openList();
			else closeList();
		});
		// リストの外側をクリックしたら閉じる(左パネル側と同じ一般的な挙動。pitfalls.md参照)。
		document.addEventListener("click", (e) => {
			if (list.hidden) return;
			const target = e.target as Node;
			if (button.contains(target) || list.contains(target)) return;
			closeList();
		});
		button.addEventListener("keydown", (e) => {
			if (e.key === "Escape") closeList();
		});

		function addOption(optValue: string, label: string): void {
			const li = document.createElement("li");
			li.className = "tera-dropdown-option";
			li.setAttribute("role", "option");
			li.tabIndex = -1;
			li.dataset.value = optValue;
			if (optValue === "") {
				li.setAttribute("aria-label", "テラスタルなし");
				const textEl = document.createElement("span");
				textEl.className = "tera-dropdown-option-text";
				textEl.textContent = "テラスタルなし";
				li.appendChild(textEl);
			} else {
				li.setAttribute("aria-label", label);
				const imgEl = document.createElement("img");
				imgEl.className = "tera-dropdown-option-image";
				imgEl.alt = label;
				const url = teraTypeIconUrl(optValue);
				if (url) imgEl.src = url;
				li.appendChild(imgEl);
				const textEl = document.createElement("span");
				textEl.className = "tera-dropdown-option-text";
				textEl.textContent = label;
				li.appendChild(textEl);
			}
			li.addEventListener("click", () => {
				if (value !== optValue) {
					value = optValue;
					updateButton();
					onChange(value);
				}
				for (const opt of optionEls) opt.li.classList.toggle("is-active", opt.value === value);
				closeList();
			});
			list.appendChild(li);
			optionEls.push({ value: optValue, li });
		}

		addOption("", "テラスタルなし");
		for (const t of TERA_TYPES) addOption(t, t);

		wrap.append(button, list);
		updateButton();

		// 種族プリセット適用時に、クリック操作を介さず外部から表示だけを更新できるようにする
		// (onChangeは呼ばない。値の反映・再計算・保存のトリガーは呼び出し側=
		// applyOpponentBuildPreset側でまとめて行う)。
		function setValue(newValue: string): void {
			value = newValue;
			for (const opt of optionEls) opt.li.classList.toggle("is-active", opt.value === value);
			updateButton();
		}

		return { wrap, setValue };
	}

	// --- 行(相手1体)のDOM構築 ---
	function renderRow(row: DamageRowState): HTMLElement {
		const root = document.createElement("article");
		// ダメージ計算1件=対戦相手1体は追加/削除できるコレクション要素なので、
		// 基底.card(global.css)+ページ固有の.card-damageにする。
		root.className = "card card-damage";
		row.root = root;

		const body = document.createElement("div");
		body.className = "damage-row-body";
		root.appendChild(body);

		// --- 左側: 相手ビルドの箱(DamageCard.pngの左側のボックス) ---
		// この箱のクリックは無反応(サイドバーを開くのは技列の箱だけ)。選択マーカー用の
		// row.buildEl参照は持たない。
		const buildEl = document.createElement("div");
		buildEl.className = "damage-row-build";
		body.appendChild(buildEl);

		// 相手アイコンは最初の5段分(攻守切替+種族名/特性/持ち物/テラスの4段)を使う。
		// buildMain/buildLeftを先に組み立て、actionsRow(1段目)をbuildLeftの中に入れることで
		// buildLeftの高さ=actionsRow+buildFields(1〜5段目)になり、隣のspriteBox(下記)が
		// align-items:stretchでその高さに追随する。
		const buildMain = document.createElement("div");
		buildMain.className = "damage-row-build-main";
		buildEl.appendChild(buildMain);
		const matchup = document.createElement("div");
		matchup.className = "damage-build-matchup";
		buildMain.appendChild(matchup);
		const buildLeft = document.createElement("div");
		buildLeft.className = "damage-row-build-left";
		buildMain.appendChild(buildLeft);

		// 自分側のドット絵と相手スプライトをつなぐ矢印が攻守切り替えを兼ねる。
		const actionsRow = document.createElement("div");
		actionsRow.className = "damage-row-actions";
		matchup.appendChild(actionsRow);

		// 「攻撃」「防御」の2値セグメントコントロールにする(role="radiogroup"+role="radio"。
		// refreshDirectionUi参照)。
		const directionToggle = document.createElement("div");
		directionToggle.className = "damage-row-direction-toggle";
		directionToggle.setAttribute("role", "radiogroup");
		directionToggle.setAttribute("aria-label", "攻守の向き");
		const attackOption = document.createElement("button");
		attackOption.type = "button";
		attackOption.className = "damage-row-direction-option";
		// 攻撃/防御を区別するdata-role属性
		// (CSSは.damage-row-direction-option[data-role="attack"/"defense"][aria-checked="true"]参照)。
		attackOption.dataset.role = "attack";
		attackOption.setAttribute("role", "radio");
		function makeSelfSpriteBadge(): HTMLElement {
			const badge = document.createElement("span");
			badge.className = "damage-direction-self-badge";
			const image = document.createElement("img");
			image.className = "damage-direction-self-image";
			image.alt = "";
			image.style.display = "none";
			const fallback = document.createElement("span");
			fallback.className = "damage-direction-self-fallback";
			void applySprite(image, fallback, selfSpeciesName, spriteUrl);
			badge.append(image, fallback);
			return badge;
		}
		const attackSelfBadge = makeSelfSpriteBadge();
		const attackArrow = document.createElement("span");
		attackArrow.className = "damage-direction-arrow";
		attackArrow.setAttribute("aria-hidden", "true");
		attackArrow.textContent = ">>>";
		attackOption.append(attackSelfBadge, attackArrow);
		const defenseOption = document.createElement("button");
		defenseOption.type = "button";
		defenseOption.className = "damage-row-direction-option";
		defenseOption.dataset.role = "defense";
		defenseOption.setAttribute("role", "radio");
		const defenseArrow = document.createElement("span");
		defenseArrow.className = "damage-direction-arrow";
		defenseArrow.setAttribute("aria-hidden", "true");
		defenseArrow.textContent = ">>>";
		const defenseSelfBadge = makeSelfSpriteBadge();
		defenseOption.append(defenseSelfBadge, defenseArrow);
		directionToggle.append(attackOption, defenseOption);
		actionsRow.appendChild(directionToggle);

		// 2〜5段目: カードには相手ビルドの読み取り専用サマリーだけを置く。
		const buildFields = document.createElement("div");
		buildFields.className = "damage-row-build-fields";
		buildLeft.appendChild(buildFields);

		const nameRow = document.createElement("div");
		nameRow.className = "damage-build-readonly-name-row";
		buildFields.appendChild(nameRow);
		const nameText = document.createElement("span");
		nameText.className = "damage-build-readonly-name";
		nameRow.appendChild(nameText);

		const readonlyFields = document.createElement("div");
		readonlyFields.className = "damage-build-readonly-fields";
		buildFields.appendChild(readonlyFields);
		function makeReadonlyField(labelText: string): { field: HTMLElement; value: HTMLElement } {
			const field = document.createElement("span");
			field.className = "damage-build-readonly-field";
			if (labelText) {
				const label = document.createElement("span");
				label.className = "damage-build-readonly-label";
				label.textContent = labelText;
				field.appendChild(label);
			}
			const value = document.createElement("span");
			value.className = "damage-build-readonly-value";
			field.appendChild(value);
			readonlyFields.appendChild(field);
			return { field, value };
		}
		const { field: abilityReadonlyField, value: abilityText } = makeReadonlyField("");
		abilityReadonlyField.classList.add("damage-build-readonly-ability-line");
		nameRow.appendChild(abilityReadonlyField);
		const readonlyTera = document.createElement("span");
		readonlyTera.className = "damage-build-readonly-tera";
		readonlyTera.hidden = true;
		const readonlyTeraImg = document.createElement("img");
		readonlyTeraImg.className = "damage-build-readonly-tera-icon";
		readonlyTeraImg.width = 20;
		readonlyTeraImg.height = 20;
		readonlyTeraImg.alt = "";
		readonlyTeraImg.style.display = "none";
		const readonlyTeraFallback = document.createElement("span");
		readonlyTeraFallback.className = "damage-build-readonly-tera-fallback";
		const readonlyTeraText = document.createElement("span");
		readonlyTeraText.className = "damage-build-readonly-tera-name";
		readonlyTera.append(readonlyTeraImg, readonlyTeraFallback, readonlyTeraText);
		readonlyFields.appendChild(readonlyTera);
		const { field: itemReadonlyField, value: itemText } = makeReadonlyField("持ち物");
		itemReadonlyField.classList.add("damage-build-readonly-item-line");
		itemReadonlyField.setAttribute("aria-label", "持ち物");
		itemReadonlyField.hidden = true;

		const spriteBox = document.createElement("div");
		spriteBox.className = "damage-sprite-box";
		const spriteImg = document.createElement("img");
		spriteImg.className = "sprite-icon";
		spriteImg.width = 104;
		spriteImg.height = 104;
		spriteImg.alt = "";
		spriteImg.style.display = "none";
		const spriteFallback = document.createElement("span");
		spriteFallback.className = "sprite-fallback";
		const itemBadge = document.createElement("span");
		itemBadge.className = "damage-item-badge";
		// applyItemImage()は画像読み込み(onload/onerror)を待って表示を切り替えるので、
		// 既定は非表示にしておく(持ち物なしの相手で空バッジ・壊れ画像アイコンが
		// 一瞬でも出ないようにする)。
		itemBadge.hidden = true;
		const itemImg = document.createElement("img");
		itemImg.className = "damage-item-image";
		// バッジのCSS(width/height:42px)に合わせる(表示サイズはCSSのwidth:100%/
		// height:100%が決めるため実害は無いが、img自身の意図する解像度を一致させておく)。
		itemImg.width = 42;
		itemImg.height = 42;
		itemImg.alt = "";
		itemImg.style.display = "none";
		itemBadge.appendChild(itemImg);
		const itemBadgePlaceholder = document.createElement("span");
		itemBadgePlaceholder.className = "damage-item-badge-placeholder";
		itemBadgePlaceholder.setAttribute("aria-hidden", "true");
		itemBadgePlaceholder.textContent = "?";
		itemBadge.appendChild(itemBadgePlaceholder);
		spriteBox.append(spriteImg, spriteFallback, itemBadge);
		matchup.appendChild(spriteBox);

		const detailForm = document.createElement("div");
		detailForm.className = "damage-detail-panel-body-inner damage-build-detail-form";
		rowBuildDetailForms.set(row, detailForm);
		const detailFields = document.createElement("div");
		detailFields.className = "damage-build-detail-fields";
		detailForm.appendChild(detailFields);
		function makeDetailField(labelText: string, control: HTMLElement): HTMLElement {
			const label = document.createElement("div");
			label.className = "damage-build-detail-field";
			const labelTextEl = document.createElement("span");
			labelTextEl.className = "field-label damage-build-detail-field-label";
			labelTextEl.textContent = labelText;
			label.append(labelTextEl, control);
			return label;
		}
		const detailIdentityRow = document.createElement("div");
		detailIdentityRow.className = "damage-build-detail-identity-row";
		detailFields.appendChild(detailIdentityRow);
		const detailDirectionToggle = document.createElement("div");
		detailDirectionToggle.className = "damage-row-direction-toggle damage-build-detail-direction-toggle";
		detailDirectionToggle.setAttribute("role", "radiogroup");
		detailDirectionToggle.setAttribute("aria-label", "攻守の向き");
		const detailAttackOption = document.createElement("button");
		detailAttackOption.type = "button";
		detailAttackOption.className = "damage-row-direction-option";
		detailAttackOption.dataset.role = "attack";
		detailAttackOption.setAttribute("role", "radio");
		detailAttackOption.textContent = "攻撃";
		const detailDefenseOption = document.createElement("button");
		detailDefenseOption.type = "button";
		detailDefenseOption.className = "damage-row-direction-option";
		detailDefenseOption.dataset.role = "defense";
		detailDefenseOption.setAttribute("role", "radio");
		detailDefenseOption.textContent = "防御";
		detailDirectionToggle.append(detailAttackOption, detailDefenseOption);
		detailIdentityRow.appendChild(detailDirectionToggle);

		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.setAttribute("list", "pokemon-list");
		nameInput.placeholder = "相手ポケモン";
		nameInput.setAttribute("aria-label", "相手ポケモン名");
		nameInput.autocomplete = "off";
		nameInput.value = row.name;
		// 相手側の動的入力にも左パネルと同じIME安全なdatalist補助を適用する。
		attachKanaTypeAhead(nameInput, el<HTMLDataListElement>("pokemon-list"));
		const nameField = makeDetailField("種族名", nameInput);
		nameField.classList.add("damage-build-detail-name-field");
		detailIdentityRow.appendChild(nameField);
		nameInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			nameInput.blur();
		});

		// モバイル専用UIでも相手ポケモンはドット絵で統一する。
		function refreshSprite(): void {
			void applySprite(
				spriteImg,
				spriteFallback,
				row.name.trim(),
				spriteUrl,
			);
		}
		rowSpriteRefreshers.set(row, refreshSprite);
		function refreshTypeBadge(): void {
			const teraType = row.teraType.trim();
			readonlyTera.hidden = teraType === "";
			readonlyTeraText.textContent = teraType;
			void applyTeraImage(readonlyTeraImg, readonlyTeraFallback, teraType);
		}
		function refreshItemImage(): void {
			void applyItemImage(itemImg, row.itemName.trim());
		}
		let refreshReadonlyEvs = (): void => {};
		function refreshBuildSummary(): void {
			nameText.textContent = row.name.trim() || "相手ポケモン未設定";
			abilityText.textContent = row.abilityName.trim() || "未設定";
			itemText.textContent = "";
			refreshReadonlyEvs();
		}

		function onFieldInput(): void {
			refreshBuildSummary();
			scheduleRowCalc(row);
			scheduleRowSave(row);
		}

		nameInput.addEventListener("input", () => {
			row.name = nameInput.value.trim();
			refreshSprite();
			onFieldInput();
		});
		// 種族名が確定した(blur、またはpokemon-listのdatalist選択によるchange)
		// タイミングでのみ特性候補を作り直す(理由は上のabilitySelectコメント参照)。
		// 同じタイミングで、種族ごとのローカルプリセット(性格・特性・
		// 持ち物・テラス・努力値)の自動適用も試みる(applyOpponentBuildPresetは同期関数。
		// 下方でabilitySelect/itemInput/teraDropdown/statPanel定義後に関数宣言するが、
		// 関数宣言はホイストされ、実行時(=ユーザーが種族名を確定した後)には既に
		// 全て初期化済みのため、rebuildRowAbilityOptions/applyRowMegaStoneAutofillと
		// 同じ理由で呼び出し位置がここでも問題ない)。
		// 呼び出し順の意図: applyOpponentBuildPresetは同期的に完了するため、この後で
		// 非同期に再開するrebuildRowAbilityOptions(previousValueを見て候補に無ければ
		// abilities[0]へフォールバック)・applyRowMegaStoneAutofill(row.itemNameが
		// 非空なら何もしない)の判定に、プリセットで設定した値がそのまま使われる
		// (=プリセットの特性/持ち物が、既存の自動候補選定で上書きされない)。
		nameInput.addEventListener("change", () => {
			void rebuildRowAbilityOptions(nameInput.value.trim()).then(() => {
				// ユーザーの種族確定に伴うJS側の特性フォールバックも自動入力対象。
				notifyDetailAbilityChanged(row, row.abilityName);
			});
			void applyRowMegaStoneAutofill(nameInput.value.trim());
			applyOpponentBuildPreset(nameInput.value.trim());
		});


		const deleteRowButton = document.createElement("button");
		deleteRowButton.type = "button";
		deleteRowButton.className = "btn-ghost damage-row-icon-button damage-row-delete-button";
		deleteRowButton.textContent = "×";
		deleteRowButton.title = "この相手を削除";
		deleteRowButton.setAttribute("aria-label", "この相手を削除");
		deleteRowButton.addEventListener("click", () => void deleteRow(row));
		root.appendChild(deleteRowButton);

		// 攻守切り替え。「攻撃」「防御」どちらを押しても、押した側の値になる
		// (同じ側を押しても意味は変わらないが、setDirectionは冪等なので害はない)。
		// 技列に入れる技は常に攻撃側の技なので、切り替えると技列の意味も入れ替わる
		// (=そのことがボタンとplaceholderから読み取れる必要がある)。
		function refreshDirectionUi(): void {
			const selfAttacks = row.direction !== "defense";
			attackOption.setAttribute("aria-checked", String(selfAttacks));
			defenseOption.setAttribute("aria-checked", String(!selfAttacks));
			detailAttackOption.setAttribute("aria-checked", String(selfAttacks));
			detailDefenseOption.setAttribute("aria-checked", String(!selfAttacks));
			root.dataset.direction = selfAttacks ? "attack" : "defense";
			const attackDetail = "この個体の技で相手を攻撃する計算です。";
			const defenseDetail = "相手の技をこの個体が受ける計算です。";
			attackOption.title = attackDetail;
			attackOption.setAttribute("aria-label", `攻撃。${attackDetail}`);
			defenseOption.title = defenseDetail;
			defenseOption.setAttribute("aria-label", `防御。${defenseDetail}`);
			detailAttackOption.title = attackDetail;
			detailAttackOption.setAttribute("aria-label", `攻撃。${attackDetail}`);
			detailDefenseOption.title = defenseDetail;
			detailDefenseOption.setAttribute("aria-label", `防御。${defenseDetail}`);
		}
		function setDirection(next: "attack" | "defense"): void {
			if (row.direction === next) return;
			row.direction = next;
			// ユーザー入力済みの技は保ち、空欄だけ切替後の候補で補う。
			for (const column of row.attacks) fillFirstMoveCandidate(row, column);
			refreshDirectionUi();
			// 技列のplaceholder/aria-label(「技」⇄「相手の技」)も向きで変わるため作り直す。
			// renderColumns()自身が末尾でselectedRow===rowなら
			// renderDetailPanel()を呼ぶため、サイドバー側の向き別ラベル
			// (「攻撃(自分)」⇄「攻撃(相手)」、壁のラベル)もここで自動的に追随する。
			renderColumns(row);
			onFieldInput();
		}
		function onDirectionOptionClick(clicked: "attack" | "defense"): void {
			if (isNarrowLayout()) {
				setDirection(row.direction === "defense" ? "attack" : "defense");
				return;
			}
			setDirection(clicked);
		}
		attackOption.addEventListener("click", () => onDirectionOptionClick("attack"));
		defenseOption.addEventListener("click", () => onDirectionOptionClick("defense"));
		detailAttackOption.addEventListener("click", () => onDirectionOptionClick("attack"));
		detailDefenseOption.addEventListener("click", () => onDirectionOptionClick("defense"));

		const selectsRow = document.createElement("div");
		selectsRow.className = "damage-build-detail-grid";
		detailFields.appendChild(selectsRow);


		const abilitySelect = document.createElement("select");
		abilitySelect.setAttribute("aria-label", "相手の特性");
		{
			// rebuildRowAbilityOptions()の初回解決(loadAbilitiesMap()のfetch完了)までの
			// 仮表示。保存済みの値をそのまま1件だけ置く(左パネルのSSR初期値と同じ考え方)。
			const placeholderOpt = document.createElement("option");
			placeholderOpt.value = row.abilityName;
			placeholderOpt.textContent = row.abilityName || "特性";
			placeholderOpt.selected = true;
			abilitySelect.appendChild(placeholderOpt);
		}
		abilitySelect.title = row.abilityName;
		let abilityRequestToken = 0;
		async function rebuildRowAbilityOptions(speciesName: string): Promise<void> {
			const token = ++abilityRequestToken;
			const abilitiesMap = await loadAbilitiesMap();
			if (token !== abilityRequestToken) return; // より新しい呼び出しに追い越された
			const trimmed = speciesName.trim();
			const abilities = trimmed ? abilitiesMap.get(trimmed) ?? [] : [];
			const previousValue = abilitySelect.value;
			abilitySelect.innerHTML = "";
			if (abilities.length === 0) {
				// 種族名が空、または候補が引けない(未知の種族名・入力途中)場合は
				// 左パネルと同じくdisabled+プレースホルダにする。
				abilitySelect.disabled = true;
				const emptyOpt = document.createElement("option");
				emptyOpt.value = "";
				emptyOpt.textContent = "特性";
				abilitySelect.appendChild(emptyOpt);
				abilitySelect.value = "";
				abilitySelect.title = "";
				if (previousValue !== "") {
					row.abilityName = "";
					onFieldInput();
				}
				// モバイルの特性ループボタン(下方のabilityCycleButton)も同じ状態へ揃える。
				refreshAbilityCycleButton();
				return;
			}
			abilitySelect.disabled = false;
			const placeholderOpt = document.createElement("option");
			placeholderOpt.value = "";
			placeholderOpt.textContent = "特性を選択";
			abilitySelect.appendChild(placeholderOpt);
			for (const a of abilities) {
				const opt = document.createElement("option");
				opt.value = a;
				opt.textContent = a;
				abilitySelect.appendChild(opt);
			}
			abilitySelect.value = abilities.includes(previousValue) ? previousValue : abilities[0];
			abilitySelect.title = abilitySelect.value;
			if (abilitySelect.value !== previousValue) {
				row.abilityName = abilitySelect.value;
				onFieldInput();
			}
			// 候補を作り直したあとの確定値をモバイルの特性ループボタンへ反映する。
			refreshAbilityCycleButton();
		}
		abilitySelect.addEventListener("change", () => {
			row.abilityName = abilitySelect.value;
			// 今回の要件: 相手特性変更時だけ、各技列の天候・フィールド自動入力を試す。
			notifyDetailAbilityChanged(row, row.abilityName);
			abilitySelect.title = abilitySelect.value;
			onFieldInput();
			refreshAbilityCycleButton();
		});
		selectsRow.appendChild(makeDetailField("特性", abilitySelect));

		function refreshAbilityCycleButton(): void {
			refreshBuildSummary();
		}
		refreshAbilityCycleButton();
		// 初期描画時点(保存済みメモの復元・新規行の生成いずれも)で、既にrow.nameが
		// 入っていれば候補を組み立てておく(左パネルのvoid rebuildAbilityOptions(...)と
		// 同じ考え方)。
		void rebuildRowAbilityOptions(row.name);

		const itemInput = document.createElement("input");
		itemInput.type = "text";
		itemInput.setAttribute("list", "item-list");
		itemInput.placeholder = "アイテム";
		itemInput.setAttribute("aria-label", "相手のアイテム");
		itemInput.autocomplete = "off";
		itemInput.value = row.itemName;
		itemInput.title = row.itemName;
		attachKanaTypeAhead(itemInput, el<HTMLDataListElement>("item-list"));
		itemInput.addEventListener("input", () => {
			row.itemName = itemInput.value.trim();
			itemInput.title = row.itemName;
			refreshItemImage();
			onFieldInput();
		});
		const itemField = makeDetailField("アイテム", itemInput);
		const itemLockNote = document.createElement("span");
		itemLockNote.className = "damage-build-detail-lock-note";
		itemLockNote.textContent = "メガストーン固定";
		itemLockNote.hidden = true;
		itemField.appendChild(itemLockNote);
		selectsRow.appendChild(itemField);

		itemInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			itemInput.blur();
		});

		const megaStoneLockedTitle = "メガシンカ中はアイテムをメガストーンに固定します";
		let rowMegaStoneAutofillToken = 0;
		function syncItemBadgeDisabled(): void {
			itemLockNote.hidden = !itemInput.disabled;
			if (itemInput.disabled) {
				itemInput.dataset.megaLocked = "true";
			} else {
				delete itemInput.dataset.megaLocked;
			}
		}
		async function applyRowMegaStoneAutofill(speciesName: string): Promise<void> {
			const token = ++rowMegaStoneAutofillToken;
			const stoneName = await resolveMegaStoneItem(speciesName);
			if (token !== rowMegaStoneAutofillToken) return; // より新しい呼び出しに追い越された
			if (!stoneName) {
				itemInput.disabled = false;
				itemInput.title = row.itemName;
				syncItemBadgeDisabled();
				return;
			}
			if (row.itemName.trim() === stoneName) {
				itemInput.disabled = true;
				itemInput.title = megaStoneLockedTitle;
				syncItemBadgeDisabled();
				return;
			}
			row.itemName = stoneName;
			itemInput.value = stoneName;
			refreshItemImage();
			onFieldInput();
			flashAutofillHint(itemInput, () => {
				itemInput.title = megaStoneLockedTitle;
			});
			itemInput.disabled = true;
			syncItemBadgeDisabled();
		}
		// 初期描画時点(保存済みメモの復元)で既にrow.nameがメガシンカ種族なら、保存済みの
		// 持ち物が誤っていても正しいメガストーンへ補正しロックする(rebuildRowAbilityOptionsと
		// 同じ考え方)。
		void applyRowMegaStoneAutofill(row.name);

		const teraDropdown = buildTeraDropdown(row.teraType, "相手のテラスタイプ", (newValue) => {
			row.teraType = newValue;
			refreshTypeBadge();
			onFieldInput();
		});
		const teraField = makeDetailField("テラスタイプ", teraDropdown.wrap);
		teraField.classList.add("damage-build-detail-tera-field");
		detailIdentityRow.appendChild(teraField);
		rowTeraFieldWraps.set(row, teraField);
		teraField.hidden = !isTerastalRegulation(currentIndividualRegulation());

		const readonlyEvGrid = document.createElement("div");
		readonlyEvGrid.className = "damage-ev-grid damage-ev-grid-readonly";
		buildEl.appendChild(readonlyEvGrid);
		const readonlyNatureLabels: Partial<Record<string, HTMLElement>> = {};
		const readonlyStatValueEls: Partial<Record<string, HTMLElement>> = {};
		const readonlyEvValueEls: HTMLElement[] = [];
		STAT_KEYS.forEach((key, i) => {
			const stat = document.createElement("span");
			stat.className = "damage-ev-readonly-stat";
			stat.dataset.stat = key;
			const label = document.createElement("span");
			label.className = "damage-ev-col-label";
			label.textContent = STAT_KANJI[key];
			if (key !== "hp") {
				readonlyNatureLabels[key] = stat;
			}
			const value = document.createElement("span");
			value.className = "damage-stat-value tnum";
			value.textContent = "-";
			readonlyStatValueEls[key] = value;
			const evValue = document.createElement("span");
			evValue.className = "damage-ev-value-readonly tnum";
			evValue.setAttribute("aria-label", `相手の${STAT_KANJI[key]}努力値`);
			readonlyEvValueEls[i] = evValue;
			stat.append(label, value, evValue);
			readonlyEvGrid.appendChild(stat);
		});
		rowReadonlyNatureLabelEls.set(row, readonlyNatureLabels);
		row.statValueEls = readonlyStatValueEls;
		refreshReadonlyEvs = () => {
			readonlyEvValueEls.forEach((value, i) => {
				const ev = row.evs[i] ?? 0;
				value.textContent = ev > 0 ? `(+${ev})` : "";
			});
		};

		const detailStats = document.createElement("section");
		detailStats.className = "damage-build-detail-stats";
		const detailStatsHeading = document.createElement("h3");
		detailStatsHeading.className = "field-label damage-build-detail-stats-heading";
		detailStatsHeading.textContent = "性格・努力値";
		detailStats.appendChild(detailStatsHeading);
		const statPanelOptions: StatAdjustmentPanelOptions = {
			baseStats: [],
			evs: row.evs,
			nature: row.nature,
			natureUp: row.natureUp,
			natureDown: row.natureDown,
			onChange: () => {
				row.evs = statPanelOptions.evs;
				row.nature = statPanelOptions.nature;
				row.natureUp = statPanelOptions.natureUp;
				row.natureDown = statPanelOptions.natureDown;
				refreshRowNatureButtons(row);
				onFieldInput();
			},
		};
		const statPanel = buildStatAdjustmentPanel(statPanelOptions);
		rowStatAdjustmentPanels.set(row, { panel: statPanel, options: statPanelOptions });
		detailStats.appendChild(statPanel.root);
		detailForm.appendChild(detailStats);

		// 相手ビルドのプリセット適用は、このパネルの同一インスタンスへ同期する。
		function applyOpponentBuildPreset(speciesName: string): void {
			const trimmed = speciesName.trim();
			if (trimmed === "") return;
			if (!isOpponentBuildUnset(row)) return;
			const preset = loadOpponentBuildPreset(trimmed);
			if (!preset) return;

			row.nature = preset.nature;
			row.natureUp = preset.natureUp;
			row.natureDown = preset.natureDown;
			row.abilityName = preset.abilityName;
			row.itemName = preset.itemName;
			row.teraType = preset.teraType;
			row.evs.splice(0, row.evs.length, ...preset.evs);
			statPanelOptions.evs = row.evs;
			statPanelOptions.nature = row.nature;
			statPanelOptions.natureUp = row.natureUp;
			statPanelOptions.natureDown = row.natureDown;
			statPanel.refresh();

			refreshRowNatureButtons(row);

			// abilitySelectはこの時点でまだ「入力途中の仮プレースホルダ」しか持たない
			// (候補一覧はこの後rebuildRowAbilityOptionsが非同期に組み立てる)ため、値を
			// 一致させるための一時optionを追加してからvalueを設定する(初期描画時の
			// プレースホルダ生成と同じ考え方)。rebuildRowAbilityOptions再開時、
			// abilities.includes(previousValue)がtrueならこの値がそのまま維持される。
			if (row.abilityName) {
				const opt = document.createElement("option");
				opt.value = row.abilityName;
				opt.textContent = row.abilityName;
				abilitySelect.appendChild(opt);
			}
			abilitySelect.value = row.abilityName;
			abilitySelect.title = row.abilityName;
			refreshAbilityCycleButton();
			notifyDetailAbilityChanged(row, row.abilityName);

			itemInput.value = row.itemName;
			itemInput.title = row.itemName;
			refreshItemImage();

			teraDropdown.setValue(row.teraType);
			refreshTypeBadge();

			onFieldInput();
		}

		const totalBlock = document.createElement("div");
		totalBlock.className = "damage-row-total";
		totalBlock.dataset.severity = "none";
		const totalLabel = document.createElement("span");
		totalLabel.className = "damage-row-total-label";
		totalLabel.textContent = "累計結果";
		const totalResult = document.createElement("p");
		totalResult.className = "damage-row-total-result tnum";
		totalResult.textContent = "(計算前)";
		totalResult.dataset.severity = "none";
		totalResult.title = TOTAL_RESULT_HINT;
		totalBlock.append(totalLabel, totalResult);
		row.totalResultEl = totalResult;
		row.totalBlockEl = totalBlock;

		const techniquesRow = document.createElement("div");
		techniquesRow.className = "damage-row-techniques-row";
		body.appendChild(techniquesRow);
		const columnsWrap = document.createElement("div");
		columnsWrap.className = "damage-row-columns-wrap";
		techniquesRow.appendChild(columnsWrap);
		const columnsEl = document.createElement("div");
		columnsEl.className = "damage-row-columns";
		row.columnsEl = columnsEl;
		columnsWrap.appendChild(columnsEl);
		const addColumnSlot = document.createElement("div");
		addColumnSlot.className = "damage-add-column-slot";
		techniquesRow.appendChild(addColumnSlot);
		row.addColumnSlotEl = addColumnSlot;
		renderColumns(row);

		// 24-D1(訂正後): totalBlockはbuildElでもrootでもなく、techniquesRow
		// (columnsWrap・addColumnSlotの後)の子にする。これにより技列カラムの下端に
		// 収まる1行になり、相手ビルドの箱(左側)には掛からない。
		techniquesRow.appendChild(totalBlock);

		const footer = document.createElement("div");
		footer.className = "damage-row-footer";
		footer.hidden = true;
		root.appendChild(footer);
		row.footerEl = footer;

		const saveStatus = document.createElement("p");
		saveStatus.className = "status-text damage-row-save-status";
		saveStatus.dataset.state = row.id ? "saved" : "idle";
		saveStatus.textContent = row.id ? "保存済み" : "未保存(相手ポケモン名を入力すると保存されます)";
		row.saveStatusEl = saveStatus;
		footer.appendChild(saveStatus);

		const retryButton = document.createElement("button");
		retryButton.type = "button";
		retryButton.className = "btn-ghost damage-row-retry-button";
		retryButton.textContent = "再試行";
		retryButton.addEventListener("click", () => void saveRow(row));
		row.retryButtonEl = retryButton;
		footer.appendChild(retryButton);

		refreshSprite();
		refreshTypeBadge();
		refreshItemImage();
		refreshBuildSummary();
		refreshRowNatureButtons(row);
		refreshDirectionUi();
		renderColumnDisplays(row); // 保存済みclientResultをまず即座に表示する
		void recalcRow(row); // エンジン初期化済みなら実数値・ダメージを再計算して上書きする

		root.addEventListener("click", (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, select, textarea, button, a, label")) return;
			const columnEl = target?.closest<HTMLElement>(".damage-column");
			if (columnEl) {
				const idx = Number(columnEl.dataset.columnIndex);
				const column = row.attacks[idx];
				if (column) selectColumn(row, column);
				return;
			}
			if (target?.closest(".damage-row-build")) selectBuild(row);
		});

		return root;
	}

	// --- 行一覧の状態・取得・追加 ---
	let rows: DamageRowState[] = [];
	// 今回の要件: 自分の特性変更時は全カードの全技列を対象にする。rowsを所有するこの層で
	// 配線し、右パネル側には特性名と対象行だけを渡して状態管理の二重化を避ける。
	el<HTMLSelectElement>("ability").addEventListener("change", (event) => {
		const abilityName = (event.currentTarget as HTMLSelectElement).value;
		for (const row of rows) notifyDetailAbilityChanged(row, abilityName);
	});
	// 左パネルの種族確定で #ability の候補・値がJSから再構築される経路。
	// 初期復元では監視を開始せず、ユーザーの species change 後の最初の再構築だけを見るため、
	// 保存済みカードを開いただけで自動入力が走ることはない。
	const selfSpeciesInput = document.getElementById("species-name") as HTMLInputElement | null;
	const selfAbilitySelect = document.getElementById("ability") as HTMLSelectElement | null;
	selfSpeciesInput?.addEventListener("change", () => {
		if (!selfAbilitySelect) return;
		const observer = new MutationObserver(() => {
			observer.disconnect();
			for (const row of rows) notifyDetailAbilityChanged(row, selfAbilitySelect.value);
		});
		observer.observe(selfAbilitySelect, { childList: true });
	});

	const rowSortOrder = new WeakMap<DamageRowState, number>();

	const bulkAdjustRowIds = new WeakMap<DamageRowState, string>();
	let bulkAdjustRowIdSeq = 0;
	function bulkAdjustRowId(row: DamageRowState): string {
		let id = bulkAdjustRowIds.get(row);
		if (!id) {
			id = row.id ?? `local-${++bulkAdjustRowIdSeq}`;
			bulkAdjustRowIds.set(row, id);
		}
		return id;
	}
	function findRowByBulkAdjustId(rowId: string): DamageRowState | undefined {
		return rows.find((row) => bulkAdjustRowId(row) === rowId);
	}

	// direction === "defense" のカードだけを耐久調整用のスナップショットにする。
	// 名前が空、または有効な技(moveNameが非空)が0件の行は計算できないため除外する。
	// attackerSpec/attacks(=safeAttacks)/optionsの組み立てはrecalcRow()と全く同じ
	// buildSequenceInputs()から導出する(カードの確N表示と耐久調整の計算を食い違わせない
	// ための今回の最重要要件。上のbuildSequenceInputsのコメント参照)。
	function getDefenseRows(): BulkAdjustRowSnapshot[] {
		const result: BulkAdjustRowSnapshot[] = [];
		for (const row of rows) {
			if (row.direction !== "defense") continue;
			if (row.name.trim() === "") continue;
			// recalcRowが計算直前に行っているのと同じ順序(壁on/off・攻守ランクの配列反映
			// →有効な技の抽出)を再現する(1324〜1330行目付近のrecalcRow参照)。
			for (const a of row.attacks) resolveColumnDerivedFields(a);
			const attacks = validAttacksOf(row);
			if (attacks.length === 0) continue;
			const { attackerSpec, safeAttacks } = buildSequenceInputs(row, attacks);
			// 表示用の技名一覧。hitCount>1のときだけ(N発)を付記する。
			const moveLabels = attacks.map((a) => ((a.hitCount ?? 1) > 1 ? `${a.moveName}(${a.hitCount}発)` : a.moveName));
			result.push({
				id: bulkAdjustRowId(row),
				name: row.name.trim(),
				attackerSpec,
				attacks: safeAttacks,
				moveLabels,
				seed: parseSeed(row.seedRaw),
			});
		}
		return result;
	}

	// 指定した行のカードDOM(article.card.card-damage、row.root)を複製して返す。
	// ポップアップに貼るための表示専用の複製で、元のカードには影響しない。
	function buildCardPreview(rowId: string): HTMLElement | null {
		const row = findRowByBulkAdjustId(rowId);
		if (!row || !row.root) return null;
		const clone = row.root.cloneNode(true) as HTMLElement;
		// ページ内でidが重複すると document.getElementById が壊れるため、複製から
		// すべてのid属性を再帰的に削除する(クローンのroot自身がidを持つ想定は無いが、
		// 念のため両方処理する)。
		clone.removeAttribute("id");
		clone.querySelectorAll<HTMLElement>("[id]").forEach((idEl) => idEl.removeAttribute("id"));
		clone.querySelectorAll<HTMLElement>(".damage-detail-panel").forEach((panelEl) => panelEl.remove());
		// 表示専用の複製なので、フォーム要素(name属性の有無を問わず)はすべて操作不可にする
		// (誤操作・自動保存の暴発を防ぐ)。tabindex="-1"でフォーカスが入らないようにもする。
		clone.querySelectorAll<HTMLElement>("input, select, textarea, button").forEach((formEl) => {
			(formEl as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement).disabled = true;
			formEl.tabIndex = -1;
		});
		// ポップアップ側の幅はCSSに委ねる。
		clone.style.width = "";
		return clone;
	}

	registerBulkAdjustBridge({
		getDefenseRows: () => getDefenseRows(),
		buildCardPreview: (rowId) => buildCardPreview(rowId),
	});

	const damageRowsListEl = el<HTMLElement>("damage-rows-list");
	initializeCardDeleteMode(damageRowsListEl, ".card-damage", ".damage-row-delete-button");
	const engineStatusEl = el<HTMLElement>("damage-calc-engine-status");
	const engineStatusTextEl = el<HTMLElement>("damage-calc-engine-status-text");
	const engineReloadButton = el<HTMLButtonElement>("damage-calc-engine-reload-button");
	engineReloadButton.addEventListener("click", () => window.location.reload());

	const damageDetailPanelEl = el<HTMLElement>("damage-detail-panel");
	const damageDetailPanelOriginalParentEl = damageDetailPanelEl.parentElement;
	function refreshMobileDetailPlacement(): void {
		if (!isNarrowLayout()) {
			damageDetailPanelEl.classList.remove("is-mobile-inline", "is-mobile-suggest");
			if (damageDetailPanelOriginalParentEl) damageDetailPanelOriginalParentEl.appendChild(damageDetailPanelEl);
			return;
		}

		const selectedRow = getSelectedRow();
		const selectedColumn = getSelectedColumn();
		if (selectedRow && (selectedColumn || getSelectedIsBuild()) && selectedRow.root?.parentElement === damageRowsListEl) {
			damageDetailPanelEl.classList.remove("is-mobile-inline", "is-mobile-suggest");
			if (damageDetailPanelOriginalParentEl) damageDetailPanelOriginalParentEl.appendChild(damageDetailPanelEl);
			return;
		}
		if (damageDetailPanelEl.querySelector("#damage-detail-panel-body .damage-suggest")) {
			damageRowsListEl.appendChild(damageDetailPanelEl);
			// 未選択のサジェスト一覧はカード列の一部として常設される(閉じる対象の選択が無い)。
			// 閉じるボタンは押しても何も起きない死んだボタンになるのでCSSで隠す。
			damageDetailPanelEl.classList.add("is-mobile-inline", "is-mobile-suggest");
			return;
		}

		damageDetailPanelEl.classList.remove("is-mobile-inline", "is-mobile-suggest");
		if (damageDetailPanelOriginalParentEl) damageDetailPanelOriginalParentEl.appendChild(damageDetailPanelEl);
	}
	refreshMobileDetailPlacement();
	// 技列の追加上限がレイアウト幅で変わる(モバイル2 / デスクトップ3、currentMaxColumnsToAdd)ため、
	// 境界をまたいだら「＋ 技を追加」ボタンの有効/無効を描き直す。
	// renderColumns()は同じrow.attacksから列を作り直すだけなので
	// 何度呼んでも状態は変わらない。
	window.matchMedia("(max-width: 899px)").addEventListener("change", () => {
		for (const row of rows) {
			renderColumns(row);
			// レイアウト更新後も公式アートワークの読み込み状態を揃える。
			rowSpriteRefreshers.get(row)?.();
		}
	});
	document.addEventListener("click", (e) => {
		// タブ切替はクリックハンドラ中でヘッダーを再構築する。その後にここへ
		// バブリングしてきた時点ではe.targetが既にDOMから外れているため、現在の
		// ツリーではなくイベント発火時の経路で内側クリックかを判定する。
		const path = e.composedPath();
		if (path.includes(damageDetailPanelEl)) return;
		if (path.some((entry) => entry instanceof Element && entry.matches(".damage-column"))) return;
		if (isNarrowLayout() && path.some((entry) => entry instanceof Element && entry.matches(".card-damage"))) return;
		clearSelectionAndMarks();
	});

	function addNewRowAndFocus(): void {
		const row = createEmptyRow();
		// 通常の新規カードだけ初期技を補う。サジェスト・既存メモの復元経路には適用しない。
		fillFirstMoveCandidate(row, row.attacks[0]);
		renderRow(row);
		const existingOrders = rows
			.map((r) => rowSortOrder.get(r))
			.filter((v): v is number => v !== undefined);
		const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) : 0;
		rowSortOrder.set(row, maxOrder + 1000);
		rows.push(row);
		rebuildRowsList();
		row.root?.querySelector<HTMLInputElement>('input[aria-label="相手ポケモン名"]')?.focus();
	}

	function addSuggestedRow(suggestion: DamageCalcSuggestion): void {
		const row = createEmptyRow();
		row.direction = suggestion.direction;
		row.name = suggestion.opponentName;
		const build = suggestion.opponentBuild;
		// 性格名から↑↓を正引きして復元する(noteToRowStateと同じ手順・同じ正規化)。
		const mod = NATURE_STAT_MODIFIERS[build.nature ?? ""] ?? { up: null, down: null };
		row.natureUp = mod.up;
		row.natureDown = mod.down;
		row.nature = natureNameFromBoosts(mod.up, mod.down);
		row.abilityName = build.abilityName ?? "";
		row.itemName = build.itemName ?? "";
		row.teraType = build.teraType ?? "";
		row.evs = STAT_KEYS.map((_, i) => build.evs?.[i] ?? 0);
		row.attacks[0].moveName = suggestion.moveName;

		renderRow(row);
		const existingOrders = rows
			.map((r) => rowSortOrder.get(r))
			.filter((v): v is number => v !== undefined);
		const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) : 0;
		rowSortOrder.set(row, maxOrder + 1000);
		rows.push(row);
		rebuildRowsList();
		// 相手名が入っている=保存できる状態なので、通常の編集と同じ経路で保存と再計算を予約する。
		scheduleRowSave(row);
		scheduleRowCalc(row);
		refreshRowConditionChips(row);
	}

	registerDamageSuggestBridge({
		// 向き・相手・技の3つ組(=020の集計単位)で「もう画面にある計算」を表す。
		// 1枚のカードが複数の技列を持つため、行ではなく技ごとに1キー作る。
		listExistingKeys: () =>
			rows.flatMap((row) =>
				row.attacks
					.filter((attack) => attack.moveName.trim() !== "")
					.map((attack) =>
						damageCalcSuggestionKey({
							direction: row.direction,
							opponentName: row.name,
							moveName: attack.moveName,
						}),
					),
			),
		addSuggestion: (suggestion) => addSuggestedRow(suggestion),
	});

	function buildAddRowTile(): HTMLButtonElement {
		const tile = document.createElement("button");
		tile.type = "button";
		tile.className = "add-card-tile box-add-button";
		// DamageCard.pngの「ダメージ計算追加ボタン」(カードの外・下側)にあたる。
		// 1枚のカード = 相手1体分のダメージ計算なので、追加すると新しい相手の行が増える。
		tile.setAttribute("aria-label", "ダメージ計算を追加");
		const icon = document.createElement("span");
		icon.className = "add-card-tile-icon";
		icon.setAttribute("aria-hidden", "true");
		icon.textContent = "＋";
		const label = document.createElement("span");
		label.className = "add-card-tile-label";
		label.textContent = "ダメージ計算を追加";
		tile.append(icon, label);
		tile.addEventListener("click", addNewRowAndFocus);
		return tile;
	}

	function rebuildRowsList(): void {
		damageRowsListEl.innerHTML = "";
		damageRowsListEl.appendChild(buildAddRowTile());
		for (const row of rows) {
			if (row.root) damageRowsListEl.appendChild(row.root);
		}
		refreshMobileDetailPlacement();
	}

	async function fetchAndRenderRows(): Promise<void> {
		damageRowsListEl.innerHTML = "";
		const loadingP = document.createElement("p");
		loadingP.textContent = "読み込み中…";
		damageRowsListEl.appendChild(loadingP);
		try {
			const res = await fetch(`/api/opponent-notes?owned_pokemon_id=${encodeURIComponent(ownedPokemonId)}`, {
				credentials: "same-origin",
			});
			if (!res.ok) throw new Error(`一覧の取得に失敗しました (status=${res.status})`);
			const body = (await res.json()) as { data: OpponentNoteRecord[] };
			const rowsNeedingResave: DamageRowState[] = [];
			rows = body.data.map((note) => {
				const { row, needsResave, order } = noteToRowState(note);
				if (needsResave) rowsNeedingResave.push(row);
				if (order !== undefined) rowSortOrder.set(row, order);
				return row;
			});
			rows = rows
				.map((row, index) => ({ row, sortKey: rowSortOrder.has(row) ? (rowSortOrder.get(row) as number) : index }))
				.sort((a, b) => a.sortKey - b.sortKey)
				.map((entry) => entry.row);
			for (const row of rows) renderRow(row);
			for (const row of rowsNeedingResave) scheduleRowSave(row);
			rebuildRowsList();
			clearSelection();
			renderDetailPanel();
		} catch (err) {
			console.error(err);
			damageRowsListEl.innerHTML = "";
			const errP = document.createElement("p");
			errP.className = "card-hint";
			errP.textContent = "ダメージ計算カードの取得に失敗しました。時間をおいて再度お試しください。";
			damageRowsListEl.appendChild(errP);
		}
	}

	void fetchAndRenderRows();

	initDamageSuggest();

	function renderEngineStatus(progress: EngineProgress): void {
		engineStatusEl.dataset.state = progress.status;
		// 準備完了後は行そのものを隠す。カードを囲むパネルを廃した結果、この1行だけが
		// カードの上に残ると「何のための文言か」が分からない浮いた表示になるため
		// (初期化中・失敗時は待ち時間や原因を伝える必要があるので表示し続ける)。
		engineStatusEl.hidden = progress.status === "ready";
		if (progress.status === "ready") {
			engineStatusTextEl.textContent = "計算エンジンの準備ができました。";
			engineReloadButton.hidden = true;
		} else if (progress.status === "idle") {
			engineStatusTextEl.textContent = "計算エンジンを準備しています(自動で開始します)…";
			engineReloadButton.hidden = true;
		} else if (progress.status === "error") {
			engineStatusTextEl.textContent = "ダメージ計算エンジンの読み込みに失敗しました。";
			engineReloadButton.hidden = false;
		} else {
			engineStatusTextEl.textContent = progress.message;
			engineReloadButton.hidden = true;
		}
	}

	function combinedDamageEngineProgress(progress: EngineProgress): void {
		renderEngineStatus(progress);
		if (progress.status === "ready") {
			void recalcStats();
			for (const row of rows) {
				void recalcRow(row);
			}
		}
	}

	// UI刷新: このページに限り、表示直後にアイドル時間を使ってバックグラウンドでPyodideを
	// プリフェッチする(全ページ共通の「ボタンを押すまで遅延初期化」方針への例外、
	// プロダクトオーナー承認済み)。ユーザー操作はブロックしない。
	function schedulePrefetchEngine(callback: () => void): void {
		if (typeof window.requestIdleCallback === "function") {
			window.requestIdleCallback(() => callback());
		} else {
			setTimeout(callback, 0);
		}
	}
	schedulePrefetchEngine(() => {
		initEngine(combinedDamageEngineProgress).catch((err) => {
			console.error(err);
		});
	});

	// loadAutocomplete()の呼び出しは11-4対応で左サイド(left-panel.ts)の
	// autocompleteReadyPromiseへ移動した(二重に呼ぶとdatalistの候補が重複するため
	// 呼び出し箇所は1箇所のみ)。
	// Pyodide本体・jpoke wheelのオフラインキャッシュ登録(SW登録のみで、初期化トリガーとは
	// 独立)。元は if (form) の直下(if (opponentNotesSection) の外側)にあったが、
	// #edit-formと#opponent-notes-sectionはどちらもpokemon存在時にのみ同時にSSR描画
	// されるため(box/[id].astroのテンプレート参照)、両者の存在条件は常に一致する。
	// 構造分割ラウンド(フェーズ1)でif (form)自体を撤去したため、この位置
	// (if (opponentNotesSection)の内側末尾)へ移設した(実行されるかどうかの
	// 条件は変わらない)。
	registerOfflineCache();
}
