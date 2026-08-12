import {
	renderBoxPokemonCard,
	type BoxPokemonCardPinOptions,
	type BoxPokemonCardPokemon,
} from "./box-pokemon-card";

export interface TeamMemberCardContent {
	pokemon: BoxPokemonCardPokemon;
	displayName: string;
	ariaLabel: string;
	pin?: BoxPokemonCardPinOptions;
	onDelete?: () => void | Promise<void>;
}

export interface RenderTeamMemberGridOptions<M> {
	membersBySlot: ReadonlyMap<number, M>;
	toCardContent: (member: M, slot: number) => TeamMemberCardContent;
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
