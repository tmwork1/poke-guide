import { getOpponentBuild, getSelectedTeam } from "./shared-core";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function renderSummary(): void {
  const opponent = getOpponentBuild();
  const list = byId<HTMLElement>("damage-calc-summary-list");
  list.replaceChildren();
  if (!opponent.speciesName) return;

  const team = getSelectedTeam();
  if (!team?.members.length) return;

  team.members.forEach((member, index) => {
    const card = document.createElement("div");
    card.className = "card damage-calc-summary-card";
    card.id = `damage-calc-summary-card-${index}`;

    const name = document.createElement("strong");
    name.textContent = member.ownedPokemon.species_name;
    const item = document.createElement("span");
    item.textContent = member.ownedPokemon.item_name || "もちものなし";
    const versus = document.createElement("span");
    versus.textContent = `vs ${opponent.speciesName}`;
    card.append(name, item, versus);
    list.append(card);
  });
}

export function initMatchupCardList(): void {
  document.addEventListener("damage-calc:change", renderSummary);
  renderSummary();
}
