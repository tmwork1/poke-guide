import { championSpriteUrl, loadPokemonMasterList, officialArtworkUrl } from "../pokemon-master-data";
import { getOpponentBuild, setOpponentBuild } from "./shared-core";
import { readJsonScriptStringArray } from "../json-script";

const CHANGE_EVENT = "damage-calc:change";
const emitChange = (reason: string) => document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason } }));

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function commitOpponentSpecies(speciesName: string): void {
  const previous = getOpponentBuild();
  if (previous.speciesName === speciesName) return;
  setOpponentBuild({ ...previous, speciesName, abilityName: "" });
  emitChange("opponent");
}

function syncOpponentCard(speciesName: string, imageId: number | undefined): void {
  const name = byId<HTMLElement>("damage-calc-opponent-name");
  const artwork = byId<HTMLImageElement>("damage-calc-opponent-artwork");
  name.textContent = speciesName;
  artwork.alt = speciesName;
  if (imageId != null) {
    artwork.src = championSpriteUrl(imageId);
    artwork.onerror = () => { artwork.onerror = null; artwork.src = officialArtworkUrl(imageId); };
  }
}

export function initSecondaryBar(): void {
  const rail = byId<HTMLElement>("damage-calc-summary-rail");
  const opponentSelect = byId<HTMLSelectElement>("damage-calc-opponent-select");
  const opggRankedSpeciesNames = readJsonScriptStringArray("damage-calc-opgg-ranked-species");
  // 相手ポケモンをタップだけで選べるよう、opgg使用率上位の候補をアイコンレールに並べる
  // (/data のbattle-data-railと同じ「候補をアイコン一列に並べる」考え方の流用)。
  loadPokemonMasterList().then((pokemon) => {
    const imageIds = new Map(pokemon.map((entry) => [entry.name, entry.imageId]));
    opponentSelect.replaceChildren(...pokemon.map((entry) => {
      const option = document.createElement("option"); option.value = entry.name; option.textContent = entry.name;
      return option;
    }));
    const selectOpponent = (name: string) => {
      opponentSelect.value = name;
      commitOpponentSpecies(name);
      syncOpponentCard(name, imageIds.get(name));
    };
    selectOpponent(getOpponentBuild().speciesName || "サーフゴー");
    opponentSelect.addEventListener("change", () => selectOpponent(opponentSelect.value));
    rail.replaceChildren(...opggRankedSpeciesNames.slice(0, 24).map((name) => {
      const item = document.createElement("button"); item.type = "button"; item.className = "damage-calc-summary-rail-item"; item.ariaLabel = name;
      const imageId = imageIds.get(name);
      if (imageId != null) { const img = document.createElement("img"); img.src = championSpriteUrl(imageId); img.alt = ""; img.onerror = () => { img.onerror = null; img.src = officialArtworkUrl(imageId); }; item.append(img); }
      else item.textContent = name.slice(0, 1);
      item.addEventListener("click", () => selectOpponent(name));
      return item;
    }));
  }).catch(() => undefined);
}
