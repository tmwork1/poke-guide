import {
	loadBaseStatsMap,
	loadImageIdMap,
	loadMoveTypeMap,
	officialArtworkUrl,
} from "./pokemon-master-data";
import { itemIconUrl } from "./sprite-urls";
import { NATURE_STAT_MODIFIERS, STAT_KEYS, calcHpStat, calcOtherStat } from "./stats";
import { DEFAULT_TYPE_COLOR, TYPE_COLORS } from "./type-colors";

// このカードは /box と team編成タブで共有している。片方だけ直すと表示が食い違うので、
// カード内部のDOM・ツールチップ・付属ボタンを変更するときは必ずこのファイルで行う。

/** ボックスカードの描画に必要な、OwnedPokemonRecordの構造的部分型。 */
export interface BoxPokemonCardPokemon {
	species_name: string;
	level: number | null;
	nature: string | null;
	ability_name: string | null;
	item_name: string | null;
	tera_type: string | null;
	evs: number[];
	ivs: number[];
	move_names: string[];
	memo: string | null;
}

export interface OwnedPokemonDisplayNameSource {
	nickname: string | null;
	species_name: string;
}

export interface BoxPokemonCardPinOptions {
	isPinned: boolean;
	onToggle: () => void | Promise<void>;
}

export interface BoxPokemonCardOptions<T extends HTMLElement> {
	root: T;
	pokemon: BoxPokemonCardPokemon;
	displayName: string;
	ariaLabel: string;
	/** /box 専用。指定した場合だけ左上のピン留めボタンを生成する。 */
	pin?: BoxPokemonCardPinOptions;
	/** /box 専用。指定した場合だけ右上の削除ボタンを生成する。 */
	onDelete?: () => void | Promise<void>;
}

type ActualStat = { value: number; mod: "up" | "down" | null };

const STAT_LABELS = ["H", "A", "B", "C", "D", "S"] as const;

// 種族名→imageId、種族値、技タイプ、持ち物画像のマップはいずれもローダー側でもキャッシュ
// されている。カードはこれらを待たず同期的に返し、解決後に画像・titleを個別に流し込む。
// 一覧の初回表示をマスターデータのfetchで遅らせないため、この非同期挙動を維持すること。
const imageIdMapPromise = loadImageIdMap();
const baseStatsMapPromise = loadBaseStatsMap();
const moveTypeMapPromise = loadMoveTypeMap();

// nickname・species_nameのどちらも空(自動登録直後の空個体)の場合、カード見出しが
// 空文字にならないよう "(未設定)" にフォールバックする。両画面の並べ替え・検索・確認
// ダイアログでも同じ表示名を使えるよう、カード生成とは別に公開する。
export function ownedPokemonDisplayName(pokemon: OwnedPokemonDisplayNameSource): string {
	if (pokemon.nickname && pokemon.nickname.trim() !== "") return pokemon.nickname;
	if (pokemon.species_name && pokemon.species_name.trim() !== "") return pokemon.species_name;
	return "(未設定)";
}

// UI刷新: カード内の公式絵。取得できない場合は画像を未設定のままにする。
// 初期display:noneのままloading="lazy"を付けると、画面外扱いでfetch自体が行われず
// onloadが永久に発火しない(過去に踏んだ不具合、box/[id].astroのapplySprite参照)。
async function applyCardArtwork(
	artwork: HTMLElement,
	imgEl: HTMLImageElement,
	name: string,
): Promise<void> {
	const imageId = name ? (await imageIdMapPromise).get(name) : undefined;
	if (imageId == null) return;
	artwork.hidden = false;
	imgEl.src = officialArtworkUrl(imageId);
}

// 公式絵に重ねる持ち物バッジ。アイテム名が空/画像読み込みに失敗した場合はバッジごと隠す
// (box/[id].astroのapplyItemImageと同様、テキストのフォールバックは持たせない)。
function applyItemBadge(imgEl: HTMLImageElement, badgeEl: HTMLElement, itemName: string): void {
	const name = itemName.trim();
	if (!name) {
		badgeEl.hidden = true;
		return;
	}
	imgEl.onerror = () => {
		badgeEl.hidden = true;
	};
	imgEl.onload = () => {
		badgeEl.hidden = false;
	};
	imgEl.src = itemIconUrl(name);
}

