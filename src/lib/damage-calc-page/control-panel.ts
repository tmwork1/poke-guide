import { DAMAGE_AILMENTS, DAMAGE_TERRAINS, DAMAGE_WEATHERS, clampInt } from "../box-id/damage-calc";
import { getFieldState, getOpponentState, getSelfState, setFieldState, setOpponentState, setSelfState } from "./shared-core";
import { teraTypeIconUrl } from "../sprite-urls";
import { createTeraSelectDialog } from "../tera-select-dialog";
import { createRankPicker } from "../shared/rank-picker";

// 攻撃時に参照される能力(物理ならA/特殊ならC)と、被弾時に参照される能力(物理ならB/特殊ならD)を
// それぞれ1本のランクにまとめる。どちらの技を撃つ/受けるかは技側のカテゴリで決まるため、
// A/Cを常に同じ値にそろえておけば個別に持つ場合と同じ計算結果になる(B/Dも同様)。
const RANK_GROUPS: { label: string; indices: readonly [number, number] }[] = [
  { label: "AC", indices: [1, 3] },
  { label: "BD", indices: [2, 4] },
];
const emit = () => document.dispatchEvent(new CustomEvent("damage-calc:change", { detail: { reason: "controls" } }));
// ダメージ計算詳細設定モーダル(box-id/damage-detail-panel.ts)と同じ汎用テラスタルアイコン。
// タイプ別アイコン(teraTypeIconUrl)が引けない(チーム/相手未選択でタイプ不明)間も
// ボタンを空にせず、この汎用アイコンを薄く表示してテラスタルボタンだと分かるようにする。
const GENERIC_TERA_ICON_URL = "https://img.gamewith.jp/article_tools/pokemon-sv/gacha/map_icon_terra2.png";
const formatRank = (value: number): string => (value > 0 ? `+${value}` : String(value));

interface RankStepper { row: HTMLElement; setValue: (value: number) => void; }

// ダメージ計算詳細設定モーダル(src/lib/box-id/damage-detail-panel.ts の buildSideSection)と同じ
// 「±ボタン + ワンタップで-6〜+6を選べるポップアップ」構成を流用する。
function createRankStepper(label: string, ariaSideLabel: string, onChange: (value: number) => void): RankStepper {
  const row = document.createElement("div"); row.className = "damage-calc-rank-row";
  const decrementButton = document.createElement("button"); decrementButton.type = "button"; decrementButton.textContent = "−"; decrementButton.ariaLabel = `${ariaSideLabel}の${label}ランクを下げる`;
  const incrementButton = document.createElement("button"); incrementButton.type = "button"; incrementButton.textContent = "+"; incrementButton.ariaLabel = `${ariaSideLabel}の${label}ランクを上げる`;
  const pickerButton = document.createElement("button"); pickerButton.type = "button"; pickerButton.className = "number-stepper-value tnum"; pickerButton.setAttribute("aria-haspopup", "dialog"); pickerButton.setAttribute("aria-expanded", "false"); pickerButton.ariaLabel = `${ariaSideLabel}の${label}ランク`;
  let current = 0;
  const rankPicker = createRankPicker({ pickerButton, placement: "above", formatValue: formatRank, onSelect: (value) => commit(value) });
  const refresh = () => {
    pickerButton.textContent = formatRank(current);
    pickerButton.classList.toggle("is-nonzero", current !== 0);
    decrementButton.disabled = current <= -6; incrementButton.disabled = current >= 6;
    rankPicker.setSelectedValue(current);
  };
  const commit = (value: number) => { current = clampInt(value, -6, 6); refresh(); onChange(current); };
  decrementButton.addEventListener("click", () => commit(current - 1));
  incrementButton.addEventListener("click", () => commit(current + 1));
  refresh();
  const stepperGroup = document.createElement("span"); stepperGroup.className = "rank-stepper-group number-stepper";
  stepperGroup.append(decrementButton, pickerButton, incrementButton, rankPicker.picker);
  row.append(stepperGroup);
  return { row, setValue: (value: number) => { current = value; refresh(); } };
}

