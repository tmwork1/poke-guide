// ダメージ計算のサジェスト(ユーザー要望、2026-08-05)。個体育成画面の右パネルの
// ニュートラル状態に「そのポケモンの型でよく行われているダメージ計算」を並べ、クリックすると
// 中央パネルにダメージ計算カードが1枚増える。
//
// 責務の分割:
//   - 集計         … migrations/020_damage_calc_suggestions.sql(suggestionsテーブルへ書き出す)
//   - 取得口       … 既存の GET /api/suggestions(kind + subject_key。新規APIは作っていない)
//   - 純粋ロジック … src/lib/damage-calc-suggest.ts(キーの組み立て・payload正規化・重複除外)
//   - このファイル … 取得の駆動・描画・クリック時のカード追加の橋渡し
//
// ■ 右パネルでの位置づけ
// 右パネルは既に (A)技カード選択時の詳細設定 / (B)耐久調整の候補一覧 / (C)耐久指数の候補一覧 の
// 3用途で取り合いになっている(src/lib/box-id/right-panel.ts)。依頼は「ニュートラル状態で
// 表示する」なので、既存の優先順位 (A) > (B)(C) > 空 の一番最後、つまり
// renderDetailPanelEmpty() が本当に何も出さない状態のときだけこのサジェストを出す
// (= 新しい優先順位は (A) > (B)(C) > サジェスト > 空)。既存3用途の見え方は変えない。
//
// ■ 型はサーバではなくクライアントで判定する
// 左パネルの人気度サジェスト(left-panel.ts の currentArchetype)と同じく、いま編集中の値から
// classifyArchetype() でその場で型を決める。保存済みのレコード(owned_pokemon.archetype_id)を
// サーバで引き直す方式にしないのは、持ち物や努力値を触っている最中の値にそのまま追随させる
// ため(このページは自動保存だが、保存完了を待たずに型が変わって見えるほうが自然)。
import { classifyArchetype, type ArchetypeKey } from "../archetype";
import {
	DAMAGE_CALC_SUGGESTION_KINDS,
	damageCalcSubjectKeys,
	filterNewDamageCalcSuggestions,
	parseDamageCalcSuggestionPayload,
	type DamageCalcSuggestion,
} from "../damage-calc-suggest";
import { applySprite, applyItemImage, buildAttackerSpec, renderDetailPanel } from "./shared-core";

// 右パネルの高さに収まる件数。取得側(020のtop_n=12)より少なくし、押せる候補だけを見せる。
const VISIBLE_LIMIT = 6;
// 左パネルの連続操作(スライダー・文字入力)のたびに叩かないためのデバウンス。
// left-panel.ts の schedulePopularBuildSuggestionsReload と同じ意図・同じ桁の値にする。
const RELOAD_DEBOUNCE_MS = 300;

/**
 * 中央パネル(ダメージ計算カード)側との橋渡し。カードの一覧も追加処理も damage-calc.ts の
 * クロージャの中にあるため、shared-core.ts の registerDamageCalcBridge と同じ「登録」パターンで
 * 受け取る(このファイルから damage-calc.ts を import すると相互 import が3本目になるため避ける)。
 */
export interface DamageSuggestBridge {
	/** いま画面にあるダメージ計算の同一性キー(damageCalcSuggestionKey と同じ形式)。 */
	listExistingKeys: () => string[];
	/** サジェストを1件、新しいダメージ計算カードとして中央パネルへ追加する。 */
	addSuggestion: (suggestion: DamageCalcSuggestion) => void;
}
let bridge: DamageSuggestBridge | null = null;
export function registerDamageSuggestBridge(value: DamageSuggestBridge): void {
	bridge = value;
}

// 直近の取得結果。パネルは選択状態が変わるたびに何度も再描画されるため、描画のたびに
// 取りに行かず、ここに持っている結果を使い回す(再取得は左パネルの変更が駆動する)。
let currentSuggestions: DamageCalcSuggestion[] = [];
/**
 * 採用したキーの粒度。カードの根拠テキストの主語がこれで変わる。
 * 型で引けたのか種族へ落ちたのかを黙って同じ文言にすると、「同じ型の◯%」と書いてあるのに
 * 実際は持ち物違いも混ざった数字、という嘘になるため必ず出し分ける。
 */
