// このカードは編成タブと相性タブで共有している。片方だけ直すと表示が食い違うので、
// カード内部のDOMを変更するときは必ずこのファイルで行う。

/** チームメイト6枠の描画に必要な、OwnedPokemonRecordの構造的部分型。 */
export interface TeamMateCardPokemon {
	species_name: string;
	item_name: string | null;
}

export interface TeamMateSlotsOptions<T extends TeamMateCardPokemon> {
	root: HTMLElement;
	membersBySlot: ReadonlyMap<number, T>;
	displayName: (member: T) => string;
	selectedSlot?: number | null;
	onSlotClick?: (slot: number) => void;
	onSlotTap?: (slot: number) => void;
	onSlotDoubleTap?: (slot: number) => void;
	onSlotLongPress?: (slot: number) => void;
	applySprite: (imgEl: HTMLImageElement, fallbackEl: HTMLElement, name: string) => void | Promise<void>;
	applyItemIcon: (imgEl: HTMLImageElement, itemName: string, visibilityEl?: HTMLElement) => void | Promise<void>;
	/** falseならアイコン右下の持ち物オーバーレイを描かない(もちもの入替モーダルは別行でアイテムを表示するため)。省略時true。 */
	showItem?: boolean;
}

/** 編成タブと相性タブで共通のチームメイト6枠を描画する。 */
export function renderTeamMateSlots<T extends TeamMateCardPokemon>(options: TeamMateSlotsOptions<T>): void {
	const { root, membersBySlot, displayName, selectedSlot = null, onSlotClick, onSlotTap, onSlotDoubleTap, onSlotLongPress, applySprite, applyItemIcon, showItem = true } = options;
	root.innerHTML = "";

	for (let slot = 1; slot <= 6; slot += 1) {
		const member = membersBySlot.get(slot);
		let card: HTMLElement;
		if (onSlotClick || onSlotTap) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("aria-pressed", String(selectedSlot === slot));
			if (onSlotTap || onSlotDoubleTap || onSlotLongPress) {
				let tapTimer: number | undefined;
				let longPressTimer: number | undefined;
				let longPressed = false;
				const cancelLongPress = () => {
					if (longPressTimer !== undefined) window.clearTimeout(longPressTimer);
					longPressTimer = undefined;
				};
				button.addEventListener("pointerdown", () => {
					if (!member || !onSlotLongPress) return;
					longPressed = false;
					longPressTimer = window.setTimeout(() => {
						longPressed = true;
						longPressTimer = undefined;
						onSlotLongPress(slot);
					}, 500);
				});
				button.addEventListener("pointerup", cancelLongPress);
				button.addEventListener("pointercancel", cancelLongPress);
				button.addEventListener("click", () => {
					if (longPressed) {
						longPressed = false;
						return;
					}
					if (tapTimer !== undefined) {
						window.clearTimeout(tapTimer);
						tapTimer = undefined;
						onSlotDoubleTap?.(slot);
						return;
					}
					tapTimer = window.setTimeout(() => {
						tapTimer = undefined;
						(onSlotTap ?? onSlotClick)?.(slot);
					}, 250);
				});
			} else {
				button.addEventListener("click", () => onSlotClick?.(slot));
			}
			card = button;
		} else {
			card = document.createElement("div");
			card.classList.add("team-mate-card--readonly");
		}

		card.classList.add("team-mate-card");
		card.dataset.slot = String(slot);
		if (selectedSlot === slot) card.classList.add("is-selected");

		if (!member) {
			card.classList.add("team-mate-card--empty");
			card.setAttribute("aria-label", (onSlotClick || onSlotTap) ? `${slot}番目の空き枠を選択` : `${slot}番目の空き枠`);
			card.textContent = String(slot);
		} else {
			card.setAttribute(
				"aria-label",
				(onSlotClick || onSlotTap) ? `${displayName(member)}、${slot}番目の枠を選択` : `${displayName(member)}、${slot}番目の枠`,
			);
			const sprite = document.createElement("img");
			sprite.className = "team-mate-card__art";
			sprite.alt = "";
			sprite.draggable = false;
			sprite.style.display = "none";
			const fallback = document.createElement("span");
			fallback.className = "team-mate-card__fallback";
			card.append(sprite, fallback);
			void applySprite(sprite, fallback, member.species_name);

			const itemName = member.item_name?.trim() ?? "";
			if (showItem && itemName) {
				const item = document.createElement("span");
				item.className = "team-mate-card__item";
				const itemImg = document.createElement("img");
				itemImg.alt = "";
				itemImg.draggable = false;
				itemImg.style.display = "none";
				item.appendChild(itemImg);
				card.appendChild(item);
				void applyItemIcon(itemImg, itemName, item);
			}
		}

		root.appendChild(card);
	}
}
