// box/[id].astro 構造分割ラウンド(フェーズ1)。
//
// このファイルは docs/plan/ui_parallelization.md 4.2節が「共有コア(2領域以上から呼ばれる)」と
// 分類した17関数を、元の box/[id].astro の <script> から定義位置のまま(ロジックは一切変更せず)
// 集約して export したものです。左サイド(left-panel.ts)・ダメージ計算/右サイド(box/[id].astro に
// 残置)の両方からこのファイルを import して呼び出します。
//
// 17関数: scheduleRowSave / scheduleRowCalc / refreshRowConditionChips / renderDetailPanel /
// selectColumn / applySelectionMarks / applySprite / applyTeraImage / applyItemImage /
// resolveMegaStoneItem / flashAutofillHint / natureNameFromBoosts / normalizedNatureBoosts /
// nextNatureBoosts / buildAttackerSpec / recalcStats
//
// ⚠️ 設計メモ(状態の所有権について、コーディネーターへの報告事項):
// 元のコードでは3領域(左サイド/ダメージ計算/右サイド)が1つのクロージャスコープを共有していた
// ため、上記17関数の中には「同じスコープの兄弟関数」を直接呼んでいるものがある
// (例: scheduleRowSave → setRowSaveStatus/saveRow、renderDetailPanel → renderDetailPanelEmpty/
// renderColumnLevelDetailPanel、selectColumn → openDetailPanelOverlayIfNarrow、buildAttackerSpec/
// recalcStats → 左パネルの leftNatureUp/leftNatureDown・renderStatsUnavailable・updateEvRemaining)。
// これらの兄弟関数は「ダメージ計算専用54個」「右サイド専用16個」「左サイド専用22個」のいずれかに
// 分類され、今回のスコープ(左サイド+共有コアのみ)では移動しない(box/[id].astro に残る)。
// そのため、このファイル単体では兄弟関数を直接 import できない(box/[id].astro のインライン
// <script> は他ファイルから import 可能なモジュールではないため)。
//
// これを解決するため、「登録(register)」パターンを採用した:
// - 左サイド(left-panel.ts)は起動時に registerLeftPanelBridge() を1回呼び、
//   buildAttackerSpec/recalcStats が必要とする左パネル側の値・関数を渡す。
// - ダメージ計算/右サイド(box/[id].astro)は #opponent-notes-section の初期化直後に
//   registerDamageCalcBridge() を1回呼び、scheduleRowSave/scheduleRowCalc/refreshRowConditionChips/
//   renderDetailPanel/selectColumn が必要とする関数を渡す。
// 呼び出し側(scheduleRowSave(row) 等)の呼び方は一切変えていない。ブリッジ経由になったのは
// 「関数内部が兄弟関数を呼ぶ箇所」だけで、これは今回のファイル分割そのものが要求する
// 必要最小限の機械的な変更(ロジックの変更ではなく、クロージャ参照→ブリッジ参照への置換)。
//
// selectedRow/selectedColumn(現在選択中の技列を指すポインタ)も同じ理由でこのファイルに
// 移した。ダメージ計算側の renderColumns/renderColumnLevelDetailPanel、右サイドの
// deselectRowIfCurrent がこの状態を直接読み書きしていたため、box/[id].astro 側では
// getSelectedRow/getSelectedColumn/clearSelection という3つの小さなアクセサ経由に書き換えている
// (この3箇所は「今回は触らない」ダメージ計算/右サイドへの必要最小限の機械的な例外。
// 詳細はコーディネーターへの報告を参照)。

import { el, readEv, readMoveNames } from "../owned-pokemon-form";
import type { PokemonSpec, SequenceAttack } from "../pyodide-engine";
import {
	loadImageIdMap,
	loadBaseStatsMap,
	loadMegaStoneMap,
	officialArtworkUrl,
} from "../pokemon-master-data";
import { loadItemSpriteMap, itemIconUrl, teraTypeIconUrl } from "../sprite-urls";
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from "../type-colors";
import { type StatKey, STAT_KEYS, NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat } from "../stats";
import type { OpponentClientResultInput } from "../opponent-notes-validation";
import { kanaIncludes } from "../kana";