let currentBasis: "archetype" | "species" = "species";
// 直近に取得したキー。同じ型のまま他の項目を編集しただけのときに再取得しないための番人。
let loadedSubjectKey: string | null = null;
// より新しい呼び出しに古いレスポンスが追い越して上書きしないようにするトークン
// (left-panel.ts の popularBuildSuggestionsToken と同じパターン)。
let loadToken = 0;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/** いま編集中の値から型を判定する(left-panel.ts の currentArchetype と同じ入力・同じ分類器)。 */
function currentArchetype(): { speciesName: string; archetype: ArchetypeKey | null } {
	// buildAttackerSpec() は左パネルの現在値(性格・持ち物・テラス・努力値・技)を
	// そのまま PokemonSpec にする共有コア関数。同じ値を2箇所で組み立てないために流用する。
	const spec = buildAttackerSpec();
	return {
		speciesName: spec.name,
		archetype: classifyArchetype({
			speciesName: spec.name,
			itemName: spec.itemName ?? null,
			nature: spec.nature ?? null,
			evs: spec.evs ?? null,
			ivs: spec.ivs ?? null,
			moveNames: spec.moveNames ?? null,
		}),
	};
}

type SuggestionRow = { payload?: unknown };
type SuggestionApiResponse = { data?: SuggestionRow[] };

async function fetchByKey(kind: string, subjectKey: string): Promise<DamageCalcSuggestion[] | null> {
	try {
		const res = await fetch(
			`/api/suggestions?kind=${encodeURIComponent(kind)}&subject_key=${encodeURIComponent(subjectKey)}&limit=1`,
		);
		if (!res.ok) return null;
		const json = (await res.json()) as SuggestionApiResponse;
		const parsed = parseDamageCalcSuggestionPayload(json.data?.[0]?.payload);
		// 行が無い/形が違う場合は null(=次の候補キーへ落ちる)。行はあるが候補0件の場合も
		// 同じ扱いにする ── 型キーだけ存在して中身が空という状態で種族キーへ落ちないと、
		// サジェストが永久に空のままになる。
		if (!parsed || parsed.options.length === 0) return null;
		return parsed.options;
	} catch {
		return null;
	}
}

/**
 * 型キー → 種族キーの順で引き、最初に中身のあったものを採用する。
 * 型が判定できないとき(持ち物未入力など)は damageCalcSubjectKeys が種族キーだけを返すため、
 * 依頼の「型が判別できない場合は種族のみで集計したサジェスト」がそのまま実現される。
 */
async function loadSuggestions(): Promise<void> {
	const { speciesName, archetype } = currentArchetype();
	const keys = damageCalcSubjectKeys(speciesName, archetype);
	const cacheKey = keys.map((k) => `${k.kind}:${k.subjectKey}`).join("\n");
	if (cacheKey === loadedSubjectKey) return;

	const token = ++loadToken;
	if (keys.length === 0) {
		loadedSubjectKey = cacheKey;
		currentSuggestions = [];
		renderDetailPanel();
		return;
	}

	let options: DamageCalcSuggestion[] = [];
	let basis: "archetype" | "species" = "species";
	for (const key of keys) {
		const found = await fetchByKey(key.kind, key.subjectKey);
		if (token !== loadToken) return; // より新しい呼び出しに追い越された
		if (found) {
			options = found;
			basis = key.kind === DAMAGE_CALC_SUGGESTION_KINDS.archetype ? "archetype" : "species";
			break;
		}
	}
	loadedSubjectKey = cacheKey;
	currentSuggestions = options;
	currentBasis = basis;
	// 取得は非同期なので、届いた時点でパネルを描き直す。いま (A)(B)(C) を表示中なら
	// renderDetailPanel() はそちらを再描画するだけで、このサジェストは表に出ない。
	renderDetailPanel();
}

