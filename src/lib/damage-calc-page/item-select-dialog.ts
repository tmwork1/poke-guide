import { createItemSelectGrid, sortItemsByUsage } from "../box-id/item-select-dialog";
import { bindModalDismissal } from "../modal-dismiss";
import { itemIconUrl } from "../sprite-urls";
import { getOpponentBuild, getSelfBuilds, setOpponentBuild, setSelfBuildAt } from "./shared-core";

type Side = "self" | "opponent";

const CHANGE_EVENT = "damage-calc:change";
function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

type OpggUsageResponse = { options: { name: string; usageRate: number | null }[] };

// /box のもちもの選択モーダル(box-id/item-select-dialog.ts)と同じく、OP.GGの持ち物使用率で
// 候補を並べる。取得は種族ごとに1回だけ・直列(同時リクエストは開発サーバーで詰まる)。
const usageRatiosBySpecies = new Map<string, Map<string, number>>();
let usageFetchChain: Promise<unknown> = Promise.resolve();

/** もちものアイコン(選択済み画像 or ○＋斜線の「なし」)の描画。matchup-card.ts もカード生成時の
 * 初期表示にこれを使う(アイコンの見た目の定義元をここ1箇所にまとめるため)。 */
export function renderItemIcon(iconEl: HTMLImageElement, noneIconEl: Element, itemName: string): void {
  iconEl.hidden = itemName === "";
  noneIconEl.toggleAttribute("hidden", itemName !== "");
  iconEl.alt = itemName;
  if (itemName) iconEl.src = itemIconUrl(itemName);
}

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
  let activeSide: Side = "self";
  // 自分側は対面カードが複数枚あるため、どのカードのボタンを押したかを覚えておく
  // (getSelfBuilds()配列の添字。matchup-card.ts がカード生成時にトリガーへ書き込む)。
  let activeCardIndex = 0;
  let activeTrigger: HTMLButtonElement | null = null;
  let searchQuery = "";

  function speciesNameFor(side: Side): string {
    if (side === "opponent") {
      return getOpponentBuild().speciesName || document.querySelector<HTMLElement>('[data-role="opponent-name"]')?.textContent?.trim() || "";
    }
    return getSelfBuilds()[activeCardIndex]?.species_name ?? "";
  }

  function itemNameFor(side: Side): string {
    return side === "self" ? (getSelfBuilds()[activeCardIndex]?.item_name || "") : (getOpponentBuild().itemName || "");
  }

  // 相手側の情報は対面カード全枚に複製表示されているため、相手のもちものを選び直したときは
  // 表示中の全カードのアイコンをそろえて更新する。自分側は今まさに開いているダイアログが
  // 属するカード(activeTrigger)のアイコンだけを更新すればよい(他のカードは自分の選択値の
  // ままで変わらない)。
  function syncCardItem(side: Side, itemName: string): void {
    if (side === "self") {
      const cardRoot = activeTrigger?.closest(".damage-calc-matchup-card");
      const icon = cardRoot?.querySelector<HTMLImageElement>('[data-role="self-item-icon"]');
      const noneIcon = cardRoot?.querySelector('[data-role="self-item-none-icon"]');
      if (icon && noneIcon) renderItemIcon(icon, noneIcon, itemName);
    } else {
      const icons = document.querySelectorAll<HTMLImageElement>('[data-role="opponent-item-icon"]');
      const noneIcons = document.querySelectorAll('[data-role="opponent-item-none-icon"]');
      icons.forEach((icon, index) => {
        const noneIcon = noneIcons[index];
        if (noneIcon) renderItemIcon(icon, noneIcon, itemName);
      });
    }
    activeTrigger?.setAttribute("aria-label", `${side === "self" ? "自分" : "相手"}のもちものを選択${itemName ? `（${itemName}）` : ""}`);
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
      if (activeSide === "self") {
        const build = getSelfBuilds()[activeCardIndex];
        if (build) setSelfBuildAt(activeCardIndex, { ...build, item_name: itemName });
      } else setOpponentBuild({ ...getOpponentBuild(), itemName });
      syncCardItem(activeSide, itemName);
      document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason: `${activeSide}-item` } }));
      closeDialog();
    },
  });

  async function openDialog(trigger: HTMLButtonElement, side: Side): Promise<void> {
    activeSide = side;
    activeCardIndex = side === "self" ? Number(trigger.dataset.damageCalcCardIndex ?? 0) : 0;
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

  // もちもの選択ボタンは対面カードの枚数ぶん動的に生成され、matchup-card.ts の再描画のたびに
  // 作り直される。起動時に一度だけ querySelectorAll するのではなく、document への委譲で
  // クリックのたびにトリガーを判定する。
  document.addEventListener("click", (event) => {
    const trigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-damage-calc-item-side]");
    if (!trigger) return;
    const side = trigger.dataset.damageCalcItemSide;
    if (side === "self" || side === "opponent") void openDialog(trigger, side);
  });
  closeButton.addEventListener("click", closeDialog);
  bindModalDismissal({ backdrop, dialog, isOpen: () => !dialog.hidden, onDismiss: closeDialog });
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    grid.render(searchQuery);
  });
}
