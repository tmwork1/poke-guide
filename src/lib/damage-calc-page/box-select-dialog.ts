import { listOwnedPokemonPage } from "../data/pokemon-repo";
import { ownedPokemonDisplayName, renderBoxPokemonCard } from "../owned-pokemon-card";
import { bindModalDismissal } from "../modal-dismiss";
import type { OwnedPokemonRecord } from "../owned-pokemon";
import { setSelfBuild } from "./shared-core";

const PAGE_SIZE = 48;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function toSelfBuild(pokemon: OwnedPokemonRecord) {
  return {
    id: pokemon.id,
    species_name: pokemon.species_name,
    level: pokemon.level,
    nature: pokemon.nature,
    ability_name: pokemon.ability_name,
    item_name: pokemon.item_name,
    tera_type: pokemon.tera_type,
    evs: pokemon.evs,
    ivs: pokemon.ivs,
    move_names: pokemon.move_names,
  };
}

export function initBoxSelectDialog(): void {
  const trigger = byId<HTMLButtonElement>("damage-calc-pokemon-button");
  const backdrop = byId<HTMLElement>("damage-calc-box-select-backdrop");
  const dialog = byId<HTMLElement>("damage-calc-box-select-dialog");
  const closeButton = byId<HTMLButtonElement>("damage-calc-box-select-close-button");
  const grid = byId<HTMLElement>("damage-calc-box-select-grid");
  const loading = byId<HTMLElement>("damage-calc-box-select-loading");
  const error = byId<HTMLElement>("damage-calc-box-select-error");
  const empty = byId<HTMLElement>("damage-calc-box-select-empty");
  let cachedPokemon: OwnedPokemonRecord[] | null = null;
  let loadingPromise: Promise<void> | null = null;

  function closeDialog(): void {
    backdrop.hidden = true;
    dialog.hidden = true;
    trigger.focus();
  }

  async function selectPokemon(pokemon: OwnedPokemonRecord): Promise<void> {
    setSelfBuild(toSelfBuild(pokemon));
    document.dispatchEvent(new CustomEvent("damage-calc:change", { detail: { reason: "self" } }));
    closeDialog();
  }

  function renderList(pokemon: OwnedPokemonRecord[]): void {
    grid.replaceChildren(...pokemon.map((entry) => {
      const card = document.createElement("button");
      card.type = "button";
      const displayName = ownedPokemonDisplayName(entry);
      renderBoxPokemonCard({
        root: card,
        pokemon: entry,
        displayName,
        ariaLabel: `${displayName}を自分側に設定`,
      });
      card.addEventListener("click", () => void selectPokemon(entry));
      return card;
    }));
    empty.hidden = pokemon.length !== 0;
  }

  async function loadList(): Promise<void> {
    if (cachedPokemon) {
      renderList(cachedPokemon);
      return;
    }
    if (loadingPromise) return loadingPromise;
    loading.hidden = false;
    error.hidden = true;
    empty.hidden = true;
    loadingPromise = (async () => {
      const pokemon: OwnedPokemonRecord[] = [];
      let hasMore = true;
      while (hasMore) {
        const page = await listOwnedPokemonPage({ limit: PAGE_SIZE, offset: pokemon.length });
        pokemon.push(...page.data);
        hasMore = page.hasMore && page.data.length > 0;
        if (hasMore && page.data.length > 0) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      cachedPokemon = pokemon;
      renderList(pokemon);
    })().catch((cause: unknown) => {
      console.error(cause);
      error.textContent = "個体一覧を読み込めませんでした。時間をおいて再度お試しください。";
      error.hidden = false;
    }).finally(() => {
      loading.hidden = true;
      loadingPromise = null;
    });
    return loadingPromise;
  }

  async function openDialog(): Promise<void> {
    backdrop.hidden = false;
    dialog.hidden = false;
    dialog.focus();
    await loadList();
  }

  trigger.addEventListener("click", () => void openDialog());
  closeButton.addEventListener("click", closeDialog);
  bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
}