// [min, max]の範囲外の値を、範囲の反対側から続くように循環(モジュロ演算)させる。
// 例: min=0,max=32のとき 33→0、-1→32、50→17(50 mod 33)。育成ルールの範囲自体
// (min/max引数)は呼び出し側がそのまま渡すだけで、この関数は「範囲を超えたときの
// 挙動」だけを変える(上下限の値自体は変更しない)。左パネル・ダメージ計算カード双方の
// 努力値スピンボックスから共有して使う。
export function wrapToRange(value: number, min: number, max: number): number {
	const size = max - min + 1;
	return (((value - min) % size) + size) % size + min;
}

// --- ダメージ計算の行/列の状態(元は #opponent-notes-section ブロック内で定義されていた
//     DamageColumnState/DamageRowState インターフェース。共有コア関数の引数・戻り値の型として
//     必要なため、このファイルへ移し左サイド/box側の双方から type import する)。
//     フィールドの中身は一切変更していない。 ---

export interface DamageColumnState {
	moveName: string;
	hitCount: number;
	critical: boolean;
	weather: string;
	terrain: string;
	wallEnabled: boolean;
	stealthRock: boolean;
	// みみっきゅの「ばけのかわ」が最初の1発で消費済みという想定で、防御側の初期HPを最大HPの
	// 1/8減らした状態で計算するか。jpokeのアビリティ機構とは独立実装(pyodide-engine.ts参照)。
	defenderDisguiseBroken: boolean;
	spikes: number;
	defenderSideFields: string[];
	attackerRank: number;
	defenderRank: number;
	attackerBoosts: number[];
	attackerAilment: string;
	attackerTerastallized: boolean;
	// 技カードごとに、育成タブで確定した本来のテラスタイプ(#tera/DBのtera_type)とは別の
	// 仮想テラスタイプを試すための上書き値。空文字列は「上書きなし(本来のテラスタイプを使う)」
	// を意味する(src/lib/opponent-notes-validation.tsの同名フィールドと同じ方針)。
	attackerTeraType: string;
	attackerVolatiles: string[];
	defenderBoosts: number[];
	defenderAilment: string;
	defenderTerastallized: boolean;
	defenderTeraType: string;
	defenderVolatiles: string[];
}

export interface DamageRowState {
	id: string | null;
	direction: "attack" | "defense";
	name: string;
	nature: string;
	natureUp: StatKey | null;
	natureDown: StatKey | null;
	abilityName: string;
	itemName: string;
	teraType: string;
	evs: number[];
	seedRaw: string;
	attacks: DamageColumnState[];
	memo: string;
	clientResult: OpponentClientResultInput | null;
	root: HTMLElement | null;
	columnsEl: HTMLElement | null;
	addColumnSlotEl: HTMLElement | null;
	columnResultEls: HTMLElement[];
	columnChipEls: HTMLElement[];
	totalResultEl: HTMLElement | null;
	totalBlockEl: HTMLElement | null;
	saveStatusEl: HTMLElement | null;
	retryButtonEl: HTMLButtonElement | null;
	footerEl: HTMLElement | null;
	statValueEls: Partial<Record<string, HTMLElement>>;
	natureColLabelEls: Partial<Record<string, HTMLElement>>;
	saveTimer: ReturnType<typeof setTimeout> | null;
	calcTimer: ReturnType<typeof setTimeout> | null;
	saving: boolean;
	pendingSave: boolean;
}

// ネイティブdatalistの絞り込み条件は差し替えられないため、末尾入力時だけ候補側の表記へ寄せる。
export function attachKanaTypeAhead(input: HTMLInputElement, datalist: HTMLDataListElement): void {
	let composing = false;
	function evaluate(): void {
		const value = input.value;
		if (!value || input.selectionStart !== value.length) return;
		const options = Array.from(datalist.options, (option) => option.value);
		if (options.some((candidate) => candidate.includes(value))) return;
		const candidate = options.find((option) => kanaIncludes(option, value));
		if (!candidate) return;
		input.value = candidate.slice(0, value.length);
		input.setSelectionRange(input.value.length, input.value.length);
	}
	input.addEventListener("compositionstart", () => { composing = true; });
	input.addEventListener("compositionend", () => { composing = false; evaluate(); });
	// captureで既存の保存・再計算より先に値を整え、イベントの再発火による二重実行を避ける。
	input.addEventListener("input", () => { if (!composing) evaluate(); }, { capture: true });
}

