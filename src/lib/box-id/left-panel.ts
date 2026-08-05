// box/[id].astro 構造分割ラウンド(フェーズ1)。
//
// 左サイド(ポケモン編集パネル、.panel-left)専用のロジック一式。元は box/[id].astro の
// <script> 内、`if (form) { ... }` ブロック(#opponent-notes-section より前)に定義されていた
// もので、ロジックは一切変更せずこのファイルへ移設した(定義位置の変更のみ)。
//
// このファイルは src/components/box-id/LeftPanel.astro の <script> から
// `import "../../lib/box-id/left-panel";` の形で副作用importされ、モジュール読み込み時に
// 即座に自身を初期化する(元のインラインスクリプトと同じ「読み込まれたら即実行」の挙動)。
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
import {
	loadTypesMap,
	loadMoveTypeMap,
	loadLearnsetMap,
	loadAbilitiesMap,
	officialArtworkUrl,
	loadMoveDetailMap,
	type MoveDetail,
	type MoveCategory,
} from "../pokemon-master-data";
import { typeIconUrl, teraTypeIconUrl } from "../sprite-urls";
import { isTerastalRegulation } from "../regulations";
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from "../type-colors";
import { type StatKey, STAT_KEYS, NATURE_STAT_MODIFIERS } from "../stats";
import { classifyArchetype, type ArchetypeKey } from "../archetype";
import {
	applySprite,
	applyTeraImage,
	applyItemImage,
	resolveMegaStoneItem,
	flashAutofillHint,
	natureNameFromBoosts,
	normalizedNatureBoosts,
	toggleNatureUp,
	toggleNatureDown,
	recalcStats,
	baseStatsMapPromise,
	registerLeftPanelBridge,
} from "./shared-core";
// UI改修依頼(個体編集画面、2026-08-02→2026-08-03統合)「耐久指数最大化」ボタン
// (ステータス表の下、#durability-index-button)の配線。計算(純JS、Pyodide不要)は
// durability-index.ts、一覧表示はright-panel.tsのrenderCandidateList()(耐久調整
// ポップアップと共用の汎用レンダラ)に委譲し、このファイルは「現在の種族値・努力値・性格を
// 渡して総合/物理/特殊の3指数を計算する」「3件を右パネルへ一覧表示する」「クリックされた
// 候補を左パネルへ反映する」の橋渡しだけを担う。旧・H/B/D個別3ボタン
// (#stat-adjust-hp/def/spd)時代はボタン押下で即座にbestを左パネルへ適用していたが、
// 単一ボタン化に伴い、押下時は表示のみ・適用は一覧クリック時のみに変更した。
import {
	maximizeDurabilityIndex,
	type DurabilityIndexKind,
	type DurabilityIndexCandidate,
} from "./durability-index";
// ⚠️ 実装時に踏んだ罠: renderCandidateList/openDetailPanelOverlayIfNarrowを他の関数と同じ
// 静的importにすると、box/[id].astroでLeftPanel.astroがDamageCalcSection.astroより先に
// レンダリングされる(=このファイルのscriptが先に評価される)ため、right-panel.ts⇄damage-calc.ts
// の相互import(既存、両ファイルとも編集対象外)へ「right-panel.ts側から先に入る」経路が
// 新たに生まれてしまう。既存の相互importは「damage-calc.ts側から先に入る」順序でのみ安全
// (right-panel.tsコメント「モジュール top-level で即時評価されない値のみを跨いでいる」参照)
// になるよう設計されていたため、順序が変わると right-panel.ts の `let detailPanelEl` 等が
// 自身の宣言文へ到達する前に initRightPanel() から代入されてしまい、
// "Cannot access 'detailPanelEl' before initialization" で例外になる
// (実機のPlaywright検証で再現・特定した)。型だけの参照(CandidateListItem)は実行時に
// 消えるため static import のままでよいが、実行時に呼ぶ関数(renderCandidateList/
// openDetailPanelOverlayIfNarrow)はボタンクリック時(=ページの全scriptが評価を終え、
// damage-calc.ts側から通常どおりright-panel.tsが初期化された後)に初めてdynamic import
// することで、モジュールグラフへ入る経路を変えないようにする(loadRightPanel、下記)。
import type { CandidateListItem } from "./right-panel";
let rightPanelModulePromise: Promise<typeof import("./right-panel")> | null = null;
function loadRightPanel(): Promise<typeof import("./right-panel")> {
	if (!rightPanelModulePromise) rightPanelModulePromise = import("./right-panel");
	return rightPanelModulePromise;
}

// UI品質改善(2026-07-26 第4弾 11-4): #move-listのlearnset優先並び替え(rebuildMoveListForSpecies、
// 下で定義)は #move-list に既に候補が入っている前提で動く。loadAutocomplete()は元は<script>末尾で
// void呼び出ししていたが、それより先にupdateSpeciesDisplay()の初回呼び出し(ページ読み込み時の
// 種族名反映、下の方)が走るため、呼び出し順のままでは並び替え時に#move-listがまだ空になってしまう。
// loadAutocomplete()はdatalistへ<option>を追記するだけで内部にキャッシュを持たない
// (二重に呼ぶと候補が重複する)ため、呼び出し箇所はこの1箇所だけに保ち、Promiseを
// 変数で保持してrebuildMoveListForSpecies側から待ち合わせに使う。
// 純粋なsubject_key組み立てをNodeテストからimportできるよう、DOMの無い環境では副作用を起動しない。
const autocompleteReadyPromise = typeof document === "undefined" ? Promise.resolve() : loadAutocomplete();

const typesMapPromise = loadTypesMap();
const moveTypeMapPromise = loadMoveTypeMap();
const learnsetMapPromise = loadLearnsetMap();

