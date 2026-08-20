// ダメージ計算のサジェスト。個体育成画面の「box/damage」タブに「そのポケモンの型で
// よく行われているダメージ計算」を並べ、クリックすると中央のダメージ計算カード一覧に
// カードが1枚増える。
//
// 責務の分割:
//   - 集計         … migrations/020_damage_calc_suggestions.sql(suggestionsテーブルへ書き出す)
//   - 取得口       … 既存の GET /api/suggestions(kind + subject_key。新規APIは作っていない)
//   - 純粋ロジック … src/lib/damage-calc-suggest.ts(キーの組み立て・payload正規化・重複除外)
//   - このファイル … 取得の駆動・描画・クリック時のカード追加の橋渡し
//
// ■ 表示位置
// 以前は右パネル(#damage-detail-panel、技カード編集・耐久調整候補・耐久指数候補と取り合いに
// なるモーダル)の「ニュートラル状態」としてだけ表示していたが、開閉しなくても常に見える方が
// 便利という要望により、ダメージ計算カード一覧(#damage-rows-list)の直下に常設表示する
// #damage-suggest-section/#damage-suggest-list(DamageCalcSection.astro)へ直接描画する形に
// 変更した。右パネル側の優先順位(A:技カード編集 > B/C:耐久調整・耐久指数の候補一覧 > 空)には
// もう関与しない(renderDamageSuggestSectionは右パネルの状態と無関係に、値の変更のたびに
// 独立して呼ばれる)。
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
import { applySprite, applyItemImage, buildAttackerSpec } from "./shared-core";
import { typeIconUrl } from "../sprite-urls";

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

// C-4: 技のタイプアイコン用に技名→タイプを引く。right-panel.ts(moveAutoInputDetailsPromise)と
// 同じ考え方だが、このファイルからあちらへの依存を増やさないため(相互import増加を避ける
// 既存方針)、独自に同じ /master-data/detail/moves.json を取得してキャッシュする。
const moveTypeDetailsPromise: Promise<Map<string, string | null>> = fetch("/master-data/detail/moves.json")
	.then((response) => response.json())
	.then((moves: Array<{ name: string; type?: string | null }>) => new Map(moves.map((move) => [move.name, move.type ?? null])))
	.catch((error) => {
		console.warn("技のタイプ情報の読み込みに失敗しました", error);
		return new Map<string, string | null>();
	});

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
		renderDamageSuggestSection();
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
	// 取得は非同期なので、届いた時点で常設セクションを描き直す。
	renderDamageSuggestSection();
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
	renderDamageSuggestSection();
}

function buildDirectionChip(direction: DamageCalcSuggestion["direction"]): HTMLElement {
	const chip = document.createElement("span");
	chip.className = "damage-suggest-direction";
	chip.dataset.direction = direction;
	// 中央パネルの攻守トグル(damage-calc.ts の directionToggle)と同じ語彙にする。
	chip.textContent = direction === "defense" ? "防御" : "攻撃";
	return chip;
}

