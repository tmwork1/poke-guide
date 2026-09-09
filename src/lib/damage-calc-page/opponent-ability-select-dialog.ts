import { normalizeForSearch } from "../kana";
import { bindModalDismissal } from "../modal-dismiss";
import { getOpponentBuild, setOpponentBuild } from "./shared-core";

const CHANGE_EVENT = "damage-calc:change";

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

let openDialog: ((trigger: HTMLButtonElement, abilities: readonly string[]) => void) | null = null;

export function openOpponentAbilitySelectDialog(trigger: HTMLButtonElement, abilities: readonly string[]): void {
  openDialog?.(trigger, abilities);
}

export function initOpponentAbilitySelectDialog(): void {
  const backdrop = byId<HTMLElement>("damage-calc-opponent-ability-select-backdrop");
  const dialog = byId<HTMLElement>("damage-calc-opponent-ability-select-dialog");
  const closeButton = byId<HTMLButtonElement>("damage-calc-opponent-ability-select-close-button");
  const grid = byId<HTMLElement>("damage-calc-opponent-ability-select-grid");
  const empty = byId<HTMLElement>("damage-calc-opponent-ability-select-empty");
  const searchInput = byId<HTMLInputElement>("damage-calc-opponent-ability-select-search-input");
  let activeTrigger: HTMLButtonElement | null = null;
  let abilities: string[] = [];

  function closeDialog(): void {
    backdrop.hidden = true;
    dialog.hidden = true;
    activeTrigger?.focus();
  }

  function render(): void {
    const query = normalizeForSearch(searchInput.value.trim());
    const options = ["", ...abilities].filter((ability) => !query || normalizeForSearch(ability || "特性なし").includes(query));
    const currentAbility = getOpponentBuild().abilityName;
    grid.hidden = options.length === 0;
    empty.hidden = options.length !== 0;
    grid.replaceChildren(...options.map((ability) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "item-select-cell";
      cell.dataset.value = ability;
      cell.setAttribute("role", "option");
      cell.setAttribute("aria-selected", String(currentAbility === ability));
      cell.classList.toggle("is-active", currentAbility === ability);
      const label = ability || "特性なし";
      cell.ariaLabel = label;
      cell.title = label;
      const text = document.createElement("span");
      text.className = "item-select-cell-text";
      text.textContent = label;
      cell.append(text);
      cell.addEventListener("click", () => {
        setOpponentBuild({ ...getOpponentBuild(), abilityName: ability });
        document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason: "opponent-ability", abilityName: ability } }));
        closeDialog();
      });
      return cell;
    }));
  }

  openDialog = (trigger, nextAbilities) => {
    activeTrigger = trigger;
    abilities = [...new Set(nextAbilities.filter(Boolean))];
    searchInput.value = "";
    render();
    backdrop.hidden = false;
    dialog.hidden = false;
    dialog.focus();
  };
  closeButton.addEventListener("click", closeDialog);
  bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
  searchInput.addEventListener("input", render);
}