// UI刷新(Pokemon.png): 種族アイコン右上の「タイプ画像」バッジ。
// ラウンド3 B-6: 以前はtypes配列の先頭(types?.[0])だけを1枚の<img>に表示しており、
// 複合タイプ(例: メガリザードンX=ほのお/ドラゴン、ハバタクカミ=ゴースト/フェアリー)が
// 単一タイプとして表示される不正確な状態だった。containerに全タイプぶんの<img>を
// 動的に追加する方式に変更する(タイプ数が種族によって1〜2件で可変なため)。
// 取得できない(sprite-urls側がnullを返す/画像404)場合は既存のTYPE_COLORSによる
// 色ボックス表現にフォールバックする。種族名が空/タイプ不明の場合はコンテナを空にする。
async function applyTypeBadge(container: HTMLElement, name: string): Promise<void> {
	container.innerHTML = "";
	const types = name ? (await typesMapPromise).get(name) : undefined;
	if (!types || types.length === 0) return;
	for (const t of types) {
		const imgEl = document.createElement("img");
		imgEl.className = "type-badge-img";
		// CSS側(--icon-size-sm=20px)と一致させる
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
// UI品質改善(2026-07-26 第4弾): global.cssの--slider-progressに現在値/32の割合を
// 設定し、「振った分だけ着色」されるようにする(要件)。
function updateSliderProgress(rangeInput: HTMLInputElement): void {
	const value = Number(rangeInput.value) || 0;
	const percent = Math.min(100, Math.max(0, (value / 32) * 100));
	rangeInput.style.setProperty("--slider-progress", `${percent}%`);
}
// UI改善ラウンド40ユーザー指示(40-T2)「スピンボックスは上下限で打ち切らず循環するUIにする」。
// [min, max]の範囲外の値を、範囲の反対側から続くように循環(モジュロ演算)させる。
// 例: min=0,max=32のとき 33→0、-1→32、50→17(50 mod 33)。育成ルールの範囲自体
// (min/max引数)は呼び出し側がそのまま渡すだけで、この関数は「範囲を超えたときの
// 挙動」だけを変える(上下限の値自体は変更しない)。
function wrapToRange(value: number, min: number, max: number): number {
	const size = max - min + 1;
	return (((value - min) % size) + size) % size + min;
}
function pairEvSlider(numberId: string, rangeId: string, onSync: () => void): void {
	const numberInput = el<HTMLInputElement>(numberId);
	const rangeInput = el<HTMLInputElement>(rangeId);
	rangeInput.value = numberInput.value || "0";
	updateSliderProgress(rangeInput);
	rangeInput.addEventListener("input", () => {
		numberInput.value = rangeInput.value;
		updateSliderProgress(rangeInput);
		onSync();
	});
	// ラウンド40(40-T2)対応: numberInput側はLeftPanel.astroでmin/max属性を外して
	// あるため、ネイティブの増減スピナー矢印・ArrowUp/ArrowDown・ホイール操作のいずれも
	// 範囲外の値(33や-1等)をそのままinputイベントで渡してくる。ここでwrapToRange()に
	// 通してから range 側・number 側の両方に書き戻す(numberInput.value自体も
	// 循環後の値に補正することで、表示上も「32の次は0」に見えるようにする)。
	// range側(スライダー)は据え置き(ドラッグ操作は循環させると直感に反するため、
	// 40-T2の対象はあくまで増減ボタン付きの数値入力=スピンボックスのみ)。
	numberInput.addEventListener("input", () => {
		const n = Number(numberInput.value);
		if (Number.isFinite(n)) {
			const wrapped = wrapToRange(Math.round(n), 0, 32);
			if (String(wrapped) !== numberInput.value) numberInput.value = String(wrapped);
			rangeInput.value = String(wrapped);
		}
		updateSliderProgress(rangeInput);
	});
}

// UI改善ラウンド34ユーザー指示(34-C1)「種族名・特性・アイテム・技の選択ボックスは
// 一度選択した状態で再クリックしても、フィルタが適用されており他の選択肢が表示されない。
// フィルタ結果だけ表示するのではなく、フィルタ結果を最上位に表示するようにしたい」対応。
//
// 診断: #species-name/#item/#move-1〜#move-4はネイティブ<input list="...">+<datalist>。
// Chromium系ブラウザは「現在の入力値と一致しない<option>を候補から除外(非表示)する」
// 独自フィルタを持つ。値が確定済み(=候補の1つと完全一致)の状態で再度フォーカスすると、
// ブラウザは現在値でフィルタをかけ直すため他の選択肢がほぼ隠れる(候補1件になることが多い)。
// これはCSS/DOM順の変更だけでは制御できないブラウザ既定動作。
//
// 方針: フォーカス時に現在値を一時変数へ退避してからinput.valueを空にし、ブラウザに
// 全件を表示させる。空にする直前に<datalist>内の<option>を退避した現在値に近い順
// (完全一致→前方一致→部分一致→残り、安定ソートで同順位内の相対順序=既存の並びは維持)に
// 並べ替えておくことで、「フィルタ結果(=現在値に近いもの)が実質的に最上位に来る」体裁に
// する。blur時、ユーザーが新しい値を選ばず(=inputイベントが発火せず)値が空のままなら、
// 退避値を書き戻す(誤って値を消したままにしない)。ユーザーが実際に打鍵/datalistから
// 選択した場合はinputイベントが発火するため、その後は書き戻さない(新しい値を尊重する)。
//
// 技(#move-1〜#move-4)は#move-listを4つのinputで共有しており、rebuildMoveListForSpecies()
// が既にlearnset優先で並べ替え済み(下記参照)。安定ソートで同順位(rank)内の相対順序を
// 保つため、learnset優先の並びを壊さずに「現在値との近さ」だけをさらに上乗せできる。
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

// 匿名集計サジェスト機能。編集中の個体と同じ種族(species_name)について、他ユーザーが
// 登録した個体を匿名集計した「よく使われる性格/アイテム/テラス/技」を、対応する選択候補
// (datalist/カスタムドロップダウン/技選択ウィンドウ)の並び順・表示テキストに反映する。
// バックエンド(GET /api/suggestions、変更不要)は該当種族のサンプル数がk-匿名性の閾値
// (既定5件)未満だと該当kindの行自体が存在しない(data: [])——この場合は各候補リストを
// 元の並び順・元のテキストのまま変更しない(過去の「常時表示される空枠」を作らない方針を、
// 候補リストへの「上書きをしない」という形で引き継ぐ)。
//
// 🔴 UI改修依頼(個体編集左パネル、2026-08-01)「サジェストはリストボックスの候補に反映し、
// パネルに常時表示しない。人気順に並び替えたり作用率を併記したりする。」により、常時表示の
// ヒント段落(#nature-suggestion-hint等、旧実装。LeftPanel.astroから削除済み)を廃止し、
// 各候補リストそのものを書き換える方式に置き換えた。
//
// 対象は性格・持ち物・テラス・技の4箇所(既存のsuggestions kindがpopular_nature/
// popular_item/popular_tera/popular_moveの4種類のみのため、migrations/009参照)。
// 特性(#ability<select>)は対応するsuggestions kindが存在しない——特性はそもそも
// 「その種族が持ちうる特性」しか候補に出ない設計(rebuildAbilityOptions参照、通常1〜3件)
// で、人気順に並び替える元データが無い。無理に新しいkindを作らず、rebuildAbilityOptions
// 自体には手を入れない。
//
// 🔴 d7552ad「サジェストがレギュレーションを混ぜている件」の解消(UI改修依頼 2026-08-01
// 「サジェストもレギュレーションにフォーカスして精度を高めたい」/「レギュレーションを
// 指定した場合は、サジェストをそのレギュレーション限定の情報に絞る」)。
// migrations/013_regulation.sql の refresh_popular_builds() が、同じ集計を2つのスコープで
// 書き出すようになった:
//   subject_key = '種族名'        … 全レギュレーション横断(従来と同じ。レギュレーション未指定時に使う)
//   subject_key = '種族名|M-A'    … そのレギュレーション限定
// このファイルは編集中の個体の #regulation の値に応じて subject_key を切り替えるだけでよく、
// GET /api/suggestions 自体は無変更。
//
// ユーザー指示により、規制別集計が取得不能または空のときは種族名だけの横断集計へフォールバックする。
// データが少ない規制でも候補を空にせず、popular_nature/item/tera/moveを同じ取得方針に統一する。
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

// 種族が変わるたびに最新のペイロードで上書きするキャッシュ。#item-dropdown-list等は
// 初回オープン時に遅延構築される(buildItemDropdownOptions参照)ため、構築がサジェスト取得
// より後になるケースに備えて保持し、構築側(openItemDropdown)からも読みに来られるようにする。
let lastNatureSuggestion: SuggestionPayload | undefined;
let lastItemSuggestion: SuggestionPayload | undefined;
let lastTeraSuggestion: SuggestionPayload | undefined;
let lastMoveSuggestion: SuggestionPayload | undefined;

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

// --- 持ち物: #item-dropdown-list(カスタムドロップダウン、初回オープン時に遅延構築)。
//     「持ち物なし」(value="")は常に先頭固定のまま、残りを人気順→元の順で並べ替え、
//     .item-dropdown-option-textに"(NN%)"を追記する。 ---
function applyItemSuggestionOrdering(): void {
	const listEl = document.getElementById("item-dropdown-list") as HTMLUListElement | null;
	if (!listEl) return;
	const lis = Array.from(listEl.querySelectorAll<HTMLLIElement>(".item-dropdown-option"));
	if (lis.length === 0) return; // 未構築(次回buildItemDropdownOptions/openItemDropdownで改めて適用される)
	const ratioMap = new Map((lastItemSuggestion?.options ?? []).map((o) => [o.value, o.ratio] as const));
	const noneLi = lis.find((li) => li.dataset.value === "");
	const rest = lis.filter((li) => li.dataset.value !== "");
	rest.sort((a, b) => suggestionCompare(ratioMap, a.dataset.value ?? "", b.dataset.value ?? ""));
	for (const li of rest) {
		const value = li.dataset.value ?? "";
		const ratio = ratioMap.get(value);
		const textEl = li.querySelector<HTMLElement>(".item-dropdown-option-text");
		if (textEl) textEl.textContent = ratio != null ? `${value}(${suggestionRatioText(ratio)})` : value;
	}
	const emptyLi = listEl.querySelector<HTMLLIElement>(".item-dropdown-empty");
	if (noneLi) listEl.appendChild(noneLi);
	for (const li of rest) listEl.appendChild(li);
	if (emptyLi) listEl.appendChild(emptyLi); // 「該当する持ち物がありません」は常に末尾
}

// --- テラスタイプ: #tera-dropdown-list(19件、初期化時に構築済み)。「テラスタルなし」
//     (value="")は常に先頭固定。 ---
function applyTeraSuggestionOrdering(): void {
	const listEl = document.getElementById("tera-dropdown-list") as HTMLUListElement | null;
	if (!listEl) return;
	const lis = Array.from(listEl.querySelectorAll<HTMLLIElement>(".tera-dropdown-option"));
	if (lis.length === 0) return;
	const ratioMap = new Map((lastTeraSuggestion?.options ?? []).map((o) => [o.value, o.ratio] as const));
	const noneLi = lis.find((li) => li.dataset.value === "");
	const rest = lis.filter((li) => li.dataset.value !== "");
	rest.sort((a, b) => suggestionCompare(ratioMap, a.dataset.value ?? "", b.dataset.value ?? ""));
	for (const li of rest) {
		const value = li.dataset.value ?? "";
		const ratio = ratioMap.get(value);
		const textEl = li.querySelector<HTMLElement>(".tera-dropdown-option-text");
		if (textEl) textEl.textContent = ratio != null ? `${value}(${suggestionRatioText(ratio)})` : value;
	}
	if (noneLi) listEl.appendChild(noneLi);
	for (const li of rest) listEl.appendChild(li);
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

// regulation: 編集中の個体のレギュレーション(#regulation の値。未指定は null)。
// 種族が変わったときだけでなくレギュレーションが変わったときにも呼び直す必要がある。
export async function loadPopularBuildSuggestions(
	speciesName: string,
	regulation: string | null,
	archetype: ArchetypeKey | null = null,
): Promise<void> {
	const name = speciesName.trim();
	const token = ++popularBuildSuggestionsToken;
	if (!name) {
		lastNatureSuggestion = lastItemSuggestion = lastTeraSuggestion = lastMoveSuggestion = undefined;
		applyNatureSuggestionOrdering();
		applyItemSuggestionOrdering();
		applyTeraSuggestionOrdering();
		onMoveSuggestionUpdated?.();
		return;
	}
	const [nature, item, tera, move] = await Promise.all([
		fetchSuggestionPayload("popular_nature", name, regulation),
		fetchSuggestionPayload("popular_item", name, regulation),
		fetchSuggestionPayload("popular_tera", name, regulation),
		fetchPopularMovePayload(name, regulation, archetype),
	]);
	if (token !== popularBuildSuggestionsToken) return; // より新しい呼び出しに追い越された
	lastNatureSuggestion = nature;
	lastItemSuggestion = item;
	lastTeraSuggestion = tera;
	lastMoveSuggestion = move;
	applyNatureSuggestionOrdering();
	applyItemSuggestionOrdering();
	applyTeraSuggestionOrdering();
	onMoveSuggestionUpdated?.();
}

const form = typeof document === "undefined" ? null : document.getElementById("edit-form") as HTMLFormElement | null;
if (form) {
	// UI改修依頼(個体編集画面、2026-08-03)「耐久指数最大化」ボタン(ステータス表の下、
	// #durability-index-button)。静的マークアップ(LeftPanel.astro)では常にdisabledで
	// 描画されており、種族値が引けて実数値が計算できる状態(=種族名が入力済み)になった
	// ときだけ有効化する。applyBaseStats()が種族値の有無(base)を既に判定しているため、
	// その結果をそのまま流用する(旧・個別3ボタン時代と同じ「種族値の有無」の判定基準)。
	const durabilityIndexButton = el<HTMLButtonElement>("durability-index-button");
	function updateDurabilityIndexButtonEnabled(hasBaseStats: boolean): void {
		durabilityIndexButton.disabled = !hasBaseStats;
	}

	// UI刷新: 種族値の常時表示(実数値と同じ行に並べる)。
	async function applyBaseStats(name: string): Promise<void> {
		const base = name ? (await baseStatsMapPromise).get(name) : undefined;
		for (let i = 0; i < STAT_KEYS.length; i++) {
			const el2 = document.getElementById(`base-${STAT_KEYS[i]}`);
			if (!el2) continue;
			el2.textContent = base ? String(base[i]) : "-";
		}
		// ラウンド17指摘(B-5): HP種族値1(全1290種でヌケニンのみ)は努力値を振っても
		// 実数値が動かない(calcHpStatのbase===1特例と同じ判定)。誤解を招かないよう
		// 注記の表示/非表示をここで切り替える。
		const hpFixedNoteEl = document.getElementById("hp-fixed-note");
		if (hpFixedNoteEl) hpFixedNoteEl.hidden = !(base && base[0] === 1);
		updateDurabilityIndexButtonEnabled(!!base);
	}

	// UI品質改善(2026-07-26 第4弾 11-4): 技候補(#move-list)を種族の覚え技(learnset)
	// 優先で並べ替える。種族名変更のたびにupdateSpeciesDisplay()から呼ぶ(初期表示・
	// 入力のどちらにも追随)。種族が未確定/存在しない名前のときは全技リストのみ
	// (元の挙動)にフォールバックする。
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

	// ラウンド21ユーザー指示(21-L8)「タイプアイコンを技名の左に置く」。技が未入力/タイプ不明のときは
	// アイコンを隠す([hidden]は詳細度で負けるため、CSS側で[hidden]用のdisplay:noneを
	// 併記済み。pitfalls.md参照)。
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

	// ラウンド4ユーザー指示: 性格の選択UIを廃止し、能力値ラベル(HP以外)のクリックで
	// 上昇/下降を切り替える。上昇1つ・下降1つの排他選択(新しく選ぶと元の保持者からは
	// 自動的に外れる)。初期値はSSRで埋め込んだ現在の性格名(data-nature)を
	// NATURE_STAT_MODIFIERSで正引きして復元する。
	let leftNatureUp: StatKey | null = null;
	let leftNatureDown: StatKey | null = null;
	{
		const initial = NATURE_STAT_MODIFIERS[form.dataset.nature ?? ""] ?? { up: null, down: null };
		leftNatureUp = initial.up;
		leftNatureDown = initial.down;
	}
	// ▲/▼ボタンの初期の押下状態を反映する(refreshNatureButtonsは関数宣言でホイスト
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

	const ownedPokemonId = form.dataset.id ?? "";
	const speciesInput = el<HTMLInputElement>("species-name");
	const statusEl = el<HTMLElement>("autosave-status");
	const statusTextEl = el<HTMLElement>("autosave-status-text");
	const retryButton = el<HTMLButtonElement>("retry-button");
	const deleteButton = el<HTMLButtonElement>("delete-button");

	const speciesSpriteImg = el<HTMLImageElement>("species-sprite");
	const speciesSpriteFallback = el<HTMLElement>("species-sprite-fallback");
	const speciesTypeBadge = el<HTMLElement>("species-type-badge");

	// UI品質改善(2026-07-26 第4弾): ページ見出し(ニックネーム/種族名)を種族名/ニックネームの
	// 入力に追随して更新する。ヘッダはpokemonが存在するときだけSSRで描画されるため、
	// この<script>ブロック自体がpokemon存在時(=#edit-form描画時)にしか実行されず、
	// 要素は必ず存在する。
	const topbarTitleEl = document.querySelector<HTMLElement>(".app-topbar-title");

	function updateHeaderIdentity(): void {
		const species = speciesInput.value.trim();
		const display = species || "個体編集";
		if (topbarTitleEl) {
			topbarTitleEl.textContent = display;
		}
	}

	// 「図鑑で見る」リンクは要件により廃止(種族名の変更に追随するのは画像と種族値のみ)。
	function updateSpeciesDisplay(): void {
		const name = speciesInput.value.trim();
		void applySprite(speciesSpriteImg, speciesSpriteFallback, name, officialArtworkUrl);
		void applyTypeBadge(speciesTypeBadge, name);
		void applyBaseStats(name);
		void rebuildMoveListForSpecies(name);
		updateHeaderIdentity();
	}
	speciesInput.addEventListener("input", updateSpeciesDisplay);
	updateSpeciesDisplay();
	// UI改善ラウンド34ユーザー指示(34-C1): 再クリック時に他の種族候補が隠れてしまう
	// ネイティブdatalistフィルタを回避する(上のsetupDatalistRefocus参照)。
	setupDatalistRefocus(speciesInput, el<HTMLDataListElement>("pokemon-list"));
	// ラウンド3 B-12: 実数値は純JS計算になったので、エンジンの初期化を待たず
	// ページ表示直後に計算する(以前はcombinedDamageEngineProgress経由でエンジン
	// 準備完了後にしか呼ばれておらず、それまで「(未計算)」のままだった)。
	void recalcStats();

	// UI刷新(Pokemon.png): アイテム画像(入力の横)。アイテム名が変わるたびに差し替える。
	const itemImageEl = el<HTMLImageElement>("item-image");
	const itemInput = el<HTMLInputElement>("item");
	function updateItemImage(): void {
		void applyItemImage(itemImageEl, itemInput.value.trim());
	}
	// ラウンド4の積み残し: 持ち物欄が長い値(「こだわりハチマキ」等)で見切れる。
	// 幅を大きく取れないため、titleでホバー時に全文を見られるようにする
	// (CSS側のtext-overflow:ellipsisと合わせて、見切れていることが分かる+全文も確認できる)。
	function updateItemTitle(): void {
		itemInput.title = itemInput.value.trim();
	}
	// UI改善ラウンド26ユーザー指示(26-L2)「アイテム画像+アイテム名(テキスト)を余裕を
	// もって配置する」。#item-name-displayは読み取り専用の表示のみ(既存の#item入力欄・
	// buildPayloadの保存経路は一切変えない)。持ち物なしのときは25-R2/24-L3と同じ
	// 「muted文字色」の見た目にする(placeholder風。CSSは.item-name-display.is-empty参照)。
	const itemNameDisplayEl = el<HTMLElement>("item-name-display");
	function updateItemNameDisplay(): void {
		const name = itemInput.value.trim();
		itemNameDisplayEl.textContent = name || "アイテムなし";
		itemNameDisplayEl.title = name;
		itemNameDisplayEl.classList.toggle("is-empty", name === "");
	}
	itemInput.addEventListener("input", updateItemImage);
	itemInput.addEventListener("input", updateItemTitle);
	itemInput.addEventListener("input", updateItemNameDisplay);
	updateItemImage();
	updateItemTitle();
	updateItemNameDisplay();
	// UI改善ラウンド34ユーザー指示(34-C1): 再クリック時に他の持ち物候補が隠れてしまう
	// ネイティブdatalistフィルタを回避する(上のsetupDatalistRefocus参照)。#itemはこの後
	// hidden化する(下記41-L1参照)ため、これ以降ユーザーが直接クリックすることは無くなるが、
	// 挙動自体は無害なので変更しない。
	setupDatalistRefocus(itemInput, el<HTMLDataListElement>("item-list"));

	// UI改善ラウンド41ユーザー指示(41-L1)「アイテム選択ボックスもテラスタルと同様に、
	// 選択肢をアイコン+テキストで表示」。テラス側(下のteraSelect一式、buildTeraDropdown相当)を
	// 参照実装にする。#item(上のitemInput、LeftPanel.astro側でhidden化済み)は保存経路の
	// 実体として残し、値の変更はitemInput.value経由のまま(buildPayloadは変えない)。
	// テラス(19種、SSR時に<select>へ全option埋め込み済み)と違い、アイテムは候補が
	// #item-list(datalist、loadAutocomplete()がitems.jsonから流し込む、270件規模)にしか
	// 無く、しかも非同期取得のため、初回ドロップダウンを開いたタイミングで1回だけ
	// <li>一覧を構築する(遅延構築。ページ表示直後に270件ぶんのアイコン画像を全部
	// フェッチするコストを避けるため)。絞り込み入力(#item-dropdown-search)は既存の
	// 「アイテム名を打って絞り込む」操作性を維持するための追加要素(テラスには無い)。
	const itemDropdownButton = el<HTMLButtonElement>("item-dropdown-button");
	const itemDropdownImage = el<HTMLImageElement>("item-dropdown-image");
	const itemDropdownPlaceholder = el<HTMLElement>("item-dropdown-placeholder");
	const itemDropdownPanel = el<HTMLElement>("item-dropdown-panel");
	const itemDropdownSearch = el<HTMLInputElement>("item-dropdown-search");
	const itemDropdownListEl = el<HTMLUListElement>("item-dropdown-list");

	// #item-listはloadAutocomplete()(autocompleteReadyPromise)が非同期でoptionを流し込むため、
	// getAllMoveNames()(上記rebuildMoveListForSpecies参照)と同じパターンで一度だけ読み取って
	// キャッシュする。
	let itemOptionNamesCache: string[] | null = null;
	async function getItemOptionNames(): Promise<string[]> {
		await autocompleteReadyPromise;
		if (!itemOptionNamesCache) {
			itemOptionNamesCache = Array.from(el<HTMLDataListElement>("item-list").options).map((o) => o.value);
		}
		return itemOptionNamesCache;
	}

	const itemDropdownOptionEls: { value: string; li: HTMLLIElement }[] = [];
	const itemDropdownEmptyEl = document.createElement("li");
	itemDropdownEmptyEl.className = "item-dropdown-empty";
	itemDropdownEmptyEl.textContent = "該当する持ち物がありません";
	itemDropdownEmptyEl.setAttribute("aria-disabled", "true");
	itemDropdownEmptyEl.hidden = true;

	function selectItem(value: string): void {
		if (itemInput.value !== value) {
			itemInput.value = value;
			// textInputIds(scheduleSave)・statAffectingIds(recalcStats)の両方に"item"が
			// 登録されているため(下記参照)、input/changeの両方を発火させる必要がある。
			itemInput.dispatchEvent(new Event("input"));
			itemInput.dispatchEvent(new Event("change"));
		}
		closeItemDropdown();
	}

	let itemDropdownBuilt = false;
	async function buildItemDropdownOptions(): Promise<void> {
		if (itemDropdownBuilt) return;
		itemDropdownBuilt = true;
		const names = await getItemOptionNames();
		const fragment = document.createDocumentFragment();
		// テラスの「テラスなし」(value="")と同じ扱いで、持ち物を外す選択肢を先頭に置く
		// (ドロップダウン化に伴い、候補一覧から選ぶだけでは持ち物を空にする操作が失われて
		// しまうため、テラス実装に倣い明示的な「持ち物なし」項目を追加する)。
		{
			const li = document.createElement("li");
			li.className = "item-dropdown-option";
			li.setAttribute("role", "option");
			li.tabIndex = -1;
			li.dataset.value = "";
			li.setAttribute("aria-label", "アイテムなし");
			const textEl = document.createElement("span");
			textEl.className = "item-dropdown-option-text";
			textEl.textContent = "アイテムなし";
			li.appendChild(textEl);
			li.addEventListener("click", () => selectItem(""));
			fragment.appendChild(li);
			itemDropdownOptionEls.push({ value: "", li });
		}
		for (const value of names) {
			const li = document.createElement("li");
			li.className = "item-dropdown-option";
			li.setAttribute("role", "option");
			li.tabIndex = -1;
			li.dataset.value = value;
			li.setAttribute("aria-label", value);
			const imgEl = document.createElement("img");
			imgEl.className = "item-dropdown-option-image";
			imgEl.alt = "";
			void applyItemImage(imgEl, value);
			li.appendChild(imgEl);
			const textEl = document.createElement("span");
			textEl.className = "item-dropdown-option-text";
			textEl.textContent = value;
			li.appendChild(textEl);
			li.addEventListener("click", () => selectItem(value));
			fragment.appendChild(li);
			itemDropdownOptionEls.push({ value, li });
		}
		itemDropdownListEl.appendChild(fragment);
		itemDropdownListEl.appendChild(itemDropdownEmptyEl);
	}

	function filterItemDropdown(): void {
		const query = itemDropdownSearch.value.trim().toLowerCase();
		let anyVisible = false;
		for (const opt of itemDropdownOptionEls) {
			const match = query === "" || opt.value.toLowerCase().includes(query);
			opt.li.hidden = !match;
			if (match) anyVisible = true;
		}
		itemDropdownEmptyEl.hidden = anyVisible;
	}
	itemDropdownSearch.addEventListener("input", filterItemDropdown);

	function closeItemDropdown(): void {
		itemDropdownPanel.hidden = true;
		itemDropdownButton.setAttribute("aria-expanded", "false");
	}
	async function openItemDropdown(): Promise<void> {
		await buildItemDropdownOptions();
		// 匿名集計サジェスト機能: 初回オープン時(遅延構築の直後)は、種族確定後に既に取得済みの
		// サジェストがあれば人気順・作用率併記をここで初めて反映する(構築より先にサジェストが
		// 届いていた場合、applyItemSuggestionOrdering自体は「未構築ならno-op」で戻っていたため)。
		applyItemSuggestionOrdering();
		itemDropdownSearch.value = "";
		for (const opt of itemDropdownOptionEls) {
			opt.li.classList.toggle("is-active", opt.value === itemInput.value);
			opt.li.hidden = false;
		}
		itemDropdownEmptyEl.hidden = true;
		itemDropdownPanel.hidden = false;
		itemDropdownButton.setAttribute("aria-expanded", "true");
		itemDropdownSearch.focus();
	}
	itemDropdownButton.addEventListener("click", () => {
		if (itemDropdownPanel.hidden) void openItemDropdown();
		else closeItemDropdown();
	});
	// リストの外側をクリックしたら閉じる(#tera-dropdown-listと同じ一般的な挙動)。
	document.addEventListener("click", (e) => {
		if (itemDropdownPanel.hidden) return;
		const target = e.target as Node;
		if (itemDropdownButton.contains(target) || itemDropdownPanel.contains(target)) return;
		closeItemDropdown();
	});
	itemDropdownButton.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeItemDropdown();
	});
	itemDropdownSearch.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			closeItemDropdown();
			itemDropdownButton.focus();
		}
	});

	// ボタン(閉じた状態)に現在選択中の持ち物を表示する(テラスのupdateTeraDropdownButtonと
	// 同じ役割)。
	function updateItemDropdownButton(): void {
		const value = itemInput.value.trim();
		const isUnselected = value === "";
		itemDropdownButton.classList.toggle("is-item-unselected", isUnselected);
		itemDropdownButton.setAttribute("aria-label", value ? `持ち物: ${value}` : "持ち物: 未選択");
		itemDropdownPlaceholder.classList.toggle("is-item-value-text", !isUnselected);
		if (isUnselected) {
			itemDropdownImage.style.display = "none";
			itemDropdownPlaceholder.textContent = "アイテムなし";
			return;
		}
		itemDropdownPlaceholder.textContent = value;
		void applyItemImage(itemDropdownImage, value);
	}
	itemInput.addEventListener("input", updateItemDropdownButton);
	updateItemDropdownButton();

	// ラウンド21ユーザー指示(21-L5): 特性はそのポケモンに属する特性だけを候補とする
	// <select>にする(予測変換のinput/datalistは不要という指示のため撤去)。種族が
	// 変わるたびに候補を作り直し、現在の値が新しい候補に無ければクリアする。
	const abilitySelectEl = el<HTMLSelectElement>("ability");
	let abilityRequestToken = 0;
	async function rebuildAbilityOptions(name: string): Promise<void> {
		const token = ++abilityRequestToken;
		const abilitiesMap = await loadAbilitiesMap();
		if (token !== abilityRequestToken) return; // より新しい呼び出しに追い越された
		const abilities = name ? abilitiesMap.get(name) ?? [] : [];
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
		// UI改善ラウンド34ユーザー指示(34-C2)「ポケモンが選択されている状態での、特性選択
		// ボックスの"特性を選択"という候補を削除」。ここに到達するのは種族(pokemon)が
		// 確定していてabilities.length>0の場合に限る(nameが空/該当なしならabilities=[]と
		// なり上のガード節で早期returnする)。この分岐では下のvalue決定ロジックが
		// 必ずどれか実在の特性(previousValueかabilities[0])を選ぶため、「特性を選択」の
		// プレースホルダーは選んでも意味の無い余剰候補でしかなかった(誤って選ぶと
		// ability_name=""で保存されてしまう入口にもなっていた)。種族未選択時
		// (abilities.length===0の分岐、上記)のプレースホルダー(textContent="特性")は
		// 今回のスコープ外のため変更しない。
		for (const a of abilities) {
			const opt = document.createElement("option");
			opt.value = a;
			opt.textContent = a;
			abilitySelectEl.appendChild(opt);
		}
		// UI改善ラウンド26ユーザー指示(26-L1)「特性はデフォルトで一つ目の特性を設定する。
		// 特性なし状態は発生しなくなる。」保存済みの値が新しい候補に無い場合のフォールバック先を
		// ""(「特性を選択」のプレースホルダー)ではなく候補の先頭(abilities[0])にする。
		// 種族名を確定した瞬間に特性が自動で埋まり自動保存される(下のscheduleSave()参照)。
		abilitySelectEl.value = abilities.includes(previousValue) ? previousValue : abilities[0];
		abilitySelectEl.title = abilitySelectEl.value;
		if (abilitySelectEl.value !== previousValue) scheduleSave();
	}
	abilitySelectEl.addEventListener("change", () => {
		abilitySelectEl.title = abilitySelectEl.value;
	});
	// 種族名のinputイベント(1文字ごと)には結線しない: 編集途中の不完全な種族名で候補が
	// 毎回作り直され、既存の正しい特性選択が失われてしまう事故を避けるため、種族名が
	// 「確定した」タイミング(blur、またはdatalistからの選択によるchangeイベント)でのみ
	// 再構築する。
	// UI改修依頼(共通)「メガシンカポケモンのアイテムをメガストーンで固定する」により、
	// 「持ち物が既に入っていれば何もしない」自動設定から、メガシンカ種族が確定している間は
	// 常にメガストーンへ強制し、持ち物選択ボタン自体を操作不能にする方式へ変更した
	// (ゲーム仕様上メガシンカ中はメガストーン以外を持てないため)。ページ初期表示時
	// (保存済みデータが誤ったアイテムを持っている場合を含む)にも働くよう、下のinit呼び出しにも
	// 追加している。rebuildAbilityOptionsと同じくinput(1文字ごと)ではなくchange
	// (blur/確定)にのみ結線する(理由も同じ: 入力途中の不完全な種族名で誤発火させない)。
	const megaStoneLockedTitle = "メガシンカ中は持ち物をメガストーンに固定します";
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
		// UI改善ラウンド41ユーザー指示(41-L1)で#item自体をhidden化したため、
		// flashAutofillHint()がitemInputに付ける視覚的なハイライト(border-color+box-shadow)は
		// 見えなくなった。表示を担う#item-dropdown-button側にも同じ視覚言語(既存の
		// #edit-form #item.is-autofilledと同じトークン、上記CSS参照)で一時的にハイライトする。
		itemDropdownButton.classList.add("is-autofilled");
		window.setTimeout(() => itemDropdownButton.classList.remove("is-autofilled"), 1400);
		setItemLocked(true);
	}
	// 🔴 UI改修依頼(個体編集左パネル・レギュレーション対応、2026-08-01)。
	// #regulation(2段目左の選択ボックス)は次の3つを駆動する:
	//   ① テラスタル選択ボックス(2段目右、#tera-field)の表示/非表示
	//   ② 未選択時の placeholder 表現(data-empty="true" → 破線・薄字。LeftPanel.astroのCSS)
	//   ③ 人気度サジェストの母集団の切り替え(subject_key に '|レギュレーション' を足す)
	// 保存(scheduleSave)は下の changeInputIds に "regulation" を足すことで行う。
	const regulationSelect = el<HTMLSelectElement>("regulation");
	const teraField = document.getElementById("tera-field");

	function currentRegulation(): string | null {
		const value = regulationSelect.value.trim();
		return value === "" ? null : value;
	}

	function currentArchetype(): ArchetypeKey | null {
		// IV=31・Lv50は本アプリの育成ルール。現在の編集値を分類器へそのまま渡す。
		return classifyArchetype({
			speciesName: speciesInput.value.trim(),
			itemName: itemInput.value.trim(),
			nature: currentLeftNature(),
			evs: STAT_KEYS.map((key) => readEv(key)),
			ivs: STAT_KEYS.map(() => 31),
			moveNames: readMoveNames(),
		});
	}

	function reloadPopularBuildSuggestions(): void {
		void loadPopularBuildSuggestions(speciesInput.value.trim(), currentRegulation(), currentArchetype());
	}
	let suggestionReloadTimer: ReturnType<typeof setTimeout> | undefined;
	function schedulePopularBuildSuggestionsReload(): void {
		// スライダーや文字入力の連続操作ごとにAPIを叩かず、確定に近い最新値だけで型を再判定する。
		if (suggestionReloadTimer) clearTimeout(suggestionReloadTimer);
		suggestionReloadTimer = setTimeout(reloadPopularBuildSuggestions, 200);
	}

	// ①: レギュレーションが M-* のときはテラス欄を隠す(未指定・T-* のときは表示)。
	// 隠すだけで #tera の値には触れない ── 別のレギュレーションに戻したときに
	// 保存済みのテラスタイプがそのまま復帰するようにするため(値の破棄はしない、
	// というユーザー確認 2026-08-01 の判断)。SSR側の初期状態は LeftPanel.astro の
	// showTeraField が同じ関数(isTerastalRegulation)で決めている。
	function syncTeraFieldVisibility(): void {
		if (!teraField) return;
		teraField.hidden = !isTerastalRegulation(currentRegulation());
	}

	// ②: <select> には :placeholder-shown が無いため、空のときだけ data-empty を付ける。
	function syncRegulationPlaceholder(): void {
		if (currentRegulation() === null) regulationSelect.dataset.empty = "true";
		else delete regulationSelect.dataset.empty;
	}

	regulationSelect.addEventListener("change", () => {
		syncTeraFieldVisibility();
		syncRegulationPlaceholder();
		// ③: レギュレーションが変わると人気度の母集団そのものが変わるため取り直す。
		reloadPopularBuildSuggestions();
	});
	// ページ初期表示時にも1回そろえる(SSRと同じ結果になるはずだが、二重管理にしない)。
	syncTeraFieldVisibility();
	syncRegulationPlaceholder();

	speciesInput.addEventListener("change", () => {
		void rebuildAbilityOptions(speciesInput.value.trim());
		void applyLeftMegaStoneAutofill(speciesInput.value.trim());
		// 匿名集計サジェスト機能・第5段階: 種族確定時に人気の性格/アイテム/テラス/技を取り直す。
		reloadPopularBuildSuggestions();
	});
	void rebuildAbilityOptions(speciesInput.value.trim());
	// ページ初期表示時点(SSRで埋め込まれた現在の種族名)で既にメガシンカ種族の場合、
	// 保存済みの持ち物が誤っていても正しいメガストーンへ補正しロックする。
	void applyLeftMegaStoneAutofill(speciesInput.value.trim());
	// 匿名集計サジェスト機能・第5段階: ページ初期化時(SSRで埋め込まれた現在の種族名)にも
	// 1回呼ぶ。
	reloadPopularBuildSuggestions();

	// UI改善ラウンド25(25-L1/25-L2): テラスタイプ画像バッジ(#tera-image-badge)は25-L1で
	// 廃止した。テラスタイプの視覚表現はテラスタイプ選択欄そのものに統合する。
	// #tera(<select>)はhidden化して保存経路の値の実体として残し(値の変更は
	// 引き続きteraSelect.value経由)、その位置にボタン+リストボックスのカスタム
	// ドロップダウン(#tera-dropdown-button/#tera-dropdown-list)を作る。
	const teraSelect = el<HTMLSelectElement>("tera");
	const teraDropdownButton = el<HTMLButtonElement>("tera-dropdown-button");
	const teraDropdownImage = el<HTMLImageElement>("tera-dropdown-image");
	const teraDropdownPlaceholder = el<HTMLElement>("tera-dropdown-placeholder");
	const teraDropdownList = el<HTMLUListElement>("tera-dropdown-list");

	// 選択肢は#tera(<select>)のoption一覧からそのまま生成する(値・順序の実体は
	// <select>側にあるため二重管理を避ける。「テラスなし」はvalue=""のoptionとして
	// 既に含まれている)。各optionにaria-labelを付け、スクリーンリーダー・ホバー
	// 両方にタイプ名(日本語)を伝える(画像だけでは伝わらないため)。
	const teraDropdownOptionEls: { value: string; li: HTMLLIElement }[] = [];
	for (const optionEl of Array.from(teraSelect.options)) {
		const value = optionEl.value;
		const li = document.createElement("li");
		li.className = "tera-dropdown-option";
		li.setAttribute("role", "option");
		li.tabIndex = -1;
		li.dataset.value = value;
		if (value === "") {
			li.setAttribute("aria-label", "テラスタルなし");
			const textEl = document.createElement("span");
			textEl.className = "tera-dropdown-option-text";
			textEl.textContent = "テラスタルなし";
			li.appendChild(textEl);
		} else {
			li.setAttribute("aria-label", value);
			const imgEl = document.createElement("img");
			imgEl.className = "tera-dropdown-option-image";
			imgEl.alt = value;
			const url = teraTypeIconUrl(value);
			if (url) imgEl.src = url;
			li.appendChild(imgEl);
			const textEl = document.createElement("span");
			textEl.className = "tera-dropdown-option-text";
			textEl.textContent = value;
			li.appendChild(textEl);
		}
		li.addEventListener("click", () => {
			if (teraSelect.value !== value) {
				teraSelect.value = value;
				teraSelect.dispatchEvent(new Event("change"));
			}
			closeTeraDropdown();
		});
		teraDropdownList.appendChild(li);
		teraDropdownOptionEls.push({ value, li });
	}
	// 匿名集計サジェスト機能: このリストは(アイテムと違い)ページ初期化時に即座に構築される
	// ため、初期表示のSSR種族名について既に取得済みのサジェストがあれば直後に反映する
	// (以後の種族変更はloadPopularBuildSuggestions→applyTeraSuggestionOrderingが担う)。
	applyTeraSuggestionOrdering();

	function closeTeraDropdown(): void {
		teraDropdownList.hidden = true;
		teraDropdownButton.setAttribute("aria-expanded", "false");
	}
	function openTeraDropdown(): void {
		for (const opt of teraDropdownOptionEls) {
			opt.li.classList.toggle("is-active", opt.value === teraSelect.value);
		}
		teraDropdownList.hidden = false;
		teraDropdownButton.setAttribute("aria-expanded", "true");
	}
	teraDropdownButton.addEventListener("click", () => {
		if (teraDropdownList.hidden) openTeraDropdown();
		else closeTeraDropdown();
	});
	// リストの外側をクリックしたら閉じる(pitfalls.md想定の一般的なドロップダウン挙動)。
	document.addEventListener("click", (e) => {
		if (teraDropdownList.hidden) return;
		const target = e.target as Node;
		if (teraDropdownButton.contains(target) || teraDropdownList.contains(target)) return;
		closeTeraDropdown();
	});
	teraDropdownButton.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeTeraDropdown();
	});

	// ボタン(閉じた状態)に現在選択中のテラスタイプを表示する。
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
	teraSelect.addEventListener("change", () => {
		for (const opt of teraDropdownOptionEls) {
			opt.li.classList.toggle("is-active", opt.value === teraSelect.value);
		}
	});
	updateTeraDropdownButton();

	// UI改善ラウンド28ユーザー指示(28-L2)「テラスタイプ(画像)はアイテムの下に重ねて右下に
	// 配置する」。帯(.top-block-icon)の右下に、読み取り専用のテラスタイプ画像
	// (#top-block-tera-image、クリックしても開かない。選択自体は上のテラスタル選択ボックス
	// 側で行う)を新設する。表示ロジックはapplyTeraImage()をそのまま再利用する。
	const topBlockTeraImage = el<HTMLImageElement>("top-block-tera-image");
	const topBlockTeraFallback = el<HTMLElement>("top-block-tera-image-fallback");
	function refreshTopBlockTeraImage(): void {
		void applyTeraImage(topBlockTeraImage, topBlockTeraFallback, teraSelect.value);
	}
	teraSelect.addEventListener("change", refreshTopBlockTeraImage);
	refreshTopBlockTeraImage();

	// ラウンド4ユーザー指示で追加した「技の詳細はリンクではなくホバー表示にする」
	// ツールチップは、ラウンド20ユーザー指示(20-L2)「わざのヘルプ表示を削除」により撤去した。
	// ただし同じループ内で技名inputに結線していたタイプ色反映(updateMoveTypeColor)は
	// 独立した機能なので、トリガー<span>を経由せず#move-1〜#move-4のinputへ直接結線する。
	for (let slot = 1; slot <= 4; slot++) {
		const input = document.getElementById(`move-${slot}`) as HTMLInputElement | null;
		if (!input) continue;
		input.addEventListener("input", () => void updateMoveTypeIcon(input));
		input.addEventListener("change", () => void updateMoveTypeIcon(input));
		void updateMoveTypeIcon(input);
		// UI改善ラウンド34ユーザー指示(34-C1): 再クリック時に他の技候補が隠れてしまう
		// ネイティブdatalistフィルタを回避する(上のsetupDatalistRefocus参照)。#move-listは
		// 4つの技inputで共有しているが、安定ソートのためlearnset優先の並び
		// (rebuildMoveListForSpecies参照)は壊さない。
		setupDatalistRefocus(input, moveListEl);
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
	const preservedIsPinned = form.dataset.pinned === "true";

	function buildPayload() {
		return {
			nickname: el<HTMLInputElement>("nickname").value.trim(),
			species_name: speciesInput.value.trim(),
			level: preservedLevel,
			// ラウンド4ユーザー指示: 性格の選択UIは廃止し、能力値ラベルのクリックで選んだ
			// 上昇/下降から性格名を逆算して保存する(API契約は変えない=従来どおり性格名を送る)。
			nature: currentLeftNature(),
			ability_name: el<HTMLSelectElement>("ability").value.trim(),
			item_name: el<HTMLInputElement>("item").value.trim(),
			// テラス欄が非表示(M-*)でも #tera の値はそのまま保存する。非表示は「このルールでは
			// 使わない」という表示上の判断であって、保存済みの値を捨てる指示ではない
			// (ユーザー確認 2026-08-01。別のレギュレーションに戻せば元の値が見える)。
			tera_type: el<HTMLSelectElement>("tera").value,
			regulation: el<HTMLSelectElement>("regulation").value,
			evs: STAT_KEYS.map((k) => readEv(k)),
			ivs: STAT_KEYS.map(() => 31),
			move_names: readMoveNames(),
			memo: el<HTMLTextAreaElement>("memo").value.trim(),
			tags: preservedTags,
			is_pinned: preservedIsPinned,
		};
	}

	// ラウンド5ユーザー指示: ▲/▼ボタンの押下状態は「実際にクリックして選ばれている
	// 生の状態」(leftNatureUp/leftNatureDown)をそのまま反映する(正規化前)。
	function refreshNatureButtons(): void {
		// NATURE_TOGGLE_KEYS(下方で const 宣言)はこの関数がページ表示直後に呼ばれる
		// (TDZでまだ初期化されていない)ため、ここではSTAT_KEYSから都度フィルタする。
		for (const key of STAT_KEYS) {
			if (key === "hp") continue;
			const upBtn = document.getElementById(`nature-up-${key}`);
			const downBtn = document.getElementById(`nature-down-${key}`);
			if (upBtn) upBtn.setAttribute("aria-pressed", String(leftNatureUp === key));
			if (downBtn) downBtn.setAttribute("aria-pressed", String(leftNatureDown === key));
			// ラウンド21ユーザー指示(21-L7): A/B/C/D/SラベルもBoolean上昇/下降で赤・青に。
			const labelEl = document.getElementById(`nature-label-${key}`);
			if (labelEl) {
				if (leftNatureUp === key) labelEl.dataset.mod = "up";
				else if (leftNatureDown === key) labelEl.dataset.mod = "down";
				else delete labelEl.dataset.mod;
			}
		}
		// ラウンド21ユーザー指示(21-L4)「技の上に性格も表示する」。
		// 🔴 UI改修依頼(個体編集左パネル、2026-08-01)「性格をREAD限定にする」により、
		// #nature-readout-valueはLeftPanel.astro側で<input>から読み取り専用の<span>へ
		// 変更した。書き戻し先を.value代入からtextContent代入へ追随する(id・呼び出し順は
		// 変えていない)。
		const natureReadoutEl = document.getElementById("nature-readout-value");
		if (natureReadoutEl) natureReadoutEl.textContent = currentLeftNature();
	}

	// ラウンド5ユーザー指示: 「実数値」ラベルの左あたりに 66-(努力値合計) を表示する
	// (チャンピオンズルールの努力値合計上限66に対する残りポイント)。
	function updateEvRemaining(): void {
		const remainEl = document.getElementById("ev-remaining");
		if (!remainEl) return;
		const total = STAT_KEYS.reduce((sum, k) => sum + readEv(k), 0);
		const remaining = 66 - total;
		remainEl.textContent = `残り${remaining}`;
		if (remaining < 0) remainEl.dataset.state = "over";
		else if (remaining === 0) remainEl.dataset.state = "zero";
		else delete remainEl.dataset.state;
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
	}

	// デバウンス付き即時自動保存 + 楽観的UI更新(計画書§6.2)。
	const DEBOUNCE_MS = 700;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;
	let pendingRetry = false;

	async function saveNow(): Promise<void> {
		if (saving) {
			pendingRetry = true;
			return;
		}
		const payload = buildPayload();
		saving = true;
		statusEl.dataset.state = "saving";
		statusTextEl.textContent = "保存中...";
		retryButton.classList.remove("visible");

		try {
			const res = await fetch(`/api/owned-pokemon/${encodeURIComponent(ownedPokemonId)}`, {
				method: "PUT",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `保存に失敗しました (status=${res.status})`);
			}
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
		statusEl.dataset.state = "saving";
		statusTextEl.textContent = "編集中...";
		retryButton.classList.remove("visible");
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void saveNow();
		}, DEBOUNCE_MS);
	}

	retryButton.addEventListener("click", () => {
		void saveNow();
	});

	// ラウンド21ユーザー指示(21-L5): #abilityは<input>から<select>に変わったため、
	// input用のtextInputIds(自動保存)から外し、select用のchangeInputIds(change
	// イベントでの自動保存)へ移す。ここを漏らすと特性を変更しても保存されない。
	const textInputIds = ["nickname", "species-name", "item", "memo", ...STAT_KEYS.map((k) => `ev-${k}`), "move-1", "move-2", "move-3", "move-4"];
	for (const id of textInputIds) {
		const target = document.getElementById(id);
		if (!target) continue;
		target.addEventListener("input", scheduleSave);
	}
	// 型判定に使う持ち物・努力値・技が変わったら、技人気だけを新しい型で取り直す。
	for (const id of ["item", ...STAT_KEYS.map((k) => `ev-${k}`), "move-1", "move-2", "move-3", "move-4"]) {
		document.getElementById(id)?.addEventListener("input", schedulePopularBuildSuggestionsReload);
	}
	const changeInputIds = ["tera", "ability", "regulation"];
	for (const id of changeInputIds) {
		const target = document.getElementById(id);
		if (!target) continue;
		target.addEventListener("change", scheduleSave);
	}

	// UI刷新: ポケモン名/特性/持ち物/テラス/努力値のいずれかが変更されたら
	// 実数値を再計算する(change イベントで十分。入力のたびの再計算は不要。
	// IVは「チャンピオンズ」ルールで常に31固定のため変更対象から除外)。
	// 性格の変更(クリックによる上昇/下降切り替え)は下のnature-toggleクリックハンドラ側で
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

	// ラウンド5ユーザー指示: ▲/▼を独立した当たり判定にする。▲は上昇の保持者のみ、
	// ▼は下降の保持者のみを切り替える(toggleNatureUp/toggleNatureDown参照)。
	const NATURE_TOGGLE_KEYS = STAT_KEYS.filter((k) => k !== "hp");
	for (const key of NATURE_TOGGLE_KEYS) {
		const upButton = document.getElementById(`nature-up-${key}`);
		const downButton = document.getElementById(`nature-down-${key}`);
		upButton?.addEventListener("click", () => {
			leftNatureUp = toggleNatureUp(leftNatureUp, key);
			refreshNatureButtons();
			void recalcStats();
			scheduleSave();
			schedulePopularBuildSuggestionsReload();
		});
		downButton?.addEventListener("click", () => {
			leftNatureDown = toggleNatureDown(leftNatureDown, key);
			refreshNatureButtons();
			void recalcStats();
			scheduleSave();
			schedulePopularBuildSuggestionsReload();
		});
	}

	// 🔴 ラウンド48ユーザー追加指示(A-7)「性格の欄から性格を直接変更できるようにする」で
	// #nature-readout-valueのchangeハンドラ(直接入力→NATURE_STAT_MODIFIERSと完全一致検証)を
	// 追加していたが、🔴 UI改修依頼(個体編集左パネル、2026-08-01)「性格をREAD限定にする」に
	// よりA-7の判断を撤回した。要素自体がLeftPanel.astro側で読み取り専用の<span>になり
	// changeイベントを発火しないため、このハンドラごと削除する。性格の変更手段は
	// ▲/▼ボタン(上のnature-up-{key}/nature-down-{key}クリックハンドラ)のみに戻る。

	// UI刷新: 努力値の各スライダーを数値入力とペアリングする。
	for (const k of STAT_KEYS) {
		pairEvSlider(`ev-${k}`, `ev-${k}-range`, () => {
			scheduleSave();
			void recalcStats();
			schedulePopularBuildSuggestionsReload();
		});
	}
	// 端点ボタンは値を直接保存せず、既存rangeのinputハンドラへ流して全ての副作用を揃える。
	for (const button of document.querySelectorAll<HTMLButtonElement>(".stat-ev-endpoint-button")) {
		button.addEventListener("click", () => {
			const rangeInput = document.getElementById(button.dataset.evTarget ?? "") as HTMLInputElement | null;
			if (!rangeInput) return;
			rangeInput.value = button.dataset.evEndpoint === "max" ? rangeInput.max : rangeInput.min;
			rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	deleteButton.addEventListener("click", () => {
		void (async () => {
			if (!window.confirm("この個体を削除します。よろしいですか?")) return;
			deleteButton.disabled = true;
			try {
				const res = await fetch(`/api/owned-pokemon/${encodeURIComponent(ownedPokemonId)}`, {
					method: "DELETE",
					credentials: "same-origin",
				});
				if (!res.ok) throw new Error(`削除に失敗しました (status=${res.status})`);
				window.location.href = "/box";
			} catch (err) {
				console.error(err);
				window.alert("削除に失敗しました。時間をおいて再度お試しください。");
				deleteButton.disabled = false;
			}
		})();
	});

	// 匿名集計サジェスト機能・第4段階(UI: データ提供トグル)。この個体を性格/アイテム/テラス/
	// 技の匿名集計対象から除外する。PATCH /api/owned-pokemon/:id に { collection_opt_out: boolean }
	// を送るだけの軽量経路(is_pinnedのPATCHと同じパターン、上のdeleteButton同様ownedPokemonIdを
	// 使う)で、フォーム全体の自動保存(saveNow/scheduleSave、デバウンス付きPUT)とは完全に別経路
	// ——チェックのたびに即座に送信し、PUTのpayload(buildPayload)には一切含めない。
	//
	// UI改修依頼(個体編集ヘッダー)により、チェックの意味を「拒否」(true=拒否)から
	// 「匿名でデータ提供する」(true=提供)へ反転させた。UIのcheckedはずっと「提供する」側の
	// 意味のまま保ち、サーバーへ送るcollection_opt_out(true=拒否)はその論理否定を送る。
	//
	// 🔴 UI改修依頼(2026-08-01)でラベルを「非公開」に変え、**もう一度**意味を反転させた。
	// checked の意味は「提供する」から「非公開(=収集拒否)」へ戻り、既定はOFF(=提供する)。
	// そのため送信値は論理否定ではなく checked そのものになる。
	// ⚠ この行の否定を外し忘れると、UIの表示は新しい意味なのに送信値だけ旧ロジックのまま
	// になり、「非公開ON」で collection_opt_out:false(=収集対象のまま)が送られる。
	// 実際にヘッダー担当が実機で踏んで報告した(表示は正しいのにDBが逆になる)。
	// DBの意味(collection_opt_out_until: NULL/過去=収集対象、未来=拒否期間中)は不変。
	// あわせて「あとN日」のカウントダウン表示(旧renderOptOutStatus)は撤去し、30日で自動的に
	// 解除される旨はラベルのtitle属性(box/[id].astro側の静的な説明文)でホバー説明に一本化した。
	// このステータス要素はPATCH失敗時のエラーメッセージ表示にのみ引き続き使う。
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

	// 個体の公開共有トグル(PUT /api/owned-pokemon/:id/share)のUIは要件により廃止した。
	// APIと公開ページ(/share/[slug])自体は残っているので、UIを再び付けたくなった場合は
	// git履歴のこの位置にあった renderShareStatus / is-public チェックボックスの実装を参照すること。

	// ============================================================
	// UI改修依頼(個体編集画面、2026-08-03)「耐久指数最大化」ボタンの配線
	// ============================================================
	// マークアップ(LeftPanel.astro)・計算(durability-index.ts)・一覧表示(right-panel.tsの
	// renderCandidateList、耐久調整ポップアップと共用)はいずれも実装済み。ここでは
	// (1)ボタン押下→現在の種族値・努力値・性格から総合/物理/特殊3指数それぞれのbestを求めて
	// 右パネルへ一覧表示(この時点では左パネルは変更しない)、(2)一覧クリックでその配分を
	// 左パネルへ適用、の2つを配線する。
	//
	// ⚠️ 努力値の書き換えは.valueへの代入だけではinput/changeどちらのイベントも発火せず、
	// 再計算(recalcStats)も自動保存(scheduleSave、textInputIds経由)も走らない
	// (このファイル上部、textInputIds/statAffectingIdsの設定箇所参照)。同じファイル内の
	// bulk-adjust.ts(耐久調整ポップアップ、編集禁止ファイル)のapplyEvToLeftPanelと
	// 完全に同じ手順(値を代入したうえでinput/changeの両方をbubbles:trueで発火)を踏む。
	// 性格はここでは変更しない(耐久指数の最大化はH/B/Dの努力値配分のみが対象で、
	// 性格は現在の値のまま使う。durability-index.ts参照)。
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

	// 指数の値の表示桁: total(総合耐久指数)はH*B*D/(B+D)で割り切れないことが多いため
	// 小数2桁に丸める。physical/special(H*B・H*D)は実数値同士の掛け算で必ず整数になる。
	function formatDurabilityIndexValue(kind: DurabilityIndexKind, value: number): string {
		return kind === "total" ? value.toFixed(2) : String(Math.round(value));
	}

	// UI改修依頼(個体編集画面、2026-08-03)旧「耐久調整」3ボタン(H/B/D個別)を単一の
	// 「耐久指数最大化」ボタンへ統合。押下時に総合/物理/特殊の3指数をまとめて計算し、
	// 右パネルへ3件同時表示する(切り替えボタンは無し)。旧実装と異なり、ボタン押下だけでは
	// 左パネルを更新しない(3件を表示するだけ)。一覧内の候補をクリックしたときだけ、その
	// 候補のH/B/D配分を左パネルへ適用する。
	const DURABILITY_INDEX_KINDS: { kind: DurabilityIndexKind; heading: string }[] = [
		{ kind: "total", heading: "総合耐久指数(H×B×D÷(B+D))" },
		{ kind: "physical", heading: "物理耐久指数(H×B)" },
		{ kind: "special", heading: "特殊耐久指数(H×D)" },
	];

	// UI改修依頼(個体編集画面、2026-08-04)「耐久調整/耐久最大化 カードデザイン統一」により、
	// 表示をright-panel.tsの新API renderDurabilityIndexResults()(統一カード、依頼4〜6)へ
	// 差し替えた(コーディネーター許可、この関数の呼び出し部分のみ変更)。旧実装は候補クリック
	// のたびにmaximizeDurabilityIndex()を再計算していた(適用後は現在のH/B/Dが変わり、
	// 残り予算・bestが変わり得るため)。renderDurabilityIndexResults()はこの「今の状態で
	// 計算し直す」処理そのものをbuildGroups/getCurrentEvsという関数として受け取り、内部の
	// 再描画(候補クリック後を含む)のたびに呼び直す設計にしたため、計算ロジック
	// (maximizeDurabilityIndex呼び出し・DURABILITY_INDEX_KINDS・baseStats/natureの扱い)は
	// このファイル側にそのまま残る。
	async function runDurabilityIndexMaximize(): Promise<void> {
		const name = speciesInput.value.trim();
		if (!name) return; // ボタンは種族名が空のときdisabledのはずだが、念のための防御
		const base = (await baseStatsMapPromise).get(name);
		if (!base) return;
		const { renderDurabilityIndexResults, openDetailPanelOverlayIfNarrow } = await loadRightPanel();
		const nature = currentLeftNature();

		renderDurabilityIndexResults(
			() =>
				DURABILITY_INDEX_KINDS.map(({ kind, heading }) => ({
					kind,
					heading,
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

	// ============================================================
	// UI改善ラウンド37(37-1〜37-3): 技選択の専用ウィンドウ
	// ============================================================
	// 技入力欄(#move-1〜#move-4)は普通のリストボックス(<input list="move-list">、
	// setupDatalistRefocus参照)のままだと、タイプ/分類/PPで絞り込んだりソートしたり
	// できない。4スロット共有の1ウィンドウ・インスタンスを作り、「どのスロットに
	// 入力中か」をactiveSlotという内部状態で管理する(RightPanel.astroの詳細設定
	// サイドバーが「選択中の技列」を切り替えて表示するのと同じ考え方、round-37.md参照)。
	// 既存のdatalist挙動(直接タイプでの絞り込み・再クリック時フィルタ対策)は
	// setupDatalistRefocusのまま一切変更しない。このウィンドウは追加の選択手段。
	setupMovePickerWindow(speciesInput);

	// ============================================================
	// UI改善ラウンド38(38-L1): 技1〜4のドラッグ&ドロップ並び替え
	// ============================================================
	setupMoveReorderDrag();
}

// UI改善ラウンド38ユーザー指示(38-L1)「技の順番をドラッグアンドドロップで入れ替えられる
// ようにしたい」への対応。
//
// 設計方針: #move-1〜#move-4のDOM位置・id自体は一切動かさない。代わりに、ドラッグ&ドロップの
// 結果として4つの入力欄の「値」を並べ替える。理由は、この4つのidに依存する既存ロジックが
// 複数あり、DOM位置を動かす実装だとそれらとの整合を都度取り直す必要が出るため:
//   - setupMovePickerWindow()のactiveSlot(上記参照)は`move-${activeSlot}`というidで
//     document.getElementByIdを都度呼ぶ設計(DOM位置に依存しない)。値スワップ方式なら
//     このロジックには一切手を入れずに済む(ドラッグ後も「今開いているウィンドウがどの
//     スロット向けか」の対応関係が崩れない)。
//   - setupDatalistRefocus・updateMoveTypeIcon・textInputIds(自動保存)はいずれも
//     document.getElementById("move-N")で固定id参照するため、DOM位置が変わっても
//     動作自体は変わらないが、値スワップ方式ならそもそも影響が及ばない。
//   - readMoveNames()(owned-pokemon-form.ts)はmove-1→move-4の順でidを読んで
//     move_names配列を作る。DOM位置ではなくid順で読むため、値スワップ方式が
//     「画面上の並び=保存される並び」を保証するのに最も直接的。
//
// ドラッグの実装はHTML5 Drag and Drop API(dragstart/dragover/drop)ではなく、
// mousedown/mousemove/mouseupの手実装にした。ネイティブDnD APIはブラウザ間の実装差・
// dataTransferのセキュリティ制約があり、Playwrightでの自動テスト時にdragstart/drop相当の
// イベントを安定して発火させるにはpage.mouse.down/move/upで十分な素朴な実装の方が検証しやすい
// (mousedown/mousemove/mouseupは通常のマウス操作そのものであり、Playwrightのmouse APIが
// そのままdispatchする)。
//
// ハンドル(.move-drag-handle)は入力欄の兄弟要素(input自体ではない)。#move-N入力欄自体には
// 一切リスナーを追加しないため、ラウンド37の技選択ウィンドウ(input.mousedown→openPicker)や
// setupDatalistRefocus(input.mousedown→openWithFullList)の挙動と競合しない。
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

	// 🔴 UI改修依頼(個体編集左パネル、2026-08-01)「サジェストはリストボックスの候補に反映し、
	// 人気順に並び替えたり作用率を併記したりする」により、"popularity"(人気、種族ごとの
	// popular_move サジェストのratio)を並び替え可能な列として追加する。既存の6キーと同じ
	// makeSortButton/comparatorの仕組みに合流させることで、「初期表示は人気順、ユーザーが
	// 別の列ヘッダをクリックしたらそちらが優先される」を新しい分岐追加なしに実現する
	// (sortKeyは開いた後もモジュール外へリセットされない永続状態のため、一度でも
	// ヘッダをクリックすればそれ以降は常にユーザーの選択が優先される)。
	type SortKey = "popularity" | "name" | "type" | "category" | "power" | "accuracy" | "pp";
	type SortDir = "asc" | "desc";

	const CATEGORY_LABELS: Record<MoveCategory, string> = { physical: "物理", special: "特殊", status: "変化" };
	// タイプ/分類は「文字列/カテゴリ順で構わない」(round-37.md 37-3)。物理→特殊→変化の
	// 慣習的な並びをランクで表現する(アルファベット順だと直感に反するため)。
	const CATEGORY_RANK: Record<MoveCategory, number> = { physical: 0, special: 1, status: 2 };

	let activeSlot: number | null = null;
	let learnsetOnly = true; // 37-2: 既定ON
	// 初期表示は人気順(sortDir="desc"=ratio降順)。ユーザーがどれかの列ヘッダを1回でも
	// クリックした時点でこの初期値は上書きされ、以後はユーザーの選択がそのまま残り続ける
	// (このウィンドウはページ内で使い回されるシングルトンで、開閉のたびにリセットしない)。
	let sortKey: SortKey = "popularity";
	let sortDir: SortDir = "desc";
	const filters = { name: "", type: "", category: "" };

	let allMoves: MoveDetail[] = [];
	let allMovesReady = false;
	let currentPool: MoveDetail[] = [];

	// --- DOM構築(1回だけ。document.body直下にappendする理由は
	//     LeftPanel.astro側の<style is:global>直前コメント参照) ---
	const windowEl = document.createElement("div");
	windowEl.id = "move-picker-window";
	windowEl.className = "move-picker-window";
	windowEl.hidden = true;
	windowEl.setAttribute("role", "dialog");
	windowEl.setAttribute("aria-label", "技を選択");

	const headerEl = document.createElement("div");
	headerEl.className = "move-picker-header";
	const titleEl = document.createElement("span");
	titleEl.className = "move-picker-title";
	titleEl.textContent = "技を選択";
	headerEl.appendChild(titleEl);

	// UI改善ラウンド41ユーザー指示(41-L4)。
	// 1. 文言修正: 「覚える技だけ表示する」→「覚える技のみ表示」。
	// 2. 見た目をチェックボックスからトグルスイッチに変更する(このプロジェクトに既存の
	//    toggle/switch規格が無いことをgrepで確認済み。LeftPanel.astro側の<style is:global>に
	//    汎用の.toggle-switch一式を新規に作った)。<input type="checkbox">自体は
	//    visually-hidden化するだけで、checked状態・change イベント・aria-labelは
	//    一切変えない(下のtoggleInput参照はこれまでどおり)。
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
	headerEl.appendChild(toggleLabel);

	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "move-picker-close";
	closeButton.setAttribute("aria-label", "技選択ウィンドウを閉じる");
	closeButton.textContent = "×";
	headerEl.appendChild(closeButton);

	windowEl.appendChild(headerEl);

	const noteEl = document.createElement("p");
	noteEl.className = "move-picker-note";
	noteEl.hidden = true;
	windowEl.appendChild(noteEl);

	const tableWrap = document.createElement("div");
	tableWrap.className = "move-picker-table-wrap";
	const table = document.createElement("table");
	table.className = "move-picker-table";
	const thead = document.createElement("thead");
	const headerRow = document.createElement("tr");

	function makeSortButton(label: string, key: SortKey): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "move-picker-sort-btn";
		btn.dataset.sortKey = key;
		btn.textContent = label;
		btn.addEventListener("click", () => {
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
		top.appendChild(makeSortButton(label, key));
		th.appendChild(top);
		if (filterEl) {
			const filterWrap = document.createElement("div");
			filterWrap.className = "move-picker-th-filter";
			filterWrap.appendChild(filterEl);
			th.appendChild(filterWrap);
		}
		return th;
	}

	const nameFilterInput = document.createElement("input");
	nameFilterInput.type = "text";
	nameFilterInput.placeholder = "技名で絞り込み";
	nameFilterInput.setAttribute("aria-label", "技名で絞り込み");
	nameFilterInput.addEventListener("input", () => {
		filters.name = nameFilterInput.value.trim();
		renderRows();
	});

	const typeFilterSelect = document.createElement("select");
	typeFilterSelect.setAttribute("aria-label", "タイプで絞り込み");
	typeFilterSelect.addEventListener("change", () => {
		filters.type = typeFilterSelect.value;
		renderRows();
	});

	const categoryFilterSelect = document.createElement("select");
	categoryFilterSelect.setAttribute("aria-label", "分類で絞り込み");
	for (const [value, label] of [
		["", "すべて"],
		["physical", "物理"],
		["special", "特殊"],
		["status", "変化"],
	] as const) {
		const opt = document.createElement("option");
		opt.value = value;
		opt.textContent = label;
		categoryFilterSelect.appendChild(opt);
	}
	categoryFilterSelect.addEventListener("change", () => {
		filters.category = categoryFilterSelect.value;
		renderRows();
	});

	headerRow.appendChild(makeHeaderCell("技名", "name", nameFilterInput));
	// 匿名集計サジェスト機能: 「人気」列(種族ごとのpopular_moveサジェスト、作用率%を表示)。
	// 既存の並び替え可能な列と同じ仕組み(makeSortButton/makeHeaderCell)に合流させる
	// (絞り込みフィルタは無いのでfilterElはnull、威力/命中/PPと同じ扱い)。
	headerRow.appendChild(makeHeaderCell("人気", "popularity", null));
	headerRow.appendChild(makeHeaderCell("タイプ", "type", typeFilterSelect));
	headerRow.appendChild(makeHeaderCell("分類", "category", categoryFilterSelect));
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
	emptyMessageEl.textContent = "該当する技がありません。";
	emptyMessageEl.hidden = true;
	windowEl.appendChild(emptyMessageEl);

	// 37-1: LeftPanel.astro側の<style is:global>直前コメントで詳述した実測結果により、
	// z-index:-1ではなくauto(position:fixedのみ)を使う。このウィンドウをbodyの
	// 「先頭の子」として挿入することで、box/[id].astroがSSRで描画する`.card-damage`
	// (position:relative、同じCSS区分(6))よりも必ずDOM順で先(=同区分内比較で背面)になる。
	document.body.insertBefore(windowEl, document.body.firstChild);

	function updateSortButtonIndicators(): void {
		for (const btn of Array.from(table.querySelectorAll<HTMLButtonElement>(".move-picker-sort-btn"))) {
			const key = btn.dataset.sortKey as SortKey;
			btn.classList.toggle("is-active", key === sortKey);
			btn.dataset.sortDir = key === sortKey ? sortDir : "";
		}
	}

	function populateTypeFilterOptions(): void {
		const types = Array.from(new Set(allMoves.map((m) => m.type).filter((t): t is string => !!t))).sort((a, b) =>
			a.localeCompare(b, "ja"),
		);
		const previousValue = typeFilterSelect.value;
		typeFilterSelect.innerHTML = "";
		const allOpt = document.createElement("option");
		allOpt.value = "";
		allOpt.textContent = "すべて";
		typeFilterSelect.appendChild(allOpt);
		for (const t of types) {
			const opt = document.createElement("option");
			opt.value = t;
			opt.textContent = t;
			typeFilterSelect.appendChild(opt);
		}
		if (types.includes(previousValue)) typeFilterSelect.value = previousValue;
	}

	async function ensureAllMovesLoaded(): Promise<void> {
		if (allMovesReady) return;
		const map = await loadMoveDetailMap();
		allMoves = [...map.values()];
		allMovesReady = true;
		populateTypeFilterOptions();
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

	// 種族の覚え技(learnsetMapPromiseはこのファイル上部で既にモジュールスコープ定義済み、
	// rebuildMoveListForSpeciesと共用)でプールを絞り込む。種族未選択/該当なしのときは
	// クラッシュせず全件表示にフォールバックする(round-37.md 37-2の要件どおり)。
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
		if (filters.name && !m.name.includes(filters.name)) return false;
		if (filters.type && m.type !== filters.type) return false;
		if (filters.category && m.category !== filters.category) return false;
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
		for (const el2 of Array.from(tbody.querySelectorAll(".move-picker-row.is-selected"))) {
			el2.classList.remove("is-selected");
		}
		const row = tbody.querySelector<HTMLElement>(`[data-move-name="${CSS.escape(move.name)}"]`);
		row?.classList.add("is-selected");
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
				typeTd.appendChild(document.createTextNode(m.type));
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
		tableWrap.hidden = isEmpty;
	}

	// 🔴 UI改善ラウンド38(round-37.mdの「実装中に見つかったバグ」節への対応)。
	// 37-1時点の実装は「.panel-leftの右端に外付け」(left = anchorRect.right + gap)
	// だったが、これは.edit-layout-right(ダメージカード列)の真上に重なる位置になる。
	// 実測(Playwright、フィクスチャc8680844-...・ダメージカード4枚、ビューポート1920x1080)で
	// 判明した実際のジオメトリ:
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
	// 一方.card-damage(レイヤー6)とはDOM順のタイブレークになるため、37-1の設計どおり
	// このウィンドウをdocument.bodyの先頭子として挿入していることで、重なる部分は
	// 引き続きカードが前面になる。.damage-detail-panel/.app-sidebarはレイヤー7(正のz-index)
	// で常に最前面のため、この2つの矩形とだけは重ねてはいけない(重ねてもウィンドウ側が
	// 常に埋もれて一切操作できなくなるだけで、「一部は操作できる」にすらならない)。
	//
	// 上記の理由により、右へ外付けする37-1時点の設計を撤回し、.panel-left自身の列
	// (position:staticなので重ねてもこのウィンドウが前面になる)に重ねる形へ変更する。
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
	// 縦位置(top)は37-1時点の「今フォーカスしている技入力欄の上端」から変更した。
	// .panel-leftへ重ねる方式にしたことで新たに実測で見つかった罠: .panel-left内は
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
	// 追随できるようにするため)。 */
	// UI改修依頼(個体編集左パネル)「技選択テーブルは左パネルの右側に併設する」により、
	// ラウンド38の「.panel-left自体に重ねる」設計から「.panel-leftの右側に外付けする」
	// (ラウンド37-1と同じ水平配置)へ戻す。ラウンド38で問題になった「ダメージカード列に
	// 重なると背面に埋もれて操作不能になる」点は、今回`.move-picker-window`にz-index:10を
	// 明示指定したことで解消済み(このファイル冒頭のCSSコメント参照。`.card-damage`
	// (position:relative・z-index:auto)に確実に勝つ)。
	// ただし900〜1199px幅(1200px未満)は.edit-layoutが2カラムグリッド化されず.panel-leftが
	// 全幅ブロックになるため、右側に外付けする余地(最低320px)が無い。この場合はラウンド38の
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
		// UI改善ラウンド40ユーザー指示(40-L3-2)追記、ラウンド41ユーザー指示(41-L2)で根本原因を
		// 特定・是正済み: 性格補正の上下ボタン(.stat-nature-up/.stat-nature-down、
		// stat-tableの各行)がこのウィンドウより手前に表示されるバグがあった。
		// 【根本原因(41-L2で特定)】ボタン自身・祖先はすべてposition:static・z-index:auto・
		// transform/opacity/willChange/contain/isolationいずれも既定値だったが、押下時
		// (aria-pressed="true")の縁取り表現にfilter: drop-shadow(...)を::beforeへ適用して
		// いた。filterはスタッキングコンテキストを生成するプロパティで、実測(Playwright、
		// document.elementFromPoint)したところ、この::beforeのfilterが**ホスト要素
		// (.stat-nature-btn自身)を暗黙にスタッキングコンテキスト化**しており、非押下時
		// (filterなし)は正しくこのウィンドウが手前に来る一方、押下時だけボタンが
		// 「position指定+z-index:auto」と同じレイヤーに昇格してDOM順のタイブレークで
		// 勝ってしまっていた(このウィンドウはdocument.bodyの先頭子=DOM順で先のため、
		// 同レイヤーの要素には後から現れるものが勝つ)。
		// 【是正】LeftPanel.astro側の.stat-nature-btnの縁取りを、filterを使わない
		// 「二重三角形(::before=一回り大きい縁取り色、::after=現在サイズの塗り色、
		// grid-area:1/1で重ねる)」方式に置き換え、スタッキングコンテキストを生成する
		// プロパティを一切使わないようにした(LeftPanel.astroの.stat-nature-btn CSSコメント
		// 参照)。これによりこのウィンドウは常にこのボタンより手前になるため、このバグ自体は
		// 解消済みだが、このスキャンロジック(reposition()が性格補正ボタンの下端も座標回避の
		// 対象に含める処理)自体は「重ならない方が見た目に自然」という理由で無害なため残す
		// (41-L2要件「座標のずらしは残してよい」より)。将来また同種の「filterや
		// transform等を::before/::afterに使う新要素」を追加する際は、同じ罠(ホスト要素が
		// 暗黙にスタッキングコンテキスト化する)を踏まないよう、position/z-index/filter/
		// transform/opacity/will-change/contain/isolationのいずれも使わない実装を優先すること。
		if (!canDockRight) {
			for (const el of Array.from(anchor.querySelectorAll<HTMLElement>(".stat-nature-up, .stat-nature-down"))) {
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

	function openPicker(slot: number, inputEl: HTMLInputElement): void {
		// 幅の狭い画面(デスクトップ2カラム構成が成立しない1200px未満相当)では
		// 「左パネルの右側に外付け」という前提が成立しない。この場合は開かず、
		// 既存のdatalist(直接タイプ)による絞り込みだけを使ってもらう(壊さない)。
		if (window.innerWidth < 900) return;
		activeSlot = slot;
		titleEl.textContent = `技${slot}を選択`;
		windowEl.hidden = false;
		reposition(inputEl);
		window.addEventListener("resize", onScrollOrResize);
		window.addEventListener("scroll", onScrollOrResize, true);
		void refreshPool();
	}

	function closePicker(): void {
		windowEl.hidden = true;
		window.removeEventListener("resize", onScrollOrResize);
		window.removeEventListener("scroll", onScrollOrResize, true);
	}

	closeButton.addEventListener("click", closePicker);
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

	// 匿名集計サジェスト機能: 種族変更に伴いloadPopularBuildSuggestionsがlastMoveSuggestionを
	// 更新したとき、このウィンドウが開いていれば「人気」列・並び順を最新化する
	// (refreshPool自体は別経路(speciesInputのinputイベント)で覚え技プールの絞り込みを
	// 追随させているが、サジェスト取得は独立した非同期fetchのため別途フックが要る)。
	onMoveSuggestionUpdated = () => {
		if (!windowEl.hidden) renderRows();
	};

	updateSortButtonIndicators();
}
