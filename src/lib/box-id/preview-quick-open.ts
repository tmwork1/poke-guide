// 育成タブのポケモンプレビュー(MobileTrainingBar.astro)の各項目をタップして、
// 対応する既存の選択UIをそのまま開く配線。新しいモーダルは作らず、LeftPanel.astro
// (left-panel.ts)側に既にある入口(トリガーボタンのクリック/入力のfocus)を
// そのまま呼ぶだけにとどめる。
//
// LeftPanel(トリガーボタン・#move-*入力)は育成タブ・ダメージタブのどちらでも
// DOMに存在するため(box/[id].astro参照)、activeTabによる出し分けはしない。
// バトルデータ/上位チーム/相性タブ(別ページ)には対象が存在しないため、
// 各項目ごとに要素の有無を確認し、無ければ安全にno-opにする
// (stat-adjustment-dialog.tsと同じ方針)。

// モバイルではclickを待たず、最初に届くpointerdownで実行する。clickはキーボード操作
// (Enter/Space)のフォールバックとして残す(.pokemon-preview-sprite-wrap/
// mega-preview-toggle.ts、#pokemon-preview-stats-trigger/stat-adjustment-dialog.tsと同じ方針)。
import { bindSettingsModalTrigger } from "./settings-modal";

// 種族名・タイプ → 種族選択モーダル(#species-select-trigger-button、
// SpeciesSelectDialog.astro/species-select-dialog.ts)をそのまま開く。
const speciesTrigger = document.getElementById("pokemon-preview-species-trigger");
if (speciesTrigger) {
  bindSettingsModalTrigger(speciesTrigger, { kind: "species" });
}

// 技(各行)→ left-panel.tsの"move-picker:open"イベント(.mobile-move-toggleと同じ入口、
// LeftPanel.astro参照)にタップしたスロット番号をdetailで渡し、そのスロットのわざ選択
// モーダルを開く。モーダル自体は複製しない。
const moveTriggers = document.querySelectorAll<HTMLElement>(".pokemon-preview-move-trigger");
for (const trigger of moveTriggers) {
  const slot = Number(trigger.dataset.moveSlot);
  if (![1, 2, 3, 4].includes(slot)) continue;
  bindSettingsModalTrigger(trigger, { kind: "move", slot });
}

// もちもの → もちもの選択モーダル(#item-dropdown-button、ItemSelectDialog.astro/
// item-select-dialog.ts)をそのまま開く。
const itemTrigger = document.getElementById("pokemon-preview-item-trigger");
if (itemTrigger) {
  bindSettingsModalTrigger(itemTrigger, { kind: "item" });
}