// --- 汎用ユーティリティ層(元は <script> 冒頭・if (form) より外側で定義)。
//     画像用データの一覧はページ表示直後に一度だけfetchしておき、以後は同じPromiseを使い回す。
//     imageIdMapPromise/itemSpriteMapPromise/megaStoneMapPromiseは共有コア関数(applySprite/
//     applyItemImage/resolveMegaStoneItem)だけが使うためこのファイルに集約する。
//     baseStatsMapPromiseは左サイド(applyBaseStats)・共有コア(recalcStats)・ダメージ計算
//     (recalcRowStatsOnly)の3箇所から使われるため、同じくここに集約し全箇所からimportする。 ---

export const imageIdMapPromise = loadImageIdMap();
export const baseStatsMapPromise = loadBaseStatsMap();
const itemSpriteMapPromise = loadItemSpriteMap();
const megaStoneMapPromise = loadMegaStoneMap();

// メガシンカ種族が確定したとき、対応するメガストーン名を返す(該当しなければnull)。
// ⚠️ loadMegaStoneMap()自体は「メガレックウザ」等メガストーン不要の種族を含まず、
// 「ニャオニクスナイト」のようにitems.json(=loadItemSpriteMap())に存在しない
// アイテム名も含みうる(jpoke側のMEGA_STONES逆引きがオス/メスで曖昧になり登録漏れ
// している既知の不整合、pokemon-master-data.tsのloadMegaStoneMapコメント参照)。
// 後者を弾かないと、持ち物画像が出ずダメージ計算にも反映されない「設定できるのに
// 効かない」UIになるため、items.jsonに実在するかを都度確認する(特定のアイテム名を
// ハードコードしない。将来jpoke側の不整合が直れば自動的に有効になる)。
export async function resolveMegaStoneItem(speciesName: string): Promise<string | null> {
	const trimmed = speciesName.trim();
	if (!trimmed) return null;
	const [megaStoneMap, itemSpriteMap] = await Promise.all([megaStoneMapPromise, itemSpriteMapPromise]);
	const stoneName = megaStoneMap.get(trimmed);
	if (!stoneName) return null;
	if (!itemSpriteMap.has(stoneName)) return null;
	return stoneName;
}

// メガストーンを自動設定したことが分かる一時的な手掛かり(黙って値が変わると混乱するため)。
// レイアウトを崩さないよう高さを取らないbox-shadowのみで表現し(is-autofilledクラス)、
// 約1.4秒後に自動で外す。titleも一時的に「自動設定」である旨を添え、消灯時にrevertTitleで
// 通常のtitle(値そのもの)へ戻す。
export function flashAutofillHint(inputEl: HTMLInputElement, revertTitle: () => void): void {
	inputEl.classList.add("is-autofilled");
	inputEl.title = `${inputEl.value}(メガシンカに伴い自動設定)`;
	window.setTimeout(() => {
		inputEl.classList.remove("is-autofilled");
		revertTitle();
	}, 1400);
}

// UI刷新: <img>に公式絵を表示する。Champions用スプライトは対応していない種族で404に
// なるため、育成画面では最初から全種族にある公式絵を使い、取得不能時だけ頭文字へ退避する。
export async function applySprite(
	imgEl: HTMLImageElement,
	fallbackEl: HTMLElement,
	name: string,
): Promise<void> {
	const imageId = name ? (await imageIdMapPromise).get(name) : undefined;
	if (imageId == null) {
		imgEl.style.display = "none";
		fallbackEl.style.display = "flex";
		fallbackEl.textContent = name ? name.charAt(0) : "?";
		return;
	}
	imgEl.onerror = () => {
		imgEl.style.display = "none";
		fallbackEl.style.display = "flex";
		fallbackEl.textContent = name.charAt(0);
	};
	imgEl.onload = () => {
		imgEl.style.display = "";
		fallbackEl.style.display = "none";
	};
	imgEl.src = officialArtworkUrl(imageId);
}