function syncControlBarHeight(): void {
  const bar = document.querySelector<HTMLElement>(".damage-calc-control-bar");
  if (!bar) return;
  // body.damage-calc-page 側のスタイルシートで --damage-calc-control-bar-height: 0px が
  // 宣言されているため、:root(documentElement)へ書き込んでも同じ要素での宣言に負けて
  // 子孫からは常に0pxに見えてしまう(相手選択レールの高さ計算などが壊れる)。
  // 同じbody要素へ直接書き込み、インラインstyleでスタイルシート側の宣言を上書きする。
  const update = () => document.body.style.setProperty("--damage-calc-control-bar-height", `${bar.offsetHeight}px`);
  new ResizeObserver(update).observe(bar);
  update();
}

// box一覧ページ(box/index.astro の syncBoxScrollViewport)と同じく、--app-header-height等の
// 想定トークン値ではなく実際に描画されたSecondaryBarの下端座標を使う。ボーダー等を含む
// 実測値を使うことで、.damage-calc-shell/相手選択レールの上端が数px単位でズレるのを防ぐ。
function syncContentTop(): void {
  const secondaryBar = document.querySelector<HTMLElement>(".damage-calc-secondary-bar");
  if (!secondaryBar) return;
  const update = () => document.body.style.setProperty("--damage-calc-content-top", `${secondaryBar.getBoundingClientRect().bottom}px`);
  new ResizeObserver(update).observe(secondaryBar);
  update();
}

