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
} from "../pokemon-master-data";
import { typeIconUrl, teraTypeIconUrl } from "../sprite-urls";
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from "../type-colors";
import { type StatKey, STAT_KEYS, NATURE_STAT_MODIFIERS } from "../stats";
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

// UI品質改善(2026-07-26 第4弾 11-4): #move-listのlearnset優先並び替え(rebuildMoveListForSpecies、
// 下で定義)は #move-list に既に候補が入っている前提で動く。loadAutocomplete()は元は<script>末尾で
// void呼び出ししていたが、それより先にupdateSpeciesDisplay()の初回呼び出し(ページ読み込み時の
// 種族名反映、下の方)が走るため、呼び出し順のままでは並び替え時に#move-listがまだ空になってしまう。
// loadAutocomplete()はdatalistへ<option>を追記するだけで内部にキャッシュを持たない
// (二重に呼ぶと候補が重複する)ため、呼び出し箇所はこの1箇所だけに保ち、Promiseを
// 変数で保持してrebuildMoveListForSpecies側から待ち合わせに使う。
const autocompleteReadyPromise = loadAutocomplete();

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
	numberInput.addEventListener("input", () => {
		const n = Number(numberInput.value);
		if (Number.isFinite(n)) rangeInput.value = String(Math.min(32, Math.max(0, Math.round(n))));
		updateSliderProgress(rangeInput);
	});
}

const form = document.getElementById("edit-form") as HTMLFormElement | null;
if (form) {
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
		itemNameDisplayEl.textContent = name || "持ち物なし";
		itemNameDisplayEl.title = name;
		itemNameDisplayEl.classList.toggle("is-empty", name === "");
	}
	itemInput.addEventListener("input", updateItemImage);
	itemInput.addEventListener("input", updateItemTitle);
	itemInput.addEventListener("input", updateItemNameDisplay);
	updateItemImage();
	updateItemTitle();
	updateItemNameDisplay();

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
		const placeholderOpt = document.createElement("option");
		placeholderOpt.value = "";
		placeholderOpt.textContent = "特性を選択";
		abilitySelectEl.appendChild(placeholderOpt);
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
	// UI改善ラウンド23(23-G3): メガシンカ種族が確定したら持ち物を対応するメガストーンに
	// 自動設定する。持ち物が既に入っている場合は上書きしない(ユーザーが既に入れた値を
	// 尊重する)。rebuildAbilityOptionsと同じくinput(1文字ごと)ではなくchange
	// (blur/確定)にのみ結線する(理由も同じ: 入力途中の不完全な種族名で誤発火させない)。
	let megaStoneAutofillToken = 0;
	async function applyLeftMegaStoneAutofill(speciesName: string): Promise<void> {
		const token = ++megaStoneAutofillToken;
		if (itemInput.value.trim() !== "") return; // 持ち物が既に入っているので何もしない
		const stoneName = await resolveMegaStoneItem(speciesName);
		if (token !== megaStoneAutofillToken) return; // より新しい呼び出しに追い越された
		if (!stoneName) return;
		if (itemInput.value.trim() !== "") return; // 待機中にユーザーが入力した場合は上書きしない
		itemInput.value = stoneName;
		updateItemImage();
		updateItemTitle();
		updateItemNameDisplay();
		scheduleSave();
		void recalcStats();
		flashAutofillHint(itemInput, () => updateItemTitle());
	}
	speciesInput.addEventListener("change", () => {
		void rebuildAbilityOptions(speciesInput.value.trim());
		void applyLeftMegaStoneAutofill(speciesInput.value.trim());
	});
	void rebuildAbilityOptions(speciesInput.value.trim());

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
			li.setAttribute("aria-label", "テラスなし");
			const textEl = document.createElement("span");
			textEl.className = "tera-dropdown-option-text";
			textEl.textContent = "テラスなし";
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
			teraDropdownPlaceholder.textContent = "テラスなし";
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
			tera_type: el<HTMLSelectElement>("tera").value,
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
		const natureReadoutEl = document.getElementById("nature-readout-value") as HTMLInputElement | null;
		if (natureReadoutEl) natureReadoutEl.value = currentLeftNature();
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
			valueEl.textContent = "(未計算)";
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
	const changeInputIds = ["tera", "ability"];
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
		});
		downButton?.addEventListener("click", () => {
			leftNatureDown = toggleNatureDown(leftNatureDown, key);
			refreshNatureButtons();
			void recalcStats();
			scheduleSave();
		});
	}

	// UI刷新: 努力値の各スライダーを数値入力とペアリングする。
	for (const k of STAT_KEYS) {
		pairEvSlider(`ev-${k}`, `ev-${k}-range`, () => {
			scheduleSave();
			void recalcStats();
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

	// 個体の公開共有トグル(PUT /api/owned-pokemon/:id/share)のUIは要件により廃止した。
	// APIと公開ページ(/share/[slug])自体は残っているので、UIを再び付けたくなった場合は
	// git履歴のこの位置にあった renderShareStatus / is-public チェックボックスの実装を参照すること。
}