// UI刷新(Pokemon.png): テラスタイプ画像(select横)。呼び出し元は左パネルの読み取り専用画像
// (#top-block-tera-image)と右パネル相手ビルド行のrefreshTypeBadge()の2つで、どちらもこの
// 関数を経由するため、ここを直すだけで両方切り替わる。取得できない場合はTYPE_COLORSの
// 色ボックスにフォールバックする(「ステラ」も含めて既存のTYPE_COLORSに定義済み)。
// テラスタイプ未選択時は両方隠す。
// ⚠️ 専用アイコンは宝石型(ジグザグの尖った縁)の正方形画像なので、呼び出し先のCSSで
// border-radius: 50% による丸トリミングを絶対に掛けないこと(縁が削れる)。
export async function applyTeraImage(imgEl: HTMLImageElement, fallbackEl: HTMLElement, teraName: string): Promise<void> {
	// テラスタイプ名の文字は画像に含まれないため、alt/titleで
	// スクリーンリーダーとホバー両方にテラスタイプ名を伝える。
	imgEl.alt = teraName;
	imgEl.title = teraName;
	function showColorFallback(): void {
		imgEl.style.display = "none";
		if (!teraName) {
			fallbackEl.style.display = "none";
			return;
		}
		fallbackEl.style.display = "block";
		fallbackEl.style.backgroundColor = TYPE_COLORS[teraName] || DEFAULT_TYPE_COLOR;
	}
	const url = teraName ? teraTypeIconUrl(teraName) : null;
	if (!url) {
		showColorFallback();
		return;
	}
	imgEl.onerror = showColorFallback;
	imgEl.onload = () => {
		imgEl.style.display = "";
		fallbackEl.style.display = "none";
	};
	imgEl.src = url;
}

// UI刷新(Pokemon.png): アイテム画像。アイテム名が空/画像読み込み失敗時は画像を隠し、
// 既存のテキスト入力(#item)の表示に委ねる(色表現の代替が無いアイテムには専用
// フォールバックは設けない)。
export function applyItemImage(imgEl: HTMLImageElement, name: string): void {
	// バッジ(.damage-item-badge)が白丸+枠+影を持つように
	// なったため、画像だけを隠すと「空の白丸」が残る。画像の表示可否に合わせて
	// バッジごと隠す(/boxの.card-item-badgeと同じ方針)。
	// 左パネルの持ち物バッジは別クラス名(.item-image-badge、種族アイコンへ重ねる専用スタイル)
	// にしたため、この共通関数の closest() にも併記する(この関数は左パネル/相手ビルド両方から
	// 呼ばれる共有処理のため、新規に別関数を作らずセレクタを1つ足すだけにとどめる)。
	const badgeEl = imgEl.closest<HTMLElement>(".damage-item-badge, .item-image-badge");
	const hideBadge = (): void => {
		imgEl.style.display = "none";
		imgEl.removeAttribute("src");
		if (badgeEl) badgeEl.hidden = true;
	};
	const trimmed = name.trim();
	if (!trimmed) {
		hideBadge();
		return;
	}
	imgEl.onerror = hideBadge;
	imgEl.onload = () => {
		if (badgeEl) badgeEl.hidden = false;
		imgEl.style.display = "";
	};
	imgEl.src = itemIconUrl(trimmed);
}

// UI刷新: 性格による実数値の上昇/下降ステータスの判定テーブル
// (vendor/jpoke/src/jpoke/data/nature.py の NATURE_MODIFIER と同期させること。
// まじめ・すなお・てれや・がんばりや・きまぐれの5つは補正なし)。
// 能力値ラベルのクリックによる上昇/下降の指定(StatKey、HP以外)から性格名を逆算する。
// NATURE_STAT_MODIFIERS(nature.pyから
// 転記した正の対応表)を1回だけ反転してMapにしておく(25種の性格のうち、上昇/下降が
// ともに非nullで異なる20種だけが対象。まじめ・てれや・がんばりや・すなお・きまぐれの5つは
// 「無補正」という同じ意味なので反転せず、natureNameFromBoosts側でまとめて「まじめ」に
// 正規化する)。
const NATURE_NAME_BY_BOOSTS = new Map<string, string>();
for (const [name, mod] of Object.entries(NATURE_STAT_MODIFIERS)) {
	if (mod.up && mod.down && mod.up !== mod.down) {
		const key = `${mod.up}:${mod.down}`;
		if (!NATURE_NAME_BY_BOOSTS.has(key)) NATURE_NAME_BY_BOOSTS.set(key, name);
	}
}
// 上昇/下降(ともにHP以外、または両方null)から性格名を求める。要件:
// 「上昇と下降が同じ能力になる場合、および両方未選択の場合は無補正の性格(まじめ等)として
// 扱う」ため、up===down(理論上は起こらない設計だが防御的に)・どちらかnullの場合は
// 「まじめ」に正規化する(てれや/がんばりや/すなお/きまぐれも同じ無補正だが、代表として
// 「まじめ」を使う)。
export function natureNameFromBoosts(up: StatKey | null, down: StatKey | null): string {
	if (!up || !down || up === down) return "まじめ";
	return NATURE_NAME_BY_BOOSTS.get(`${up}:${down}`) ?? "まじめ";
}

