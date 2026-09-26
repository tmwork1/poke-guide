import { championSpriteIconUrl, loadPokemonMasterList, officialArtworkUrl } from "../pokemon-master-data";
import { normalizeForSearch } from "../kana";
import { splitSearchTokens } from "../search-tokens";
import { getOpponentBuild, setOpponentBuild } from "./shared-core";
import { readJsonScriptStringArray } from "../json-script";
import { orderPokemonEntriesForDatalist } from "../owned-pokemon-form";

const CHANGE_EVENT = "damage-calc:change";
const OPPONENT_HISTORY_STORAGE_KEY = "poke-commons:damage-calc:opponent-history";
const OPPONENT_HISTORY_LIMIT = 5;
const emitChange = (reason: string) => document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason } }));

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function loadOpponentHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(OPPONENT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((name): name is string => typeof name === "string" && name.trim() !== ""))]
      .slice(0, OPPONENT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function recordOpponentSpecies(speciesName: string): void {
  const history = loadOpponentHistory().filter((name) => name !== speciesName);
  history.unshift(speciesName);
  try {
    window.localStorage.setItem(OPPONENT_HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, OPPONENT_HISTORY_LIMIT)));
  } catch {
    // localStorage may be unavailable, so leave the rail's default ordering intact.
  }
}

function commitOpponentSpecies(speciesName: string, options: { silent?: boolean } = {}): void {
  const previous = getOpponentBuild();
  recordOpponentSpecies(speciesName);
  if (previous.speciesName === speciesName) return;
  setOpponentBuild({ ...previous, speciesName, abilityName: "" });
  if (!options.silent) emitChange("opponent");
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
      renderRail();
    };
    // 初期デフォルト相手は、対面カードの初回run()が埋め込みJSON(damage-calc-opgg-ranked-species)
    // から導く既定値と同じもの。ここでイベントを発火すると同内容のカードが再構築されるだけなので、
    // 状態への反映と対戦履歴への記録(recordOpponentSpecies)だけ行い、通知は出さない。
    commitOpponentSpecies(getOpponentBuild().speciesName || opggRankedSpeciesNames[0] || "サーフゴー", { silent: true });
    function renderRail(): void {
      const tokens = splitSearchTokens(opponentSearch.value).map(normalizeForSearch);
      const matchingNames = tokens.length > 0
        ? orderedNames.filter((name) => {
          const normalizedName = normalizeForSearch(name);
          return tokens.every((token) => normalizedName.includes(token));
        })
        : [
          ...loadOpponentHistory().filter((name) => orderedNames.includes(name)),
          ...orderedNames,
        ];
      // レールは縦スクロールできるため、主要候補に加えて環境外のポケモンも選べるよう60件まで表示する。
      const visibleNames = [...new Set(matchingNames)].slice(0, 60);
      rail.replaceChildren(...visibleNames.map((name) => {
        const item = document.createElement("button"); item.type = "button"; item.className = "damage-calc-summary-rail-item"; item.ariaLabel = name;
        const imageId = imageIds.get(name);
        if (imageId != null) { const img = document.createElement("img"); img.src = championSpriteIconUrl(imageId); img.alt = ""; img.onerror = () => { img.onerror = null; img.src = officialArtworkUrl(imageId); }; item.append(img); }
        else item.textContent = name.slice(0, 1);
        item.addEventListener("click", () => selectOpponent(name));
        return item;
      }));
    }
    opponentSearch.addEventListener("input", renderRail);
    renderRail();
  }).catch(() => undefined);
}
