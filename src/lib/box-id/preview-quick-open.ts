// 育成タブのポケモンプレビュー(MobilePokemonPreview.astro)の各項目をタップして、
// 対応する既存の選択UIをそのまま開く配線。新しいモーダルは作らず、PokemonEditPanel.astro
// (pokemon-edit-panel.ts)側に既にある入口(トリガーボタンのクリック/入力のfocus)を
// そのまま呼ぶだけにとどめる。
//
// PokemonEditPanel(トリガーボタン・#move-*入力)は育成タブ・ダメージタブのどちらでも
// DOMに存在するため(box/[id].astro参照)、activeTabによる出し分けはしない。
// バトルデータ/上位チーム/相性タブ(別ページ)には対象が存在しないため、
// 各項目ごとに要素の有無を確認し、無ければ安全にno-opにする
// (stat-adjustment-dialog.tsと同じ方針)。

// モバイルではclickを待たず、最初に届くpointerdownで実行する。clickはキーボード操作
// (Enter/Space)のフォールバックとして残す(.pokemon-preview-sprite-wrap/
// mega-preview-toggle.ts、#pokemon-preview-stats-trigger/stat-adjustment-dialog.tsと同じ方針)。
import { bindSettingsModalTrigger, requestSettingsModal } from "./settings-modal";

// 種族名・タイプ → 種族選択モーダル(#species-select-trigger-button、
// SpeciesSelectDialog.astro/species-select-dialog.ts)をそのまま開く。
const speciesTrigger = document.getElementById("pokemon-preview-species-trigger");
if (speciesTrigger) {
  bindSettingsModalTrigger(speciesTrigger, { kind: "species" });
}

// 技(各行)→ pokemon-edit-panel.tsの"move-picker:open"イベント(.mobile-move-toggleと同じ入口、
// PokemonEditPanel.astro参照)にタップしたスロット番号をdetailで渡し、そのスロットのわざ選択
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

// ポケモン未指定(種族名が空)のときは、プレビューのどこをタップしても種族選択モーダルを開く。
// 個体を新規追加した直後は種族名・特性・技・もちものが全て「-」で、どこを押せば選べるのかが
// 分からない状態になるため、種族が決まるまではプレビュー全体を1枚の「ポケモンを選ぶ」ボタンとして
// 扱う(種族が決まったあとは、上で配線した項目ごとの入口に戻す)。
//
// 判定は#species-name(育成フォームの実体。プレビューの表示テキストはこれのミラー)を
// 都度読む。種族選択後に配線し直す必要がないよう、状態は保持せずイベントのたびに評価する。
//
// 受付中であることを見た目で示す装飾(枠線・カーソル)は付けない。種族の有無で
// プレビューの見た目が変わらないこと自体が要件のため、CSSも状態クラスも足さない。
const previewRoot = document.querySelector<HTMLElement>(".pokemon-preview");
if (previewRoot) {
  const speciesNameInput = document.getElementById("species-name") as HTMLInputElement | null;
  const isSpeciesUnset = (): boolean => {
    if (!speciesNameInput) return false;
    return speciesNameInput.value.trim() === "";
  };
  // 項目ごとのトリガー(上でbindSettingsModalTriggerを付けた要素)より先に横取りするため、
  // キャプチャ段階で受けて伝播を止める。止めないと種族モーダルを開いた直後に
  // もちもの/ステータスのモーダルも開こうとして二重に発火する。
  const interceptUnset = (event: Event): void => {
    if (!isSpeciesUnset()) return;
    event.preventDefault();
    event.stopPropagation();
    requestSettingsModal({ kind: "species" });
  };
  previewRoot.addEventListener("pointerdown", interceptUnset, { capture: true });
  previewRoot.addEventListener(
    "click",
    (event) => {
      // pointerdown経由で開いた同じタップのclickは、bindSettingsModalTriggerと同じ理由
      // (開いた直後のモーダルへ届くゴーストクリック)で握りつぶすだけにする。
      if (!isSpeciesUnset()) return;
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  previewRoot.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      interceptUnset(event);
    },
    { capture: true },
  );
}