// クリックで選択中の上昇/下降が「片方だけ選ばれている」不完全な状態(例: 上昇だけ
// クリック済みで下降が未選択)のとき、実際のゲームには存在しない組み合わせ(上昇だけで
// 下降が無い性格)になってしまう。保存時はnatureNameFromBoostsがこれを「まじめ」
// (無補正)に正規化するため、実数値のプレビュー計算・能力名ラベルの色付けも同じ正規化を
// 経由させないと「クリック直後は補正が掛かって見えるのに保存/再読込すると消える」という
// 表示と保存の不一致が起きる。両方が揃って初めて上昇/下降が反映される、という一貫した
// 体験にする。
export function normalizedNatureBoosts(up: StatKey | null, down: StatKey | null): { up: StatKey | null; down: StatKey | null } {
	const name = natureNameFromBoosts(up, down);
	return NATURE_STAT_MODIFIERS[name] ?? { up: null, down: null };
}

export { nextNatureBoosts, type NatureNeutralAssignment } from "../nature-toggle";

// --- 左パネル向けブリッジ(shared-core.ts → left-panel.ts の逆方向の依存を避けるため、
//     left-panel.ts が起動時にこの関数を1回呼び、buildAttackerSpec/recalcStatsが必要とする
//     値・関数を登録する)。 ---
export interface LeftPanelBridge {
	getLeftNatureBoosts: () => { up: StatKey | null; down: StatKey | null };
	renderStatsUnavailable: () => void;
	updateEvRemaining: () => void;
}
let leftPanelBridge: LeftPanelBridge | null = null;
export function registerLeftPanelBridge(bridge: LeftPanelBridge): void {
	leftPanelBridge = bridge;
}

// UI刷新: この個体の現在のフォーム入力値からPokemonSpecを組み立てる。実数値の常時表示
// (recalcStats)と、ダメージ計算カードの両方から参照する共通処理。
// extra: 呼び出し側の都合による拡張(ダメージ計算カードのランク補正/状態異常/テラスタル発動)。
export function buildAttackerSpec(extra?: Partial<PokemonSpec>): PokemonSpec {
	const { up, down } = leftPanelBridge!.getLeftNatureBoosts();
	return {
		name: el<HTMLInputElement>("species-name").value.trim(),
		nature: natureNameFromBoosts(up, down),
		abilityName: el<HTMLSelectElement>("ability").value.trim() || undefined,
		itemName: el<HTMLInputElement>("item").value.trim() || undefined,
		teraType: el<HTMLSelectElement>("tera").value || undefined,
		evs: STAT_KEYS.map((k) => readEv(k)),
		ivs: STAT_KEYS.map(() => 31),
		moveNames: readMoveNames(),
		...extra,
	};
}

export function hpBracketLabel(hp: number): string {
	const n = Math.round(hp / 16);
	const offset = hp - 16 * n;
	if (offset === 0) return "16n";
	return `16n${offset > 0 ? "+" : ""}${offset}`;
}

// 実数値の常時表示をPyodide(jpoke)の初期化完了に依存させると、CDNが不通のときに
// 左パネル・ダメージカードの実数値6個すべてが「(未計算)」のままになる。チャンピオンズ
// ルールはIV=31固定・レベル常時50なので、種族値データだけで実数値が出せる純JS計算
// (calcHpStat/calcOtherStat)を使う。
export async function recalcStats(): Promise<void> {
	leftPanelBridge!.updateEvRemaining();
	const name = el<HTMLInputElement>("species-name").value.trim();
	if (name === "") {
		leftPanelBridge!.renderStatsUnavailable();
		return;
	}
	const base = (await baseStatsMapPromise).get(name);
	if (!base) {
		leftPanelBridge!.renderStatsUnavailable();
		return;
	}
	const level = 50;
	// 性格<select>ではなく、クリックで選んだ
	// leftNatureUp/leftNatureDownを使う。ただし片方だけ選択中の不完全な状態は
	// normalizedNatureBoostsで「まじめ」(無補正)に正規化してから使う
	// (保存されるnatureと表示を一致させるため)。
	const { up, down } = leftPanelBridge!.getLeftNatureBoosts();
	const natureMod = normalizedNatureBoosts(up, down);
	STAT_KEYS.forEach((key, i) => {
		const valueEl = document.getElementById(`stat-${key}`);
		if (!valueEl) return;
		const iv = 31;
		const ev = readEv(key);
		const value = key === "hp"
			? calcHpStat(level, base[i], iv, ev)
			: calcOtherStat(level, base[i], iv, ev, natureMod.up === key ? 1.1 : natureMod.down === key ? 0.9 : 1.0);
		valueEl.textContent = String(value);
		if (key === "hp") {
			const indicatorEl = document.getElementById("hp-16n-indicator");
			if (indicatorEl) {
				indicatorEl.textContent = hpBracketLabel(value);
			}
		}
		if (natureMod.up === key) {
			valueEl.dataset.mod = "up";
		} else if (natureMod.down === key) {
			valueEl.dataset.mod = "down";
		} else {
			delete valueEl.dataset.mod;
		}
	});
}