/** 左パネルの編集・カードの増減など、サジェストの前提が変わったときに呼ぶ。 */
export function scheduleDamageSuggestReload(): void {
	if (reloadTimer) clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => {
		void loadSuggestions();
	}, RELOAD_DEBOUNCE_MS);
}

/** カードを増減したときなど、取得はやり直さず「既に追加済み」の除外だけを引き直す。 */
export function refreshDamageSuggestView(): void {
	renderDetailPanel();
}

function buildDirectionChip(direction: DamageCalcSuggestion["direction"]): HTMLElement {
	const chip = document.createElement("span");
	chip.className = "damage-suggest-direction";
	chip.dataset.direction = direction;
	// 中央パネルの攻守トグル(damage-calc.ts の directionToggle)と同じ語彙にする。
	chip.textContent = direction === "defense" ? "防御" : "攻撃";
	return chip;
}

function buildSuggestionCard(suggestion: DamageCalcSuggestion, rank: number): HTMLElement {
	const item = document.createElement("li");
	item.className = "damage-suggest-card";

	// カード全体を1つのボタンにする(依頼「サジェストをクリックするとダメージカードが追加される」)。
	// team/[id].astro のサジェストは「育成する/チームに追加」で操作が2種類あるため右端に別ボタンを
	// 置いているが、こちらは操作が1つしかないのでカードそのものを押せるようにするほうが素直。
	const button = document.createElement("button");
	button.type = "button";
	button.className = "damage-suggest-card-button";

	const rankEl = document.createElement("span");
	rankEl.className = "damage-suggest-rank";
	rankEl.textContent = String(rank);
	button.appendChild(rankEl);

	const body = document.createElement("span");
	body.className = "damage-suggest-body";

	// 1段目: 攻守 + 相手のスプライト + 相手の種族名。
	const nameRow = document.createElement("span");
	nameRow.className = "damage-suggest-name-row";
	nameRow.appendChild(buildDirectionChip(suggestion.direction));
	const spriteEl = document.createElement("span");
	spriteEl.className = "damage-suggest-sprite";
	const spriteImg = document.createElement("img");
	spriteImg.className = "damage-suggest-sprite-img";
	spriteImg.alt = "";
	const spriteFallback = document.createElement("span");
	spriteFallback.className = "damage-suggest-sprite-fallback";
	spriteEl.append(spriteImg, spriteFallback);
	void applySprite(spriteImg, spriteFallback, suggestion.opponentName);
	const nameEl = document.createElement("span");
	nameEl.className = "damage-suggest-name";
	nameEl.textContent = suggestion.opponentName;
	nameEl.title = suggestion.opponentName;
	nameRow.append(spriteEl, nameEl);
	// 持ち物は相手のもの(集計側が返す想定ビルド)なので、相手の名前と同じ行に置く
	// ── 下の技名の行に置くと、direction='attack' のとき「自分が使う技」と「相手の持ち物」が
	// 同じ行に並んでどちらの持ち物か読めなくなる。team-suggest-name-row と同じ並びでもある。
	if (suggestion.opponentBuild.itemName) {
		// アイコンと名前は1つの塊にする(別々にappendすると、折り返しでアイコンだけが
		// 前の行に取り残される。実測で発覚)。
		const itemGroup = document.createElement("span");
		itemGroup.className = "damage-suggest-item";
		const itemIcon = document.createElement("img");
		itemIcon.className = "damage-suggest-item-icon";
		itemIcon.alt = "";
		void applyItemImage(itemIcon, suggestion.opponentBuild.itemName);
		const itemEl = document.createElement("span");
		itemEl.className = "damage-suggest-item-name";
		itemEl.textContent = suggestion.opponentBuild.itemName;
		itemGroup.append(itemIcon, itemEl);
		nameRow.appendChild(itemGroup);
	}
	body.appendChild(nameRow);

	// 2段目: 技名。direction='attack' ならこの個体が使う技、'defense' なら相手が使う技
	// (どちらの技かは1段目の攻守チップが決める)。
	const moveRow = document.createElement("span");
	moveRow.className = "damage-suggest-move-row";
	const moveEl = document.createElement("span");
	moveEl.className = "damage-suggest-move";
	moveEl.textContent = suggestion.moveName;
	moveEl.title = suggestion.moveName;
	moveRow.appendChild(moveEl);
	body.appendChild(moveRow);

	// 3段目: 根拠。母集団の実数はtitleに回し、本文は割合だけにする(右パネルは幅が狭い)。
	// 主語は採用したキーの粒度そのもの(型で引けたのか種族へ落ちたのか)にする。
	const reasonEl = document.createElement("span");
	reasonEl.className = "damage-suggest-reason";
	const subject = currentBasis === "archetype" ? "同じ型" : "同じポケモン";
	reasonEl.textContent = `${subject}の${Math.round(suggestion.ratio * 100)}%が計算`;
	reasonEl.title = `${subject}を育てている${suggestion.count}体が同じダメージ計算を登録`;
	body.appendChild(reasonEl);

	button.appendChild(body);

	const action = document.createElement("span");
	action.className = "damage-suggest-action";
	action.textContent = "追加";
	button.appendChild(action);

	button.addEventListener("click", () => {
		bridge?.addSuggestion(suggestion);
		// 追加した候補は「既に画面にある」ので次の描画から消える。
		refreshDamageSuggestView();
	});

	item.appendChild(button);
	return item;
}