// 実数値DOMは持たないが、title用の計算結果はデータとして維持する。
async function calculateActualStats(pokemon: BoxPokemonCardPokemon): Promise<ActualStat[] | null> {
	const base = pokemon.species_name ? (await baseStatsMapPromise).get(pokemon.species_name) : undefined;
	if (!base) return null;
	const level = pokemon.level ?? 50;
	const natureMod = NATURE_STAT_MODIFIERS[pokemon.nature ?? ""] ?? { up: null, down: null };
	return STAT_KEYS.map((key, i) => {
		const iv = pokemon.ivs[i] ?? 31;
		const ev = pokemon.evs[i] ?? 0;
		const value =
			key === "hp"
				? calcHpStat(level, base[i], iv, ev)
				: calcOtherStat(
						level,
						base[i],
						iv,
						ev,
						natureMod.up === key ? 1.1 : natureMod.down === key ? 0.9 : 1.0,
					);
		return {
			value,
			mod: key !== "hp" && natureMod.up === key ? "up" : key !== "hp" && natureMod.down === key ? "down" : null,
		};
	});
}

// カード上に表示されていない情報だけをホバーで示す。性格補正は A200+ / C135- のように
// 数値の後ろへ付ける。情報が一つも無ければtitle属性自体を追加しない。
function applyCardTooltip(
	card: HTMLElement,
	stats: ActualStat[] | null,
	pokemon: BoxPokemonCardPokemon,
): void {
	const lines: string[] = [];
	const ability = pokemon.ability_name?.trim() ?? "";
	if (ability) lines.push(`特性: ${ability}`);
	const teraType = pokemon.tera_type?.trim() ?? "";
	if (teraType) lines.push(`テラスタイプ: ${teraType}`);
	if (stats) {
		lines.push(
			STAT_LABELS.map((label, i) => {
				const stat = stats[i];
				const mark = stat.mod === "up" ? "+" : stat.mod === "down" ? "-" : "";
				return `${label}${stat.value}${mark}`;
			}).join(" "),
		);
	}
	const memoText = pokemon.memo?.trim() ?? "";
	if (memoText) lines.push(`メモ: ${memoText}`);
	if (lines.length > 0) card.title = lines.join("\n");
}

/**
 * 新規作成済みのHTMLElementへ、共有ボックスカードのDOMを同期的に組み立てる。
 * 画像URL・技タイプ・実数値ツールチップはPromise解決後に流し込む。
 */