// --- ダメージ計算/右サイド向けブリッジ(box/[id].astro が #opponent-notes-section の
//     初期化直後に1回呼び、scheduleRowSave/scheduleRowCalc/refreshRowConditionChips/
//     renderDetailPanel/selectColumn が必要とする関数を登録する)。 ---
export interface DamageCalcBridge {
	recalcRow: (row: DamageRowState) => Promise<void>;
	recalcAllRows: () => void;
	saveRow: (row: DamageRowState) => Promise<void>;
	setRowSaveStatus: (row: DamageRowState, state: string, text: string) => void;
	renderConditionChipsInto: (container: HTMLElement, attack: DamageColumnState, row: DamageRowState) => void;
	configureColumnMoveInput: (input: HTMLInputElement, row: DamageRowState, column: DamageColumnState) => void;
	getColumnMoveCandidates: (row: DamageRowState, column: DamageColumnState) => string[];
	getColumnMultiHitRange: (moveName: string) => Promise<[number, number] | undefined>;
	refreshColumnDisplay: (row: DamageRowState, column: DamageColumnState) => void;
	renderDetailPanelEmpty: () => void;
	renderColumnLevelDetailPanel: (row: DamageRowState, column: DamageColumnState) => void;
	renderBuildDetailPanel: (row: DamageRowState) => void;
	getBuildDetailForm: (row: DamageRowState) => HTMLElement | null;
	deleteRow: (row: DamageRowState) => Promise<void>;
	deleteColumn: (row: DamageRowState, column: DamageColumnState) => void;
	openDetailPanelOverlayIfNarrow: () => void;
}
let damageCalcBridge: DamageCalcBridge | null = null;
export function registerDamageCalcBridge(bridge: DamageCalcBridge): void {
	damageCalcBridge = bridge;
}

export function deleteDamageRow(row: DamageRowState): Promise<void> {
	return damageCalcBridge!.deleteRow(row);
}

export function deleteDamageColumn(row: DamageRowState, column: DamageColumnState): void {
	damageCalcBridge!.deleteColumn(row, column);
}

export function configureDamageColumnMoveInput(
	input: HTMLInputElement,
	row: DamageRowState,
	column: DamageColumnState,
): void {
	damageCalcBridge!.configureColumnMoveInput(input, row, column);
}

export function getDamageColumnMoveCandidates(row: DamageRowState, column: DamageColumnState): string[] {
	return damageCalcBridge!.getColumnMoveCandidates(row, column);
}

export function getDamageColumnMultiHitRange(moveName: string): Promise<[number, number] | undefined> {
	return damageCalcBridge!.getColumnMultiHitRange(moveName);
}

export function refreshDamageColumnDisplay(row: DamageRowState, column: DamageColumnState): void {
	damageCalcBridge!.refreshColumnDisplay(row, column);
}

export function getDamageBuildDetailForm(row: DamageRowState): HTMLElement | null {
	return damageCalcBridge!.getBuildDetailForm(row);
}