/**
 * 右パネルのニュートラル状態としてサジェストを描画する。
 * 出すものが何も無ければ false を返し、呼び出し元(right-panel.ts の renderDetailPanelEmpty)は
 * 従来どおりの空状態へ落ちる ── 取得中・取得失敗・候補0件のときに文言だけが出るのは、
 * 「通常時は何も見せない」という現在の空状態(UI改善ラウンド42で案内文を全廃した)と
 * 衝突するため、黙って空のままにする。
 */
export function renderDamageSuggestPanel(
	bodyEl: HTMLElement,
	setTitle: (title: string | Node) => void,
): boolean {
	const existingKeys = new Set(bridge?.listExistingKeys() ?? []);
	const visible = filterNewDamageCalcSuggestions(currentSuggestions, existingKeys, VISIBLE_LIMIT);
	if (visible.length === 0) return false;

	setTitle("よく行われるダメージ計算");
	bodyEl.innerHTML = "";
	const inner = document.createElement("div");
	inner.className = "damage-detail-panel-body-inner damage-suggest";
	bodyEl.appendChild(inner);

	const list = document.createElement("ul");
	list.className = "damage-suggest-list";
	visible.forEach((suggestion, index) => list.appendChild(buildSuggestionCard(suggestion, index + 1)));
	inner.appendChild(list);
	return true;
}

/** damage-calc.ts の #opponent-notes-section ガード内から1回だけ呼ばれる。 */
export function initDamageSuggest(): void {
	// 左パネルの編集(種族・持ち物・性格・努力値・技)は型を変えうるので取り直す。
	// left-panel.ts 側にフックを増やさず、#edit-form のイベントをこのファイルだけで拾う
	// (left-panel.ts は左サイド専用の担当ファイルで、こちらの都合で export を増やしたくない)。
	const form = document.getElementById("edit-form");
	if (form) {
		form.addEventListener("input", scheduleDamageSuggestReload);
		form.addEventListener("change", scheduleDamageSuggestReload);
		// 性格・テラス・技はボタン/カスタムドロップダウンで、input/changeが出ないものがある。
		form.addEventListener("click", scheduleDamageSuggestReload);
	}
	void loadSuggestions();
}

// 型だけを再exportする(damage-calc.ts がブリッジの実装で使う。同一性キーを作る関数は
// 純粋ロジック側にあるので、あちらは src/lib/damage-calc-suggest.ts から直接importする)。
export type { DamageCalcSuggestion };