export function renderBoxPokemonCard<T extends HTMLElement>(
	options: BoxPokemonCardOptions<T>,
): T {
	const { root: card, pokemon, displayName, ariaLabel, pin, onDelete } = options;
	card.className = "card box-card card-pokemon" + (pin?.isPinned ? " is-pinned" : "");
	card.setAttribute("aria-label", ariaLabel);

	if (pin) {
		// ピン留めは.card-actionsの外でcard直下に置き、削除ボタンと対角配置する。
		const pinButton = document.createElement("button");
		pinButton.type = "button";
		pinButton.className = "icon-button pin-toggle";
		pinButton.dataset.pinned = String(pin.isPinned);
		// 星の描画はglobal.cssの共通ルールへ委譲し、状態属性だけを表示の根拠にする。
		const pinStar = document.createElement("span");
		pinStar.className = "favorite-star-glyph";
		pinStar.setAttribute("aria-hidden", "true");
		pinButton.appendChild(pinStar);
		const pinLabel = pin.isPinned ? "ピン留めを解除する" : "ピン留めする";
		pinButton.title = pinLabel;
		pinButton.setAttribute("aria-label", pinLabel);
		pinButton.addEventListener("click", (event) => {
			// 親カード(<a>)のクリックによる/box/{id}への遷移を止める。
			event.preventDefault();
			event.stopPropagation();
			void pin.onToggle();
		});
		card.appendChild(pinButton);
	}

	if (onDelete) {
		// .card-actionsは右上の削除ボタン1個だけを持つ箱として維持する。
		const actions = document.createElement("div");
		actions.className = "card-actions";
		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "icon-button delete-button";
		// 全画面共通方針の×SVG。サイズ・stroke-widthを変えない。
		deleteButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
		deleteButton.title = "削除";
		deleteButton.setAttribute("aria-label", "削除");
		deleteButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void onDelete();
		});
		actions.appendChild(deleteButton);
		card.appendChild(actions);
	}

	const artwork = document.createElement("div");
	artwork.className = "card-artwork";
	artwork.hidden = true;
	const artworkImg = document.createElement("img");
	artworkImg.alt = "";
	artwork.appendChild(artworkImg);
	card.appendChild(artwork);
	void applyCardArtwork(artwork, artworkImg, pokemon.species_name ?? "");

	// 持ち物名は描画せず、画像だけを公式絵の右下に重ねる。
	const itemBadge = document.createElement("span");
	itemBadge.className = "card-item-badge";
	itemBadge.hidden = true;
	const itemImg = document.createElement("img");
	itemImg.alt = "";
	itemBadge.appendChild(itemImg);
	card.appendChild(itemBadge);
	void applyItemBadge(itemImg, itemBadge, pokemon.item_name ?? "");

	// ルートのaria-labelと重複するのでbody全体はaria-hiddenにする。/boxのピン留め・削除
	// ボタンはこのdivの外にあるため、隠してもフォーカス到達性へ影響しない。
	const body = document.createElement("div");
	body.className = "card-body";
	body.setAttribute("aria-hidden", "true");
	const nameRow = document.createElement("div");
	nameRow.className = "card-name-row";
	const nameEl = document.createElement("p");
	nameEl.className = "card-name";
	nameEl.textContent = displayName;
	nameRow.appendChild(nameEl);
	body.appendChild(nameRow);

	const nature = pokemon.nature?.trim() ?? "";
	const evLabels = STAT_LABELS.filter((_, index) => (pokemon.evs[index] ?? 0) >= 7).join("");
	const natureEvsText = [nature, evLabels].filter(Boolean).join(" ");
	if (natureEvsText) {
		const natureEvsEl = document.createElement("p");
		natureEvsEl.className = "card-nature-evs";
		natureEvsEl.textContent = natureEvsText;
		body.appendChild(natureEvsEl);
	}

	// 下段は技の縦リスト。空文字の技スロットは描画せず、不明タイプのアイコンはhiddenのままにする。
	const movesGrid = document.createElement("div");
	movesGrid.className = "card-moves-grid";
	for (const moveName of pokemon.move_names.filter((move) => move && move.trim() !== "")) {
		const moveEl = document.createElement("span");
		moveEl.className = "card-move-chip";
		const moveTypeBar = document.createElement("span");
		moveTypeBar.className = "card-move-type-bar";
		moveTypeBar.hidden = true;
		moveEl.appendChild(moveTypeBar);
		void moveTypeMapPromise.then((moveTypeMap) => {
			const moveType = moveTypeMap.get(moveName);
			if (!moveType) return;
			moveTypeBar.style.backgroundColor = TYPE_COLORS[moveType] ?? DEFAULT_TYPE_COLOR;
			moveTypeBar.hidden = false;
		});
		const moveTextEl = document.createElement("span");
		moveTextEl.className = "card-move-chip-text";
		moveTextEl.textContent = moveName;
		moveEl.appendChild(moveTextEl);
		movesGrid.appendChild(moveEl);
	}
	const contentRow = document.createElement("div");
	contentRow.className = "card-content-row";
	contentRow.appendChild(movesGrid);
	body.appendChild(contentRow);
	card.appendChild(body);

	// titleは実数値の解決後に設定する。戻り値をPromiseにせず、カード自体は即時返却する。
	void calculateActualStats(pokemon).then((stats) => applyCardTooltip(card, stats, pokemon));

	return card;
}