// 耐久調整ポップアップ(src/lib/box-id/bulk-adjust.ts 等)は「防御(相手→自分)方向の
// ダメージ計算カード」だけを圧縮表示し、その計算条件を使って性格+努力値の組み合わせを
// 探索する。上のDamageCalcBridgeと同じ登録(register)パターンで、damage-calc.ts側
// (#opponent-notes-sectionブロック内)からrow一覧・カードDOMへのアクセスを提供する
// ブリッジを追加する。
//
// ⚠️ getDefenseRowsが組み立てるattackerSpec/attacks/optionsは、recalcRow()が
// calcLethalSequence()を呼ぶ直前に組み立てているものと**寸分違わず同一の内部ヘルパー
// (damage-calc.ts側のbuildSequenceInputs)から導出される**。カードの確N表示(recalcRow)と
// 耐久調整の計算(このブリッジ)が別々のロジックから値を組み立てると、両者の結果が
// 食い違う(=表示は確1なのに耐久調整では耐えない、といった不整合)リスクがあるため、
// 「単一の実装から両方が導出される」ことを最重要要件として damage-calc.ts 側で
// 実装している(詳細はdamage-calc.tsのbuildSequenceInputsのコメント参照)。
export interface BulkAdjustRowSnapshot {
	/** 行の識別子(既存の row を一意に指せるもの)。 */
	id: string;
	/** 相手(攻撃側)の種族名。表示にも使う。 */
	name: string;
	/** 相手(攻撃側)の PokemonSpec。recalcRow が組み立てているものと同一(buildSequenceInputs経由)。 */
	attackerSpec: PokemonSpec;
	/** 技列。recalcRow の safeAttacks と同一(テラスタルのクランプ適用済み)。 */
	attacks: SequenceAttack[];
	/** 表示用の技名一覧(attacks と同じ順・同じ件数)。 */
	moveLabels: string[];
	/** recalcRow が options に渡しているシード(parseSeed(row.seedRaw) の結果)。 */
	seed?: number;
}

export interface BulkAdjustBridge {
	/** direction === "defense" のカードだけを、上記スナップショットにして返す(表示順を維持)。 */
	getDefenseRows: () => BulkAdjustRowSnapshot[];
	/**
	 * 指定した行のカードDOMを複製して返す。
	 * ポップアップ内に貼るための表示専用の複製。存在しない id なら null。
	 */
	buildCardPreview: (rowId: string) => HTMLElement | null;
}
// getBulkAdjustBridge()は既存のleftPanelBridge!/damageCalcBridge!のような非nullアサーションを
// 使わない(後続実装がボタンの有効/無効判定に使うため、未登録の可能性を型で表現する)。
let bulkAdjustBridge: BulkAdjustBridge | null = null;
export function registerBulkAdjustBridge(bridge: BulkAdjustBridge): void {
	bulkAdjustBridge = bridge;
}
export function getBulkAdjustBridge(): BulkAdjustBridge | null {
	return bulkAdjustBridge;
}

const CALC_DEBOUNCE_MS = 600;
const SAVE_DEBOUNCE_MS = 1000;
let allRowsCalcTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleRowCalc(row: DamageRowState): void {
	if (row.calcTimer) clearTimeout(row.calcTimer);
	row.calcTimer = setTimeout(() => {
		void damageCalcBridge!.recalcRow(row);
	}, CALC_DEBOUNCE_MS);
}

export function scheduleAllRowsCalc(): void {
	// 左パネル(左パネルは常時マウントされる)からも呼ばれるが、ダメージ計算カード
	// (DamageCalcSection、isNewMode/ゲストでは非表示)が無い画面ではブリッジ未登録のためno-opにする。
	if (!damageCalcBridge) return;
	if (allRowsCalcTimer) clearTimeout(allRowsCalcTimer);
	allRowsCalcTimer = setTimeout(() => {
		allRowsCalcTimer = null;
		damageCalcBridge!.recalcAllRows();
	}, CALC_DEBOUNCE_MS);
}

export function scheduleRowSave(row: DamageRowState): void {
	damageCalcBridge!.setRowSaveStatus(
		row,
		"saving",
		// 進行中表示は画面内で表記を揃えるため全角の三点リーダーを使う。
		row.name.trim() ? "編集中…" : "未保存(相手ポケモン名を入力すると保存されます)",
	);
	row.retryButtonEl?.classList.remove("visible");
	if (row.saveTimer) clearTimeout(row.saveTimer);
	row.saveTimer = setTimeout(() => {
		void damageCalcBridge!.saveRow(row);
	}, SAVE_DEBOUNCE_MS);
}

// row.attacks全件ぶんのチップ器を、対応する技カードの現在値で更新する
// (renderColumns後、および詳細設定サイドバーでの変更のたびに呼ぶ)。
export function refreshRowConditionChips(row: DamageRowState): void {
	row.attacks.forEach((attack, i) => {
		const chipEl = row.columnChipEls[i];
		if (chipEl) damageCalcBridge!.renderConditionChipsInto(chipEl, attack, row);
	});
}

