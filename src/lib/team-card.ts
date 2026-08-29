import {
	renderBoxPokemonCard,
	type BoxPokemonCardPokemon,
} from "./box-pokemon-card";
import { playCardDeleteExitEffect } from "./card-delete-mode";

export interface TeamMemberCardContent {
	pokemon: BoxPokemonCardPokemon;
	displayName: string;
	ariaLabel: string;
	onDelete?: () => void | Promise<void>;
}

export interface RenderTeamMemberGridOptions<M> {
	membersBySlot: ReadonlyMap<number, M>;
	toCardContent: (member: M, slot: number) => TeamMemberCardContent;
}

export interface TeamCardBadgeContent {
	className: string;
	text: string;
	title?: string;
}

export interface TeamCardPlainMetaContent {
	className: string;
	text: string;
	title?: string;
}

export interface TeamCardMemoContent {
	text?: string;
	title?: string;
	ariaLabel?: string;
}

export type TeamCardCornerAction = {
			type: "link";
			href: string;
			label: string;
			title?: string;
			content: Node;
	};

export interface RenderTeamCardOptions<M> extends RenderTeamMemberGridOptions<M> {
	href?: string;
	ariaLabel?: string;
	name: string;
	nameTitle?: string;
	cornerAction?: TeamCardCornerAction;
	onDelete?: () => void | Promise<void>;
	/** 指定時は空でも要素を作る。非表示要素をDOMに残す /team の既存仕様を保つため。 */
	memo?: TeamCardMemoContent;
	badges?: readonly TeamCardBadgeContent[];
	plainMeta?: readonly TeamCardPlainMetaContent[];
	headerVariant?: "inline";
	/** 指定時は既定の box-card グリッド(renderTeamMemberGrid)の代わりにこれを呼び、
	    メンバー表示部分のDOMを呼び出し側に委ねる(例: /team一覧の圧縮表示)。 */
	renderMembers?: (container: HTMLElement) => void;
}

/** チームカード(team/index.astro)と上位構築カード(ranked-teams/card.ts)で共有する6枠メンバーグリッド。 */
export function renderTeamMemberGrid<M>(root: HTMLElement, options: RenderTeamMemberGridOptions<M>): void {
	root.className = "box-grid";
	root.replaceChildren();
	for (let slot = 1; slot <= 6; slot += 1) {
		const member = options.membersBySlot.get(slot);
		if (!member) {
			const empty = document.createElement("div");
			empty.className = "card box-card card-team-empty-slot";
			empty.setAttribute("aria-hidden", "true");
			const slotNumber = document.createElement("span");
			slotNumber.className = "team-slot-number";
			slotNumber.textContent = String(slot);
			empty.appendChild(slotNumber);
			root.appendChild(empty);
			continue;
		}

		const content = options.toCardContent(member, slot);
		const cardRoot = document.createElement("div");
		renderBoxPokemonCard({ root: cardRoot, ...content });
		root.appendChild(cardRoot);
	}
}

/**
 * チーム一覧と類似構築で共有する、ヘッダ帯から6枠までを含むカード本体。
 * href があるカードだけリンクにし、類似構築は記事リンクを内包できる article にする。
 */
export function renderTeamCard<M>(options: RenderTeamCardOptions<M>): HTMLElement {
	const card = document.createElement(options.href === undefined ? "article" : "a");
	card.className = "card-team";
	if (options.headerVariant === "inline") card.classList.add("card-team--top-build");
	if (options.href !== undefined) (card as HTMLAnchorElement).href = options.href;
	if (options.ariaLabel !== undefined) card.setAttribute("aria-label", options.ariaLabel);

	// 右上の外部記事リンクは通常カードだけに置く。inline見出しの場合は下で見出し内に置く。
	if (options.cornerAction?.type === "link" && options.headerVariant !== "inline") {
		const action = options.cornerAction;
		const link = document.createElement("a");
		link.className = "card-team-article-link";
		link.href = action.href;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.title = action.title ?? action.label;
		link.setAttribute("aria-label", action.label);
		link.appendChild(action.content);
		card.appendChild(link);
	}

	if (options.onDelete) {
		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "card-team-delete";
		// 全画面で使う×アイコンと同じSVG。非表示でもDOMは従来どおり残す。
		deleteButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
		deleteButton.title = "削除";
		deleteButton.setAttribute("aria-label", "削除");
		deleteButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void (async () => {
				await playCardDeleteExitEffect(card);
				await options.onDelete?.();
			})();
		});
		card.appendChild(deleteButton);
	}

	const metaRow = document.createElement("div");
	metaRow.className = options.headerVariant === "inline"
		? "card-team-meta-row card-team-meta-row--inline"
		: "card-team-meta-row";
	if (options.memo !== undefined) {
		const memo = document.createElement("p");
		memo.className = "card-team-memo";
		if (options.memo.text !== undefined) memo.textContent = options.memo.text;
		if (options.memo.title !== undefined) memo.title = options.memo.title;
		if (options.memo.ariaLabel !== undefined) memo.setAttribute("aria-label", options.memo.ariaLabel);
		metaRow.appendChild(memo);
	}
	for (const badgeContent of options.badges ?? []) {
		const badge = document.createElement("span");
		badge.className = badgeContent.className;
		badge.textContent = badgeContent.text;
		if (badgeContent.title !== undefined) badge.title = badgeContent.title;
		metaRow.appendChild(badge);
	}
	for (const plainMetaContent of options.plainMeta ?? []) {
		const plainMeta = document.createElement("span");
		plainMeta.className = plainMetaContent.className;
		plainMeta.textContent = plainMetaContent.text;
		if (plainMetaContent.title !== undefined) plainMeta.title = plainMetaContent.title;
		metaRow.appendChild(plainMeta);
	}
	if (options.headerVariant !== "inline") card.appendChild(metaRow);

	const header = document.createElement("div");
	header.className = options.headerVariant === "inline"
		? "card-team-header card-team-header--inline"
		: "card-team-header";
	if (options.headerVariant === "inline") header.appendChild(metaRow);
	const name = document.createElement("p");
	name.className = "card-team-name";
	name.textContent = options.name;
	name.title = options.nameTitle ?? options.name;
	header.appendChild(name);
	if (options.cornerAction?.type === "link" && options.headerVariant === "inline") {
		const action = options.cornerAction;
		const link = document.createElement("a");
		link.className = "card-team-article-link card-team-article-link--inline";
		link.href = action.href;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.title = action.title ?? action.label;
		link.setAttribute("aria-label", action.label);
		link.appendChild(action.content);
		header.appendChild(link);
	}
	card.appendChild(header);

	const memberGrid = document.createElement("div");
	if (options.renderMembers) {
		options.renderMembers(memberGrid);
	} else {
		renderTeamMemberGrid(memberGrid, options);
	}
	card.appendChild(memberGrid);
	return card;
}
