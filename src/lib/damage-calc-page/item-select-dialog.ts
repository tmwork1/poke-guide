import { createItemSelectGrid, sortItemsByUsage } from "../box-id/item-select-dialog";
import { bindModalDismissal } from "../modal-dismiss";
import { itemIconUrl } from "../sprite-urls";
import { getOpponentBuild, setOpponentBuild } from "./shared-core";

type Side = "self" | "opponent";

const CHANGE_EVENT = "damage-calc:change";
const SELF_INITIAL_ITEM = "こだわりハチマキ";
const OPPONENT_INITIAL_ITEM = "たべのこし";

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

export function initItemSelectDialog(): void {
  const backdrop = byId<HTMLElement>("damage-calc-item-select-backdrop");
  const dialog = byId<HTMLElement>("damage-calc-item-select-dialog");
  const closeButton = byId<HTMLButtonElement>("damage-calc-item-select-close-button");
  const gridEl = byId<HTMLElement>("damage-calc-item-select-grid");
  const emptyEl = byId<HTMLElement>("damage-calc-item-select-empty");
  const searchInput = byId<HTMLInputElement>("damage-calc-item-select-search-input");
  const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-damage-calc-item-side]"));
  let activeSide: Side = "self";
  let activeTrigger: HTMLButtonElement | null = null;
  let selfItemName = SELF_INITIAL_ITEM;
  let searchQuery = "";

  function itemNameFor(side: Side): string {
    return side === "self" ? selfItemName : (getOpponentBuild().itemName || OPPONENT_INITIAL_ITEM);
  }

  function syncCardItem(side: Side, itemName: string): void {
    const icon = byId<HTMLImageElement>(`damage-calc-${side}-item-icon`);
    const trigger = triggers.find((button) => button.dataset.damageCalcItemSide === side);
    icon.hidden = itemName === "";
    icon.alt = itemName;
    if (itemName) icon.src = itemIconUrl(itemName);
    trigger?.setAttribute("aria-label", `${side === "self" ? "自分" : "相手"}のもちものを選択${itemName ? `（${itemName}）` : ""}`);
  }

  function closeDialog(): void {
    backdrop.hidden = true;
    dialog.hidden = true;
    activeTrigger?.focus();
  }

  const grid = createItemSelectGrid({
    gridEl,
    emptyEl,
    getActiveValue: () => itemNameFor(activeSide),
    sortRest: (values) => sortItemsByUsage(values, () => 0),
    onSelect: (itemName) => {
      if (activeSide === "self") selfItemName = itemName;
      else setOpponentBuild({ ...getOpponentBuild(), itemName });
      syncCardItem(activeSide, itemName);
      document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason: `${activeSide}-item` } }));
      closeDialog();
    },
  });

  // 相手ビルドは別の初期化処理で候補値を持つ場合があるため、カードの初期アイコンも
  // 実際にモーダルで選択中として扱う値へそろえる。
  syncCardItem("self", selfItemName);
  syncCardItem("opponent", itemNameFor("opponent"));

  async function openDialog(trigger: HTMLButtonElement, side: Side): Promise<void> {
    activeSide = side;
    activeTrigger = trigger;
    await grid.ensureBuilt();
    searchQuery = "";
    searchInput.value = "";
    grid.render(searchQuery);
    backdrop.hidden = false;
    dialog.hidden = false;
    dialog.focus();
  }

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const side = trigger.dataset.damageCalcItemSide;
      if (side === "self" || side === "opponent") void openDialog(trigger, side);
    });
  });
  closeButton.addEventListener("click", closeDialog);
  bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    grid.render(searchQuery);
  });
}
