import { loadAbilitiesMap, loadMoveDetailMap, loadPokemonMasterList } from "../pokemon-master-data";
import { getOpponentBuild, getSelectedTeam, setOpponentBuild, setSelectedTeam, type SelectedTeam, type TeamMemberSpecInput } from "./shared-core";
import type { Team } from "../team";

const CHANGE_EVENT = "damage-calc:change";
const emitChange = (reason: string) => document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason } }));

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function toSelectedTeam(team: Team): SelectedTeam {
  const members: TeamMemberSpecInput[] = team.members.map((member) => ({
    slot: member.slot, itemOverride: member.item_override, ownedPokemon: member.owned_pokemon,
  }));
  return { id: team.id, members, selectedMemberId: members[0]?.ownedPokemon.id ?? null };
}

export function initSecondaryBar(): void {
  const raw = byId<HTMLScriptElement>("damage-calc-teams-data").textContent ?? "[]";
  const teams = JSON.parse(raw) as Team[];
  const teamButton = byId<HTMLButtonElement>("damage-calc-team-button");
  const dialog = byId<HTMLDialogElement>("damage-calc-team-dialog");
  const teamList = byId<HTMLElement>("damage-calc-team-list");
  const summary = byId<HTMLElement>("damage-calc-selection-summary");
  const opponentButton = byId<HTMLButtonElement>("damage-calc-opponent-button");
  const opponentPanel = byId<HTMLElement>("damage-calc-opponent-panel");
  const speciesInput = byId<HTMLInputElement>("damage-calc-opponent-species");
  const abilitySelect = byId<HTMLSelectElement>("damage-calc-opponent-ability");
  const itemInput = byId<HTMLInputElement>("damage-calc-opponent-item");
  const teraSelect = byId<HTMLSelectElement>("damage-calc-opponent-tera");
  const validation = byId<HTMLElement>("damage-calc-opponent-validation");
  const moveInputs = Array.from(document.querySelectorAll<HTMLInputElement>(".damage-calc-opponent-move"));
  const pokemonList = byId<HTMLDataListElement>("damage-calc-pokemon-list");
  const moveList = byId<HTMLDataListElement>("damage-calc-move-list");
  let pokemonNames = new Set<string>();
  let abilitiesBySpecies = new Map<string, string[]>();
  let moveNames = new Set<string>();
  let moveSlots = ["", "", "", ""];

  const renderSummary = () => {
    const selected = getSelectedTeam();
    summary.textContent = selected ? `選択中: ${teams.find((team) => team.id === selected.id)?.memo || `チーム（${selected.members.length}体）`}` : "チームを選択してください";
  };
  const renderTeamChoices = () => {
    teamList.replaceChildren();
    if (teams.length === 0) {
      const empty = document.createElement("p"); empty.textContent = "チームがありません。";
      const link = document.createElement("a"); link.href = "/team"; link.className = "btn-primary"; link.textContent = "チームを登録";
      teamList.append(empty, link); return;
    }
    teams.forEach((team, index) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "damage-calc-team-choice";
      button.textContent = team.memo?.trim() || `チーム ${index + 1}（${team.members.length}体）`;
      button.addEventListener("click", () => { setSelectedTeam(toSelectedTeam(team)); dialog.close(); renderSummary(); emitChange("team"); });
      teamList.append(button);
    });
  };
  const setAbilityOptions = () => {
    const build = getOpponentBuild();
    const abilities = abilitiesBySpecies.get(build.speciesName) ?? [];
    abilitySelect.replaceChildren(new Option("特性を選択", ""), ...abilities.map((ability) => new Option(ability, ability)));
    abilitySelect.value = build.abilityName;
    abilitySelect.disabled = !build.speciesName || abilities.length === 0;
  };
  const commitSpecies = () => {
    const speciesName = speciesInput.value.trim();
    if (!pokemonNames.has(speciesName)) { validation.textContent = speciesName ? "候補から実在するポケモンを選択してください。" : ""; return; }
    const previous = getOpponentBuild();
    if (previous.speciesName === speciesName) return;
    setOpponentBuild({ ...previous, speciesName, abilityName: "" });
    validation.textContent = ""; setAbilityOptions(); emitChange("opponent");
  };
  const commitMoves = () => {
    const valid = moveSlots.filter(Boolean);
    setOpponentBuild({ ...getOpponentBuild(), moveNames: valid });
    emitChange("opponent-moves");
  };

  teamButton.addEventListener("click", () => dialog.showModal());
  byId<HTMLButtonElement>("damage-calc-team-dialog-close").addEventListener("click", () => dialog.close());
  opponentButton.addEventListener("click", () => { opponentPanel.hidden = !opponentPanel.hidden; if (!opponentPanel.hidden) speciesInput.focus(); });
  speciesInput.addEventListener("change", commitSpecies);
  speciesInput.addEventListener("keydown", (event) => { if (event.key === "Enter") commitSpecies(); });
  abilitySelect.addEventListener("change", () => { setOpponentBuild({ ...getOpponentBuild(), abilityName: abilitySelect.value }); emitChange("opponent"); });
  itemInput.addEventListener("change", () => { setOpponentBuild({ ...getOpponentBuild(), itemName: itemInput.value.trim() }); emitChange("opponent"); });
  teraSelect.addEventListener("change", () => { setOpponentBuild({ ...getOpponentBuild(), teraType: teraSelect.value }); emitChange("opponent"); });
  moveInputs.forEach((input, index) => input.addEventListener("change", () => {
    const name = input.value.trim();
    if (name && !moveNames.has(name)) { validation.textContent = `「${name}」は候補から選択してください。`; input.value = moveSlots[index]; return; }
    validation.textContent = ""; moveSlots[index] = name; commitMoves();
  }));

  renderTeamChoices(); renderSummary();
  Promise.all([loadPokemonMasterList(), loadAbilitiesMap(), loadMoveDetailMap()]).then(([pokemon, abilities, moves]) => {
    pokemonNames = new Set(pokemon.map((entry) => entry.name)); abilitiesBySpecies = abilities; moveNames = new Set(moves.keys());
    pokemonList.replaceChildren(...pokemon.map((entry) => new Option(entry.name)));
    moveList.replaceChildren(...Array.from(moves.keys(), (name) => new Option(name)));
    const build = getOpponentBuild(); speciesInput.value = build.speciesName; itemInput.value = build.itemName; teraSelect.value = build.teraType;
    moveSlots = [...build.moveNames, "", "", "", ""].slice(0, 4); moveInputs.forEach((input, index) => { input.value = moveSlots[index]; }); setAbilityOptions();
  }).catch(() => { validation.textContent = "候補データの読み込みに失敗しました。再読み込みしてください。"; });
}
