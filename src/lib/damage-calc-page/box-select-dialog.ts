import { listOwnedPokemonPage } from "../data/pokemon-repo";
import {
  ownedPokemonDisplayName,
  renderBoxPokemonCard,
} from "../owned-pokemon-card";
import { bindModalDismissal } from "../modal-dismiss";
import type { OwnedPokemonRecord } from "../owned-pokemon";
import { kanaIncludes } from "../kana";
import { splitSearchTokens } from "../search-tokens";
import { setSelfBuilds } from "./shared-core";

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

let openDialogFn: (() => Promise<void>) | null = null;

/** 対面カードの自分側立ち絵タップなど、トリガーボタン以外からモーダルを開くための入口。 */
export function openBoxSelectDialog(): void {
  void openDialogFn?.();
}

export function initBoxSelectDialog(): void {
  const trigger = byId<HTMLButtonElement>("damage-calc-pokemon-button");
  const backdrop = byId<HTMLElement>("damage-calc-box-select-backdrop");
  const dialog = byId<HTMLElement>("damage-calc-box-select-dialog");
  const closeButton = byId<HTMLButtonElement>(
    "damage-calc-box-select-close-button",
  );
  const grid = byId<HTMLElement>("damage-calc-box-select-grid");
  const loading = byId<HTMLElement>("damage-calc-box-select-loading");
  const error = byId<HTMLElement>("damage-calc-box-select-error");
  const empty = byId<HTMLElement>("damage-calc-box-select-empty");
  const searchInput = byId<HTMLInputElement>("damage-calc-box-select-search-input");
  let cachedPokemon: OwnedPokemonRecord[] | null = null;
  let loadingPromise: Promise<void> | null = null;
  let searchQuery = "";
  let searchFocusFrame: number | null = null;

  // /box の検索と同じく、半角・全角スペース区切りの語をすべて含むものだけを残す。
  function filterBySearch(entries: OwnedPokemonRecord[]): OwnedPokemonRecord[] {
    const tokens = splitSearchTokens(searchQuery);
    if (tokens.length === 0) return entries;
    return entries.filter((entry) => {
      const name = ownedPokemonDisplayName(entry);
      return tokens.every((token) => kanaIncludes(name, token));
    });
  }

  function cancelScheduledSearchFocus(): void {
    if (searchFocusFrame !== null) window.cancelAnimationFrame(searchFocusFrame);
    searchFocusFrame = null;
  }

  // モーダルの初回レイアウトが確定してからフォーカスする。preventScrollも併用して、
  // フォーカスに伴う背面・モーダル内スクロール位置の移動を防ぐ。
  function focusSearchAfterOpen(): void {
    cancelScheduledSearchFocus();
    searchFocusFrame = window.requestAnimationFrame(() => {
      searchFocusFrame = window.requestAnimationFrame(() => {
        searchFocusFrame = null;
        if (!dialog.hidden) searchInput.focus({ preventScroll: true });
      });
    });
  }

  function closeDialog(): void {
    cancelScheduledSearchFocus();
    backdrop.hidden = true;
    dialog.hidden = true;
    trigger.focus();
  }

  function selectPokemon(pokemon: OwnedPokemonRecord, artworkUrl: string): void {
    setSelfBuilds([toSelfBuild(pokemon)]);
    closeDialog();
    // 対面カードの初期描画は同期処理を含む。モーダルを先に確実に描画から外してから
    // 次フレームで通知し、タップ後にモーダルが静止して見える時間をなくす。
    window.requestAnimationFrame(() => {
      document.dispatchEvent(
        new CustomEvent("damage-calc:change", { detail: { reason: "self", artworkUrl } }),
      );
    });
  }

  function renderList(pokemon: OwnedPokemonRecord[]): void {
    grid.replaceChildren(
      ...pokemon.map((entry) => {
        const card = document.createElement("button");
        card.type = "button";
        const displayName = ownedPokemonDisplayName(entry);
        renderBoxPokemonCard({
          root: card,
          pokemon: entry,
          displayName,
          ariaLabel: `${displayName}を自分側に設定`,
        });
        card.addEventListener("click", () => {
          // 一覧カードで既に解決済みの画像をそのまま対面カードへ渡す。
          // マスターデータの取得完了を待たず、選択直後の立ち絵表示を可能にする。
          const artwork = card.querySelector<HTMLImageElement>(".card-artwork img");
          selectPokemon(entry, artwork?.currentSrc || artwork?.src || "");
        });
        return card;
      }),
    );
    empty.hidden = pokemon.length !== 0;
  }

  async function loadList(): Promise<void> {
    if (cachedPokemon) {
      renderList(filterBySearch(cachedPokemon));
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
        const page = await listOwnedPokemonPage({
          limit: PAGE_SIZE,
          offset: pokemon.length,
        });
        pokemon.push(...page.data);
        hasMore = page.hasMore && page.data.length > 0;
        if (hasMore && page.data.length > 0)
          await new Promise<void>((resolve) =>
            window.requestAnimationFrame(() => resolve()),
          );
      }
      cachedPokemon = pokemon;
      renderList(filterBySearch(pokemon));
    })()
      .catch((cause: unknown) => {
        console.error(cause);
        error.textContent =
          "ポケモン一覧を読み込めませんでした。時間をおいて再度お試しください。";
        error.hidden = false;
      })
      .finally(() => {
        loading.hidden = true;
        loadingPromise = null;
      });
    return loadingPromise;
  }

  async function openDialog(): Promise<void> {
    searchQuery = "";
    searchInput.value = "";
    backdrop.hidden = false;
    dialog.hidden = false;
    dialog.focus();
    await loadList();
    focusSearchAfterOpen();
  }

  trigger.addEventListener("click", () => void openDialog());
  closeButton.addEventListener("click", closeDialog);
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    if (cachedPokemon) renderList(filterBySearch(cachedPokemon));
  });
  bindModalDismissal({
    backdrop,
    dialog,
    isOpen: () => !dialog.hidden,
    onDismiss: closeDialog,
  });
  openDialogFn = openDialog;
}