export function initControlPanel(): void {
  syncControlBarHeight();
  syncContentTop();
  const selfAilmentSelect = document.getElementById("damage-calc-self-ailment") as HTMLSelectElement;
  const opponentAilmentSelect = document.getElementById("damage-calc-opponent-ailment") as HTMLSelectElement;
  const weatherButtons = document.getElementById("damage-calc-weather-buttons") as HTMLElement;
  const terrainButtons = document.getElementById("damage-calc-terrain-buttons") as HTMLElement;
  const teraButtons = {
    self: document.getElementById("damage-calc-self-tera-button") as HTMLButtonElement,
    opponent: document.getElementById("damage-calc-opponent-tera-button") as HTMLButtonElement,
  };
  const teraIcons = {
    self: teraButtons.self.querySelector<HTMLImageElement>(".damage-calc-tera-icon"),
    opponent: teraButtons.opponent.querySelector<HTMLImageElement>(".damage-calc-tera-icon"),
  };
  const rankRoots = Array.from(document.querySelectorAll<HTMLElement>(".damage-calc-ranks"));
  const rankControlBySide = new Map<"self" | "opponent", { stepper: RankStepper; statIndex: number }>();
  rankRoots.forEach((root) => {
    const side: "self" | "opponent" = root.dataset.side === "self" ? "self" : "opponent";
    const ariaSideLabel = side === "self" ? "自分" : "相手";
    // 自分は攻撃側(AC)、相手は防御側(BD)のランクのみ調整できればよい。
    const group = side === "self" ? RANK_GROUPS[0] : RANK_GROUPS[1];
    const stepper = createRankStepper(group.label, ariaSideLabel, (value) => {
      const state = side === "self" ? getSelfState() : getOpponentState();
      const boosts = [...state.boosts] as typeof state.boosts;
      group.indices.forEach((statIndex) => { boosts[statIndex] = value; });
      if (side === "self") setSelfState({ ...state, boosts }); else setOpponentState({ ...state, boosts });
      emit();
    });
    root.replaceChildren(stepper.row);
    rankControlBySide.set(side, { stepper, statIndex: group.indices[0] });
  });
  const fillSelect = (select: HTMLSelectElement, options: readonly { value: string; label: string }[]) => {
    select.replaceChildren(...options.map((option) => new Option(option.label, option.value)));
  };
  // 共有配列DAMAGE_AILMENTSの空値ラベルは他画面向けの「なし」のまま保ち、
  // このページの表示だけ「状態異常」に差し替える(プレースホルダーとして何のセレクトか分かるように)。
  const ailmentOptions = DAMAGE_AILMENTS.map((option) => (option.value === "" ? { ...option, label: "状態異常" } : option));
  fillSelect(selfAilmentSelect, ailmentOptions); fillSelect(opponentAilmentSelect, ailmentOptions);
  // ダメージ計算詳細設定モーダル(box-id/damage-detail-panel.ts の buildIconToggleGroup)とは異なり、
  // このパネルはアイコン+ラベルの2段組にする(「なし」用のボタンは置かず、選択中のボタンを
  // 再度押すと解除する)。ラベルはボタンの可視テキストになるので、冗長なtitle/ariaLabelは付けない。
  const renderChoiceGroup = (
    root: HTMLElement,
    options: readonly { value: string; label: string; icon: string }[],
    getValue: () => string,
    setValue: (value: string) => void,
  ) => {
    root.replaceChildren(...options.map((option) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "damage-calc-icon-btn"; button.dataset.value = option.value;
      const label = document.createElement("span"); label.className = "damage-calc-icon-btn-label"; label.textContent = option.label;
      button.innerHTML = option.icon; button.append(label);
      button.addEventListener("click", () => {
        setValue(getValue() === option.value ? "" : option.value);
        emit();
      });
      return button;
    }));
  };
  // 共有配列DAMAGE_WEATHERSの「すなあらし」は他画面向けの表記のまま保ち、
  // このパネルの4つ横並びボタンだけ幅に収まる「すな」に短縮する。
  const weatherIconOptions = DAMAGE_WEATHERS.map((option) => (option.value === "すなあらし" ? { ...option, label: "すな" } : option));
  renderChoiceGroup(weatherButtons, weatherIconOptions,
    () => getFieldState().weather,
    (weather) => setFieldState({ ...getFieldState(), weather }),
  );
  renderChoiceGroup(terrainButtons, DAMAGE_TERRAINS,
    () => getFieldState().terrain,
    (terrain) => setFieldState({ ...getFieldState(), terrain }),
  );
  const teraDialogs = (['self', 'opponent'] as const).map((side) => {
    const prefix = `damage-calc-${side}-tera-select-`;
    const triggerButton = teraButtons[side];
    return createTeraSelectDialog({
      backdrop: document.getElementById(`${prefix}backdrop`) as HTMLElement,
      dialog: document.getElementById(`${prefix}dialog`) as HTMLElement,
      closeButton: document.getElementById(`${prefix}close-button`) as HTMLButtonElement,
      grid: document.getElementById(`${prefix}grid`) as HTMLElement,
    }, triggerButton,
    () => side === 'self' ? getSelfState().teraType : getOpponentState().teraType,
    (teraType) => {
      if (side === 'self') setSelfState({ ...getSelfState(), teraType });
      else setOpponentState({ ...getOpponentState(), teraType });
      emit();
    });
  });
  const render = () => {
    const self = getSelfState(), opponent = getOpponentState(), field = getFieldState();
    (["self", "opponent"] as const).forEach((side) => {
      const state = side === "self" ? self : opponent;
      const control = rankControlBySide.get(side);
      control?.stepper.setValue(state.boosts[control.statIndex]);
    });
    selfAilmentSelect.value = self.ailment;
    opponentAilmentSelect.value = opponent.ailment;
    (["weather", "terrain"] as const).forEach((kind) => {
      const value = kind === "weather" ? field.weather : field.terrain;
      const root = kind === "weather" ? weatherButtons : terrainButtons;
      root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === value)));
    });
    (["self", "opponent"] as const).forEach((side) => {
      const button = teraButtons[side];
      const teraType = side === "self" ? self.teraType : opponent.teraType;
      button.classList.toggle("is-active", teraType !== ""); button.setAttribute("aria-pressed", String(teraType !== ""));
      const icon = teraIcons[side];
      const iconUrl = teraTypeIconUrl(teraType);
      if (icon) { icon.hidden = false; icon.src = iconUrl ?? GENERIC_TERA_ICON_URL; }
    });
  };
  selfAilmentSelect.addEventListener("change", (event) => { setSelfState({ ...getSelfState(), ailment: (event.target as HTMLSelectElement).value }); emit(); });
  opponentAilmentSelect.addEventListener("change", (event) => { setOpponentState({ ...getOpponentState(), ailment: (event.target as HTMLSelectElement).value }); emit(); });
  teraDialogs.forEach((dialog, index) => {
    const side = index === 0 ? "self" : "opponent";
    teraButtons[side].addEventListener("click", dialog.open);
  });
  document.addEventListener("damage-calc:change", render); render();
}
