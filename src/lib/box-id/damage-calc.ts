// box/[id].astro 構造分割ラウンド(フェーズ2)。
//
// ダメージ計算(#opponent-notes-section)専用のロジック一式
// (docs/plan/ui_parallelization.md 4.1節「ダメージ計算専用54」)。元は box/[id].astro の
// <script> 内、`if (opponentNotesSection) { ... }` ブロックにまとまって定義されていたもので、
// ロジックは一切変更せずこのファイルへ移設した(定義位置の変更のみ)。
//
// 右サイド(詳細設定サイドバー)専用のロジックは right-panel.ts へ切り出した
// (buildSideSection/renderColumnLevelDetailPanel/buildToggleButton/buildIconToggleGroup/
// deselectRowIfCurrent 等16関数)。ダメージ計算・右サイドは元々1つのクロージャスコープを
// 共有し scheduleRowSave/scheduleRowCalc/refreshRowConditionChips 等で密結合していた
// (ui_parallelization.md 3節・4.2節)ため、無理に独立させず、このファイルと right-panel.ts は
// 通常の import/export で直接依存し合っている(コーディネーターへの報告事項: 相互import。
// deselectRowIfCurrent/renderDetailPanelEmpty/renderColumnLevelDetailPanel/
// openDetailPanelOverlayIfNarrow はright-panel.tsからimportし、DAMAGE_WEATHERS等の選択肢
// 配列・clampIntは逆にright-panel.tsがこのファイルからimportする。いずれも関数宣言
// (hoistされるため循環import下でも安全)または、実際に使われるのが両モジュールの評価が
// 完了した後(ユーザー操作時)のみの値なので、初期化順序の問題は無い)。
//
// DAMAGE_WEATHERS/DAMAGE_TERRAINS/DAMAGE_AILMENTS/DAMAGE_ATTACKER_VOLATILES/
// DAMAGE_DEFENDER_VOLATILES/clampIntの6つは、元は`if (opponentNotesSection)`ブロックの
// 内側で定義されていたが、right-panel.tsから参照する必要があるため、このファイルの
// 先頭(トップレベル、ガードの外)へ機械的に引き上げてexportした。どちらも#opponent-notes-section
// の有無に依存しない純粋なデータ/ユーティリティのため、実行タイミングを変えても
// 動作に影響は無い(値・ロジックは一切変更していない)。
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
	officialArtworkUrl,
	// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「相手ビルドのポケモンアイコンを
	// ドット絵に変更」用。applySprite()のurlFn既定値と同じ関数だが、デスクトップは
	// officialArtworkUrl のままにするため明示的に受け取って出し分ける(下のrefreshSprite参照)。
	spriteUrl,
} from "../pokemon-master-data";
import { type StatKey, STAT_KEYS, NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from "../stats";
import { TERA_TYPES } from "../tera-types";
// UI改善ラウンド40ユーザー指示(40-D1)「テラス選択ボックスを左パネルと共通化する」用。
// shared-core.tsは"../sprite-urls"からteraTypeIconUrlをimportしているが再exportしていない
// ため(shared-core.tsはこのラウンドの編集対象外)、ここで直接importする。
import { teraTypeIconUrl } from "../sprite-urls";
import { initializeCardDeleteMode } from "../card-delete-mode";
// UI改修依頼(ダメージ計算カード、2026-08-01)「レギュレーションに応じてテラスタル選択
// ボックスの表示ON/OFFを切り替える」用。判定は必ずこの関数を使い、自前ロジックを書かない
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
	toggleNatureUp,
	toggleNatureDown,
	buildAttackerSpec,
	recalcStats,
	baseStatsMapPromise,
	registerDamageCalcBridge,
	registerBulkAdjustBridge,
	type BulkAdjustRowSnapshot,
	getSelectedRow,
	getSelectedColumn,
	clearSelection,
	scheduleRowSave,
	scheduleRowCalc,
	refreshRowConditionChips,
	renderDetailPanel,
	selectColumn,
	applySelectionMarks,
	clearSelectionAndMarks,
	wrapToRange,
	type DamageRowState,
	type DamageColumnState,
} from "./shared-core";
import {
	deselectRowIfCurrent,
	renderDetailPanelEmpty,
	renderColumnLevelDetailPanel,
	openDetailPanelOverlayIfNarrow,
	initRightPanel,
	notifyDetailMoveChanged,
	notifyDetailAbilityChanged,
} from "./right-panel";
// ダメージ計算のサジェスト(ユーザー要望、2026-08-05)。描画は右パネル側(damage-suggest.ts)に
// あり、このファイルは「いま画面にどんな計算があるか」と「1件を新しいカードにする」の
// 2つだけをブリッジとして提供する(shared-core.tsのregisterDamageCalcBridgeと同じ登録パターン)。
import { initDamageSuggest, registerDamageSuggestBridge, type DamageCalcSuggestion } from "./damage-suggest";
import { damageCalcSuggestionKey } from "../damage-calc-suggest";

// もともとはラウンド4ユーザー指示「技の詳細はリンクではなくホバー表示にする」用に
// 導入したローダー(public/master-data/detail/moves.json、src/pages/moves/[name].astroが
// 表示に使っているのと同じ静的データを技名でMap化)。ホバー表示自体はラウンド20
// ユーザー指示(20-L2)「わざのヘルプ表示を削除」で撤去したが、下のgetMoveCategory()
// (壁・ランク補正の自動判定に技の物理/特殊/変化区分を使う、ラウンド5由来)が
// 引き続きこのMapを参照しているため、ローダー自体とMoveDetailEntry型は残す
// (編集してよいファイルがこのページのみのため専用ローダーをここに直接持たせる方針も
// 変えていない)。ツールチップ表示専用だったMOVE_CATEGORY_LABEL(物理/特殊/変化の
// 日本語ラベル)は参照元ごと無くなったため削除した。
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

// ラウンド5ユーザー指示(壁のon/off・攻守ランクの単一入力)の実装用: 技名から
// 物理/特殊/変化を同期的に引けるキャッシュ。moveDetailMapPromiseは非同期のため、
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

// ラウンド20: jpoke fix(lethal)「通常のダメージ計算に従わない攻撃技の致死率を正しく
// 計算する」の取り込みにより、calc_lethal経路(pyodide-engine.ts)がカウンター・
// ちきゅうなげ・OHKO技等の固定/割合ダメージ技も正しく計算するようになった
// (vendor/jpoke/src/jpoke/core/lethal.py・handlers/lethal.pyに専用ハンドラが追加され、
// 対象14件中13件が解消。.claude/skills/jpoke/references/damage-calc.md参照)。
// ラウンド19で追加した「power:nullの技は一律算出不能」という広い抑止はもう不要。
// 唯一「はきだす」だけは、威力が「ためこむ」の回数で決まりその回数決定が
// Event.ON_TRY_MOVE_1(実戦の技実行フロー)でのみ行われるため、そのフローを通らない
// calc_lethalでは今回のfixの対象外のまま(handlers/lethal.pyのはきだす_reset_stockpile
// は使用後のランク巻き戻しのみを担当し、ダメージ自体を設定するハンドラが無い)。
function isUnsupportedLethalMove(name: string): boolean {
	return name.trim() === "はきだす";
}
const UNSUPPORTED_LETHAL_NOTE =
	"この技は威力が「ためこむ」を使った回数によって変わる特殊な計算式のため、ダメージを算出できません。";

// ラウンド22指摘(22-D-1)「変化技(まもる等)が『10発以上 0(0%)』と表示される」。
// ダメージ0は事実だが「10発以上」は「あと少しで倒せる」ように誤読されうる。
// isUnsupportedLethalMoveと同じ仕組み(理由を示して数値を出さない)に合流させる。
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
// ラウンド22指摘(22-D-1)。変化技は0ダメージが「近似値」ではなく仕様として確定した値
// なので(はきだすのような「未知の値を0扱いしている」ケースとは異なる)、一部だけ
// 変化技を含む場合の断り書きは不要(他の技の実ダメージがそのまま正しく合算される)。
// 「全技列が変化技(または変化技+はきだすの組み合わせ)」のときだけ理由を示す。
const STATUS_MOVE_TOTAL_NOTE_ALL = "技列がすべて変化技のため、合計のダメージを算出できません。";
const STATUS_AND_UNSUPPORTED_TOTAL_NOTE_ALL =
	"技列がすべて変化技または「はきだす」のため、合計のダメージを算出できません。";

// タイプごとの色(タイプ画像/テラスタイプ画像が取得できない場合の色ボックスフォールバック用、
// Pokemon.pngワイヤーフレーム参照)。慣習的なタイプカラー。ステラは公式に単色が無いため近似値。
// ラウンド21ユーザー指示(21-L8): 以前はこの<script>にローカル定義していたが、
// エージェントPがsrc/lib/type-colors.tsへ切り出したため(値は同一)、そちらからimportする
// (上のimport群にTYPE_COLORS/DEFAULT_TYPE_COLORを追加済み)。ローカル定義は削除した。

// applySprite/applyTypeBadge(左サイド専用)/applyTeraImage/applyItemImage/updateSliderProgress/
// pairEvSlider(左サイド専用)/NATURE_NAME_BY_BOOSTS/natureNameFromBoosts/normalizedNatureBoosts/
// toggleNatureUp/toggleNatureDownは構造分割ラウンド(フェーズ1)でshared-core.ts/left-panel.tsへ
// 移設した(上のimport参照。ロジックは一切変更していない)。
// ラウンド20ユーザー指示(20-D3): 相手ビルドカードのH/A/B/C/D/S見出しをクリックすると
// 無補正→上昇→下降→無補正と3循環させる(ラウンド5の「▲/▼を独立ボタン化する」を
// このカードに限り撤回)。状態機械を作り直すのではなく、上のtoggleNatureUp/
// toggleNatureDown(左パネルと共有)にそのまま委譲する薄いラッパーにすることで、
// 上のコメントにある旧cycleNatureBoosts()の事故(1個のボタンが上昇/下降を直接
// 持ち替えて不完全な組み合わせになり、見かけ上リセットされた)を再現しない。
// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「相手ビルドの性格補正が
// 機能していない(バグ)」の修正に使う退避テーブル。
//
// 【何が壊れていたか】(実測、Playwright 390px・カード1件)
//   性格補正は上昇・下降の両方が揃って初めて有効になる(片方だけの状態は実在しない性格に
//   なるため normalizedNatureBoosts が「まじめ」へ正規化する。shared-core.ts参照)。
//   ところがこの3循環(無補正→上昇→下降→無補正)では、ある列を「無補正→上昇」に進める
//   たびに natureUp が無条件でその列へ移る。つまり
//     A を1回押す → A▲(natureUp=atk)
//     C を1回押す → C▲(natureUp=spa。★ここで A の▲が消える)
//     C をもう1回 → C▼(natureUp=null, natureDown=spa)
//   となり、2つ目の列を▼にしようとすると必ず1つ目の▲を通り道で壊してしまう。
//   結果として「上昇と下降が同時に立っている状態」をこのUIからは一度も作れず、
//   実数値も確N表示も永遠に無補正のままだった(既存データに入っている A▲/C▼ の
//   組み合わせは、別UI・旧実装で保存されたもの)。
//
// 【直し方】列Xが「無補正→上昇」へ進むときに、Xが押しのけた直前の上昇保持者を覚えておき、
// 同じ列Xが「上昇→下降」へ進んだ瞬間に元の保持者へ戻す。上のシナリオは
//   A▲ → (C 1回目) C▲ ※Aを退避 → (C 2回目) A▲ + C▼
// となり、3循環の定義(1列だけを見れば 無補正→上昇→下降→無補正)は一切変えずに
// 「上昇1つ・下降1つ」の正しい性格へ到達できるようになる。
// 退避は「同じ列を続けて押している間」だけ有効な一時状態なので、行ごとに1件だけ持ち、
// 使ったら捨てる(行の寿命に紐づけるためWeakMap)。
const evictedNatureUpByCycle = new WeakMap<DamageRowState, { by: StatKey; previous: StatKey | null }>();
function cycleColumnNature(row: DamageRowState, key: StatKey): void {
	const evicted = evictedNatureUpByCycle.get(row);
	evictedNatureUpByCycle.delete(row);
	if (row.natureUp === key) {
		// 上昇→下降。この列が押しのけた保持者が居るなら、その列の上昇を復元する
		// (居なければ従来どおり上昇なしになる)。
		row.natureUp = evicted?.by === key ? evicted.previous : toggleNatureUp(row.natureUp, key);
		row.natureDown = toggleNatureDown(row.natureDown, key);
	} else if (row.natureDown === key) {
		row.natureDown = toggleNatureDown(row.natureDown, key);
	} else {
		// 無補正→上昇。押しのける相手が居るときだけ退避する。
		if (row.natureUp !== null) evictedNatureUpByCycle.set(row, { by: key, previous: row.natureUp });
		row.natureUp = toggleNatureUp(row.natureUp, key);
	}
	row.nature = natureNameFromBoosts(row.natureUp, row.natureDown);
}

