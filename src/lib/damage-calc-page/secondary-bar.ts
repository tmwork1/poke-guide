import { championSpriteUrl, loadPokemonMasterList, officialArtworkUrl } from "../pokemon-master-data";
import { normalizeForSearch } from "../kana";
import { getOpponentBuild, setOpponentBuild } from "./shared-core";
import { readJsonScriptStringArray } from "../json-script";
import { orderPokemonEntriesForDatalist } from "../owned-pokemon-form";

const CHANGE_EVENT = "damage-calc:change";
const emitChange = (reason: string) => document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason } }));

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function commitOpponentSpecies(speciesName: string): void {
  const previous = getOpponentBuild();
  if (previous.speciesName === speciesName) return;
  setOpponentBuild({ ...previous, speciesName, abilityName: "" });
  emitChange("opponent");
}

export function initSecondaryBar(): void {
  const rail = byId<HTMLElement>("damage-calc-summary-rail");
  const opponentSearch = byId<HTMLInputElement>("damage-calc-opponent-search");
  const opggRankedSpeciesNames = readJsonScriptStringArray("damage-calc-opgg-ranked-species");
  // 相手ポケモンをタップだけで選べるよう、opgg使用率上位の候補をアイコンレールに並べる
  // (/data のbattle-data-railと同じ「候補をアイコン一列に並べる」考え方の流用)。
  loadPokemonMasterList().then((pokemon) => {
    const imageIds = new Map(pokemon.map((entry) => [entry.name, entry.imageId]));
    // 種族選択モーダル(species-select-dialog.ts)と同じ並び順・候補集合にする
    // (orderPokemonEntriesForDatalistのコメント参照)。メガシンカは元々opgg順位が
    // 付かないため、検索前にtop24へ絞る旧実装では検索してもヒットしなかった。
    const orderedNames = orderPokemonEntriesForDatalist(pokemon, opggRankedSpeciesNames);
    const selectOpponent = (name: string) => {
      commitOpponentSpecies(name);
    };
    selectOpponent(getOpponentBuild().speciesName || "サーフゴー");
    const renderRail = () => {
      const query = normalizeForSearch(opponentSearch.value);
      const matchingNames = orderedNames.filter((name) => normalizeForSearch(name).includes(query)).slice(0, 24);
      rail.replaceChildren(...matchingNames.map((name) => {
        const item = document.createElement("button"); item.type = "button"; item.className = "damage-calc-summary-rail-item"; item.ariaLabel = name;
        const imageId = imageIds.get(name);
        if (imageId != null) { const img = document.createElement("img"); img.src = championSpriteUrl(imageId); img.alt = ""; img.onerror = () => { img.onerror = null; img.src = officialArtworkUrl(imageId); }; item.append(img); }
        else item.textContent = name.slice(0, 1);
        item.addEventListener("click", () => selectOpponent(name));
        return item;
      }));
    };
    opponentSearch.addEventListener("input", renderRail);
    renderRail();
  }).catch(() => undefined);
}
