import { createItemSelectGrid, sortItemsByUsage } from "../box-id/item-select-dialog";
import { bindModalDismissal } from "../modal-dismiss";
import { itemIconUrl } from "../sprite-urls";
import { getOpponentBuild, setOpponentBuild } from "./shared-core";

type Side = "self" | "opponent";

const CHANGE_EVENT = "damage-calc:change";
const SELF_INITIAL_ITEM = "こだわりハチマキ";
const OPPONENT_INITIAL_ITEM = "たべのこし";

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

type OpggUsageResponse = { options: { name: string; usageRate: number | null }[] };

// /box のもちもの選択モーダル(box-id/item-select-dialog.ts)と同じく、OP.GGの持ち物使用率で
// 候補を並べる。取得は種族ごとに1回だけ・直列(同時リクエストは開発サーバーで詰まる)。
const usageRatiosBySpecies = new Map<string, Map<string, number>>();
let usageFetchChain: Promise<unknown> = Promise.resolve();

async function fetchItemUsageRatios(speciesName: string): Promise<Map<string, number>> {
  const cached = usageRatiosBySpecies.get(speciesName);
  if (cached) return cached;
  const ratios = new Map<string, number>();
  try {
    const res = await fetch(`/api/opgg-usage?species=${encodeURIComponent(speciesName)}&category=items`);
    if (res.ok) {
      const json = await res.json() as OpggUsageResponse;
      for (const row of json.options) {
        if (row.usageRate != null) ratios.set(row.name, row.usageRate / 100);
      }
    }
  } catch {
    // 使用率が取れないときは並び替えなし(マスタの五十音順)へフォールバックする。
  }
  usageRatiosBySpecies.set(speciesName, ratios);
  return ratios;
}

/** 同時に投げず、直前の取得の完了後に続けて実行する。 */
function queueItemUsageFetch(speciesName: string): Promise<Map<string, number>> {
  const next = usageFetchChain.then(() => fetchItemUsageRatios(speciesName));
  usageFetchChain = next.catch(() => undefined);
  return next;
}

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

  function speciesNameFor(side: Side): string {
    if (side === "opponent") {
      return getOpponentBuild().speciesName || byId<HTMLElement>("damage-calc-opponent-name").textContent?.trim() || "";
    }
    return byId<HTMLElement>("damage-calc-matchup-title").textContent?.trim() || "";
  }

  function itemNameFor(side: Side): string {
    return side === "self" ? selfItemName : (getOpponentBuild().itemName || OPPONENT_INITIAL_ITEM);
  }

  function syncCardItem(side: Side, itemName: string): void {
    const icon = byId<HTMLImageElement>(`damage-calc-${side}-item-icon`);
    // もちものなしも空欄にはせず、モーダルの「なし」と同じ○＋斜線アイコンで示す。
    const noneIcon = document.getElementById(`damage-calc-${side}-item-none-icon`) as Element;
    const trigger = triggers.find((button) => button.dataset.damageCalcItemSide === side);
    icon.hidden = itemName === "";
    noneIcon.toggleAttribute("hidden", itemName !== "");
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
    sortRest: (values) => sortItemsByUsage(values, (value) => usageRatiosBySpecies.get(speciesNameFor(activeSide))?.get(value)),
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
    const speciesName = speciesNameFor(side);
    if (speciesName) await queueItemUsageFetch(speciesName);
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