// --- 詳細設定サイドバー ---
// 「特定の技列」の選択状態。selectedRow/selectedColumnは元は #opponent-notes-section ブロック
// 内のモジュールスコープ変数だったが、selectColumn/applySelectionMarks/renderDetailPanelが
// このファイルへ移ったため、この状態もここへ移す(ダメージ計算/右サイドの一部関数
// (renderColumns/renderColumnLevelDetailPanel/deselectRowIfCurrent)がこの状態を直接読み書き
// していたため、box/[id].astro側は下のgetSelectedRow/getSelectedColumn/clearSelectionを
// 経由するよう書き換えている)。
let selectedRow: DamageRowState | null = null;
let selectedColumn: DamageColumnState | null = null;
let selectedIsBuild = false;

export function getSelectedRow(): DamageRowState | null {
	return selectedRow;
}
export function getSelectedColumn(): DamageColumnState | null {
	return selectedColumn;
}
export function getSelectedIsBuild(): boolean {
	return selectedIsBuild;
}
export function clearSelection(): void {
	selectedRow = null;
	selectedColumn = null;
	selectedIsBuild = false;
}

export function renderDetailPanel(): void {
	if (!selectedRow) {
		damageCalcBridge!.renderDetailPanelEmpty();
		return;
	}
	if (selectedIsBuild) {
		damageCalcBridge!.renderBuildDetailPanel(selectedRow);
		return;
	}
	if (!selectedColumn) {
		damageCalcBridge!.renderDetailPanelEmpty();
		return;
	}
	damageCalcBridge!.renderColumnLevelDetailPanel(selectedRow, selectedColumn);
}

// 選択状態は「どの技列か」の1階層だけを扱う(.damage-column単位。相手ビルドの箱側の
// マーカーは持たない)。clearSelectionMarksはselectColumnからしか呼ばれない内部ヘルパーの
// ため非exportのままこのファイルに置く(単体でDOM操作するだけの自己完結した処理で、
// ダメージ計算/右サイドの他の関数への依存が無いため、ブリッジ経由にせずそのまま移設できた)。
function clearSelectionMarks(row: DamageRowState): void {
	row.root?.querySelectorAll<HTMLElement>(".damage-column.is-selected, .damage-row-build.is-selected").forEach((selectedEl) => {
		selectedEl.classList.remove("is-selected");
	});
}

export function applySelectionMarks(row: DamageRowState, column: DamageColumnState): void {
	const idx = row.attacks.indexOf(column);
	const colEl = idx >= 0
		? row.columnsEl?.querySelector<HTMLElement>(`.damage-column[data-column-index="${idx}"]`)
		: null;
	colEl?.classList.add("is-selected");
}

// 技列(技カード)1枚を選択し、サイドバーにその技だけの設定を表示する。
export function selectColumn(row: DamageRowState, column: DamageColumnState): void {
	if (selectedRow && selectedRow !== row) clearSelectionMarks(selectedRow);
	clearSelectionMarks(row);
	selectedRow = row;
	selectedColumn = column;
	selectedIsBuild = false;
	applySelectionMarks(row, column);
	renderDetailPanel();
	damageCalcBridge!.openDetailPanelOverlayIfNarrow();
}

export function applyBuildSelectionMark(row: DamageRowState): void {
	row.root?.querySelector<HTMLElement>(".damage-row-build")?.classList.add("is-selected");
}

export function selectBuild(row: DamageRowState): void {
	if (selectedRow && selectedRow !== row) clearSelectionMarks(selectedRow);
	clearSelectionMarks(row);
	selectedRow = row;
	selectedColumn = null;
	selectedIsBuild = true;
	applyBuildSelectionMark(row);
	renderDetailPanel();
	damageCalcBridge!.openDetailPanelOverlayIfNarrow();
}

// カード外(ページの余白・左パネル等)をクリックしたときに、選択中の技列があればその
// 見た目のマーク(.is-selected)を消し、
// 選択状態(selectedRow/selectedColumn)をクリアし、右パネルを空表示に戻す。呼び出し元
// (damage-calc.ts側のdocument全体のクリック監視)は「クリック位置がどのrow.rootにも
// #damage-detail-panelにも含まれない」ことだけを判定し、実際の解除処理はここへ委譲する。
export function clearSelectionAndMarks(): void {
	if (selectedRow) clearSelectionMarks(selectedRow);
	clearSelection();
	renderDetailPanel();
}