function buildSuggestionCard(suggestion: DamageCalcSuggestion): HTMLElement {
	const item = document.createElement("li");
	item.className = "damage-suggest-card";

	// カード全体を1つのボタンにする(依頼「サジェストをクリックするとダメージカードが追加される」)。
	// team/[id].astro のサジェストは「育成する/チームに追加」で操作が2種類あるため右端に別ボタンを
	// 置いているが、こちらは操作が1つしかないのでカードそのものを押せるようにするほうが素直。
	// C-2: 視覚的な「追加」ラベルは廃止したため、操作可能であることはaria-labelで補う
	// (ボタン自身の可視テキストはaria-labelがあれば読み上げに使われない点に注意)。
	const button = document.createElement("button");
	button.type = "button";
	button.className = "damage-suggest-card-button";
	button.setAttribute("aria-label", `${suggestion.opponentName}の${suggestion.moveName}を追加`);

	const body = document.createElement("span");
	body.className = "damage-suggest-body";

	// 左列: 攻守チップ + 相手のスプライト。ダメージカード一覧の相手ビルドカード
	// (.damage-row-build-left = .damage-build-matchup)と同じ「左列=攻守+アイコン」の
	// 構成にそろえる(C-6でnameRowの1段目からleftへ分離)。
	const left = document.createElement("span");
	left.className = "damage-suggest-left";
	left.appendChild(buildDirectionChip(suggestion.direction));
	const spriteEl = document.createElement("span");
	spriteEl.className = "damage-suggest-sprite";
	// C-3: 種族名の文字表示(nameEl)を削除する代わりに、どのポケモンかという情報が
	// 完全には失われないよう、スプライト本体にalt/titleを設定する。
	spriteEl.title = suggestion.opponentName;
	const spriteImg = document.createElement("img");
	spriteImg.className = "damage-suggest-sprite-img";
	spriteImg.alt = suggestion.opponentName;
	spriteImg.title = suggestion.opponentName;
	const spriteFallback = document.createElement("span");
	spriteFallback.className = "damage-suggest-sprite-fallback";
	spriteEl.append(spriteImg, spriteFallback);
	void applySprite(spriteImg, spriteFallback, suggestion.opponentName);
	left.appendChild(spriteEl);
	body.appendChild(left);

	// 右列: 上段(特性・持ち物)+ 下段(技・根拠)の縦2段(C-6)。
	const right = document.createElement("span");
	right.className = "damage-suggest-right";

	// 右列上段: 特性(新設)+ 持ち物。持ち物は相手のもの(集計側が返す想定ビルド)なので、
	// 自分が使う技(direction='attack'のとき下段に出る)と混ざらないよう上段にまとめる。
	const main = document.createElement("span");
	main.className = "damage-suggest-right-main";
	// 特性は値があるときだけ要素を作る(itemGroupと同じ流儀)。相手ビルドカードの
	// 特性欄(.damage-build-readonly-ability-line)と同じ控えめな見た目にする。
	if (suggestion.opponentBuild.abilityName) {
		const abilityEl = document.createElement("span");
		abilityEl.className = "damage-suggest-ability";
		abilityEl.textContent = suggestion.opponentBuild.abilityName;
		abilityEl.title = suggestion.opponentBuild.abilityName;
		main.appendChild(abilityEl);
	}
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
		main.appendChild(itemGroup);
	}
	right.appendChild(main);

	// 右列下段: タイプアイコン + 技名(左) + 根拠(右、C-5でここへ移設)。
	// direction='attack' ならこの個体が使う技、'defense' なら相手が使う技
	// (どちらの技かは左列の攻守チップが決める)。
	const moveRow = document.createElement("span");
	moveRow.className = "damage-suggest-move-row";
	// C-4: 技のタイプアイコンを技名の左に追加する(right-panel.tsのmoveDropdownの
	// アイコン表示と同じ「先に隠しておき、判明したら表示する」流儀)。
	const moveTypeIcon = document.createElement("img");
	moveTypeIcon.className = "damage-suggest-move-type-icon";
	moveTypeIcon.alt = "";
	moveTypeIcon.hidden = true;
	void moveTypeDetailsPromise.then((types) => {
		const type = types.get(suggestion.moveName);
		const url = type ? typeIconUrl(type) : null;
		if (!url) return;
		moveTypeIcon.src = url;
		moveTypeIcon.hidden = false;
	});
	moveTypeIcon.addEventListener("error", () => { moveTypeIcon.hidden = true; });
	moveRow.appendChild(moveTypeIcon);
	const moveEl = document.createElement("span");
	moveEl.className = "damage-suggest-move";
	moveEl.textContent = suggestion.moveName;
	moveEl.title = suggestion.moveName;
	moveRow.appendChild(moveEl);

	// C-5: 根拠は「x%が計算」まで短縮し、技名と同じ行の右側に表示する。母集団の実数と
	// 主語(同じ型/同じポケモン、採用したキーの粒度そのもの)はtitleに残す。
	const reasonEl = document.createElement("span");
	reasonEl.className = "damage-suggest-reason";
	const subject = currentBasis === "archetype" ? "同じ型" : "同じポケモン";
	reasonEl.textContent = `${Math.round(suggestion.ratio * 100)}%が計算`;
	reasonEl.title = `${subject}を育てている${suggestion.count}体が同じダメージ計算を登録`;
	moveRow.appendChild(reasonEl);
	right.appendChild(moveRow);
	body.appendChild(right);

	button.appendChild(body);

	button.addEventListener("click", () => {
		bridge?.addSuggestion(suggestion);
		// 追加した候補は「既に画面にある」ので次の描画から消える。
		refreshDamageSuggestView();
	});

	item.appendChild(button);
	return item;
}

/**
 * #damage-rows-list の直下に常設する「よく行われるダメージ計算」を描画する。
 * サジェストが1件も無ければ #damage-suggest-section を隠す ── 取得中・取得失敗・候補0件の
 * ときに文言だけが出るのは「通常時は何も見せない」という方針と衝突するため、黙って隠す。
 */
export function renderDamageSuggestSection(): void {
	const sectionEl = document.getElementById("damage-suggest-section");
	const listEl = document.getElementById("damage-suggest-list");
	if (!sectionEl || !listEl) return;

	const existingKeys = new Set(bridge?.listExistingKeys() ?? []);
	const visible = filterNewDamageCalcSuggestions(currentSuggestions, existingKeys, VISIBLE_LIMIT);
	if (visible.length === 0) {
		sectionEl.hidden = true;
		listEl.innerHTML = "";
		return;
	}

	sectionEl.hidden = false;
	listEl.innerHTML = "";
	visible.forEach((suggestion) => listEl.appendChild(buildSuggestionCard(suggestion)));
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