// 構造分割ラウンド(フェーズ2)でこのファイル先頭へ引き上げた6つ(right-panel.tsへexportするため。
// 上のファイル冒頭コメント参照)。
export const DAMAGE_WEATHERS = [
	{ value: "はれ", label: "はれ", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/><line x1="4" y1="4" x2="5.8" y2="5.8"/><line x1="18.2" y1="18.2" x2="20" y2="20"/><line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/><line x1="4" y1="20" x2="5.8" y2="18.2"/><line x1="18.2" y1="5.8" x2="20" y2="4"/></svg>` },
	// 今回のUI改修: 「あめ」は雲ではなく傘で即座に識別できるよう、同じ18px・線幅のSVGに揃える。
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
// UI改善タスク(揮発状態のホバー説明追加): 各項目のtitleはvendor/jpoke実装
// (src/jpoke/data/volatile.py・src/jpoke/handlers/volatile.py)を確認して書いた説明文。
// 数値(割合・倍率)を変更する場合は必ずjpoke skill(.claude/skills/jpoke)経由で
// 実装を確認し直すこと(ダメージ計算に影響する数値のため誤記厳禁)。
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
	{ value: "タールショット", label: "タールショット", title: "ほのおタイプの技の弱点としての倍率が2倍になる" },
	{ value: "ちいさくなる", label: "ちいさくなる", title: "ふみつけ等の一部の技が必ず命中し、威力が2倍になる" },
	{ value: "きょけんとつげき", label: "きょけんとつげき", title: "相手から受ける技が必ず命中し、ダメージが2倍になる" },
];
export function clampInt(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(n)));
}

// UI改善ラウンド48(A-4)ユーザー指示(第32弾)「相手ビルドの情報を種族ごとにローカルに
// 記録しておき、次に同じ種族をビルドする際にデフォルト値として設定する」。
// DBの opponent_notes.opponent_build はカード単位の保存のみで、同じ種族を別カードで
// 再入力するたびに性格・特性・持ち物・テラス・努力値を打ち直す必要があったため、
// ブラウザの localStorage に「種族名→最後に使ったビルド」を記録する(DBへの
// 新規カラム追加はしない、というユーザー指示による新規実装)。他機能と衝突しない
// 名前空間にする。
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

// UI改修依頼(ダメージ計算カード、2026-08-04)項目5「防御時の技候補を相手の技の使用率順に
// 表示する」。box/[id].astro(SSR)がDamageCalcSection.astro経由で埋め込んだJSON
// (<script type="application/json" id="damage-calc-move-adoption-data">)を読むヘルパー。
// src/lib/speed-chart/chart-table.tsのreadEmbeddedJson(小さな汎用ヘルパー)と同じロジックを
// コピーする(importできないファイルのため自前実装。著作権上の問題は無い)。
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
	// ラウンド18ユーザー指示の実装当時、この値は左パネルの `const form` の
	// data-id属性(form.dataset.id)から取っていたが、#edit-formがLeftPanel.astroへ
	// 移設されたため(構造分割ラウンド・フェーズ1)、この<script>から直接
	// #opponent-notes-sectionのdata-owned-pokemon-id属性(値は同じくpokemon.id、
	// テンプレート参照)を読む形に書き換えた。値は変わらない。
	const ownedPokemonId = opponentNotesSection.dataset.ownedPokemonId ?? "";

	// UI改修依頼(ダメージ計算カード、2026-08-01)「レギュレーションに応じてテラスタル選択
	// ボックスの表示ON/OFFを切り替える。左パネルの#regulationを変えたらダメージカード側も
	// 追随する」。#regulation(左パネル、LeftPanel.astro/left-panel.ts。このラウンドの
	// 編集対象外ファイル)はこのファイルからは値を読むだけに留め、既存のchangeリスナー
	// (left-panel.ts側でsyncTeraFieldVisibility/syncRegulationPlaceholder等を呼んでいる)は
	// 一切変更しない。ここでは同じ要素へ**別のリスナーを追加**するだけ(DOM標準のイベント
	// 購読は同一要素に何個でも独立して登録できる)なので、left-panel.tsを編集せずに追随できる。
	const regulationSelectEl = document.getElementById("regulation") as HTMLSelectElement | null;
	function currentIndividualRegulation(): string | null {
		if (!regulationSelectEl) return null;
		const value = regulationSelectEl.value.trim();
		return value === "" ? null : value;
	}
	// 行(相手)ごとに1個生成されるテラスタイプ選択ボックス(buildTeraDropdown()のwrap、
	// 下方参照)への参照。DamageRowState自体にフィールドを追加せず(shared-core.tsは編集
	// 対象外ファイルのため)、rowCollapseHandles等と同じくWeakMapで対応付ける。
	const rowTeraFieldWraps = new WeakMap<DamageRowState, HTMLElement>();
	// UI改修依頼(ダメージ計算カード、2026-08-02)「圧縮表示中も、展開表示と同様にレギュレーションに
	// 応じてテラスタルの表示・非表示を自動判断する」。圧縮表示側のテラス関連表示
	// (相手のテラスタイプ名/アイコン、技列の「攻撃側テラスタル」「防御側テラスタル」チップ)は
	// renderRow()内のrefreshTypeBadge()/refreshCollapsedTechniques()がそれぞれ持っており、
	// どちらもrow.teraType等が変わった時にしか呼ばれない(=regulation変更単独では再実行されない)。
	// rowTeraFieldWraps同様、行ごとに「圧縮表示のテラス関連表示を最新化する関数」をWeakMapへ
	// 登録しておき、syncTeraFieldVisibility()から展開側の表示切り替えとまとめて呼び直す。
	const rowCollapsedTeraRefreshers = new WeakMap<DamageRowState, () => void>();
	function syncTeraFieldVisibility(): void {
		const show = isTerastalRegulation(currentIndividualRegulation());
		for (const row of rows) {
			const wrap = rowTeraFieldWraps.get(row);
			if (wrap) wrap.hidden = !show;
			rowCollapsedTeraRefreshers.get(row)?.();
		}
	}
	regulationSelectEl?.addEventListener("change", syncTeraFieldVisibility);

	// 構造分割ラウンド(フェーズ1): shared-core.tsのscheduleRowSave/scheduleRowCalc/
	// refreshRowConditionChips/renderDetailPanel/selectColumnは、このブロック内で
	// 下に定義するsetRowSaveStatus/saveRow/recalcRow/renderConditionChipsInto/
	// renderDetailPanelEmpty/renderColumnLevelDetailPanel/openDetailPanelOverlayIfNarrow
	// を呼ぶ(元は同じクロージャスコープの兄弟関数を直接参照していた)。関数宣言は
	// このブロック内でホイストされるため、実際に定義される行より前のこの位置で
	// 登録しても問題ない(呼び出しは実際にユーザー操作等が起きた後になる)。
	registerDamageCalcBridge({
		recalcRow: (row) => recalcRow(row),
		saveRow: (row) => saveRow(row),
		setRowSaveStatus: (row, state, text) => setRowSaveStatus(row, state, text),
		renderConditionChipsInto: (container, attack) => renderConditionChipsInto(container, attack),
		renderDetailPanelEmpty: () => {
			renderDetailPanelEmpty();
			refreshMobileDetailPlacement();
		},
		renderColumnLevelDetailPanel: (row, column) => {
			renderColumnLevelDetailPanel(row, column);
			refreshMobileDetailPlacement();
		},
		openDetailPanelOverlayIfNarrow: () => {
			if (isNarrowLayout()) {
				refreshMobileDetailPlacement();
				return;
			}
			openDetailPanelOverlayIfNarrow();
		},
	});
	// 構造分割ラウンド(フェーズ2): 右サイド(詳細設定サイドバー)専用のDOM参照・
	// イベント登録・初期空状態描画は right-panel.ts へ移設した。元は同じクロージャ内で
	// モジュールスコープの const として実行されていたが(下のrp_block参照)、ファイルを
	// 分けたことで right-panel.ts 側は #damage-detail-panel 等が必ず存在する
	// (=opponentNotesSectionが存在する)ことを保証できないため、initRightPanel()という
	// 明示的な初期化関数に包み、ここ(#opponent-notes-sectionが存在すると判明した直後)から
	// 1回だけ呼ぶ形にした。呼び出し順序・実行内容はロジック上一切変えていない(元のファイルで
	// 実行されていた「DOM取得→イベント登録→初期renderDetailPanelEmpty()呼び出し」を
	// そのまま関数化しただけ)。
	initRightPanel();

	// ラウンド17指摘(B-1): ダメージ計算カードは行(相手)ごとに独立して自動保存されるため、
	// カード自身のfooter(失敗時のみ表示)は画面外にスクロールすると見えなくなる。
	// AppLayoutのトップバー(position:sticky)は常時可視なので、失敗している行数だけを
	// ここに出す(setRowSaveStatus/deleteRowの呼び出し箇所からupdateOpponentNotesFailure
	// Alert()を呼ぶ。rowsは下方で `let rows: DamageRowState[] = []` として宣言される変数を
	// 参照するが、この関数は実際に保存イベントが起きた時点で初めて呼ばれるため、
	// スクリプト初期化順の問題は無い)。
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

	// UI刷新: 相手ビルドselect用。TERA_TYPESはこの<script>タグ冒頭でsrc/lib/tera-types.tsから
	// importしたものをそのまま使う(ラウンド23の22-B-1でローカル複製を解消した)。
	// ラウンド4ユーザー指示により性格の<select>(NATURES一覧)は廃止した
	// (努力値/実数値グリッドのH/A/B/C/D/S見出しクリックへ置き換え。左パネルと同じ
	// natureNameFromBoosts/NATURE_STAT_MODIFIERSを使う)。
	// 天候/地形の選択肢。src/pages/damage-calc/index.astro の WEATHERS/TERRAINSと
	// 同じ選択肢で同期させること(jpoke側の定義が正)。ただし、ラウンド11ユーザー指示
	// (2026-07-26 第4弾)により、個体編集の詳細設定パネルのみ強天候3種(おおひでり/
	// おおあめ/らんきりゅう)を選択肢から除外している(damage-calc側はスコープ外・
	// 未変更のまま)。
	// ラウンド5ユーザー指示(要件10): 天候・フィールドはセレクトをやめてアイコン選択式に
	// する。このプロジェクトはAppSidebar.astroでlucide風のインラインSVGを自前定義する
	// 流儀のため、同じ流儀(24x24 viewBox)で簡易アイコンを用意する。
	// 🔴 UI改善ラウンド39ユーザー指示(39-R1、同ターン内で「ミストフィールドに限らず天候・
	// フィールドアイコン全部」と訂正)・ラウンド40ユーザー指示(40-R1、対象をラウンド38-R1で
	// 差し替えたすなあらし/サイコ/ミストも含む全アイコンへ拡大)により、線をわずかに太くする。
	// stroke-width 1.75→2.1(DAMAGE_WEATHERS/DAMAGE_TERRAINSの8アイコン全部で統一)。
	// ミストフィールドは線でなく塗りつぶしの円(斑点)なのでstroke-widthの変更自体は見た目に
	// 影響しないが、同ラウンドの指示にある「斑点も見やすさ優先で微調整してよい」に従い、
	// 各circleのrを一律+0.15して粒を少し大きくした(1.3→1.45等、下記DAMAGE_TERRAINS参照)。
	// ラウンド11ユーザー指示(要件11-9): 強天候(おおひでり/おおあめ/らんきりゅう)は選択肢から削除。
	// ⚠️ ラウンド24ユーザー指示(24-R1)「天候・フィールドの"なし"を廃止し、未選択なら"なし"扱いにする」
	// により、「なしも選択肢の1つとして常に並べる(radiogroupで必ずどれか1つを選ぶ)」という設計を
	// 撤回する。「なし」の選択肢(value: ""、旧ICON_NONE)自体を配列から削除し、天候・フィールドとも
	// 4択にした。「なし」相当はbuildIconToggleGroup()側のトグルオフ(選択中のボタンの再クリックで
	// value: ""に戻す、下記参照)で表現する。ICON_NONEはどこからも参照されなくなったため削除した。

	// DAMAGE_TERRAINS/DAMAGE_AILMENTSはファイル先頭へ移設した(上のexport const参照)。
	// ラウンド5ユーザー指示(要件11): 壁は種類が不要。on/offの1トグルにする
	// (DAMAGE_SIDE_FIELDSの3種セレクトは廃止。実際にどちらを立てるかは
	// resolveColumnDerivedFields()が技の物理/特殊分類から自動判定する)。
	// jpokeのAilmentNameと一致させる(空は「状態異常なし」)。
	// ラウンド11ユーザー指示(要件11-8): ゆめうつつを選択肢から削除(6種+なし)。
	// 「11-8の修正」ユーザー指示(2026-07-26追加、そのまま引用):
	// 「状態異常は種類が多く場所をとるのでリストから選択する方式にする」。
	// 一度buildIconToggleGroup()のアイコントグルに置き換えたが、選択肢7個(なし込み)は
	// 天候/フィールド(なし込み5個)より専有面積が大きく複数行に折り返して省スペース化の
	// 効果を打ち消していたため、素朴なnative <select>に戻した(buildSideSection参照)。
	// この置き換えのために追加していた状態異常専用の単色SVG6種(ICON_AILMENT_POISON等)は
	// 他で使われていないことをgrepで確認のうえ削除済み(天候/フィールドのアイコンは維持)。
	// DAMAGE_AILMENTS/DAMAGE_ATTACKER_VOLATILES/DAMAGE_DEFENDER_VOLATILESはファイル先頭へ移設した(上のexport const参照)。

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
	// ラウンド20(20-D4)で「未撃破」という語自体を廃止し、ラウンド21(21-D7)で
	// 「乱M (x%) →確N」の2段表記も廃止して「確N」単独(未到達なら「10発以上」)に
	// 一本化したため、この注記の文言もそれらの語を使わないよう更新した。
	const TOTAL_RESULT_HINT =
		"ダメージ量は与えた打点の合計です(たべのこし等の回復やどく・やけどの継続ダメージは含みません)。" +
		"確Nの判定はそれらも反映した実際の致死率なので、打点がHPを超えていても確定的な致死判定にならないことがあります。";
	// ラウンド6ユーザー指示(要件5): 技列(加算条件)は最大3つまでしか追加できない
	// (カードの高さを技列3つぶんでちょうど収まるようにするため)。この上限は
	// 「追加」操作にのみ効く上限であり、既存データを削らない: 過去に保存された
	// メモが4件以上のattacksを持っていても(サーバ側 opponent-notes-validation.ts の
	// MAX_ATTACK_COUNT=6までは元々許容されている)、renderColumnsはrow.attacksを
	// 全件そのまま描画する(=表示はする)。「＋」ボタンをrow.attacks.length>=3で
	// 無効化するだけなので、4件以上の既存行はカードが少し縦に伸びるが、データが
	// 消えたり保存が壊れたりすることはない。opponent-notes-validation.ts側の変更は
	// 不要(このファイルは編集禁止でもある)。
	const MAX_COLUMNS_TO_ADD = 3;
	// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「モバイル版では技カードを2つまでに
	// 限定し、あらかじめ左右にスペースを設けておく」。899px以下では技列セクションを
	// 固定2列(grid-template-columns: 1fr 1fr、DamageCalcSection.astro参照)にして
	// 技カードがカード幅の半分ずつを占めるため、3枚目は必ず2行目へ折り返してカードの
	// 高さが跳ねる。追加操作の上限だけをモバイルで2に下げる。
	// 上の3の説明と同じく、これは「追加」操作にのみ効く上限であり既存データは削らない
	// (3件以上のattacksを持つ既存行はrenderColumnsが全件そのまま描画し、2列gridの
	// 2行目以降へ折り返す)。
	const MAX_COLUMNS_TO_ADD_NARROW = 2;
	// isNarrowLayout()はこのブロック内の関数宣言(下方)なのでホイストされ、実際に
	// 呼ばれるのは行の描画・ユーザー操作の時点=定義行より後になるため前方参照で問題ない
	// (既存のregisterDamageCalcBridge等と同じ考え方)。
	function currentMaxColumnsToAdd(): number {
		return isNarrowLayout() ? MAX_COLUMNS_TO_ADD_NARROW : MAX_COLUMNS_TO_ADD;
	}
	// CALC_DEBOUNCE_MS/SAVE_DEBOUNCE_MSは構造分割ラウンド(フェーズ1)でshared-core.tsへ
	// 移設した(scheduleRowCalc/scheduleRowSaveと同じ場所)。

	// 1列 = 技カード1枚。天候・地形・壁・急所・ランク補正・状態異常・テラスタル発動は
	// すべてこのDamageColumnState(技カードごと)に持たせる。エンジン側は攻撃1件ごとに
	// 独立したBattleを構築するため、これらは技カード間で完全に独立して効く
	// (pyodide-engine.ts の calc_lethal_sequence_json 参照)。
	// ラウンド6ユーザー指示でweather/terrain/wallEnabledだけ「カード全体の設定」として
	// 行内の全技カードへ同時に書き込む特別扱いにしていたが、ラウンド7ユーザー指示
	// (方針転換)でこの「カード全体設定」という概念自体を廃止した。天候・フィールド・
	// 壁を含む全項目が、技列をクリックしたときのサイドバー(renderColumnLevelDetailPanel)
	// からその技カード1枚だけを書き換える、単純な1階層の設計に戻った。
	// データ形式は元々このDamageColumnStateどおり技カードごとに保存できる作りだった
	// ため(既存メモの互換読み込みも含め)、このラウンドでの変更はサイドバーの組み立てと
	// 選択状態(クリック挙動)だけで、保存フォーマット・opponent-notes-validation.ts
	// 側の変更は不要(noteToRowStateの旧形式互換ロジックも参照。行レベルにしか
	// 保存されていなかった古いメモは、その値を各技カードの初期値として引き継ぐ)。
	// attacker/defender は「攻撃側/防御側という役割」を指し、row.direction によって
	// どちらが所持ポケモンかが入れ替わる(attacker=常に所持ポケモン、ではない)。
	// DamageColumnStateは構造分割ラウンド(フェーズ1)でshared-core.tsへ移設し、
	// 型としてimportしている(上のimport参照。フィールドの中身は一切変更していない)。

	// 技カード1枚分の初期状態。詳細設定の既定値は「何も起きていない状態」。
	// legacy には、旧形式(カード共通の詳細設定を持つ既存メモ)から引き継ぐ値を渡す。
	function createEmptyColumn(legacy?: Partial<DamageColumnState>): DamageColumnState {
		return {
			moveName: "",
			hitCount: 1,
			critical: false,
			weather: "",
			terrain: "",
			wallEnabled: false,
			stealthRock: false,
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

	// UI改善ラウンド38ユーザー指示(38-D7): 「技を追加」で2個目以降の技カラムを
	// 増やすとき、直前のカラムの「詳細設定」(天候・フィールド・壁・急所・ランク補正・
	// 状態異常・じゅうでん等のvolatile・テラスタル発動)を引き継ぐ。技名・ヒット回数は
	// 技固有の値のため引き継がない(moveName/hitCountをこの戻り値に含めない)。
	// createEmptyColumn()の`legacy`引数(既存メモの旧形式互換用、上のコメント参照)を
	// そのまま再利用し、この関数が作るPartial<DamageColumnState>を渡す形にする
	// (createEmptyColumnの引数自体は増やさない)。
	function inheritedColumnDetailDefaults(previous: DamageColumnState): Partial<DamageColumnState> {
		return {
			critical: previous.critical,
			weather: previous.weather,
			terrain: previous.terrain,
			wallEnabled: previous.wallEnabled,
			stealthRock: previous.stealthRock,
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

	// ラウンド5ユーザー指示: 壁のon/off・攻守ランクのスカラー値から、実際にAPI保存・
	// エンジン呼び出しに使う配列(attackerBoosts/defenderBoosts/defenderSideFields)を
	// 技名の物理/特殊分類にもとづいて自動算出する。技が未入力・分類不明(変化技等)の
	// ときは「どちらの能力に載せるべきか決められない」ため、壁・ランクとも無効化する
	// (中途半端に片方の能力にだけ載せると誤ったダメージ計算になるため)。
	// エンジン契約(pyodide-engine.ts): PokemonSpec.boostsは能力ごとのランク配列
	// ([HP無視,攻撃,防御,特攻,特防,素早さ])、FieldSpec.defenderSideFieldsは
	// サイドフィールド効果名の配列(例["リフレクター"])。
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

	// 旧形式互換: 既存メモに保存されていた能力ごとのランク配列(attackerBoosts/
	// defenderBoosts)から、新UIのスカラー値(attackerRank/defenderRank)を復元する。
	// 「どれか1つでも立っていればON」の考え方と同様に、攻撃側はatk→spaの順、
	// 防御側はdef→spdの順で最初に非ゼロの値を採用する(両方非ゼロという通常は
	// 起こらない組み合わせのときはatk/defを優先する、という決め打ちの解釈)。
	function rankFromLegacyBoosts(boosts: number[] | undefined, primaryKey: StatKey, secondaryKey: StatKey): number {
		if (!Array.isArray(boosts)) return 0;
		const primary = boosts[STAT_KEYS.indexOf(primaryKey)] ?? 0;
		if (primary !== 0) return primary;
		return boosts[STAT_KEYS.indexOf(secondaryKey)] ?? 0;
	}
	// 旧形式互換: 個別の壁(リフレクター/ひかりのかべ/オーロラベール)のうち
	// 「どれか1つでも立っていればON」と解釈する(要件)。

	// 1行 = 相手1体分の状態。opponent_notesの1レコードに対応する
	// (id: null は「まだPOSTしていない=ローカルのみの新規行」を表す)。
	// DamageRowStateは構造分割ラウンド(フェーズ1)でshared-core.tsへ移設し、
	// 型としてimportしている(上のimport参照。フィールドの中身は一切変更していない)。

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
	// (要件: 既存メモを壊さない)。
	// ラウンド11ユーザー指示(実装リスク1・必須対応): DAMAGE_WEATHERS/DAMAGE_AILMENTSから
	// 選択肢を削除しても、既に保存済みの個体データには削除した値(おおひでり/ゆめうつつ等)が
	// 残っている場合がある。アイコン群は選択肢配列にない値を「どれも選択されていない」ように
	// しか描画できないため、描画前にこの関数で選択肢配列に存在しない値を空文字へ正規化する
	// (正規化した行はfetchAndRenderRows側でscheduleRowSave()を呼び、正規化後の値で
	// 保存し直す。アイコンは全部非選択なのにエンジン計算だけ古い値を使う、という不整合を防ぐ)。
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
		// ラウンド20ユーザー指示(20-R3): 揮発状態も選択肢配列(DAMAGE_ATTACKER_VOLATILES/
		// DAMAGE_DEFENDER_VOLATILES)に無い値は同じ理屈で正規化する。
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
	// UI改修依頼(ダメージ計算カード、2026-08-04)「カード並び順の永続化」。opponent_notesには
	// 並び順カラムが無いため、field(jsonb)にorder?: number(分数キー方式)を持たせている
	// (src/lib/opponent-notes-validation.tsのOpponentFieldInput参照)。戻り値にorderを足し、
	// 呼び出し元(fetchAndRenderRows)がrowSortOrderへ登録する形にする。
	function noteToRowState(note: OpponentNoteRecord): { row: DamageRowState; needsResave: boolean; order?: number } {
		const row = createEmptyRow();
		let needsResave = false;
		row.id = note.id;
		const build = (note.opponent_build ?? {}) as unknown as OpponentBuildInput;
		const field = (note.field ?? {}) as unknown as OpponentFieldInput;
		// direction未指定の既存メモは、従来の解釈どおり「この所持ポケモンが攻撃側」とみなす。
		row.direction = field.direction === "defense" ? "defense" : "attack";
		row.name = build.name ?? "";
		// ラウンド4ユーザー指示: 保存済みの性格名からnatureUp/natureDownを正引きして
		// 復元する(いじっぱり→atk上昇/spa下降、等。既存データを開いたときに正しく
		// ↑↓が復元されることの実機確認が必須要件)。
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

		// 旧形式互換: 詳細設定がカード共通(field直下)に保存されていた時代のメモは、
		// その値を全ての技カードの初期値として引き継ぐ。こうすることで旧メモを開いた
		// ときの計算結果が以前と変わらない(=既存メモを壊さない)。引き継いだ後は
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
		// ラウンド5ユーザー指示の後方互換: 壁は「個別の3フラグのどれか1つでも
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
			// 旧形式互換: move_nameのみのメモを1列に変換する。
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


	// clampIntはファイル先頭へ移設した(上のexport function参照。right-panel.tsから参照するため)。


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

	// ラウンド21ユーザー指示(21-D7、ラウンド20 20-D4で導入した「乱M (x%) →確N」の
	// 2段表記を撤回): 「乱3 (…) → 確4 という表記は意味が通じない。すべて込みの
	// 最終結果1つだけを表示する」。判定は「確実に倒せるのは何発目か」の1つだけを返す。
	// 10発以内に確殺(probability>=0.9999、浮動小数の誤差込み)に到達する最初の位置が
	// あれば「確N」のみを返し、そこへ至る前段の乱数確率(乱M (x%))は一切表示しない。
	// 10発以内に到達しなければ、呼び出し元から渡されたnoLethalLabel(技列側/加算後側の
	// いずれも「10発以上」相当の文字列を渡す。describeExtendedTotalNoLethalLabel参照)を返す。
	// severityは.severity-barの色分け(lethal=確1/risky=確2/safe=確3以降・10発以上)に使う。
	//
	// ⚠️ 当初の指示(round-21.md)は「技列側(.damage-column-result)は既に確定数を
	// 1つだけ出しているので触らない」としていたが、これは誤りだった。実データ
	// (フィクスチャ c8680844-... の対戦相手メモ「ディンルー」、じしんhitCount=1)で
	// 検証したところ、perAttackLethal[0] = [{1, 0.9375}, {2, 1}] であり、旧実装の
	// describeSeriesVerdict(series, ...)は最初の非0要素(attackCount1, probability0.9375)
	// を見出しにして「乱1 (93.8%) →確2」を返していた。つまり技列側もこの共有関数を
	// 経由しており、同じ2段表記の不具合を実際に抱えていた(row.lethalを使う加算後側
	// (renderTotalDisplay)だけの問題ではなかった)。共有関数1箇所を直せば両方直る。
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
	// ラウンド21ユーザー指示(21-D7): describeSeriesVerdictと同じく、「一部の乱数分岐だけが
	// 致死する(zero > 0だが zero !== total)」段階では確定と言えないため、全分岐が
	// 致死(zero === total)になるまで確定数として採用しない(旧実装はzero>0の最初の
	// 位置で即座に返しており、「乱N (xx.x%)」相当の未確定値を返していた)。
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

	// ラウンド20ユーザー指示(20-D4): 相手ビルドカード(加算後)の結果から「未撃破」という
	// 語を廃止し、実際に倒せるまで攻撃を伸ばしたときの確定数と致死率を出す。
	// describeSeriesVerdict(result.lethal, ...)は、設定済みの攻撃列(最大3枚)の範囲内で
	// 一度も確殺(致死率100%)に到達しなかったときにこの第2引数(noLethalLabel)をそのまま
	// 表示する。以前はここに固定文字列"未撃破"を渡していたが、この関数はその代わりに
	// 「設定済みの攻撃列を先頭から繰り返し当て続けたら何発で倒せるか」を、技列側
	// (describeStandaloneLethal)と同じ分布演算(1発ごとにHP分布から差し引き0で
	// クリップする)で見積もり、その結果をdescribeSeriesVerdict自身にもう一度通した
	// labelを返す(ラウンド21・21-D7以降は「確N」「10発以上」のいずれかになり、技列側と
	// 語彙が揃う。乱数確率(乱M (xx.x%))を経由する中間段階の表示はもう無い)。実際の
	// 攻撃列の範囲内(result.lethalが担保する区間)はエンジンの厳密な値(たべのこし等の
	// ターン終了時処理を含む)をそのまま使い、この関数が呼ばれるのは範囲内で確殺に
	// 未到達のときだけなので、精度が落ちるのは「まだ確認できていない延長部分」に
	// 限られる(describeStandaloneLethalと同じ精度レベル。ターン終了時処理を含まない
	// 近似値であることは変えていない)。ただし有効な攻撃列が1件だけの行では、技列側と
	// 同じ perAttackLethal[0](エンジンの厳密値)をそのまま使うため近似は発生しない
	// (技列側の「確N」と加算後側の数値が食い違わない)。
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
	function formatCumulativeDamage(row: DamageRowState, result: OpponentClientResultInput): string {
		const valid = validAttacksOf(row);
		const per = result.perAttackDamages;
		const exact = result.cumulativeDamage;
		let min: number;
		let max: number;
		if (exact && Number.isFinite(exact.min) && Number.isFinite(exact.max)) {
			min = exact.min;
			max = exact.max;
		} else {
			if (!Array.isArray(per) || valid.length === 0) return "";
			min = 0;
			max = 0;
			for (let i = 0; i < valid.length; i += 1) {
				const damages = per[i];
				if (!Array.isArray(damages) || damages.length === 0) return "";
				min += Math.min(...damages);
				max += Math.max(...damages);
			}
		}
		const hp = result.defenderHp;
		// ラウンド23ユーザー指示(23-D5)「総合結果から『累計』を削除」。数値と割合は
		// 残し、ラベルの「累計」の文字だけを外す(技列側は元々ラベルを付けていないため
		// この関数だけの変更で足りる)。
		if (hp && hp > 0) {
			const pctMin = Math.floor((min / hp) * 100);
			const pctMax = Math.ceil((max / hp) * 100);
			const pct = pctMin === pctMax ? `${pctMin}%` : `${pctMin}〜${pctMax}%`;
			return `${min}〜${max} (${pct})`;
		}
		return `${min}〜${max}`;
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

	// ラウンド3 B-4: 累計(加算後)で既に確殺に到達している位置(=それ以降の技は
	// 撃つ前提が崩れている)を求める。result.lethalはcalcLethalSequenceの累計致死率
	// 系列で、probability>=0.9999になった最初のattackCountが「そこで確実に倒せる」
	// 位置。数値自体(技ごとの独立判定)は変えず、視覚的に控えめにする材料としてのみ使う。
	function computeConfirmedKillAttackCount(result: OpponentClientResultInput | null): number | null {
		if (!result || !Array.isArray(result.lethal)) return null;
		const confirmed = result.lethal.find((l) => l.probability >= 0.9999);
		return confirmed ? confirmed.attackCount : null;
	}

	// ラウンド4の積み残し(ラウンド3 C-4「結果チップの主役化」): 以前は
	// 「75〜90 (40〜49%) 確3」のように結果テキストを1本の文字列として詰め込んで
	// おり、3枚並べたときに一番読みたい結論(確N/乱N)が他の数値に埋もれていた。
	// is:global側の.damage-row-total-result(grid auto 1fr)/.damage-column-result
	// (ラウンド11から横並びflex-direction:row。要件11-5参照)と組み合わせ、判定
	// (確N/乱N/未撃破等)を大きく太字で左に、ダメージ量の詳細を小さく右に配置する
	// 2分割構造にする。
	// severity(背景色・左罫線の色)は引き続き.severity-bar[data-severity]が
	// 要素全体に適用するため、ここでは中身のDOM構造だけを変える。
	// UI改善ラウンド42ユーザー指示(42-D3)「計算結果が10発以上のときは確定数表記をせず、
	// ダメージ量のみ表示する」。describeStandaloneLethal/describeSeriesVerdictが
	// 10発当てても確殺に至らないケースで返すラベルは`${MAX_STANDALONE_ATTACKS}発以上`
	// (="10発以上")の1種類だけ(上のMAX_STANDALONE_ATTACKS定義・両関数参照)。この値と
	// 一致するときだけverdictSpan(太字の確定数ラベル)自体を生成・appendしない
	// (detailSpanのみ残す)。呼び出し元(renderColumnDisplays=個別技カード側/
	// renderTotalDisplay=累計結果側、いずれもこの関数を経由する)を区別する必要はなく、
	// この1関数を直せば両方に適用される。
	// severity(背景色。.severity-bar[data-severity]、確3以降と同じsafe=薄青系
	// (41-D4)のまま)は据え置く判断にした(round-42.md「見た目上違和感が強ければ
	// safeのままとする」という実装者判断に委ねられた項目。色付きの帯にダメージ量だけが
	// 載る見た目を実機で確認し、違和感が無かったため変更しない)。
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
			// ラウンド3 B-4: 累計で既に確殺に到達した位置より後ろの列は「1発目で撃破済」
			// のような撃破済みキャプションを添えて控えめにする(第3弾の「列は独立判定」の
			// 方針どおり数値自体は変えない)。
			applyOverkill(confirmedKillAt != null && validPos > confirmedKillAt);
			// ラウンド22指摘(22-D-1): 変化技(まもる等)は静的な技データの時点で判定できる
			// (category==="status"はゲーム仕様として常にダメージ0のため、エンジンの
			// 計算結果を待つ必要が無い)。「10発以上 0(0%)」のような誤解を招く表示を
			// 出さず、はきだすと同じ仕組みで理由だけを示す。⚠️ OHKO技(じわれ等)・
			// はきだすは変化技ではない(物理技)ため、この分岐には入らずこれまでどおり
			// 通常のダメージ表示/はきだす専用の断り書きに進む。
			if (isStatusMove(attack.moveName)) {
				setResultPlain(target, STATUS_MOVE_NOTE);
				target.dataset.severity = "none";
				return;
			}
			// ラウンド20: 「はきだす」だけはエンジンの計算結果を待たず(静的な技データだけで
			// 判定できるため)、確N/10発以上のような「0ダメージ」に見える表示を出さず
			// 理由を示す。他の技(カウンター・ちきゅうなげ・OHKO技等)は今はエンジンが
			// 正しく計算するため、以下の通常経路をそのまま通す。
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
	}

	// 左パネル最下段の「加算後のダメ・致死率」を更新する。技列が1つだけのときは
	// 加算する意味が無いので、その旨だけを出して数字は技列側に任せる。
	function renderTotalDisplay(row: DamageRowState): void {
		const target = row.totalResultEl;
		if (!target) return;
		const result = row.clientResult;
		const validAttacks = validAttacksOf(row);
		// UI改善ラウンド45(ユーザー指示第29弾、B-3): 技列が2つ以上あるとき、合計行「確N」が
		// 何を数えているか圧縮表示だけでは伝わらない指摘(round-45.md)への対応。totalBlock
		// (.damage-row-total)は展開/圧縮で共有要素なので、DOM構造自体は変えず、ここで
		// data-multi-move属性だけを立てる(見た目には影響しない)。実際の注記表示は
		// CSS側(#opponent-notes-section .card-damage[data-collapsed="true"]
		// .damage-row-total-result[data-multi-move="true"] .damage-result-verdict::after、
		// DamageCalcSection.astro)が圧縮状態限定のセレクタで生成コンテンツとして足すため、
		// 展開表示は変わらない。全てのreturnパスで参照される属性のため、早期returnより
		// 前(このtarget取得直後)に設定する。
		target.dataset.multiMove = validAttacks.length >= 2 ? "true" : "false";
		if (validAttacks.length === 0) {
			setResultPlain(target, "");
			target.dataset.severity = "none";
			return;
		}
		// ラウンド20: 技列に「はきだす」を含む場合、エンジン(calc_lethal_sequence_json)は
		// その技の寄与を0として他の技と合成した値をそのまま返す。全技がその対象
		// (合算しても常に0)なら、素の確N表示は「0ダメージに見える」誤解を
		// 再現するため、静的な技データの時点で数値を出さず理由だけ示す。
		const hasUnsupported = validAttacks.some((a) => isUnsupportedLethalMove(a.moveName));
		// ラウンド22指摘(22-D-1): 変化技(まもる等)も同じ扱いにする。単独では
		// 技列側(renderColumnDisplays)のisStatusMove分岐で処理されるが、全技列が
		// 変化技(または変化技+はきだすの組み合わせ)だと合計側も「10発以上 0(0%)」の
		// ような誤解を招く表示になるため、こちらでも判定する。
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
			target.dataset.severity = "none";
			return;
		}
		if (!result || !Array.isArray(result.perAttackDamages)) {
			setResultPlain(target, isEngineReady() ? "(計算前)" : "(計算エンジンの初期化待ち)");
			target.dataset.severity = "none";
			return;
		}
		const hasOhko = validAttacks.some((a) => OHKO_MOVE_NAMES.has(a.moveName.trim()));
		const damageText = formatCumulativeDamage(row, result) + (hasOhko ? ` ${OHKO_NOTE}` : "");
		const { label, severity } = describeSeriesVerdict(
			result.lethal,
			describeExtendedTotalNoLethalLabel(row, result),
		);
		if (hasUnsupported) {
			// 数値自体は「算出できる技だけを合算した値」として意味があるため隠さず表示し、
			// 断り書きを添えて過信(色による確定的な印象)を防ぐ(severityは中立のnoneに)。
			const detail = damageText ? `${damageText} ${UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME}` : UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME;
			setResultVerdict(target, detail, label);
			target.dataset.severity = "none";
			return;
		}
		setResultVerdict(target, damageText, label);
		target.dataset.severity = severity;
	}

	// ラウンド20ユーザー指示(20-D3、ラウンド5の判断を撤回): 上下ボタンを廃止し、
	// H/A/B/C/D/S見出し自体が「無補正→上昇→下降→無補正」を巡回する1個のボタンになった。
	// 状態を反映する対象もキーごとの1ボタン(row.natureColLabelEls[key])だけになったため、
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
			const btn = row.natureColLabelEls[key];
			if (!btn) continue;
			const mod = row.natureUp === key ? "up" : row.natureDown === key ? "down" : null;
			if (mod) btn.dataset.mod = mod;
			else delete btn.dataset.mod;
			const indicatorEl = btn.querySelector<HTMLElement>(".damage-ev-nature-indicator");
			const { indicator, description } = describeNatureCycleState(key, mod);
			if (indicatorEl) indicatorEl.textContent = indicator;
			btn.setAttribute("aria-label", description);
			btn.title = description;
		}
	}

	// 実数値グリッド(H/A/B/C/D/S)のみを更新する。ダメージ計算(攻撃列)とは独立に、
	// 相手ビルドの入力(性格・特性・持ち物・テラスタイプ・努力値)が変わるたびに呼ぶ。
	// ラウンド3 B-12: 左パネルのrecalcStats()と同様、エンジン非依存の純JS計算に切り替える
	// (calcHpStat/calcOtherStatはモジュールスコープで定義済み)。ダメージ計算(recalcRow内の
	// この先の処理)は引き続きisEngineReady()待ちのまま。
	// rowCollapseHandlesは下方のconstだが、実際の呼び出しはその初期化後なのでTDZには触れない。
	// 更新漏れを避けるため展開状態でも中身だけ同期する(折りたたみ状態や幅は変更しない)。
	async function recalcRowStatsOnly(row: DamageRowState): Promise<void> {
		const name = row.name.trim();
		const base = name ? (await baseStatsMapPromise).get(name) : undefined;
		if (!base) {
			for (const key of STAT_KEYS) {
				const target = row.statValueEls[key];
				if (!target) continue;
				target.textContent = "-";
				delete target.dataset.mod;
			}
			rowCollapseHandles.get(row)?.refreshCollapsedViews();
			return;
		}
		const level = 50;
		// ラウンド4ユーザー指示: 性格<select>を廃止したので、row.natureUp/natureDownを
		// 使う。片方だけ選択中の不完全な状態はnormalizedNatureBoostsで「まじめ」に
		// 正規化してから使う(保存されるnatureと表示を一致させるため)。
		const natureMod = normalizedNatureBoosts(row.natureUp, row.natureDown);
		STAT_KEYS.forEach((key, i) => {
			const target = row.statValueEls[key];
			const mod = natureMod.up === key ? "up" : natureMod.down === key ? "down" : null;
			if (target) {
				const iv = 31;
				const ev = row.evs[i] ?? 0;
				const value = key === "hp"
					? calcHpStat(level, base[i], iv, ev)
					: calcOtherStat(level, base[i], iv, ev, mod === "up" ? 1.1 : mod === "down" ? 0.9 : 1.0);
				target.textContent = String(value);
				if (mod) target.dataset.mod = mod;
				else delete target.dataset.mod;
			}
			// ラウンド20ユーザー指示(20-D3): row.natureColLabelEls[key]は現在、H/A/B/C/D/Sの
			// 見出し自体が性格循環ボタンになっている(旧・別ボタン時代の名残でここに
			// あったcolLabel.dataset.modへの書き戻しは削除した)。このボタンの見た目
			// (data-mod・▲▼インジケータ・aria-label/title)はクリック直後の「生の状態」
			// (row.natureUp/row.natureDown)を反映するrefreshRowNatureButtons()が
			// 単独で担当する。ここ(recalcRowStatsOnly)はnormalizedNatureBoosts
			// (上昇/下降が両方揃って初めて有効という正規化)を使うため、片方だけ選択中の
			// 直後にここで上書きすると、クリックした瞬間に見えたはずの色/▲▼表示が
			// 一瞬で消えてしまう(実機テストで発覚した回帰)。実数値の数字側
			// (statValueEls)は正規化された値のままで正しい(実際の計算に使う値と
			// 一致させる必要があるため)。
		});
		rowCollapseHandles.get(row)?.refreshCollapsedViews();
	}

	// ラウンド22指摘(22-F)の対応で使う、キー順に依存しない構造比較用の正規化文字列化。
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

	// 🔴 UI改修依頼(個体編集画面、2026-08-02)「耐久調整」機能の土台。recalcRow() が
	// calcLethalSequence()/calcStats() を呼ぶ直前に組み立てている値(攻守切り替え・
	// テラスタルのクランプ・乱数シード)を、耐久調整ブリッジ(下のregisterBulkAdjustBridge
	// 呼び出し・getDefenseRows)からも同じ手順で取得できるよう、recalcRow内にあった
	// 該当箇所(攻守切り替え〜options組み立て)をこの1関数へ切り出した。
	// ⚠️ カードの確N表示(recalcRow)と耐久調整の計算対象(getDefenseRows)が別々のロジックで
	// 値を組み立てると、両者が食い違う(画面は確1なのに耐久調整では耐える、といった不整合)
	// おそれがあるため、必ずこの1関数だけから両方が導出されるようにする。ロジック自体は
	// 元のrecalcRow内の対応箇所から1文字も変えずに移設しただけの純粋なリファクタリング
	// (呼び出し側のrecalcRowは同じ引数・同じ順序でこの関数の戻り値を使うだけ)。
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
		// ラウンド17指摘(A-1・実バグ)の核心対応: jpokeはteraType未指定でも
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
		// ラウンド5ユーザー指示(要件11・12): 壁on/off・攻守ランクのスカラー値から、
		// 実際にエンジンへ渡す配列(attackerBoosts/defenderBoosts/defenderSideFields)を
		// 技名の物理/特殊分類にもとづいて算出し直す(resolveColumnDerivedFields参照)。
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
		// ラウンド22指摘(22-F)「読み込むだけでDBにPUTが飛ぶ」対応。改修前の再計算後の
		// scheduleRowSave(row)は無条件で、Pyodide初期化完了時にcombinedDamageEngineProgress()
		// が全行を一括recalcRow()する(6740行付近)たびに、内容が1バイトも変わらなくても
		// PUTが飛んでupdated_atだけが無意味に更新されていた(実機のPlaywrightネットワーク
		// 計測で、対戦相手メモ4件すべてがページ読み込みのたびにPUTされることを確認済み。
		// この23-D改修前のコード(git stashで退避して比較)でも同じ現象が再現したため、
		// このラウンドで新規に混入したものではなく既存のバグと確認できた)。
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
			// 再計算後の値が以前の保存値と実際に異なるときだけ保存する(22-F)。
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

	// scheduleRowCalcは構造分割ラウンド(フェーズ1)でshared-core.tsへ移設した
	// (recalcRowを呼ぶ処理は下の registerDamageCalcBridge 経由になる。上のimport参照)。

	// ラウンド3 A-4は「保存済みのときだけ隠す」だったが、ラウンド4ユーザー指示は
	// 「下部の保存済み表示は削除する」とより踏み込んだもの。DOMと.damage-row-footer/
	// .damage-row-save-statusクラスはJS/E2Eが参照する可能性があるため残したまま、
	// 保存失敗(state==="error")のとき以外は常に視覚的に隠す(再試行導線が必要な
	// 失敗時だけは残す)。row.saveStatusEl/textContentの更新箇所をこの1関数に集約する。
	function setRowSaveStatus(row: DamageRowState, state: string, text: string): void {
		if (row.saveStatusEl) {
			row.saveStatusEl.dataset.state = state;
			row.saveStatusEl.textContent = text;
		}
		if (row.footerEl) row.footerEl.hidden = state !== "error";
		// ラウンド17指摘(B-1): この行の保存状態が変わるたびに、常時可視なトップバーの
		// 失敗件数表示も更新する。
		updateOpponentNotesFailureAlert();
	}

	// scheduleRowSaveは構造分割ラウンド(フェーズ1)でshared-core.tsへ移設した
	// (setRowSaveStatus/saveRowを呼ぶ処理は下の registerDamageCalcBridge 経由になる。
	// 上のimport参照)。

	// デバウンス付き即時自動保存(左パネルのsaveNow()と同じ流儀)。
	// 相手ポケモン名が空のうちはPOSTしない(サーバ検証でopponent_build.nameが必須のため)。
	async function saveRow(row: DamageRowState): Promise<void> {
		const name = row.name.trim();
		if (name === "") {
			setRowSaveStatus(row, "idle", "未保存(相手ポケモン名を入力すると保存されます)");
			return;
		}
		// UI改善ラウンド48(A-4): 相手ポケモン名が非空で保存が起きるたびに、相手ビルド
		// (性格・特性・持ち物・テラス・努力値)を種族名キーでlocalStorageへ上書き記録する
		// (「最後に使ったビルド」がその種族の既定値になる、という指示どおりの挙動)。
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
			// 読み込み側(noteToRowState)は旧形式のキーがあれば技カードの初期値として
			// 引き継ぐので、既存メモの内容が失われることはない。
			const field: OpponentFieldInput = {
				direction: row.direction,
				attacks,
			};
			const seed = parseSeed(row.seedRaw);
			if (seed !== undefined) field.seed = seed;
			// カード並び順(rowSortOrder、上方参照)。ドラッグ&ドロップで並び替えた行・
			// 新規追加した行だけがWeakMapに値を持つ(既存データのまま一度も並び替えていない
			// 行はundefinedのまま=サーバーに送らない、既存データ互換)。
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
		// ラウンド17指摘(B-1): 保存失敗中だった行を削除した場合、失敗件数から除外する。
		updateOpponentNotesFailureAlert();
	}

	// UI改善ラウンド38ユーザー指示(38-D2): 攻撃側(row.direction === "attack"、
	// このポケモン自身が攻撃する行)の技候補は、種族の覚え技全体(#move-listの並び、
	// left-panel.tsのrebuildMoveListForSpeciesが管理)ではなく、左パネルの技1〜4欄に
	// 現在入力されている値(=このポケモン固有の実際の選択)を最上位に表示する。
	// 共有<datalist id="move-list">自体を書き換えると左パネル本体・受け(defense)側の
	// 技候補まで巻き込むため、この専用の<datalist id="move-list-self-first">を新設し、
	// 攻撃側のmoveInputだけlist属性をこちらに向ける(left-panel.ts/LeftPanel.astroは
	// 一切編集しない。#move-1〜#move-4のvalueをDOM経由で読むだけ)。
	// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「技の候補から変化技を削除」。
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

	// UI改修依頼(ダメージ計算カード、2026-08-04)項目5「防御時の技候補を相手の技の使用率順に
	// 表示する」。上のSELF_FIRST_MOVE_DATALIST_ID(攻撃側=自分の技1〜4を最上位にする)と
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

	// UI改修依頼(個体編集画面・モバイル、2026-08-08)「デフォルトの表示状態でカードを
	// 追加するボタンを表示する」対応。技列(加算条件)を1つ追加する処理は、元々
	// renderColumns内の「＋ 技を追加」ボタン(addButton)のクリックハンドラだけに書かれていたが、
	// 折りたたみ時の「＋」ボタン(renderRow内のcollapsedTechniques、下方参照)からも同じ処理を
	// 呼ぶ必要があるため、共通関数に切り出す(重複コード防止)。呼び出し側(addButton自身、
	// 折りたたみ時ボタン)は事前にMAX_COLUMNS_TO_ADD到達チェック(disabled/hidden)を
	// 行っているが、念のためここでも二重にガードする。
	function addAttackColumn(row: DamageRowState): void {
		if (row.attacks.length >= currentMaxColumnsToAdd()) return;
		// 38-D7: 直前のカラム(row.attacks末尾)があれば、その詳細設定を引き継ぐ。
		const previousColumn = row.attacks[row.attacks.length - 1];
		const column = createEmptyColumn(previousColumn ? inheritedColumnDetailDefaults(previousColumn) : undefined);
		fillFirstMoveCandidate(row, column);
		row.attacks.push(column);
		renderColumns(row);
		scheduleRowCalc(row);
		scheduleRowSave(row);
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
			// ラウンド6ユーザー指示(要件2): クリック委譲(renderRow内のroot.addEventListener)が
			// クリックされた技列を特定するために使う。列は加算/削除のたびに作り直されるため、
			// 都度この時点のindexで振り直す。
			col.dataset.columnIndex = String(index);

			// ラウンド3 B-3: 技列を横に連結する=加算という関係が伝わりにくかったため、
			// 「1発目」「2発目」…の順序キャプションを添える。
			// ラウンド25ユーザー指示(25-D2)「ダメージカードを左右分割し、左側に
			// 数字を書く」により、orderLabelはcol直下ではなく左側の狭い帯として残し、
			// それ以外(技名行・ヒット回数行・条件・結果表示)は新設のcolBody
			// (.damage-column-body、右側)にまとめる。
			const orderLabel = document.createElement("span");
			orderLabel.className = "damage-column-order-label";
			orderLabel.textContent = `${index + 1}`;
			col.appendChild(orderLabel);
			const colBody = document.createElement("div");
			colBody.className = "damage-column-body";
			col.appendChild(colBody);

			const moveInput = document.createElement("input");
			moveInput.type = "text";
			// 攻守を切り替えると技列は「相手が撃ってくる技」になるので、入力欄の
			// placeholder/aria-labelも向きに合わせて言い換える(誰の技を入れる欄なのかが
			// 分からないと、受け計算のときに自分の技を入れてしまう)。
			const attackerIsOpponent = row.direction === "defense";
			// 38-D2: 自分(このポケモン)が攻撃側のときだけ、左パネルの技1〜4を最上位にした
			// 専用datalistを使う(上のensureSelfFirstMoveDatalist/refreshSelfFirstMoveDatalist参照)。
			// 相手が攻撃側(受け計算)のときは種族全体の候補(#move-list)のまま変えない。
			if (attackerIsOpponent) {
				// UI改修依頼(ダメージ計算カード、2026-08-04)項目5: 防御側(相手が攻撃側)の
				// 技候補は、種族全体の候補(#move-list)をそのまま使うのではなく、相手の
				// 使用率順に並べ直した専用datalistを使う(上のensureOpponentPopularityMoveDatalist/
				// refreshOpponentPopularityMoveDatalist参照。攻撃側=SELF_FIRST_MOVE_DATALIST_ID
				// と同じ構造)。
				ensureOpponentPopularityMoveDatalist();
				moveInput.setAttribute("list", OPPONENT_POPULARITY_MOVE_DATALIST_ID);
				moveInput.addEventListener("focus", () => refreshOpponentPopularityMoveDatalist(row.name));
				refreshOpponentPopularityMoveDatalist(row.name);
				attachKanaTypeAhead(moveInput, ensureOpponentPopularityMoveDatalist());
			} else {
				ensureSelfFirstMoveDatalist();
				moveInput.setAttribute("list", SELF_FIRST_MOVE_DATALIST_ID);
				moveInput.addEventListener("focus", () => refreshSelfFirstMoveDatalist());
				refreshSelfFirstMoveDatalist();
				attachKanaTypeAhead(moveInput, ensureSelfFirstMoveDatalist());
			}
			moveInput.placeholder = attackerIsOpponent ? "相手の技" : "技";
			moveInput.setAttribute(
				"aria-label",
				attackerIsOpponent ? `相手が${index + 1}番目に当ててくる技` : `${index + 1}番目に当てる技`,
			);
			moveInput.autocomplete = "off";
			moveInput.value = attack.moveName;
			moveInput.addEventListener("input", () => {
				row.attacks[index].moveName = moveInput.value;
				// 今回の要件: 技が変わった瞬間だけ、critRatioに基づく確定急所の自動入力を試す。
				void notifyDetailMoveChanged(row, row.attacks[index]);
				// ラウンド21ユーザー指示(21-D6): 「マルチヒット技のデフォルトヒット回数はMax」。
				// ここ(技名inputへのユーザーの生入力)は「新規にこの技へ切り替えた」瞬間そのものなので
				// preferMax:trueを渡す。保存済みメモの復元(renderColumns初期描画、下の
				// { silent: true }呼び出し)はこの経路を通らないため、保存値(attack.hitCount)を
				// 勝手に書き換えることはない。
				void refreshHitCountVisibility({ preferMax: true });
				scheduleRowCalc(row);
				scheduleRowSave(row);
			});

			// ラウンド6ユーザー指示(要件1): 歯車(⚙)ボタンを廃止した。この技列自体を
			// クリックする(フォーム要素の外側限定。renderRow内のroot.addEventListener参照)と
			// この技だけの設定(急所・ランク補正など)がサイドバーに表示される。
			// ラウンド3 B-2の積み残し: 削除ボタン(×)は技名行にまとめる
			// (以前は技名直下の中空に取り残され、その下に200px以上の空白ができていた)。
			const moveRow = document.createElement("div");
			moveRow.className = "damage-column-move-row";
			moveRow.appendChild(moveInput);
			colBody.appendChild(moveRow);

			// ラウンド6ユーザー指示(要件4): この技に実際に効いている条件(カード全体の
			// 天候・フィールド・壁も、この技だけの急所・ランク補正等も区別せず)をまとめて
			// 一覧するチップ。既存の.damage-row-condition-chips(以前は相手ビルドの箱に
			// 1個だけ置いていた)をそのまま流用し、技列1枚につき1個生成する
			// (collectConditionChips/refreshRowConditionChips参照。ONの項目だけを出し、
			// 既定値のものは出さない)。
			const conditionChips = document.createElement("div");
			conditionChips.className = "damage-row-condition-chips";
			conditionChips.hidden = true;
			colBody.appendChild(conditionChips);
			row.columnChipEls.push(conditionChips);

			// 技名inputと結果表示の間: DamageCard.pngで「計算の細かい条件を入れる予定」と
			// されている領域。ラウンド12指摘(B-3)で連続回数(.damage-column-hitcount-row)は
			// 技名行(moveRow)側へ移したため、ここに残るのは撃破済み注記のみ。
			const conditions = document.createElement("div");
			conditions.className = "damage-column-conditions";
			colBody.appendChild(conditions);

			// ラウンド3 B-4: 累計で既に撃破済みになった以降の列を控えめに示すキャプション
			// (renderColumnDisplaysのcomputeConfirmedKillAttackCount参照。数値自体は
			// 変えない=列は独立判定のまま)。
			const overkillNote = document.createElement("p");
			overkillNote.className = "damage-column-overkill-note";
			overkillNote.hidden = true;
			conditions.appendChild(overkillNote);

			// ラウンド12指摘(B-3): 技名入力400pxに対し中身が118px(最長でも176px)しか
			// 使っていなかった。「N発目+技名」の同行化(ラウンド10)の延長として、
			// ヒット回数もこの技名行(moveRow)へ同居させ、多段ヒット技の行ぶん
			// (実測約28px)の縦を回収する。クラス名 .damage-column-hitcount-row は
			// E2Eが参照しているため改名しない(要素をmoveRowへappendするだけで、
			// クラス名・[hidden]による表示/非表示ロジックは変えない)。
			const hitRow = document.createElement("div");
			hitRow.className = "damage-column-hitcount-row";
			const hitInput = document.createElement("input");
			hitInput.type = "number";
			hitInput.step = "1";
			hitInput.value = String(attack.hitCount ?? 1);
			hitInput.addEventListener("input", () => {
				const n = Number(hitInput.value);
				const range = hitCountRange;
				row.attacks[index].hitCount = Number.isFinite(n) ? clampInt(n, range[0], range[1]) : range[0];
				scheduleRowCalc(row);
				scheduleRowSave(row);
			});
			hitRow.appendChild(hitInput);
			const unit = document.createElement("span");
			unit.className = "damage-column-hitcount-unit";
			unit.textContent = "ヒット";
			hitRow.appendChild(unit);
			moveRow.appendChild(hitRow);

			// 要件: 連続回数の指定は連続技のときだけ表示する。連続技かどうかは
			// マスタデータ(moves.jsonのhits)で判定する。連続技でない技に切り替えられた
			// ときは、隠すだけでなくhitCountを1に戻す(隠れた入力欄の値が計算に
			// 効き続けると、画面に見えていない条件でダメージが変わってしまう)。
			let hitCountRange: [number, number] = [1, 10];
			// silent: 初回描画時はtrue。値を補正してもここでは保存・再計算を予約しない
			// (描画しただけで保存が走ると、何も編集していないのに保存状態が点滅する)。
			// 補正後の値は、この直後に走る recalcRow() の成功時保存で自然に永続化される。
			// ラウンド21ユーザー指示(21-D6): preferMaxは、技名inputへのユーザーの生入力
			// (moveInput の "input" イベント)からだけtrueで渡される。renderColumns初期描画
			// (下の { silent: true } 呼び出し。保存済みメモの復元・行の再構築の両方がここを通る)
			// は常にfalse/未指定なので、attackState.hitCount(保存値)を優先して勝手に
			// 書き換えることはない。
			async function refreshHitCountVisibility(options?: { silent?: boolean; preferMax?: boolean }): Promise<void> {
				const attackState = row.attacks[index];
				if (!attackState) return;
				const name = attackState.moveName.trim();
				const range = name === "" ? undefined : (await multiHitMapPromise()).get(name);
				const applyCorrection = (value: number): void => {
					if (attackState.hitCount === value) return;
					attackState.hitCount = value;
					hitInput.value = String(value);
					if (options?.silent) return;
					scheduleRowCalc(row);
					scheduleRowSave(row);
				};
				if (!range) {
					// 連続技でない技はヒット数を指定させない(要件)。旧UIでは任意の技に
					// 「N回連続」を指定できたため、既存メモに2以上が残っていることがある。
					// 入力欄を隠すだけだと画面に出ていない倍率が計算に効き続けるので、
					// 1に戻して表示と計算を一致させる。
					hitCountRange = [1, 1];
					hitRow.hidden = true;
					applyCorrection(1);
					return;
				}
				hitCountRange = range;
				hitRow.hidden = false;
				hitInput.min = String(range[0]);
				hitInput.max = String(range[1]);
				const label = range[0] === range[1]
					? `ヒット数(${range[0]}回固定)`
					: `ヒット数(${range[0]}〜${range[1]}回)`;
				// ラウンド19: 「2〜5」という範囲の表示だけでは、実際のヒット数がプレイヤーの
				// 入力ではなく技ごとの確率で決まる乱数であり、この入力欄は「何回ヒットしたと
				// 仮定するか」を指定するものだと伝わらない(初回選択時に最小値へクランプされる
				// 理由も分からない)。確率の出典: .claude/skills/jpoke/references/damage-calc.md
				// 「3. 急所・命中・多段ヒットの扱い」(2〜5回技は37.5%/37.5%/12.5%/12.5%、
				// それ以外の範囲は一様分布)。range[0]===range[1](固定回数技)は乱数の要素が
				// 無いため対象外のまま。
				// 🔴 UI改善ラウンド29(29-D2)「ふくろだたきのヒット数ツールチップが事実と異なる」:
				// ふくろだたきだけは乱数ではなく、選出中の生存かつ状態異常でないポケモンの数で
				// 決定的にヒット数が決まる(出典: vendor/jpoke/src/jpoke/handlers/move_attack.py
				// :3049-3054)。他の多段ヒット技(22件)はこの乱数の汎用文言のままで正しい。
				const hitCountNote = name === "ふくろだたき"
					? "実際のヒット数はパーティの生存数(状態異常でない数)で決まります。乱数ではありません。"
					: "実際のヒット数は技ごとの確率で決まる乱数です。";
				hitInput.title = range[0] === range[1]
					? label
					: `${label}。${hitCountNote}ここでは指定した回数ヒットした場合を計算します。`;
				hitInput.setAttribute("aria-label", label);
					unit.textContent = "ヒット";
				// ラウンド21ユーザー指示(21-D6): 「マルチヒット技のデフォルトヒット回数はMax」。
				// 新規にこの技へ切り替えた直後(preferMax:true)だけrange[1](最大)にする。
				// それ以外(保存済みメモの復元・行の再構築)はattackState.hitCount(保存値、
				// 新規技行では常に1)をそのままクランプする従来どおりの挙動を維持する。
				const desired = options?.preferMax ? range[1] : attackState.hitCount;
				applyCorrection(clampInt(desired, range[0], range[1]));
			}
			hitRow.hidden = true; // マスタデータの読み込み完了まではひとまず隠しておく
			void refreshHitCountVisibility({ silent: true });

			// UI改善ラウンド43ユーザー指示(43-D6)「技カードの削除ボタンを技カード右上に固定」。
			// 以前は[技名][×]を技名行(moveRow)にまとめてインライン配置していた(ラウンド3 B-2)が、
			// カード全体の削除ボタン(.damage-row-delete-button、position:absolute; top; right)と
			// 同じ考え方で、この技カード(col、.damage-column)自身を基準に右上へ絶対配置する。
			// moveRowへは追加せず、col直下へ直接appendする(CSSはDamageCalcSection.astroの
			// .damage-column-remove-button参照。.damage-columnにposition:relativeを追加済み)。
			col.classList.toggle("has-remove-button", row.attacks.length > 1);
			if (row.attacks.length > 1) {
				const removeBtn = document.createElement("button");
				removeBtn.type = "button";
				removeBtn.className = "btn-ghost damage-row-icon-button damage-column-remove-button";
				removeBtn.textContent = "×";
				removeBtn.title = "この技カードを削除";
				removeBtn.addEventListener("click", () => {
					row.attacks.splice(index, 1);
					renderColumns(row);
					scheduleRowCalc(row);
					scheduleRowSave(row);
				});
				col.appendChild(removeBtn);
			}

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
		// ラウンド6ユーザー指示(要件5): 技列は最大3つまで。3つに達したら押せなくする
		// だけでなく、ラベル文言そのものを理由の説明に差し替える(titleのhoverだけに
		// 頼らない = 見ただけで「なぜ押せないか」が分かる状態にする)。
		const addButton = document.createElement("button");
		addButton.type = "button";
		addButton.className = "damage-add-column-button";
		// 上限はレイアウト幅で変わる(モバイルは2、デスクトップは3。currentMaxColumnsToAdd参照)。
		const maxColumns = currentMaxColumnsToAdd();
		const isAtMax = row.attacks.length >= maxColumns;
		// UI品質改善(ラウンド8 A-2): 上限到達時の説明文はコントラストが低く読めない
		// うえ48pxを消費し続けていた。文言はホバー用title向けに残しつつ、スロット自体を
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
		// UI改修依頼(個体編集画面・モバイル、2026-08-08): 実際に技を1つ追加する処理は
		// addAttackColumn(row)(fillFirstMoveCandidateの直後で定義)へ切り出し済み。
		// 折りたたみ時の「＋」ボタン(renderRow内のcollapsedTechniques)と共通化するため。
		addButton.addEventListener("click", () => addAttackColumn(row));
		(row.addColumnSlotEl ?? row.columnsEl).appendChild(addButton);

		renderColumnDisplays(row);
		// ラウンド6ユーザー指示(要件4): 列を作り直すと条件チップの器
		// (.damage-row-condition-chips)も作り直されるため、中身をここで再描画する。
		refreshRowConditionChips(row);
		// ラウンド6ユーザー指示(要件2): 列を作り直すとis-selectedマーカーも失われるため
		// (columnsEl.innerHTMLを丸ごと差し替えているため)、選択中ならここで再適用する。
		// ラウンド7ユーザー指示(方針転換): 「カード全体設定」という代替の表示先が
		// 無くなったため、選択されていた技列自体が削除された場合は選択を完全に解除する
		// (サイドバーは空状態に戻る。既存データ自体は失われない)。
		// selectedRow/selectedColumnはshared-core.tsへ移設したため、getSelectedRow/
		// getSelectedColumn/clearSelection経由で読み書きする(構造分割ラウンド・フェーズ1。
		// ロジック自体は変えていない)。
		if (getSelectedRow() === row) {
			const currentSelectedColumn = getSelectedColumn();
			if (currentSelectedColumn && row.attacks.includes(currentSelectedColumn)) {
				applySelectionMarks(row, currentSelectedColumn);
			} else {
				clearSelection();
			}
			renderDetailPanel();
		}
	}

	// --- 詳細設定サイドバーに表示する内容(ラウンド7ユーザー指示・方針転換) ---
	// 天候・地形・壁・急所・ランク補正・状態異常・テラスタル発動は、実装上はすべて
	// DamageColumnStateとして技カード(攻撃列)ごとに保持している。ラウンド3〜5では
	// 「見出しは技名なのに中身は行全体で共通の設定」という食い違いを避けるため、
	// これら全部をひとまとめにして行内の全技列へ同時反映する1枚の⚙ダイアログにし、
	// ラウンド6では天候・フィールド・壁だけ「カード全体の設定」として残し、他を
	// 技ごとの独立設定に分割していた。ラウンド7ユーザー指示で「カード全体設定」という
	// 概念自体を廃止し、天候・フィールド・壁も含めた全項目が技列をクリックしたときの
	// サイドバー(renderColumnLevelDetailPanel)からその技カード1枚だけを書き換える、
	// 単純な1階層の設計に戻った。
	// 保存フォーマット(技カードごとのフィールド)自体は元から変えていないので
	// opponent-notes-validation.ts側の変更は不要。
	// ステルスロック等の設置技はcalc_damages/calc_lethalではイベントが発火せず効果ゼロと
	// 判明しているため、ここには置かない。
	// ラウンド5ユーザー指示: 壁・ランクの判定はUI上のスカラー値(wallEnabled/
	// attackerRank/defenderRank)で行う。attackerBoosts等の配列はresolveColumn
	// DerivedFields()が技名の分類判明後に算出する派生値なので、値がまだ0のまま
	// (技名未入力・分類不明の間)でもスカラー側は即座に正しい状態を反映できる。

	// 既定以外の条件を短いラベルの配列にする(技列ごとのONチップ表示用)。
	// 天候・フィールド・壁・急所・ランク補正・状態異常・テラスタル発動のうち、
	// 既定でない値がすべて漏れなくここに出ること。ラウンド7で全項目が技ごとの
	// 独立設定になったため、この関数はもともと1つのDamageColumnStateだけを見る
	// 実装のまま(カード全体/技ごとを区別する必要自体が無くなった=単純化)。
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
		if (a.defenderAilment) defender.push(a.defenderAilment);
		if (showTera && a.defenderTerastallized) defender.push("テラスタル");
		if (a.weather) field.push(a.weather);
		if (a.terrain) field.push(a.terrain);
		// 🔴 UI改善ラウンド29(29-D1)「条件チップ『攻撃+6』が技の分類を区別しない固定文言」:
		// resolveColumnDerivedFields()(上記)は技の物理/特殊分類でatk/spaのどちらに
		// ランクを載せるか自動振り分け済み(計算自体は正しい)。表記だけが「攻撃」固定で、
		// 特殊技でも実際に乗っているのは特攻(C)ランクなのに「攻撃」と表示され誤解を招く。
		// getMoveCategory(a.moveName)で物理/特殊を判定し、物理なら「攻撃/防御」、特殊なら
		// 「特攻/特防」と出し分ける(右パネルの単一「ランク」入力欄自体は変えない)。
		// 今回の表記統一では、グループ見出しで側を判別できることを優先してこの出し分けを廃止する。
		// 攻撃側・防御側はグループ見出しで判別できるため、能力名ではなく共通の「ランク」で示す。
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
		// 展開表示は、非テラスレギュレーションでも計算に残っているテラスタル設定を
		// ユーザーが把握できるよう常に表示する。折りたたみ表示だけはユーザー指示どおり
		// refreshCollapsedTechniques()側でレギュレーションに応じて出し分ける。
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

	// refreshRowConditionChipsは構造分割ラウンド(フェーズ1)でshared-core.tsへ移設した
	// (row.columnChipEls[i]へのrenderConditionChipsInto呼び出しはregisterDamageCalcBridge
	// 経由になる。上のimport参照)。

	// UI改善ラウンド36ユーザー指示(第18弾・機能追加)「ダメージカードの折りたたみ機能」。
	// 状態はDBに保存しない(ページ再読み込みでは既定=展開状態に戻ってよい、というユーザー
	// 指示どおり)ため、JSメモリ内(このモジュールのクロージャ)だけで完結させる。
	// DamageRowState(shared-core.ts、このラウンドの編集対象外ファイル)にはフィールドを
	// 追加せず、row参照をキーにしたWeakSet/WeakMapで折りたたみ状態と行ごとの
	// setCollapsed()を保持する(WeakなのでrowがGCされれば自動的に参照も外れる)。
	const collapsedRowSet = new WeakSet<DamageRowState>();
	// モバイルは1カラムでカード幅を親に追従させるため、展開時のpx幅固定を使わない。
	function isNarrowLayout(): boolean {
		return true;
	}
	// 🔴 UI改修依頼(個体編集画面、2026-08-02)「耐久調整」機能の土台。refreshCollapsedViewsは
	// 耐久調整ポップアップに貼る圧縮表示の複製(buildCollapsedPreview、下方参照)を作る前に、
	// 元のカードの折りたたみ状態(dataset.collapsed)を一切変えずに、折りたたみ用DOM
	// (.damage-row-collapsed-summary/.damage-row-collapsed-techniques・実数値表)の中身だけを
	// 最新化するために追加した。setCollapsed()が呼んでいるrefreshCollapsedSummary()/
	// refreshCollapsedStats()/refreshCollapsedTechniques()の3つをこの1関数にまとめて、
	// setCollapsedと同じくrenderRowのクロージャ内で定義してWeakMapへ登録する。
	const rowCollapseHandles = new WeakMap<
		DamageRowState,
		{ setCollapsed: (collapsed: boolean) => void; refreshCollapsedViews: () => void }
	>();
	// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「相手ビルドのポケモンアイコンを
	// ドット絵に変更」。ドット絵(モバイル)と公式アートワーク(デスクトップ)の切り替えは
	// 画像URLの差でしかないため、幅の境界をまたいだ瞬間に各行のrefreshSprite()を呼び直す
	// 必要がある。rowCollapseHandlesと同じく、renderRowのクロージャ内の関数をWeakMapで
	// 行に紐づけておき、下方のmatchMediaリスナーがrows(表示中の行)を回して呼ぶ
	// (行ごとにリスナーを足すと、削除した行のクロージャがリスナー経由で残ってしまう)。
	const rowSpriteRefreshers = new WeakMap<DamageRowState, () => void>();
	function setAllRowsCollapsed(collapsed: boolean): void {
		for (const row of rows) {
			rowCollapseHandles.get(row)?.setCollapsed(collapsed);
		}
	}

	// 🔴 UI改善ラウンド40ユーザー指示(40-D1)「テラスタイプ選択ボックスは、左パネルのもの
	// (選択肢にアイコンが見えるカスタムドロップダウン)と共通化する」。LeftPanel.astro
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

		// UI改善ラウンド48(A-4): 種族プリセット適用時に、クリック操作を介さず外部から
		// 表示だけを更新できるようにする(onChangeは呼ばない。値の反映・再計算・保存の
		// トリガーは呼び出し側=applyOpponentBuildPreset側でまとめて行う)。
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
		// UI品質改善(デザイン原則整合): ダメージ計算1件=対戦相手1体は追加/削除できる
		// コレクション要素なので、基底.card(global.css)+ページ固有の.card-damageにする。
		root.className = "card card-damage";
		row.root = root;

		const body = document.createElement("div");
		body.className = "damage-row-body";
		root.appendChild(body);

		// --- 左側: 相手ビルドの箱(DamageCard.pngの左側のボックス) ---
		// ラウンド7ユーザー指示(方針転換): この箱のクリックは無反応(サイドバーを
		// 開くのは技列の箱だけ)という確定仕様になったため、選択マーカー用の
		// row.buildEl参照は廃止した。
		const buildEl = document.createElement("div");
		buildEl.className = "damage-row-build";
		body.appendChild(buildEl);

		// 🔴 UI改善ラウンド28ユーザー指示(28-D1)「相手アイコンは最初の5段分(攻守切替+
		// 種族名/特性/持ち物/テラスの4段)を使う」により、buildMain/buildLeftを先に
		// 組み立て、actionsRow(1段目)をbuildLeftの中に入れる(以前はbuildEl直下の
		// 独立した行だった)。こうするとbuildLeftの高さ=actionsRow+buildFields(1〜5段目)
		// になり、隣のspriteBox(下記)がalign-items:stretchでその高さに追随する。
		const buildMain = document.createElement("div");
		buildMain.className = "damage-row-build-main";
		buildEl.appendChild(buildMain);
		const buildLeft = document.createElement("div");
		buildLeft.className = "damage-row-build-left";
		buildMain.appendChild(buildLeft);

		// 1段目: 攻守切り替えボタン。
		const actionsRow = document.createElement("div");
		actionsRow.className = "damage-row-actions";
		buildLeft.appendChild(actionsRow);

		// ラウンド20ユーザー指示(20-D2、旧・単一トグルボタンを撤回): 「攻撃」「防御」の
		// 2値セグメントコントロールにする(role="radiogroup"+role="radio"。
		// refreshDirectionUi参照)。
		const directionToggle = document.createElement("div");
		directionToggle.className = "damage-row-direction-toggle";
		directionToggle.setAttribute("role", "radiogroup");
		directionToggle.setAttribute("aria-label", "攻守の向き");
		const attackOption = document.createElement("button");
		attackOption.type = "button";
		attackOption.className = "damage-row-direction-option";
		// UI改善ラウンド26(26-D1): 攻撃/防御を区別するdata-role属性を新設する
		// (CSSは.damage-row-direction-option[data-role="attack"/"defense"][aria-checked="true"]参照)。
		attackOption.dataset.role = "attack";
		attackOption.setAttribute("role", "radio");
		attackOption.textContent = "攻撃";
		const defenseOption = document.createElement("button");
		defenseOption.type = "button";
		defenseOption.className = "damage-row-direction-option";
		defenseOption.dataset.role = "defense";
		defenseOption.setAttribute("role", "radio");
		defenseOption.textContent = "防御";
		directionToggle.append(attackOption, defenseOption);
		actionsRow.appendChild(directionToggle);

		// 2〜5段目: 名前input+特性/持ち物/テラスの縦スタック(.damage-row-build-fields)。
		// UI品質改善(ラウンド8 A-1)由来の構成をそのまま維持する。
		const buildFields = document.createElement("div");
		buildFields.className = "damage-row-build-fields";
		buildLeft.appendChild(buildFields);

		const nameRow = document.createElement("div");
		nameRow.className = "pokemon-name-row";
		buildFields.appendChild(nameRow);

		// ラウンド4で24px→48pxに拡大、ラウンド5ユーザー指示で「まだ小さすぎる」との
		// 再指摘で72px64pxに拡大、ラウンド8指摘(A-1)で名前行から出したぶんの余白を使い
		// 96px/88pxへ拡大、ラウンド26ユーザー指示(26-D3)「攻撃・防御ボタンの幅を短縮し、
		// 空いた分でポケモンアイコンを大きくする」により112px/104pxへさらに拡大する
		// (.damage-sprite-boxのCSSと合わせる)。
		// 持ち物画像は名前行の横幅を圧迫しないよう名前inputの隣に置かず、種族アイコンの
		// 右下バッジ(テラスタイプバッジは右上)として重ねる。
		// 🔴 UI改善ラウンド28ユーザー指示(28-D1)「ポケモンアイコンは最初の5段分使う」
		// により、spriteBox自体の高さはCSS側でbuildLeft(1〜5段目)の高さに
		// stretchで追随させる(.damage-row-build-main { align-items: stretch }参照)。
		// img自体はwidth/height属性による固定サイズをやめ、object-fit:containで
		// 箱いっぱいに収める(CSSの img.sprite-icon 参照。縦横比は保つ)。
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
		const typeBadge = document.createElement("span");
		typeBadge.className = "damage-type-badge";
		const typeBadgeImg = document.createElement("img");
		typeBadgeImg.className = "damage-type-badge-img";
		typeBadgeImg.width = 20; // box-damage-card.cssの.damage-type-badge-img(20px)に合わせる
		typeBadgeImg.height = 20;
		typeBadgeImg.alt = "";
		typeBadgeImg.style.display = "none";
		const typeBadgeFallback = document.createElement("span");
		typeBadgeFallback.className = "damage-type-badge-fallback";
		typeBadge.append(typeBadgeImg, typeBadgeFallback);
		const itemBadge = document.createElement("span");
		itemBadge.className = "damage-item-badge";
		// applyItemImage()は非同期なので、既定は非表示にしておく
		// (持ち物なしの相手で空バッジ・壊れ画像アイコンが一瞬でも出ないようにする)。
		itemBadge.hidden = true;
		const itemImg = document.createElement("img");
		itemImg.className = "damage-item-image";
		// 23-D1: バッジのCSS(width/height:37px)に合わせる(表示サイズはCSSのwidth:100%/
		// height:100%が決めるため実害は無いが、img自身の意図する解像度を一致させておく)。
		itemImg.width = 37;
		itemImg.height = 37;
		itemImg.alt = "";
		itemImg.style.display = "none";
		itemBadge.appendChild(itemImg);
		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「ダメージカードの相手ビルドサイズを
		// 大幅削減」。提案図(box_個体編集_vs_相手ビルド.png)では、持ち物がまだ決まっていなくても
		// ドット絵の右下にオレンジ色の丸い「?」バッジが常に見えていて、そこをタップして
		// 持ち物を選ぶ導線になっている。持ち物アイコンが出せないとき(=applyItemImageが
		// バッジごとhiddenにする状態。未設定・アイコン画像が引けない種類の両方を含む)に
		// 代わりに見せるプレースホルダを1個だけ入れておく(表示切り替えはモバイルのCSSのみ。
		// デスクトップの「持ち物なしならバッジごと出さない」既存仕様は変更しない)。
		const itemBadgePlaceholder = document.createElement("span");
		itemBadgePlaceholder.className = "damage-item-badge-placeholder";
		itemBadgePlaceholder.setAttribute("aria-hidden", "true");
		itemBadgePlaceholder.textContent = "?";
		itemBadge.appendChild(itemBadgePlaceholder);
		spriteBox.append(spriteImg, spriteFallback, typeBadge, itemBadge);
		// ラウンド8指摘(A-1): 以前は名前行(nameRow)の中に置いていたが、名前行が
		// スプライトの高さぶん1行占有してしまう原因だったため、名前行の外へ出していた。
		// ラウンド27ユーザー指示(27-D1)でbuildMain(入力ボックス一式buildLeftの隣)へ戻し、
		// 🔴 ラウンド28ユーザー指示(28-D1)でbuildLeftが1段目(actionsRow)を含むようになった
		// ことで、このspriteBoxも1〜5段目ぶんの高さまで自動的に伸びる。
		buildMain.appendChild(spriteBox);

		// UI改善ラウンド36ユーザー指示(36-1)「折りたたみ時に代わりに出す要素」: 相手ポケモン名
		// (読み取り専用)+攻守の向き。buildLeft(入力欄一式)を隠す折りたたみ時だけCSSで
		// display:flexにする(#opponent-notes-section .damage-row-collapsed-summary参照)。
		// 実体の<input>/トグルボタンを複製せず、値をtextContentへ反映するだけの
		// 読み取り専用表示にすることで、自動保存契約(row.name/row.direction)には
		// 一切影響しない(refreshCollapsedSummary参照、下で定義)。
		const collapsedSummary = document.createElement("div");
		collapsedSummary.className = "damage-row-collapsed-summary";
		const collapsedNameEl = document.createElement("span");
		collapsedNameEl.className = "damage-row-collapsed-name";
		const collapsedDirectionEl = document.createElement("span");
		collapsedDirectionEl.className = "damage-row-collapsed-direction";
		// UI改善ラウンド46ユーザー指示(第30弾、A-1): ラウンド42時点では「340px幅に名前・
		// 攻守バッジ・実数値6つを収める時点で十分密になっており、特性名まで足すと1行に
		// 収まらず可読性を損なう」と判断して特性名を出していなかった(下のコメント参照)。
		// ラウンド45でこの左ブロック(.damage-row-collapsed-summary)の幅が115.2px→234.42pxに
		// 拡張され、当時の空間制約の前提が変わったため、round-46.mdのワイヤーフレーム
		// (docs/ui_proposal/ダメージカード_圧縮.png、種族名→攻撃or防御→特性→実数値の
		// 4行構成)どおり特性行を追加する。特性はマルチスケイル・しんりょく・こだいかっせい・
		// メガランチャーのようにダメージ計算そのものに直結する情報であり、折りたたみ一覧
		// だけで相手を見比べる場面での判断ミスを防ぐ(round-46.md、プレイヤー視点レビュアー
		// 指摘)。右側の技列2段目(.damage-row-collapsed-detail-line)と同一仕様
		// (0.76rem/font-weight 400/var(--color-text-muted)/nowrap+ellipsis+title)で新設し、
		// 新色・新フォントサイズは増やさない(round-46.md、UIレビュアー指摘の実装方針)。
		const collapsedAbilityEl = document.createElement("span");
		collapsedAbilityEl.className = "damage-row-collapsed-ability";
		// 🔴 UI改善ラウンド42ユーザー指示(42-D4、38-D6を撤回): 使用技名を「/」区切りで
		// 列挙していた旧collapsedMovesEl(.damage-row-collapsed-moves)は削除した。
		// round-42.mdの総評「圧縮前後で情報の欠落が大きい」を受け、使用技はヒット数・
		// 詳細設定込みで右側の新設3段表示(refreshCollapsedTechniques、下方参照)へ
		// 表示場所を移す。この左側summaryには代わりに、42-D4が要件とする「H/A/B/C/D/Sの
		// 実数値のみ」の行(collapsedStatsEl)を追加する(種族値・努力値・スライダーは
		// 出さない。展開時の.damage-ev-gridをまるごと出す旧方式とは別に、実数値だけの
		// コンパクトな新規表示にする)。テラスタイプは既存のtypeBadge(spriteBoxに重ねる
		// アイコン、42-D4「アイテム・テラスタルはアイコンのみ」の対象)で既に見えているため
		// テキストでは重複表示しない。特性名は42-D4時点では「実装者判断で表示しない」
		// としていたが、🔴 UI改善ラウンド46ユーザー指示(第30弾、A-1)でこの判断を撤回し、
		// 上のcollapsedAbilityElとして追加した(理由は上のコメント参照)。
		// 実測(round-42.md検証時、フィクスチャc8680844-...のカイリュー行)で判明: 6項目を
		// flex-wrapの1コンテナに任せると、build幅340px(スプライト80px分を引いた残り
		// 約234px)ぎりぎりのところで「S116だけ2行目に孤立して折り返る」ような不揃いな
		// 折り返りが起き、カード同士の高さが行によって102.75px/116.06pxとばらつく事故が
		// 実測で見つかった(3桁の実数値が並ぶと数px単位でギリギリ)。ラウンド45はH/A/B
		// (1行目)・C/D/S(2行目)に固定で分けた3列×2行gridで対応した。
		// 🔴 UI改善ラウンド47ユーザー指示(第31弾、A-1): 当初「6項目を1行flexに詰める」案を
		// 実装したが、Coordinatorから追加指示があり「ラベル行(H/A/B/C/D/S)+実数値行の
		// 2段・6列表」という確定仕様に差し替えられた(1行flexだと最悪ケースでフォントを
		// 12px下限ギリギリまで縮める必要があり見た目が窮屈になるため撤回)。6個のラベル要素を
		// 先に1段目、6個の実数値要素を2段目に配置し、6列グリッド(grid-auto-flow:row既定)へ
		// display:contentsで直接参加させることで、同じ列位置に縦の対応が取れる
		// (H↑値、A↑値…と6列すべてが揃う)。性格補正の上昇/下降は、ラウンド45で追加した
		// 値側の▲/▼記号ではなく、ラベル文字への+/-付記(例: A+/C-)で表現する新仕様になった
		// (refreshCollapsedStats参照、値には記号を付けない)。
		const collapsedStatsEl = document.createElement("div");
		collapsedStatsEl.className = "damage-row-collapsed-stats";
		const collapsedStatKeyEls: Partial<Record<StatKey, HTMLElement>> = {};
		const collapsedStatValueEls: Partial<Record<StatKey, HTMLElement>> = {};
		const statLabelRow = document.createElement("div");
		statLabelRow.className = "damage-row-collapsed-stats-line";
		const statValueRow = document.createElement("div");
		statValueRow.className = "damage-row-collapsed-stats-line";
		STAT_KEYS.forEach((key) => {
			const keyEl = document.createElement("span");
			keyEl.className = "damage-row-collapsed-stat-key";
			keyEl.textContent = STAT_KANJI[key];
			statLabelRow.appendChild(keyEl);
			collapsedStatKeyEls[key] = keyEl;
		});
		STAT_KEYS.forEach((key) => {
			const valueEl = document.createElement("span");
			valueEl.className = "damage-row-collapsed-stat-value tnum";
			valueEl.textContent = "-";
			statValueRow.appendChild(valueEl);
			collapsedStatValueEls[key] = valueEl;
		});
		collapsedStatsEl.append(statLabelRow, statValueRow);
		// 🔴 UI改善ラウンド47ユーザー指示(第31弾、追加指示A-7、A-5を撤回して差し替え):
		// 直前のA-5実装(種族名・攻撃/防御バッジ・特性を1段の.damage-row-collapsed-meta-rowに
		// まとめる)を、ユーザーの再指定「1段目: 攻撃/防御 種族名 / 2段目: 特性、テラスタル」
		// により2段構成へ作り直す。
		// 1段目(.damage-row-collapsed-meta-row、既存クラス名を流用): 攻撃/防御バッジ
		// (collapsedDirectionEl)→種族名(collapsedNameEl)の順(ユーザー指定の並び順に合わせて
		// DOM追加順を変更。以前のA-5はnameEl→directionElの順だった)。特性(collapsedAbilityEl)は
		// この行から外す。バッジ・種族名とも省略しない(flex:0 0 auto、下のCSS参照)。
		// 2段目(.damage-row-collapsed-tera-row、新設): 特性(collapsedAbilityEl、既存要素を
		// そのままこちらへ移動。スタイル・ellipsis仕様は維持)→テラス情報の順。
		// テラス情報はスプライト画像に重ねていた既存の.damage-type-badge(typeBadgeImg/
		// typeBadgeFallback)をやめ(折りたたみ時限定でCSS側をdisplay:noneに戻す、下方の
		// [data-collapsed="true"] .damage-type-badge参照)、ここに新しい小アイコン
		// (collapsedTeraImg/collapsedTeraFallback)として表示する。applyTeraImage()の
		// シグネチャ(imgEl, fallbackEl, teraName)はtypeBadgeImg/typeBadgeFallbackへの
		// 呼び出しと同一で、同じ関数を2組の要素へそれぞれ適用するだけでよい(下方の
		// refreshTypeBadge参照)。特性・テラアイコンの合計が234.42px幅を超える場合は
		// A-5と同じ考え方で特性側だけellipsis省略する(flex:1 1 auto; min-width:0、
		// テラアイコン側はflex:0 0 auto固定サイズ)。
		const collapsedTeraImg = document.createElement("img");
		collapsedTeraImg.className = "damage-row-collapsed-tera-icon-img";
		collapsedTeraImg.width = 16;
		collapsedTeraImg.height = 16;
		collapsedTeraImg.alt = "";
		// typeBadgeImgと同じ理由(applyTeraImage解決前に壊れ画像アイコンが一瞬出ないよう
		// 既定で隠す)。
		collapsedTeraImg.style.display = "none";
		const collapsedTeraFallback = document.createElement("span");
		collapsedTeraFallback.className = "damage-row-collapsed-tera-icon-fallback";
		const collapsedTeraIconEl = document.createElement("span");
		collapsedTeraIconEl.className = "damage-row-collapsed-tera-icon";
		collapsedTeraIconEl.append(collapsedTeraImg, collapsedTeraFallback);
		// round-47.md A-7「テキストラベル(タイプ名)を併記するかは実装者判断でよい」に基づき、
		// アイコンの右にタイプ名テキストを添える。アイコン・名前とも省略対象にしない固定サイズの
		// 塊としてまとめる(.damage-row-collapsed-tera-info、下記append参照。CSSは
		// DamageCalcSection.astro参照)。
		const collapsedTeraNameEl = document.createElement("span");
		collapsedTeraNameEl.className = "damage-row-collapsed-tera-name";
		const collapsedTeraInfoEl = document.createElement("span");
		collapsedTeraInfoEl.className = "damage-row-collapsed-tera-info";
		collapsedTeraInfoEl.append(collapsedTeraIconEl, collapsedTeraNameEl);

		const collapsedMetaRow = document.createElement("div");
		collapsedMetaRow.className = "damage-row-collapsed-meta-row";
		collapsedMetaRow.append(collapsedDirectionEl, collapsedNameEl);
		const collapsedTeraRow = document.createElement("div");
		collapsedTeraRow.className = "damage-row-collapsed-tera-row";
		collapsedTeraRow.append(collapsedAbilityEl, collapsedTeraInfoEl);
		collapsedSummary.append(collapsedMetaRow, collapsedTeraRow, collapsedStatsEl);
		buildMain.appendChild(collapsedSummary);
		function refreshCollapsedSummary(): void {
			collapsedNameEl.textContent = row.name.trim() || "(名前未設定)";
			const selfAttacks = row.direction !== "defense";
			// UI改善ラウンド45(ユーザー指示第29弾、A-4)で「攻撃/防御」→「与ダメ/被ダメ」に
			// 変更したが(%の基準が伝わらないというプレイヤー視点レビュアー指摘への対応)、
			// 🔴 UI改善ラウンド47ユーザー指示(第31弾、A-2)によりユーザーが明示的にこれを
			// 撤回し「攻撃/防御」への復帰を指示した(ワイヤーフレーム
			// docs/ui_proposal/ダメージカード_圧縮.png の表記に合わせる)。ユーザー判断が
			// 最優先のため撤回する。ラウンド45が指摘した「%の基準が伝わらない」問題自体は
			// 復活する(再度指摘があれば別解決策を検討する、round-47.md参照)。展開時の
			// インタラクティブなセグメントコントロール(.damage-row-direction-option、
			// 下のattackOption/defenseOption)は「攻撃」「防御」のまま元々変更していない
			// (別要素・別の確定仕様)。dataset.role(色分け用)はラウンド45のまま変更しない。
			collapsedDirectionEl.textContent = selfAttacks ? "攻撃" : "防御";
			collapsedDirectionEl.dataset.role = selfAttacks ? "attack" : "defense";
			// UI改善ラウンド46ユーザー指示(第30弾、A-1): 名前欄の
			// row.name.trim() || "(名前未設定)" と同じフォールバック文法に揃える。
			// title属性にもフルテキストを持たせ、ellipsis省略時のツールチップにする
			// (round-46.md、UI・プレイヤー視点レビュアー重複指摘、統合済み)。
			const abilityText = row.abilityName.trim() || "(特性未設定)";
			collapsedAbilityEl.textContent = abilityText;
			collapsedAbilityEl.title = abilityText;
		}
		// 42-D4: H/A/B/C/D/Sの実数値だけをこの折りたたみ用の行へ複製する。実数値の算出
		// ロジック自体(性格補正込み)は展開時の.damage-ev-grid(row.statValueEls)を
		// recalcRowStatsOnly()が最新化しており、この関数はその結果(表示済みのtextContent/
		// data-mod)をそのまま読み写すだけ(計算式を二重に持たない)。折りたたみ中は
		// 入力欄が隠れて編集不可なため(36-1の既存方針)、この読み写しはsetCollapsed()の
		// タイミングだけで行えば値がずれることはない(下のsetCollapsed参照)。
		function refreshCollapsedStats(): void {
			for (const key of STAT_KEYS) {
				const keyTarget = collapsedStatKeyEls[key];
				const valueTarget = collapsedStatValueEls[key];
				const source = row.statValueEls[key];
				if (!keyTarget || !valueTarget) continue;
				const mod = source?.dataset.mod;
				// UI改善ラウンド45(ユーザー指示第29弾、A-3)で性格補正の上昇/下降を値側に
				// ▲/▼記号として追加したが(色のみ表現はWCAG 1.4.1に抵触するため)、
				// UI改善ラウンド47ユーザー指示(第31弾、A-1、Coordinator追加指示)により
				// 「ラベル行+実数値行の2段・6列表」への変更に伴い、記号の付与位置がラベル側
				// (H/A/B/C/D/Sの文字)へ移り、一時的に▲/▼ではなく+/-をラベル文字に直接付記する
				// 形にしていた(例: 上昇ならA+、下降ならC-)。
				// 🔴 UI改善ラウンド47ユーザー指示(第31弾、A-7実装後にさらに追加)「性格補正は
				// +/-ではなく展開中と同じ三角形で表現する」により、記号だけを+/-→▲/▼に戻す
				// (付与位置=ラベル文字への直接付記はそのまま変更しない、例: 上昇ならA▲、
				// 下降ならC▼)。展開時の.damage-ev-nature-indicator(describeNatureCycleState、
				// 上方参照)と同じグリフを使う。値側には記号を付けない。色は新色を作らず、
				// 既存の--color-stat-up/--color-stat-down(.damage-row-collapsed-stat-key[data-mod]、
				// DamageCalcSection.astro)をそのままラベル側に付け替えて流用する。
				const suffix = mod === "up" ? "▲" : mod === "down" ? "▼" : "";
				keyTarget.textContent = STAT_KANJI[key] + suffix;
				if (mod) keyTarget.dataset.mod = mod;
				else delete keyTarget.dataset.mod;
				valueTarget.textContent = source?.textContent ?? "-";
			}
		}

		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.setAttribute("list", "pokemon-list");
		nameInput.placeholder = "相手ポケモン";
		nameInput.setAttribute("aria-label", "相手ポケモン名");
		nameInput.autocomplete = "off";
		nameInput.value = row.name;
		// 相手側の動的入力にも左パネルと同じIME安全なdatalist補助を適用する。
		attachKanaTypeAhead(nameInput, el<HTMLDataListElement>("pokemon-list"));
		nameRow.appendChild(nameInput);

		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「ダメージカードの相手ビルドサイズを
		// 大幅削減」(docs/ui_proposal/mobile/box_個体編集_vs_相手ビルド.png)。提案図の相手ビルドは
		// 「ドット絵 + [攻撃][特性][テラスタル]の1行 + H〜Sの3段表」だけで、種族名の入力欄が
		// 描かれていない。ユーザー確認済みの確定仕様は「ドット絵をタップすると種族名入力欄が
		// その場に現れてフォーカスされる」。
		// 実装方針: 入力欄はDOMから消さず(自動保存契約 row.name / 既存のdatalist補助・
		// change時のプリセット適用をそのまま使うため)、モバイルのCSSで既定 display:none にし、
		// この buildEl.dataset.mobileEdit の値で出し分ける。
		// role/tabindexはデスクトップでも付くが、デスクトップでは入力欄が常時見えているため
		// 「クリックすると種族名欄にフォーカスが移るだけ」の無害な導線になる(モバイル判定で
		// 属性を付け外しする仕組みを行ごとに持つより、こちらのほうが単純で壊れにくい)。
		spriteBox.setAttribute("role", "button");
		spriteBox.tabIndex = 0;
		spriteBox.setAttribute("aria-label", "相手の種族名を編集");
		// ⚠️ 「入力欄からフォーカスが外れたら畳む」方式は採らない(実装途中で実測して撤回した):
		// 畳むのはmousedown(=次のタップの入り口)で起きるため、開いていた行のぶんだけ
		// 画面が上にずれ、mousedownとmouseupで別の要素が当たって「1回目のタップが無反応に
		// なる」事故になる(努力値テキストで再現)。同じトリガをもう一度押して閉じる
		// トグル方式なら、レイアウトが動くのは常にユーザーが意図した操作の瞬間だけになる。
		function toggleMobileEdit(target: "name" | "item"): void {
			if (buildEl.dataset.mobileEdit === target) {
				delete buildEl.dataset.mobileEdit;
				return;
			}
			// もう片方が開いていても、値を先に差し替えてからfocus()する
			// (focus()が誘発するblurより先にCSSの出し分けを確定させる)。
			buildEl.dataset.mobileEdit = target;
		}
		function beginMobileNameEdit(): void {
			toggleMobileEdit("name");
			if (buildEl.dataset.mobileEdit !== "name") return;
			nameInput.focus();
			nameInput.select();
		}
		spriteBox.addEventListener("click", beginMobileNameEdit);
		spriteBox.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault(); // Spaceでのページスクロールを止める
			beginMobileNameEdit();
		});
		// Enterで確定したら畳む(タップ操作では同じドット絵をもう一度押して畳む)。
		nameInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			if (buildEl.dataset.mobileEdit !== "name") return;
			nameInput.blur();
			delete buildEl.dataset.mobileEdit;
		});

		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「相手ビルドのポケモンアイコンを
		// ドット絵に変更」。デスクトップ(900px以上)は従来どおり公式アートワーク
		// (officialArtworkUrl)のままで、899px以下だけPokeAPIのドット絵(spriteUrl。
		// 左パネルの持ち物バッジ等と同じソース)に差し替える。
		// 幅の境界をまたいだときは下方のmatchMediaリスナーが全行のこの関数を呼び直す。
		function refreshSprite(): void {
			void applySprite(
				spriteImg,
				spriteFallback,
				row.name.trim(),
				isNarrowLayout() ? spriteUrl : officialArtworkUrl,
			);
		}
		rowSpriteRefreshers.set(row, refreshSprite);
		function refreshTypeBadge(): void {
			// 🔴 UI改善ラウンド31ユーザー指示(31-D4b)で追加していた選択欄左の専用アイコン
			// (teraFieldIcon/teraFieldIconFallback)への同時更新は、🔴 UI改善ラウンド40
			// ユーザー指示(40-D1)「テラス選択ボックスを左パネルと共通化する」により、
			// アイコン表示自体がbuildTeraDropdown()のボタン内蔵アイコン(下方のteraDropdown
			// 参照。row.teraTypeが変わるたびに内部でteraTypeIconUrlを引き直す)に一本化された
			// ため不要になった(選択欄の外に重ねる専用アイコンはもう無い)。
			void applyTeraImage(typeBadgeImg, typeBadgeFallback, row.teraType);
			// 🔴 UI改善ラウンド47ユーザー指示(第31弾、A-7): 折りたたみ2段目
			// (collapsedTeraRow)の小アイコンも同じrow.teraTypeで更新する。上のtypeBadgeImg/
			// typeBadgeFallbackへの呼び出しと同じapplyTeraImage()を、別の要素ペア
			// (collapsedTeraImg/collapsedTeraFallback)へそのまま適用するだけでよい。
			void applyTeraImage(collapsedTeraImg, collapsedTeraFallback, row.teraType);
			// round-47.md A-7「テキストラベル(タイプ名)を併記するかは実装者判断でよい」に
			// 基づき、アイコンの隣にタイプ名テキストを表示する。テラスタイプ未設定
			// (row.teraType==="")のときは空文字にし、アイコン(applyTeraImageがimg/fallback
			// 両方をdisplay:noneにする)と同じく何も見えない状態にする。
			const teraTypeText = row.teraType.trim();
			collapsedTeraNameEl.textContent = teraTypeText;
			collapsedTeraNameEl.title = teraTypeText;
			// UI改修依頼(共通方針、2026-08-01)「テラスタイプが未設定の場合、"未設定"などと
			// 表示せず要素ごと非表示にする」。アイコン(applyTeraImage)・名前テキストは既に
			// 空/非表示になっているが、それだけだと空のicon+textラッパー(collapsedTeraInfoEl、
			// gap込み)が場所だけ占有して残るため、ラッパーごと隠す(持ち物バッジ等、他の
			// 未設定表現と同じ「要素ごと消す」流儀に揃える)。
			// UI改修依頼(ダメージ計算カード、2026-08-02)「圧縮表示もレギュレーションに応じて
			// テラスタルの表示・非表示を自動判断する」。展開側のrowTeraFieldWraps(相手の
			// テラスタイプ選択欄、syncTeraFieldVisibility()参照)と同じisTerastalRegulation()
			// 判定を、圧縮表示の相手テラスタイプ表示(このcollapsedTeraInfoEl)にもかける。
			// row.teraType自体は変更しない(表示の出し分けのみ)。
			collapsedTeraInfoEl.hidden =
				teraTypeText === "" || !isTerastalRegulation(currentIndividualRegulation());
		}
		function refreshItemImage(): void {
			void applyItemImage(itemImg, row.itemName.trim());
		}

		function onFieldInput(): void {
			scheduleRowCalc(row);
			scheduleRowSave(row);
		}

		nameInput.addEventListener("input", () => {
			row.name = nameInput.value.trim();
			refreshSprite();
			refreshCollapsedSummary();
			onFieldInput();
		});
		// 23-D2: 種族名が確定した(blur、またはpokemon-listのdatalist選択によるchange)
		// タイミングでのみ特性候補を作り直す(理由は上のabilitySelectコメント参照)。
		// UI改善ラウンド48(A-4): 同じタイミングで、種族ごとのローカルプリセット(性格・特性・
		// 持ち物・テラス・努力値)の自動適用も試みる(applyOpponentBuildPresetは同期関数。
		// 下方でabilitySelect/itemInput/teraDropdown/evInputEls定義後に関数宣言するが、
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

		// ラウンド6ユーザー指示(要件1): ⚙(この行の計算条件)ボタンは廃止した。
		// ラウンド7ユーザー指示(方針転換): 相手ビルドの箱のクリックは無反応(サイドバーを
		// 開くのは技列の箱だけ)という確定仕様になった(このrenderRow末尾の
		// root.addEventListener("click", ...)参照)。

		// ラウンド21ユーザー指示(21-D3、以前はactionsRow=攻守切り替えボタンと同じ1行目に
		// 同居させていた構成を撤回): 「削除ボタンはカード全体の右上に移動。×印を使う」。
		// カード(root)直下にposition:absoluteで置く(CSSは.damage-row-delete-button参照。
		// hover/focus-within時のみ可視 + 既存のwindow.confirm()(deleteRow内)の
		// 二重の誤操作抑止)。
		const deleteRowButton = document.createElement("button");
		deleteRowButton.type = "button";
		deleteRowButton.className = "btn-ghost damage-row-icon-button damage-row-delete-button";
		deleteRowButton.textContent = "×";
		deleteRowButton.title = "この相手を削除";
		deleteRowButton.setAttribute("aria-label", "この相手を削除");
		deleteRowButton.addEventListener("click", () => void deleteRow(row));
		root.appendChild(deleteRowButton);

		// UI改善ラウンド36ユーザー指示(36-2)「折りたたみ・展開のきりかえボタンを右下に配置」。
		// 削除ボタンが右上に戻ったことで空いた右下の座席(CSSは
		// .damage-row-collapse-toggle-button参照)に、この行専用の折りたたみ/展開トグルを置く。
		// 状態はDBに保存しない(row.collapsed相当のフィールドをDamageRowState自体には追加せず、
		// このファイル内のWeakSet/WeakMapだけで完結させる。下のsetCollapsed/collapsedRowSet参照)。
		const collapseToggleButton = document.createElement("button");
		collapseToggleButton.type = "button";
		collapseToggleButton.className = "btn-ghost damage-row-icon-button damage-row-collapse-toggle-button";
		root.appendChild(collapseToggleButton);

		// UI改善ラウンド38ユーザー指示(38-D5)「折りたたみ・展開ボタンは >> を90度回転させた
		// デザインにする。ボタンに枠は表示しない」。文字自体は常に"»"(二重山括弧、見た目は
		// 右向きの>>2つ)で固定し、90度の回転方向だけをCSS側([aria-expanded]、下の
		// .damage-row-collapse-toggle-button参照)で状態ごとに切り替える(回転後は
		// 展開中=上向き"^^"、折りたたみ中=下向き"vv"に見える)。枠(border)はCSS側で除去する。
		// 🔴 UI改善ラウンド43ユーザー指示(43-D5)「丸枠の中心と記号の中心を一致させる」対応:
		// 以前はボタン自身(textContent="»")にtransform(rotate)を掛けていたが、ボタン自身に
		// transformを掛けると円形の背景(border-radius:50%の丸枠)も一緒に動く/回転する
		// (円は回転しても見た目が変わらないため回転自体は無害だったが、中心を補正する
		// translateYを足すと、円と文字が一緒にずれるだけで「円の中の文字の位置」は
		// 一切変わらないことが実測で判明した)。円(ボタン自身の背景)を動かさずに文字だけを
		// 補正するため、glyph用の<span>を新設し、rotate/translateYはこのspanにだけ適用する
		// (CSSはDamageCalcSection.astroの.damage-row-collapse-toggle-glyph参照)。
		const collapseToggleGlyph = document.createElement("span");
		collapseToggleGlyph.className = "damage-row-collapse-toggle-glyph";
		collapseToggleGlyph.textContent = "»";
		collapseToggleGlyph.setAttribute("aria-hidden", "true");
		collapseToggleButton.appendChild(collapseToggleGlyph);
		function setCollapsed(collapsed: boolean): void {
			// UI改修依頼(ダメージカード)「圧縮前後で全体の横幅が変わらないようにする」対応。
			// .card-damageは幅を指定せず内容量(技列の枚数等)で決まるため、折りたたみで
			// .damage-row-columns-wrap等がdisplay:noneになると内容が減り、カード自体の横幅も
			// 一緒に縮んでいた。まだ展開状態のレイアウトが残っている(=dataset.collapsedを
			// 書き換える前)今のうちに実測幅を固定し、折りたたみ後もその幅を維持する。
			// getBoundingClientRect()はレイアウトを強制するため、必ずdataset.collapsedの
			// 変更より前に呼ぶこと(後に呼ぶと既に折りたたみ後の縮んだ幅を読んでしまう)。
			if (isNarrowLayout()) {
				root.style.width = "";
			} else if (collapsed && root.dataset.collapsed !== "true") {
				const expandedWidth = root.getBoundingClientRect().width;
				if (expandedWidth > 0) root.style.width = `${expandedWidth}px`;
			}
			if (collapsed) {
				collapsedRowSet.add(row);
			} else {
				collapsedRowSet.delete(row);
				// 展開に戻すときは固定幅を解除し、内容量に応じた自然なサイズに戻す
				// (技列の追加・削除で幅が変わる既存の挙動を壊さないため)。
				root.style.width = "";
			}
			root.dataset.collapsed = collapsed ? "true" : "false";
			collapseToggleButton.title = collapsed ? "この相手の入力欄を展開する" : "この相手の入力欄を折りたたむ";
			collapseToggleButton.setAttribute(
				"aria-label",
				collapsed ? "この相手の入力欄を展開する" : "この相手の入力欄を折りたたむ",
			);
			collapseToggleButton.setAttribute("aria-expanded", String(!collapsed));
			refreshCollapsedSummary();
			// 🔴 UI改善ラウンド42ユーザー指示(42-D4/42-D5): 折りたたみ時にだけ見える
			// 実数値行(refreshCollapsedStats)・技列3段表示(refreshCollapsedTechniques)も
			// このタイミングで最新化する。両関数とも、参照するDOM要素(collapsedStatsEl配下・
			// collapsedTechniques配下)はrenderRowの後半(techniquesRow組み立て時)で
			// constされるため、この関数自体は先に定義されていても、実際に呼ばれる
			// (=setCollapsed()が呼ばれる)のはrenderRow全体の構築が完了した後(下方の
			// 初回setCollapsed(false)呼び出し、またはユーザーのクリック)に限られる限り
			// 問題ない(関数宣言のホイストと、それが参照するconst変数の初期化完了は別物
			// なので、初回呼び出し位置をrenderRowの末尾に置いている。下方参照)。
			refreshCollapsedStats();
			refreshCollapsedTechniques();
			// 🔴 38-H1: 個別行の折りたたみ切り替え(このボタン自身のクリックでも、
			// ヘッダーの単一トグルボタンからのsetAllRowsCollapsed()経由でも)のたびに、
			// ヘッダーボタンのラベルを最新の「全部畳まれているか」判定で更新する。
			updateCollapseToggleButtonLabel();
		}
		// 🔴 UI改修依頼(個体編集画面、2026-08-02)「耐久調整」機能の土台。setCollapsed()から
		// dataset.collapsed/width操作を除いた「表示中身の最新化」だけを行う版。耐久調整
		// ポップアップ用の複製(buildCollapsedPreview)を作る直前に、このカード(元のDOM)の
		// 折りたたみ状態を変えずに.damage-row-collapsed-summary等の中身だけ最新化するために使う。
		function refreshCollapsedViews(): void {
			refreshCollapsedSummary();
			refreshCollapsedStats();
			refreshCollapsedTechniques();
		}
		collapseToggleButton.addEventListener("click", () => setCollapsed(!collapsedRowSet.has(row)));
		// 36-3「すべて折りたたむ・展開する」ツールバーが行ごとのsetCollapsed()を呼べるように、
		// row参照をキーにしたWeakMapへ登録する(DamageRowState自体にコールバック用フィールドを
		// 増やさないための実装手段。上のimport元のshared-core.tsは編集対象外ファイルのため)。
		// 耐久調整ブリッジ(refreshCollapsedViews)もここで一緒に登録する。
		rowCollapseHandles.set(row, { setCollapsed, refreshCollapsedViews });
		// 🔴 UI改善ラウンド42ユーザー指示(42-D4/42-D5)対応: 初回のsetCollapsed(false)呼び出しは
		// renderRow末尾(techniquesRow/collapsedTechniques・totalBlock等すべてのconst構築が
		// 完了した後、下方のrefreshSprite()等の初期描画呼び出しの並びに移設した。旧実装は
		// ここ(buildLeft/ev-grid/techniques-rowを組み立てるより前)で即座に呼んでいたが、
		// setCollapsed()がrefreshCollapsedTechniques()(collapsedMoveListEl/
		// collapsedDetailLineEl等、techniquesRow組み立て時に初めてconstされる変数を参照する)を
		// 呼ぶようになったため、ここで即座に呼ぶとTDZ(初期化前のconst参照)でエラーになる。
		// 呼び出しタイミングを移すだけで、「初期状態は展開」という結果自体は変わらない。

		// 攻守切り替え。「攻撃」「防御」どちらを押しても、押した側の値になる
		// (同じ側を押しても意味は変わらないが、setDirectionは冪等なので害はない)。
		// 技列に入れる技は常に攻撃側の技なので、切り替えると技列の意味も入れ替わる
		// (=そのことがボタンとplaceholderから読み取れる必要がある)。
		function refreshDirectionUi(): void {
			const selfAttacks = row.direction !== "defense";
			attackOption.setAttribute("aria-checked", String(selfAttacks));
			defenseOption.setAttribute("aria-checked", String(!selfAttacks));
			// ラウンド21ユーザー指示(21-D4)でカード全体の背景色を方向別に出し分けるために
			// 導入したroot.dataset.directionは、ラウンド26ユーザー指示(26-D1)でその
			// CSSルール(.card-damage[data-direction=...])自体を撤回した後も、方向を示す
			// DOM属性として残す(他の用途で参照される可能性を考慮。実害は無い)。
			root.dataset.direction = selfAttacks ? "attack" : "defense";
			const attackDetail = "この個体の技で相手を攻撃する計算です。";
			const defenseDetail = "相手の技をこの個体が受ける計算です。";
			attackOption.title = attackDetail;
			attackOption.setAttribute("aria-label", `攻撃。${attackDetail}`);
			defenseOption.title = defenseDetail;
			defenseOption.setAttribute("aria-label", `防御。${defenseDetail}`);
		}
		function setDirection(next: "attack" | "defense"): void {
			if (row.direction === next) return;
			row.direction = next;
			// ユーザー入力済みの技は保ち、空欄だけ切替後の候補で補う。
			for (const column of row.attacks) fillFirstMoveCandidate(row, column);
			refreshDirectionUi();
			refreshCollapsedSummary();
			// 技列のplaceholder/aria-label(「技」⇄「相手の技」)も向きで変わるため作り直す。
			// renderColumns()自身が末尾でselectedRow===rowなら
			// renderDetailPanel()を呼ぶため、サイドバー側の向き別ラベル
			// (「攻撃(自分)」⇄「攻撃(相手)」、壁のラベル)もここで自動的に追随する。
			renderColumns(row);
			onFieldInput();
		}
		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「ダメージカードの相手ビルドサイズを
		// 大幅削減」。提案図(box_個体編集_vs_相手ビルド.png)の1行目は[攻撃][特性][テラスタル]の
		// 3ボタンで、攻守は2値セグメントではなく1個のボタン+注記「クリックして攻防入れ替え」に
		// なっている。モバイルでは非選択側をCSSで隠す(下記CSS
		// .damage-row-direction-option[aria-checked="false"])ため、見えているボタン=現在の向きで
		// あり、それを押す操作は「切り替えたい」以外に意味がない。そこでモバイルのときだけ
		// 押された側ではなく反対側へ倒す。デスクトップは2値セグメントのまま(押した側になる)。
		function onDirectionOptionClick(clicked: "attack" | "defense"): void {
			if (isNarrowLayout()) {
				setDirection(row.direction === "defense" ? "attack" : "defense");
				return;
			}
			setDirection(clicked);
		}
		attackOption.addEventListener("click", () => onDirectionOptionClick("attack"));
		defenseOption.addEventListener("click", () => onDirectionOptionClick("defense"));

		const selectsRow = document.createElement("div");
		selectsRow.className = "damage-row-build-grid";
		buildFields.appendChild(selectsRow);

		// ラウンド4ユーザー指示: 性格の<select>は廃止した。性格は努力値/実数値グリッドの
		// H/A/B/C/D/S見出しクリック(下のevGrid構築部分、natureColLabelEls参照)で
		// 決まるようになったため、1行(性格select)ぶん高さも削減できる。

		// ラウンド23ユーザー指示(23-D2、=ラウンド22の22-Cを統合): 特性はその種族が
		// 持ちうる特性だけを候補とする<select>にする(左パネルのrebuildAbilityOptions()
		// と同じ考え方。ただし左パネルはローカル変数に密結合していて共通関数化されて
		// いないため、ここでも同じloadAbilitiesMap()を呼ぶ専用実装を用意する)。
		// ⚠️ 相手ビルドは種族名を頻繁に打ち替えるため、1文字ごとの"input"イベントで
		// 候補を作り直すと入力途中で選択肢が消え続けて操作を妨げる(左パネルのコメント
		// 「pitfalls.mdの自動保存リスクと同種」参照)。種族名inputの"change"
		// (blur/確定時)にだけ結線し、タイプ中は現在の候補を保持する(実機で
		// 妨げないことを確認済み。判断根拠は報告参照)。
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
					// UI改善ラウンド46ユーザー指示(第30弾、A-1): 折りたたみ左ブロックの
					// 特性行(collapsedAbilityEl)もrow.abilityNameの変化に追随させる。
					refreshCollapsedSummary();
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
			// UI改善ラウンド26ユーザー指示(26-L1/26-R2)「相手ビルドの特性もデフォルトで
			// 一つ目の特性を設定する」。左パネルのrebuildAbilityOptions()と同じ考え方で、
			// 保存済みの値が新しい候補に無い場合のフォールバック先を""ではなく
			// 候補の先頭(abilities[0])にする。
			abilitySelect.value = abilities.includes(previousValue) ? previousValue : abilities[0];
			abilitySelect.title = abilitySelect.value;
			if (abilitySelect.value !== previousValue) {
				row.abilityName = abilitySelect.value;
				// UI改善ラウンド46ユーザー指示(第30弾、A-1): 特性のデフォルト設定
				// (26-L1/26-R2)でも折りたたみ左ブロックの特性行を最新化する。
				refreshCollapsedSummary();
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
			// UI改善ラウンド46ユーザー指示(第30弾、A-1): 特性<select>のchangeイベントで
			// row.abilityNameが変わるたびに折りたたみ左ブロックの特性行も追随させる。
			refreshCollapsedSummary();
			onFieldInput();
			refreshAbilityCycleButton();
		});
		selectsRow.appendChild(abilitySelect);

		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「特性はリストボックスでは
		// なく、クリックすると [特性なし → 特性1 → 特性2 → … → 特性なし] をループするボタンに
		// する。ボタンの見た目はただのテキストにして目立たなくする」。
		// <select>自体は消さずモバイルでCSS非表示にし、この薄いラッパーボタンから
		// abilitySelect.value を進めて change を発火させる(row.abilityNameの更新・
		// notifyDetailAbilityChanged・折りたたみ表示の追随・自動保存は、すべて上の
		// change ハンドラ1本に集約されたまま。デスクトップの<select>の見た目・挙動は無変更)。
		// ループの並びは<select>のoption順そのもの。rebuildRowAbilityOptions()が先頭に
		// value="" のプレースホルダを置くので、それがそのまま提案の「特性なし」になる。
		const abilityCycleButton = document.createElement("button");
		abilityCycleButton.type = "button";
		abilityCycleButton.className = "damage-row-ability-cycle";
		function refreshAbilityCycleButton(): void {
			const label = abilitySelect.value || "特性なし";
			abilityCycleButton.textContent = label;
			abilityCycleButton.title = label;
			// 候補が引けない種族(未入力・入力途中)では<select>もdisabledになる。
			// 回せるものが無いのでボタン側も同じ状態にする。
			abilityCycleButton.disabled = abilitySelect.disabled || abilitySelect.options.length <= 1;
			abilityCycleButton.setAttribute("aria-label", `相手の特性: ${label}。タップして切り替え`);
		}
		abilityCycleButton.addEventListener("click", () => {
			const count = abilitySelect.options.length;
			if (count === 0) return;
			// selectedIndexは未選択のとき-1になりうるが、その場合も次は0(先頭=特性なし)になる。
			abilitySelect.selectedIndex = (abilitySelect.selectedIndex + 1) % count;
			abilitySelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		selectsRow.appendChild(abilityCycleButton);
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
		selectsRow.appendChild(itemInput);

		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08): 提案図の注記「アイテムアイコン。
		// クリックしてアイテム選択」。ドット絵の右下に重ねた持ち物バッジをタップすると、
		// モバイルで畳んである持ち物入力欄がその場に現れてフォーカスされる(種族名側の
		// beginMobileNameEditと同じ仕組み。上方のspriteBoxのコメント参照)。
		// ⚠️ itemBadgeはspriteBoxの子なので、stopPropagation()しないと種族名編集の
		// クリックハンドラまで走ってしまう(後勝ちで種族名欄が開く事故になる)。
		// ⚠️ メガシンカ種族では持ち物がメガストーンに固定されitemInputがdisabledになる
		// (applyRowMegaStoneAutofill)。そのときは編集モードにせず、バッジ側も
		// aria-disabledで操作できないことを伝える。
		itemBadge.setAttribute("role", "button");
		itemBadge.tabIndex = 0;
		itemBadge.setAttribute("aria-label", "相手の持ち物を選択");
		function beginMobileItemEdit(): void {
			if (itemInput.disabled) return;
			toggleMobileEdit("item");
			if (buildEl.dataset.mobileEdit !== "item") return;
			itemInput.focus();
			itemInput.select();
		}
		itemBadge.addEventListener("click", (event) => {
			event.stopPropagation();
			beginMobileItemEdit();
		});
		itemBadge.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			event.stopPropagation();
			beginMobileItemEdit();
		});
		itemInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			if (buildEl.dataset.mobileEdit !== "item") return;
			itemInput.blur();
			delete buildEl.dataset.mobileEdit;
		});

		// UI改修依頼(共通)「メガシンカポケモンのアイテムをメガストーンで固定する」により、
		// 「持ち物が既に入っていれば何もしない」自動設定から、メガシンカ種族が確定している間は
		// 常にメガストーンへ強制し持ち物欄自体を編集不能にする方式へ変更した(ゲーム仕様上
		// メガシンカ中はメガストーン以外を持てないため)。相手の種族は頻繁に打ち替えるため、
		// rebuildRowAbilityOptionsと同じくnameInputの"change"(blur/確定)にのみ結線する。
		const megaStoneLockedTitle = "メガシンカ中はアイテムをメガストーンに固定します";
		let rowMegaStoneAutofillToken = 0;
		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08): 持ち物欄がロックされている間は、
		// その欄を開くための入口(ドット絵右下の持ち物バッジ)も操作できないことを伝える。
		// disabledの付け外しと必ず同じタイミングで呼ぶ。
		function syncItemBadgeDisabled(): void {
			if (itemInput.disabled) {
				itemBadge.setAttribute("aria-disabled", "true");
				itemBadge.title = megaStoneLockedTitle;
			} else {
				itemBadge.removeAttribute("aria-disabled");
				itemBadge.removeAttribute("title");
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

		// 🔴 UI改善ラウンド40ユーザー指示(40-D1)「テラスタイプ選択ボックスは、左パネルのもの
		// (選択肢にアイコンが見えるカスタムドロップダウン)と共通化する」。以前の<select>+
		// 左に絶対配置したアイコンのオーバーレイを撤回し、buildTeraDropdown()(下方定義。
		// LeftPanel.astro/left-panel.tsの#tera-dropdown-button/#tera-dropdown-list相当を
		// idを使わないクロージャ実装に書き直したもの)でこのカードの相手テラスタイプ
		// ドロップダウンを1つ生成する。ダメージカードは複数枚同時に存在しうるため、
		// idの一意性に依存しないこの実装が必要(左パネルはページ内に1個だけなのでidで
		// 事足りるが、こちらは行の数だけインスタンスが要る)。
		const teraDropdown = buildTeraDropdown(row.teraType, "相手のテラスタイプ", (newValue) => {
			row.teraType = newValue;
			refreshTypeBadge();
			onFieldInput();
		});
		selectsRow.appendChild(teraDropdown.wrap);
		// UI改修依頼(2026-08-01)「レギュレーションに応じてテラスタル選択ボックスの表示
		// ON/OFFを切り替える」。初期表示はこの生成時点の#regulation値で決め、以後は
		// 上のsyncTeraFieldVisibility()(#regulationのchangeリスナー)が追随する。
		rowTeraFieldWraps.set(row, teraDropdown.wrap);
		teraDropdown.wrap.hidden = !isTerastalRegulation(currentIndividualRegulation());
		// UI改修依頼(ダメージ計算カード、2026-08-02)「圧縮表示もレギュレーションに応じて
		// テラスタルの表示・非表示を自動判断する」。refreshTypeBadge()/refreshCollapsedTechniques()
		// はどちらも関数宣言(ホイストされる)なので、本体の定義位置(前者は上方、後者は下方)より
		// このregisterのほうが先でも参照できる(上のrowTeraFieldWraps.set()と同じホイスト依存の
		// 既存パターン)。実際に呼ばれるのはsyncTeraFieldVisibility()実行時(regulation変更後)。
		rowCollapsedTeraRefreshers.set(row, () => {
			refreshTypeBadge();
			refreshCollapsedTechniques();
		});

		// 努力値/実数値グリッド(DamageCard.pngの「努力値 ＨＡＢＣＤＳ」「実数値 ＨＡＢＣＤＳ」)。
		// CSSが7列グリッド(行ラベル1列 + H/A/B/C/D/Sの6列)なので、DOMも行優先で
		// 「見出し7セル → 努力値7セル → 実数値7セル」の順に生成する。
		// ラウンド27ユーザー指示(27-D1)ではbuildLeft(スプライトの左側の列、202px相当)に
		// 入れていたが、🔴 ラウンド28ユーザー指示(28-D3)「ステータスは相手ビルド領域の
		// 全幅を使う」により、buildLeftではなくbuildEl直下(buildMainの下、全幅=321px相当)
		// に置き直す。数値がくっついて見える窮屈さを解消する。
		const evGrid = document.createElement("div");
		evGrid.className = "damage-ev-grid";
		buildEl.appendChild(evGrid);

		// 1段目: 行ラベル列を空けたうえでH/A/B/C/D/Sの見出し。
		// ラウンド4ユーザー指示: 「性格の選択UIは廃止し、能力値のラベルをクリックして
		// 上昇/下降を切り替える」。この指示は編集画面全体に適用されるため、相手ビルドの
		// 努力値/実数値グリッドの見出しもクリック対象にする(1行まるごと削れるので
		// カード高さの削減にもなる)。HPは性格補正が無いのでクリック対象外。
		// ラウンド20ユーザー指示(20-D3、ラウンド5の「▲/▼を独立ボタン化する」を撤回):
		// 上下2個の専用ボタン(nature-up-{key}/nature-down-{key}と同じ設計、縦3段
		// ▲/文字/▼)をやめ、見出しの文字自体を1個のボタンにして「無補正→上昇→下降→
		// 無補正」を巡回させる(高さが3段から1段になり、カード高さの削減にも寄与する)。
		// 色だけで状態を伝えないよう(WCAG 1.4.1)、文字色(--color-stat-up/--color-stat-down。新色は
		// 作らない)に加えて文字の直後に小さく▲/▼を添える(.damage-ev-nature-indicator、
		// aria-hiddenで装飾扱い。実際の状態説明はボタンのaria-label/titleが担う)。
		const natureColLabelEls: Partial<Record<string, HTMLElement>> = {};
		// 見出し行の1列目(行ラベル列)の空セル。🔴 UI改修依頼(個体編集画面・モバイル、
		// 2026-08-08)「ダメージカードの相手ビルドサイズを大幅削減」
		// (docs/ui_proposal/mobile/box_個体編集_vs_相手ビルド.png)では行ラベル列そのものが
		// 無い6列表になるため、CSS側でこの空セルも消す必要がある。nth-child依存の脆い
		// セレクタを書かずに済むよう、クラス名を与えておく(デスクトップでは何のスタイルも
		// 当たらない=見た目は従来どおり空のspan)。
		const evCornerEl = document.createElement("span");
		evCornerEl.className = "damage-ev-corner";
		evGrid.appendChild(evCornerEl);
		for (const key of STAT_KEYS) {
			if (key === "hp") {
				const label = document.createElement("span");
				label.className = "damage-ev-col-label";
				label.textContent = STAT_KANJI[key];
				evGrid.appendChild(label);
				continue;
			}
			const cycleBtn = document.createElement("button");
			cycleBtn.type = "button";
			cycleBtn.className = "damage-ev-col-label damage-ev-nature-cycle";
			const letter = document.createTextNode(STAT_KANJI[key]);
			const indicator = document.createElement("span");
			indicator.className = "damage-ev-nature-indicator";
			indicator.setAttribute("aria-hidden", "true");
			cycleBtn.append(letter, indicator);
			cycleBtn.addEventListener("click", () => {
				cycleColumnNature(row, key);
				refreshRowNatureButtons(row);
				void recalcRowStatsOnly(row);
				onFieldInput();
			});
			evGrid.appendChild(cycleBtn);
			natureColLabelEls[key] = cycleBtn;
		}
		row.natureColLabelEls = natureColLabelEls;
		refreshRowNatureButtons(row);

		// 2段目: 努力値入力(チャンピオンズルールの0〜32スケール)。
		const evRowLabel = document.createElement("span");
		evRowLabel.className = "damage-ev-row-label";
		evRowLabel.textContent = "努力値";
		evGrid.appendChild(evRowLabel);
		// UI改善ラウンド48(A-4): 種族プリセット適用時にこの行の努力値入力欄へ直接
		// 値を書き戻せるよう、STAT_KEYS順で参照を保持しておく(row自体には型を
		// 追加しない。renderRowのローカルクロージャで完結させる)。
		const evInputEls: HTMLInputElement[] = [];
		// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「ダメージカードの相手ビルドサイズを
		// 大幅削減」(docs/ui_proposal/mobile/box_個体編集_vs_相手ビルド.png)。提案図の努力値行は
		// 「+32 / - / +4」というテキスト表示で、数値入力欄(スピナー付きinput[type=number]、
		// 実測1行あたり約24px)は描かれていない。ユーザー確認済みの確定仕様は
		// 「テキスト表示にし、タップしたらその1項目だけ入力欄に切り替えて編集できる」。
		// そのため input を <span class="damage-ev-cell"> で包み、同じグリッドセルの中に
		// 表示用ボタン(.damage-ev-value-text)を同居させる。
		// ⚠️ デスクトップ(900px以上)の見た目は一切変えない: .damage-ev-cell は display:block・
		// .damage-ev-value-text は display:none を既定にし、既存の
		// `#opponent-notes-section .damage-ev-grid input[type="number"]`(子孫セレクタなので
		// ラップ後もそのまま効く)がこれまでどおり幅100%でセルを埋める。
		const evTextRefreshers: Array<() => void> = [];
		STAT_KEYS.forEach((key, i) => {
			const cell = document.createElement("span");
			cell.className = "damage-ev-cell";

			const input = document.createElement("input");
			input.type = "number";
			input.className = "tnum";
			input.step = "1";
			input.value = String(row.evs[i] ?? 0);
			input.setAttribute("aria-label", `相手の${STAT_KANJI[key]}努力値(0〜32)`);

			// 表示専用の読み取り(0は提案図どおり「-」、1以上は「+32」形式)。
			const valueText = document.createElement("button");
			valueText.type = "button";
			valueText.className = "damage-ev-value-text tnum";
			function refreshEvText(): void {
				const ev = row.evs[i] ?? 0;
				valueText.textContent = ev > 0 ? `+${ev}` : "-";
				valueText.setAttribute(
					"aria-label",
					`相手の${STAT_KANJI[key]}努力値 ${ev}。タップして編集`,
				);
			}
			refreshEvText();
			evTextRefreshers.push(refreshEvText);

			input.addEventListener("input", () => {
				const n = Number(input.value);
				const wrapped = Number.isFinite(n) ? wrapToRange(Math.round(n), 0, 32) : 0;
				input.value = String(wrapped);
				row.evs[i] = wrapped;
				refreshEvText();
				onFieldInput();
			});
			// タップ(クリック)でこのセルだけ入力欄に切り替える。切り替えはCSSの
			// [data-editing="true"] だけで表現し、実体のinputは常にDOMに存在させたままにする
			// (既存の自動保存契約 row.evs / evInputEls への書き戻しに一切影響させないため)。
			valueText.addEventListener("click", () => {
				cell.dataset.editing = "true";
				input.focus();
				input.select();
			});
			input.addEventListener("blur", () => {
				delete cell.dataset.editing;
			});

			// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08 第2弾)「努力値をクリックしたら、
			// 左右に MIN - + MAX の4ボタンを表示する」。従来はタップでその1セルが数値入力欄に
			// 変わるだけで、実機ではスピナーが小さすぎて値を動かせなかった。
			// 育成タブの努力値操作(LeftPanel.astro、0/-/+/32の4ボタン)と同じ操作体系に揃える。
			// セルは1/6列(実測55px弱)しか無いので、編集中だけCSSでセルを努力値行の全幅へ
			// 絶対配置し(下記 .damage-ev-cell[data-editing="true"]、行の高さは変わらない)、
			// [MIN][−] 入力欄 [+][MAX] の並びで見せる。
			// 値の更新は必ず input の "input" イベント経由にする(row.evs への書き戻し・
			// 表示テキスト更新・再計算・自動保存が上の1ハンドラに集約されているため)。
			function stepEv(next: number): void {
				input.value = String(clampInt(next, 0, 32));
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
			function makeEvStepButton(label: string, ariaLabel: string, compute: () => number): HTMLButtonElement {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "damage-ev-step-button";
				button.textContent = label;
				button.setAttribute("aria-label", `相手の${STAT_KANJI[key]}努力値を${ariaLabel}`);
				// ⚠️ 編集モードを閉じるのは input の blur(下記)なので、押した瞬間に
				// フォーカスが外れると1回目のタップだけが無効になる。mousedownの既定動作
				// (フォーカス移動)を止めて、入力欄にフォーカスを残したまま押せるようにする。
				button.addEventListener("mousedown", (event) => event.preventDefault());
				button.addEventListener("click", () => stepEv(compute()));
				return button;
			}
			const evMinButton = makeEvStepButton("MIN", "0にする", () => 0);
			const evDecButton = makeEvStepButton("−", "1減らす", () => (row.evs[i] ?? 0) - 1);
			const evIncButton = makeEvStepButton("+", "1増やす", () => (row.evs[i] ?? 0) + 1);
			const evMaxButton = makeEvStepButton("MAX", "最大(32)にする", () => 32);

			// ⚠️ 操作行(4ボタン+入力欄)は必ずこの専用ラッパーに入れ、セル自身は
			// グリッドのフローに残すこと。セル自体をposition:absoluteにすると、そのセルが
			// グリッドの自動配置から抜けて後続セル(残り5個の努力値と実数値の6個)が
			// 1列ずつ前へ詰め、実数値のHが努力値行へ吸い上げられる(実測で再現)。
			// ラッパーは既定display:contents(=箱を作らない)なので、デスクトップの
			// 「セルの中に入力欄1個」という構造は従来のまま変わらない。
			const editor = document.createElement("span");
			editor.className = "damage-ev-editor";
			// DOM順がそのまま並び順になる(編集中はCSSでflex行)。左に MIN・−、右に +・MAX。
			editor.append(evMinButton, evDecButton, input, evIncButton, evMaxButton);
			cell.append(editor, valueText);
			evGrid.appendChild(cell);
			evInputEls.push(input);
		});
		/** 努力値を外部(プリセット適用など)から書き換えたときに表示テキストを追随させる。 */
		function refreshAllEvTexts(): void {
			for (const refresh of evTextRefreshers) refresh();
		}

		// UI改善ラウンド48(A-4)ユーザー指示(第32弾)「相手ビルドの情報を種族ごとにローカルに
		// 記録しておき、次に同じ種族をビルドする際にデフォルト値として設定する」の適用側。
		// 保存側はsaveRow()参照(モジュール先頭のsaveOpponentBuildPreset/loadOpponentBuildPreset/
		// isOpponentBuildUnset)。この行の相手ビルド5項目(性格/特性/持ち物/テラス/努力値)が
		// すべて未設定のときに限り、種族名に対応するプリセットがあれば適用する。
		// 🔴 既存カード(DBから読み込んだ行)を絶対に上書きしない: isOpponentBuildUnset()が
		// falseならここで即return するため、何か1つでも値が入っている行(=既存カードの
		// 典型)には一切触れない。発動するのは「新規に追加した空行へ初めて種族名を
		// 入力したとき」だけ。
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
			row.evs = [...preset.evs];

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

			STAT_KEYS.forEach((_key, i) => {
				const evInput = evInputEls[i];
				if (evInput) evInput.value = String(row.evs[i] ?? 0);
			});
			// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08): モバイルでは努力値が
			// テキスト表示(.damage-ev-value-text)になるため、入力欄への書き戻しと同時に
			// 表示テキストも最新化しないとプリセット適用が画面に反映されない。
			refreshAllEvTexts();

			refreshCollapsedSummary();
			onFieldInput();
		}

		// 3段目: 実数値(性格による上昇/下降は文字色で表現する)。
		const statRowLabel = document.createElement("span");
		statRowLabel.className = "damage-ev-row-label";
		statRowLabel.textContent = "実数値";
		evGrid.appendChild(statRowLabel);
		const statValueEls: Partial<Record<string, HTMLElement>> = {};
		for (const key of STAT_KEYS) {
			const valueSpan = document.createElement("span");
			valueSpan.className = "damage-stat-value tnum";
			valueSpan.textContent = "-";
			statValueEls[key] = valueSpan;
			evGrid.appendChild(valueSpan);
		}
		row.statValueEls = statValueEls;

		// ラウンド3 A-6(5)で追加した条件チップは、以前は相手ビルドの箱(努力値グリッド
		// 直下)に1個だけ置いていた。ラウンド6ユーザー指示(要件4・8)で「技ごとにONの
		// 条件をまとめて表示する」設計に変わったため、この箱には置かず、各技列
		// (.damage-column)側に1個ずつ生成するよう移した(renderColumns参照。
		// row.columnChipEls/refreshRowConditionChips参照)。

		// 「加算後(打点の合計)」(全技列の合計)。
		// 🔴 ラウンド24ユーザー指示(24-D1、実装中にユーザーから訂正): 当初「カード全体
		// (root)の全幅フッター」として実装したが誤りだった。正しくは「相手ビルドの箱
		// (buildEl)の最下段ではなく、ダメージカード領域=技列側(techniquesRow、右側)の
		// 最下部」に移動する、が要件。カード全体(左右をまたぐ全幅)ではなく、右側の
		// 技列カラムの下に置く。要素自体はここで組み立て、実際のappendChild先(下の
		// techniquesRow.appendChild(totalBlock))はtechniquesRowを組み立てた後に行う。
		const totalBlock = document.createElement("div");
		totalBlock.className = "damage-row-total";
		const totalLabel = document.createElement("span");
		totalLabel.className = "damage-row-total-label";
		totalLabel.textContent = "加算後(打点の合計)";
		const totalResult = document.createElement("p");
		totalResult.className = "severity-bar damage-row-total-result tnum";
		totalResult.textContent = "(計算前)";
		totalResult.dataset.severity = "none";
		// ダメージ量と判定で参照している値の性質が違うため、そのことを明示する。
		// 「264〜312 (114〜135%) 10発以上」のように、打点がHPを超えているのに
		// 確定的な致死判定にならない表示が正しく成立しうる(たべのこし持ちの相手など。
		// ラウンド20(20-D4)で「未撃破」という語自体は廃止し、ラウンド23(23-D5)で
		// 数値ラベルの「累計」も外した)。
		totalResult.title = TOTAL_RESULT_HINT;
		totalBlock.append(totalLabel, totalResult);
		row.totalResultEl = totalResult;

		// --- 下段: 攻撃列(横に並べると加算ダメージ計算) ---
		// ラウンド5ユーザー指示(要件7の作り直し): 相手ビルドの箱(buildEl)を上段、
		// 技列を下段に積む2段組にしたため、技列(columnsWrap)と「＋」(addColumnSlot)を
		// 束ねる横方向ラッパー(techniquesRow)を新設し、bodyの直接の子として
		// このラッパー1つだけを追加する(columnsWrap/addColumnSlot自体は
		// 従来どおりのクラス名・要素のまま、親がbodyからtechniquesRowに変わっただけ)。
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

		// 🔴 UI改善ラウンド42ユーザー指示(42-D5)「ダメージカードは3段表示。1段目は技名、
		// 2段目に詳細設定、3段目に累計の結果」。折りたたみ時の技列側(旧・「/」区切り
		// 1行、collapsedMovesEl)を作り直す。1段目(collapsedMoveListEl)・2段目
		// (collapsedDetailLineEl)をこのブロックで新設し、3段目は既存のtotalBlock
		// (.damage-row-total、下でappendする)をそのまま流用する(クラス名・要素とも
		// 変更しない。壊してはいけないクラス名、pitfalls.md参照)。
		const collapsedTechniques = document.createElement("div");
		collapsedTechniques.className = "damage-row-collapsed-techniques";
		// 技名・条件テキストの2段(collapsedMoveListEl/collapsedDetailLineEl)をまとめる
		// ラッパー。元は「折りたたみ時にもその右へ『＋』ボタンを横並びに置く」ために
		// 新設したが、🔴 UI改修依頼(2026-08-08)「ダメージカードの圧縮表示を廃止」により
		// モバイルでは圧縮状態自体が発生しなくなったため、その「＋」ボタン
		// (.damage-row-collapsed-add-column-button)は削除した。ラッパー自体は
		// デスクトップの折りたたみ表示・耐久調整ポップアップの複製で使い続けるため残す
		// (中の2つの<p>はどちらもmargin:0なので、素の縦積みと見た目は同じ)。
		const collapsedTechniquesText = document.createElement("div");
		collapsedTechniquesText.className = "damage-row-collapsed-techniques-text";
		const collapsedMoveListEl = document.createElement("p");
		collapsedMoveListEl.className = "damage-row-collapsed-move-list";
		const collapsedDetailLineEl = document.createElement("p");
		collapsedDetailLineEl.className = "damage-row-collapsed-detail-line";
		collapsedTechniquesText.append(collapsedMoveListEl, collapsedDetailLineEl);
		collapsedTechniques.append(collapsedTechniquesText);
		techniquesRow.appendChild(collapsedTechniques);
		// 折りたたみ中は技列の入力欄(.damage-row-columns-wrap)が隠れて編集不可になる
		// (36-1の既存方針)ため、row.attacksはsetCollapsed()呼び出し時点で確定した値に
		// なっている。展開中の編集のたびに追随させる必要は無く、setCollapsed()の
		// タイミングだけで読み直せば表示がずれることはない(refreshCollapsedStatsと
		// 同じ考え方)。
		function refreshCollapsedTechniques(): void {
			// 1段目: 技名(+複数回ヒットする技には"(N発)"を付記。round-42.mdの例
			// 「スケイルショット(5発) + フレアドライブ」どおり、hitCount===1のときは
			// 付記しない)。技名が空の列(技が無い列)は列挙から除く。
			const namedAttacks = row.attacks.filter((a) => a.moveName.trim() !== "");
			if (namedAttacks.length === 0) {
				collapsedMoveListEl.textContent = "(技未設定)";
				collapsedMoveListEl.title = "";
			} else {
				const movesText = namedAttacks
					.map((a) => {
						const name = a.moveName.trim();
						return a.hitCount > 1 ? `${name}(${a.hitCount}発)` : name;
					})
					.join(" + ");
				collapsedMoveListEl.textContent = movesText;
				collapsedMoveListEl.title = movesText;
			}
			// 2段目: 詳細設定。既存のcollectConditionChips()(技列側の条件チップ、
			// .damage-row-condition-chipsと同じ判定ロジック)を技列ごとに呼び、右パネル・
			// 技列チップと同じ語彙(攻撃側どく/防御側テラスタル/急所/かべ等)で列挙する。
			// 技列が複数あり、かつ条件が付いている列が複数あるときだけ列番号
			// (.damage-column-order-labelと同じ1始まりの番号)を先頭に付けて区別する
			// (単一技列、または条件が1列にしか付いていない場合は番号を付けない=
			// 冗長な"1: "を出さない)。
			// UI改修依頼(ダメージ計算カード、2026-08-02)「圧縮表示もレギュレーションに応じて
			// テラスタルの表示・非表示を自動判断する」。展開側のrowTeraFieldWraps判定
			// (isTerastalRegulation(currentIndividualRegulation()))と同じ値を、圧縮表示の
			// 「攻撃側テラスタル」「防御側テラスタル」チップの出し分けにも使う。
			const showTera = isTerastalRegulation(currentIndividualRegulation());
			const chipGroups: { index: number; text: string }[] = [];
			row.attacks.forEach((a, i) => {
				if (a.moveName.trim() === "") return;
				const groups = collectConditionGroups(a, showTera);
				// グループ間は記号を挟まず、全角空白だけで区切る。
				const text = groups.map((group) => [group.label, ...group.chips].filter(Boolean).join(" ")).join("　");
				if (text) chipGroups.push({ index: i + 1, text });
			});
			if (chipGroups.length === 0) {
				collapsedDetailLineEl.hidden = true;
				collapsedDetailLineEl.textContent = "";
				collapsedDetailLineEl.title = "";
			} else {
				const showIndex = namedAttacks.length > 1 && chipGroups.length > 0;
				const detailText = chipGroups
					.map((g) => (showIndex ? `${g.index}: ${g.text}` : g.text))
					.join(" ｜ ");
				collapsedDetailLineEl.hidden = false;
				collapsedDetailLineEl.textContent = detailText;
				collapsedDetailLineEl.title = detailText;
			}
			// 🔴 UI改修依頼(2026-08-08)「ダメージカードの圧縮表示を廃止」により、ここにあった
			// 折りたたみ時の「＋」ボタンの上限判定(hidden/title の更新)はボタンごと削除した。
		}

		// 24-D1(訂正後): totalBlockはbuildElでもrootでもなく、techniquesRow
		// (columnsWrap・addColumnSlotの後)の子にする。これにより技列カラムの下端に
		// 収まる1行になり、相手ビルドの箱(左側)には掛からない。
		techniquesRow.appendChild(totalBlock);

		// --- 下部: 保存状態 ---
		// メモ欄は要件により廃止した(row.memo自体は既存の値を保って送り返すために残す)。
		// ラウンド4ユーザー指示: 「下部の保存済み表示は削除する」。DOMは残す(JS/E2Eが
		// クラス名を参照する可能性があるため)が、初期描画時点(idle/saved相当)は
		// 常に隠す(setRowSaveStatus参照。保存失敗時だけ表示する)。
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
		refreshDirectionUi();
		renderColumnDisplays(row); // 保存済みclientResultをまず即座に表示する
		void recalcRow(row); // エンジン初期化済みなら実数値・ダメージを再計算して上書きする
		// UI改善ラウンド36ユーザー指示(36-1)「初期状態は展開」。🔴 UI改善ラウンド42
		// ユーザー指示(42-D4/42-D5)対応でこの呼び出し位置をrenderRow冒頭付近から
		// ここ(techniquesRow/collapsedTechniques・totalBlock等すべての構築完了後)へ
		// 移した(上のsetCollapsed定義の直後にあったコメント参照。TDZ回避のため)。
		setCollapsed(false);
		// 専用ハンドルを廃止し、圧縮時だけカード面全体からswapを開始できるようにする。
		setupCollapsedCardDrag(row, root);

		// ラウンド5ユーザー指示(要件9)・ラウンド6ユーザー指示(要件1・2)・
		// ラウンド7ユーザー指示(方針転換): ⚙ボタンは廃止したままだが、「相手ビルドの
		// 箱をクリックしてもカード全体設定を開く」という挙動自体をユーザー確定仕様として
		// 廃止した。サイドバーを開くのは技列の箱だけ(それ以外をクリックしても無反応)。
		// まず共通のガードとして、カード内の入力欄(技列にも<select>/<input>がある)を
		// クリックしたときに意図せず選択が切り替わらないよう、選択トリガーはフォーム
		// 要素の外側に限定する(このガードを外すと入力のたびにサイドバーが切り替わる
		// 回帰が起きるため、技列側の分岐の前段に必ず置く)。
		// ガードを通過し、かつ.damage-column(技列)の内側だったときだけ
		// selectColumn()を呼ぶ。それ以外(相手ビルドの箱・技列の下の余白・フッターなど)
		// は何もしない=既に開いているサイドバーの内容も変えない。
		root.addEventListener("click", (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, select, textarea, button, a, label")) return;
			// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「ダメージカードの圧縮表示を
			// 廃止」により、ここにあった「モバイルの圧縮カードはカードのどこを押しても
			// 1つ目の技を選択する」分岐を削除した(899px以下では圧縮状態自体が発生しなく
			// なったため到達不能。技カードは常に見えているので直接タップできる)。
			const columnEl = target?.closest<HTMLElement>(".damage-column");
			if (!columnEl) return;
			const idx = Number(columnEl.dataset.columnIndex);
			const column = row.attacks[idx];
			if (column) selectColumn(row, column);
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

	// UI改修依頼(ダメージ計算カード、2026-08-04)「カードをドラッグ&ドロップで並び替え」。
	// opponent_notesテーブルには並び順カラムが無いため、field(jsonb)のorder?: number
	// (分数キー方式。src/lib/opponent-notes-validation.tsのOpponentFieldInput参照)で
	// 並び順を管理する。DamageRowState型自体は編集対象外(shared-core.ts)のため、
	// rowTeraFieldWraps等と同じくWeakMapで行ごとに対応付ける。値が無い行(=既存データの
	// 大半)はサーバー返却順(created_at DESC)をそのままフォールバックとして使う
	// (fetchAndRenderRows/reorderRow参照)。
	const rowSortOrder = new WeakMap<DamageRowState, number>();

	// 🔴 UI改修依頼(個体編集画面、2026-08-02)「耐久調整」機能の土台。row.idはPOST前の
	// 新規行だとnull(619行目付近のid: null参照)のため、耐久調整ブリッジが行を一意に
	// 指すためのidはrow.id(あれば)を優先しつつ、無ければローカル専用の合成idを割り当てて
	// WeakMapへキャッシュする(一度決めたidは、以後row.idが変わっても差し替えない=
	// getDefenseRows→buildCollapsedPreviewの往復の間でidがぶれないようにするため)。
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
			// 表示用の技名一覧。refreshCollapsedTechniques()の1段目(collapsedMoveListEl)と
			// 同じ「hitCount>1のときだけ(N発)を付記する」表記に揃える(3095行目付近参照)。
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

	// 指定した行のカードDOM(article.card.card-damage、row.root)を、折りたたみ表示状態で
	// 複製して返す。ポップアップに貼るための表示専用の複製で、元のカードの展開/折りたたみ
	// 状態には一切影響しない。
	function buildCollapsedPreview(rowId: string): HTMLElement | null {
		const row = findRowByBulkAdjustId(rowId);
		if (!row || !row.root) return null;
		// 複製の前に、この行の折りたたみ用DOM(.damage-row-collapsed-summary/
		// .damage-row-collapsed-techniques・実数値表)を最新値で埋める。カードが展開状態の
		// ままだとこれらの中身が空/古いままなので、複製前に必ず呼ぶ(refreshCollapsedViews、
		// 上のrowCollapseHandles参照)。呼んでいるのは表示用DOMの更新だけで、root.dataset.
		// collapsed・root.style.widthには触れない(元のカードの見た目は変えない)。
		rowCollapseHandles.get(row)?.refreshCollapsedViews();
		const clone = row.root.cloneNode(true) as HTMLElement;
		// ページ内でidが重複すると document.getElementById が壊れるため、複製から
		// すべてのid属性を再帰的に削除する(クローンのroot自身がidを持つ想定は無いが、
		// 念のため両方処理する)。
		clone.removeAttribute("id");
		clone.querySelectorAll<HTMLElement>("[id]").forEach((idEl) => idEl.removeAttribute("id"));
		// 🔴 実機で発覚した回帰(2026-08-08): モバイルの詳細設定パネル(#damage-detail-panel)は
		// 「技カードをタップするとその場でインライン展開する」対応(refreshMobileDetailPlacement)
		// により、選択中はこのカードの子孫(技列セクション内)へDOM移動している。以前は
		// カードの外の兄弟だったため複製に入り込まなかったが、今は cloneNode(true) が
		// パネルまで丸ごと複製してしまい、耐久調整ポップアップの圧縮プレビューに
		// 詳細設定パネルが丸ごと写り込んでいた。複製側からは必ず取り除く
		// (複製なので、実体である元のパネルには影響しない)。
		clone.querySelectorAll<HTMLElement>(".damage-detail-panel").forEach((panelEl) => panelEl.remove());
		// 表示専用の複製なので、フォーム要素(name属性の有無を問わず)はすべて操作不可にする
		// (誤操作・自動保存の暴発を防ぐ)。tabindex="-1"でフォーカスが入らないようにもする。
		clone.querySelectorAll<HTMLElement>("input, select, textarea, button").forEach((formEl) => {
			(formEl as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement).disabled = true;
			formEl.tabIndex = -1;
		});
		// setCollapsed()は折りたたみ時にroot.style.widthを実測値で固定するが(2611行目付近)、
		// その固定幅を複製に持ち込むとポップアップ側のレイアウトを壊すため、複製の
		// style.widthは常に空にする(ポップアップ側の幅はCSSに委ねる)。
		clone.style.width = "";
		// 複製側にだけ折りたたみ状態を強制する(元のカードのdataset.collapsedは変更しない)。
		clone.dataset.collapsed = "true";
		return clone;
	}

	registerBulkAdjustBridge({
		getDefenseRows: () => getDefenseRows(),
		buildCollapsedPreview: (rowId) => buildCollapsedPreview(rowId),
	});

	const damageRowsListEl = el<HTMLElement>("damage-rows-list");
	initializeCardDeleteMode(damageRowsListEl, ".card-damage", ".damage-row-delete-button");
	const engineStatusEl = el<HTMLElement>("damage-calc-engine-status");
	const engineStatusTextEl = el<HTMLElement>("damage-calc-engine-status-text");
	const engineReloadButton = el<HTMLButtonElement>("damage-calc-engine-reload-button");
	engineReloadButton.addEventListener("click", () => window.location.reload());

	// UI改善タスク「ダメージカードの外をクリックしたら選択(フォーカス)状態を解除する」。
	// 2082行目付近の「リストの外側をクリックしたら閉じる」(テラスタルドロップダウン)と
	// 同じ考え方: document全体のクリックを監視し、クリック位置(target)が選択の対象で
	// ある技カード(.damage-column)にも右パネルの詳細設定エリア(#damage-detail-panel。
	// パネル内の操作は選択解除の対象外にする)にも含まれない場合だけ選択解除する。
	// 🔴 UI改修依頼(個体編集ダメージカード、2026-08-02)「技カードの外をクリックしたときに、
	// 技カードへのフォーカスが外れるようにする」により、判定の基準を「ダメージカード全体
	// (row.root)の外側」から「技カード(.damage-column)の外側」へ狭めた。これにより
	// 相手ビルドの箱・カードのフッター・技カード下の余白など「カード内だが技カードの外」を
	// クリックしたときも選択が外れる(以前はカード内なら何をクリックしても選択が残っていた)。
	// row.root を辿らなくなったため rows への依存も無くなった(行の追加・削除で判定が
	// 古くなる余地が無くなり、閉包経由で最新のrowsを見る必要も無い)。
	// closest() のためにElementへ絞る(テキストノードをクリックした場合、event.targetは
	// Chromiumでは要素になるが、仕様上Nodeなのでガードしておく)。技カードごと削除された
	// 直後(× ボタン)は target が切り離された部分木に居るが、その部分木にも .damage-column
	// の祖先が残るため closest() は非nullを返し、ここでは何もしない(選択マークの整合は
	// renderColumns / rebuildRowsList 側が持つ。従来の row.root.contains() と同じ挙動)。
	const damageDetailPanelEl = el<HTMLElement>("damage-detail-panel");
	const damageDetailPanelOriginalParentEl = damageDetailPanelEl.parentElement;
	function refreshMobileDetailPlacement(): void {
		if (!isNarrowLayout()) {
			damageDetailPanelEl.classList.remove("is-mobile-inline", "is-mobile-suggest");
			delete damageDetailPanelEl.dataset.mobileArrow;
			if (damageDetailPanelOriginalParentEl) damageDetailPanelOriginalParentEl.appendChild(damageDetailPanelEl);
			return;
		}

		damageDetailPanelEl.classList.remove("is-open");
		const selectedRow = getSelectedRow();
		const selectedColumn = getSelectedColumn();
		if (selectedRow && selectedColumn && selectedRow.root?.parentElement === damageRowsListEl) {
			// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「技カードをクリックすると
			// 詳細設定がインライン展開される」。提案図
			// (docs/ui_proposal/mobile/box_個体編集_vs_詳細設定.png)では、展開された詳細設定は
			// ダメージカードの内側・技カード列の直下・累計ダメージ(.damage-row-total)の上に
			// 開く。従来はカード全体(root)の直後へ移していたため、累計ダメージがパネルより
			// 上に残り「そのカード自身が展開された」ようには見えていなかった。
			// 技列セクション(.damage-row-techniques-row)はaddColumnSlotの親であり、
			// 累計結果ブロックはその直下の子(renderRow参照)。
			const techniquesRow = selectedRow.addColumnSlotEl?.parentElement ?? null;
			const totalBlock = techniquesRow?.querySelector<HTMLElement>(":scope > .damage-row-total") ?? null;
			if (techniquesRow && totalBlock) {
				techniquesRow.insertBefore(damageDetailPanelEl, totalBlock);
			} else {
				// 構造が想定と違う場合(将来のDOM変更など)は従来どおりカードの直後に置く。
				selectedRow.root.after(damageDetailPanelEl);
			}
			damageDetailPanelEl.classList.add("is-mobile-inline");
			damageDetailPanelEl.classList.remove("is-mobile-suggest");
			// パネルは技列セクションの左右2枠にまたがる全幅の段になるため、どちらの技カードから
			// 開いたのかは上辺の三角マーカーの位置でしか表せない(CSS側の
			// [data-mobile-arrow="left"|"right"]::before、DamageCalcSection.astro参照)。
			// 2列gridなので列位置は「技カードの並び順 % 2」で決まる(既存データが3枚以上を
			// 持つ行では2行目以降へ折り返すが、左右の対応は同じ式で正しい)。
			const columnIndex = selectedRow.attacks.indexOf(selectedColumn);
			damageDetailPanelEl.dataset.mobileArrow = columnIndex >= 0 && columnIndex % 2 === 1 ? "right" : "left";
			return;
		}
		delete damageDetailPanelEl.dataset.mobileArrow;
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
	// 境界をまたいだら「＋ 技を追加」ボタンの有効/無効と折りたたみ時「＋」ボタンの表示を
	// 描き直す(そうしないとデスクトップ→モバイルへ縮めた直後、押しても何も起きない
	// 「＋ 技を追加」が残る)。renderColumns()は同じrow.attacksから列を作り直すだけなので
	// 何度呼んでも状態は変わらない。
	window.matchMedia("(max-width: 899px)").addEventListener("change", () => {
		// 圧縮表示はモバイルでは廃止した(上のsetAllRowsCollapsed(true)撤去の注記参照)。
		// デスクトップで畳んだカードを持ったまま899px以下へ縮めると、折りたたみボタンが
		// CSSで消えるぶん畳んだまま開けなくなるため、狭くなった時点で全行を展開へ戻す。
		if (isNarrowLayout()) setAllRowsCollapsed(false);
		for (const row of rows) {
			renderColumns(row);
			rowCollapseHandles.get(row)?.refreshCollapsedViews();
			// モバイル=ドット絵 / デスクトップ=公式アートワークの出し分け(上のrowSpriteRefreshers参照)。
			rowSpriteRefreshers.get(row)?.();
		}
	});
	document.addEventListener("click", (e) => {
		const target = e.target as Node;
		if (damageDetailPanelEl.contains(target)) return;
		if (target instanceof Element && target.closest(".damage-column")) return;
		if (isNarrowLayout() && target instanceof Element && target.closest(".card-damage")) return;
		clearSelectionAndMarks();
	});

	// UI改善ラウンド36ユーザー指示(36-3)で「すべて折りたたむ・展開する」の2ボタン版を導入し、
	// 🔴 UI改善ラウンド38ユーザー指示(38-H1)「ヘッダーに移動し単一ボタンで交互切り替え」により
	// 単一トグルボタンへ統合した。ボタン本体はDamageCalcSection.astroではなく
	// src/pages/box/[id].astro の<Fragment slot="topbar-actions">内(AppLayout共通トップバー)
	// にあるが、id経由のel()で問題なく取得できる(同じページのDOMツリーに含まれるため)。
	// 個々の行の折りたたみボタン(setCollapsed、上のrowCollapseHandles参照)との状態整合は
	// setAllRowsCollapsed()が各行のsetCollapsed()をそのまま呼ぶことで保つ(全展開後に1行だけ
	// 再度折りたたむ、といった操作も個別ボタン側のsetCollapsedがそのまま効くため破綻しない)。
	// ボタンのラベル/disabled切り替えはupdateCollapseToggleButtonLabel()に集約し、
	// 「行の追加・削除」「個別行の折りたたみ切り替え」「このボタン自身のクリック」の
	// 3経路すべてから呼ぶ(setCollapsed内・rebuildRowsList内、下方の該当箇所を参照。
	// この関数はここより上のsetCollapsed定義から前方参照されるが、関数宣言はブロック内で
	// ホイストされ、かつ実際に呼ばれるのは行の初期化時=この行の実行より後になるため問題ない
	// 既存のregisterDamageCalcBridge等と同じ考え方)。
	const damageCollapseToggleButtonEl = el<HTMLButtonElement>("damage-collapse-toggle-button");
	// UI改善ラウンド43ユーザー指示(43-H1)「すべて折りたたむ・すべて展開ボタンにも>>記号を
	// 追加(左端)」。box/[id].astro側の静的マークアップを
	// <span class="damage-collapse-toggle-chevron">»</span><span class="damage-collapse-toggle-label">
	// の2要素構成にしたため(<Fragment slot="topbar-actions">参照)、ここではlabelSpan側の
	// textContentだけを差し替える(textContent全体を上書きするとchevronSpanごと消えてしまうため)。
	// 個別カードの折りたたみボタン(.damage-row-collapse-toggle-button)と同じ回転ロジックを
	// 流用する: このボタン自身にaria-expandedを立て、CSS側(DamageCalcSection.astro、
	// #damage-collapse-toggle-button .damage-collapse-toggle-chevron)がその属性値で
	// chevronSpanだけを回転させる(ボタン本体やlabelSpanは回転しない)。
	// 「現在すべて折りたたまれていない(=少なくとも1枚は展開中)」を"expanded"寄りの状態とみなし、
	// 個別ボタンの「展開中=aria-expanded="true"で上向き」と同じ向きの対応にする。
	const damageCollapseToggleLabelEl = damageCollapseToggleButtonEl.querySelector<HTMLElement>(
		".damage-collapse-toggle-label",
	);
	function updateCollapseToggleButtonLabel(): void {
		damageCollapseToggleButtonEl.disabled = rows.length === 0;
		const allCollapsed = rows.length > 0 && rows.every((r) => collapsedRowSet.has(r));
		const label = allCollapsed ? "すべて展開する" : "すべて折りたたむ";
		if (damageCollapseToggleLabelEl) {
			damageCollapseToggleLabelEl.textContent = label;
		} else {
			// 万一マークアップがこの構成でない場合のフォールバック(従来どおりボタン全体に文言を出す)。
			damageCollapseToggleButtonEl.textContent = label;
		}
		damageCollapseToggleButtonEl.setAttribute("aria-expanded", allCollapsed ? "false" : "true");
		const describedLabel = `${label}(ダメージ計算カード全件)`;
		damageCollapseToggleButtonEl.setAttribute("aria-label", describedLabel);
		damageCollapseToggleButtonEl.title = describedLabel;
	}
	damageCollapseToggleButtonEl.addEventListener("click", () => {
		const allCollapsed = rows.length > 0 && rows.every((r) => collapsedRowSet.has(r));
		// 押した結果が直感的であること(要件): 1枚でも展開中なら「すべて折りたたむ」を押した
		// ことになり、全部畳まれているときだけ「すべて展開する」を押したことになる。
		setAllRowsCollapsed(!allCollapsed);
		updateCollapseToggleButtonLabel();
	});

	// カード追加処理を1箇所にまとめる(通常の追加タイルと、0件時の空状態内CTAの両方から呼ぶ。
	// ラウンド3 B-5参照)。
	// UI改修依頼(ダメージ計算カード、2026-08-04)「新規カードは先頭に追加する」により、
	// rows.push()からrows.unshift()に変更する。並び順(rowSortOrder)も「現在rowsの中の
	// 最小order値 − 1000」を割り当てて先頭扱いにする(既存行が誰もorderを持たない
	// = 通常のケースでは基準を0とみなす)。
	function addNewRowAndFocus(): void {
		const row = createEmptyRow();
		// 通常の新規カードだけ初期技を補う。サジェスト・既存メモの復元経路には適用しない。
		fillFirstMoveCandidate(row, row.attacks[0]);
		renderRow(row);
		const existingOrders = rows
			.map((r) => rowSortOrder.get(r))
			.filter((v): v is number => v !== undefined);
		const minOrder = existingOrders.length > 0 ? Math.min(...existingOrders) : 0;
		rowSortOrder.set(row, minOrder - 1000);
		rows.unshift(row);
		rebuildRowsList();
		row.root?.querySelector<HTMLInputElement>('input[aria-label="相手ポケモン名"]')?.focus();
	}

	// ダメージ計算のサジェスト(ユーザー要望、2026-08-05)。候補1件を新しいカードにする。
	// 追加位置・order値の付け方・rebuildRowsListの呼び方はaddNewRowAndFocus()と同じにする
	// (「新規カードは先頭に追加する」というUI改修依頼 2026-08-04 の挙動を2箇所で食い違わせない)。
	// 相手のビルド(性格・特性・持ち物・テラス・努力値)は集計側が項目ごとの最頻値として
	// 返してくるものをそのまま入れる(migrations/020)。値が無い項目は空のままにし、
	// 保存済みの個体データと同じく「未入力」として扱う。
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
		const minOrder = existingOrders.length > 0 ? Math.min(...existingOrders) : 0;
		rowSortOrder.set(row, minOrder - 1000);
		rows.unshift(row);
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
		// UI改善ラウンド36ユーザー指示(36-3)「相手が0件のときはツールバー自体が意味を
		// 持たない」→ 🔴 38-H1でヘッダーの単一ボタンに統合した後も同じ考え方を踏襲し、
		// 0件のときはボタンをdisabledにする(updateCollapseToggleButtonLabel内)。
		// 行の追加・削除のたびに「全部畳まれているか」の判定結果が変わりうるため、ここでも
		// 呼び直す。
		updateCollapseToggleButtonLabel();
		damageRowsListEl.innerHTML = "";
		// UI改修依頼(ダメージ計算カード、2026-08-04)「追加ボタンを最上部に固定配置する」
		// により、以前は行ループの後ろに追加していたbuildAddRowTile()をループの前に移す
		// 0件のときも同じ追加タイルだけを表示する。
		damageRowsListEl.appendChild(buildAddRowTile());
		for (const row of rows) {
			if (row.root) damageRowsListEl.appendChild(row.root);
		}
		refreshMobileDetailPlacement();
	}

	// ドロップ元とドロップ先の位置・order値を交換する。insertではなくswapにすることで、
	// カードのどこへ落としても結果が一意になり、入れ替わった2行だけを保存すればよい。
	function orderOfRowAt(row: DamageRowState, index: number): number {
		const stored = rowSortOrder.get(row);
		return stored !== undefined ? stored : index * 1000;
	}
	function swapRows(movedRow: DamageRowState, targetRow: DamageRowState): void {
		const fromIdx = rows.indexOf(movedRow);
		const targetIdx = rows.indexOf(targetRow);
		if (fromIdx === -1 || targetIdx === -1 || movedRow === targetRow) return;
		const movedOrder = orderOfRowAt(movedRow, fromIdx);
		const targetOrder = orderOfRowAt(targetRow, targetIdx);
		[rows[fromIdx], rows[targetIdx]] = [rows[targetIdx], rows[fromIdx]];
		rowSortOrder.set(movedRow, targetOrder);
		rowSortOrder.set(targetRow, movedOrder);
		rebuildRowsList();
		scheduleRowSave(movedRow);
		scheduleRowSave(targetRow);
	}

	// 圧縮カードの任意位置から開始する。入力要素やボタンは将来圧縮表示へ追加されても
	// 通常操作を優先し、展開カードおよび展開カードへのドロップは並べ替え対象にしない。
	function setupCollapsedCardDrag(row: DamageRowState, root: HTMLElement): void {
		root.addEventListener("mousedown", (downEvent) => {
			if (root.dataset.collapsed !== "true") return;
			const target = downEvent.target as HTMLElement | null;
			if (target?.closest("input, select, textarea, button, a, label")) return;
			downEvent.preventDefault();
			let hoverRow: DamageRowState | null = null;
			root.classList.add("is-dragging");

			function clearDragOverMarks(): void {
				for (const r of rows) r.root?.classList.remove("is-drag-over");
			}
			function onMove(moveEvent: MouseEvent): void {
				const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
				const hoveredCard = (target as HTMLElement | null)?.closest<HTMLElement>(".card-damage") ?? null;
				clearDragOverMarks();
				hoverRow = null;
				if (hoveredCard && hoveredCard !== root && hoveredCard.dataset.collapsed === "true") {
					hoveredCard.classList.add("is-drag-over");
					hoverRow = rows.find((r) => r.root === hoveredCard) ?? null;
				}
			}
			function onUp(): void {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				root.classList.remove("is-dragging");
				clearDragOverMarks();
				if (hoverRow) swapRows(row, hoverRow);
			}
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});
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
			// ラウンド11ユーザー指示(実装リスク1): 選択肢配列から削除された値
			// (おおひでり/ゆめうつつ等)が残っていた行は、正規化後の値でPUTし直す
			// (renderRow()がrow.saveStatusEl/footerElを設定した後でないと
			// scheduleRowSave()が使えないため、renderRowループの後にまとめて行う)。
			const rowsNeedingResave: DamageRowState[] = [];
			rows = body.data.map((note) => {
				const { row, needsResave, order } = noteToRowState(note);
				if (needsResave) rowsNeedingResave.push(row);
				if (order !== undefined) rowSortOrder.set(row, order);
				return row;
			});
			// UI改修依頼(ダメージ計算カード、2026-08-04)「カードの並び順を永続化する」。
			// order値を持つ行はorder昇順、持たない行(既存データはほぼ全部これに該当)は
			// サーバー返却順(created_at DESC)の元インデックスを仮のorder値として扱う
			// (Array.prototype.sortは安定ソートなので、order値を持つ行が1つも無ければ
			// 実質的に元の並びのまま=現状維持のフォールバックになる)。
			rows = rows
				.map((row, index) => ({ row, sortKey: rowSortOrder.has(row) ? (rowSortOrder.get(row) as number) : index }))
				.sort((a, b) => a.sortKey - b.sortKey)
				.map((entry) => entry.row);
			for (const row of rows) renderRow(row);
			for (const row of rowsNeedingResave) scheduleRowSave(row);
			rebuildRowsList();
			// 🔴 UI改修依頼(個体編集画面・モバイル、2026-08-08)「ダメージカードの圧縮表示を廃止し、
			// 常に2枚の技カードが見えるようにする」。以前はここで「保存済み行を初めて描画した
			// 直後だけモバイル既定を圧縮表示にする」(setAllRowsCollapsed(true))を行っていたが、
			// 圧縮表示ではカードを開かないと技カードに辿り着けなかった。899px以下では常に
			// 展開状態で表示する(個別カードの折りたたみボタンもCSSで非表示にした。
			// DamageCalcSection.astroの.damage-row-collapse-toggle-button参照)。
			// デスクトップ(900px以上)の折りたたみ機能は従来どおり残す。
			// 初期表示では画面幅にかかわらず技列を自動選択せず、詳細パネルも空状態に戻す。
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

	// ダメージ計算のサジェスト(ユーザー要望、2026-08-05)の初期取得。上のブリッジ登録より後
	// (= listExistingKeys/addSuggestion が使える状態)であればよく、fetchAndRenderRows()の
	// 完了は待たない ── 取得が先に終わってもサジェストは「まだ画面に無い計算」を1件も
	// 除外しないだけで、カードが揃った時点で次の再描画から正しく除外される。
	initDamageSuggest();

	// --- エンジン初期化状態の表示・準備完了時の全行再計算 ---
	// ラウンド3 B-12: 失敗時、以前はpyodide-engine.ts由来の生のメッセージ(CDNの
	// URLを含みうる)をそのまま表示していた。内部URLを含まない定型文に差し替え、
	// 再読み込みボタンを出す(テキストはengineStatusTextElだけを更新し、
	// engineStatusEl.textContent への直接代入はしない=ボタンを消さないため)。
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
			// 左パネルの実数値表示(recalcStats)も、エンジン初期化完了と同時に更新する
			// (旧実装がengineInitButton経由のcombinedEngineProgressで担っていた処理を踏襲、
			// 左パネルの入力・自動保存自体には一切手を入れていない)。
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
