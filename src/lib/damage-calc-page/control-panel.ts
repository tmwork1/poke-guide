import { DAMAGE_AILMENTS, DAMAGE_TERRAINS, DAMAGE_WEATHERS, clampInt } from "../box-id/damage-calc";
import { getFieldState, getOpponentBuild, getOpponentState, getSelectedTeam, getSelfState, setFieldState, setOpponentState, setSelfState } from "./shared-core";
import { teraTypeIconUrl } from "../sprite-urls";

// 攻撃時に参照される能力(物理ならA/特殊ならC)と、被弾時に参照される能力(物理ならB/特殊ならD)を
// それぞれ1本のランクにまとめる。どちらの技を撃つ/受けるかは技側のカテゴリで決まるため、
// A/Cを常に同じ値にそろえておけば個別に持つ場合と同じ計算結果になる(B/Dも同様)。
const RANK_GROUPS: { label: string; indices: readonly [number, number] }[] = [
  { label: "AC", indices: [1, 3] },
  { label: "BD", indices: [2, 4] },
];
const emit = () => document.dispatchEvent(new CustomEvent("damage-calc:change", { detail: { reason: "controls" } }));
const formatRank = (value: number): string => (value > 0 ? `+${value}` : String(value));

interface RankStepper { row: HTMLElement; setValue: (value: number) => void; }

// ダメージ計算詳細設定モーダル(src/lib/box-id/right-panel.ts の buildSideSection)と同じ
// 「±ボタン + ワンタップで-6〜+6を選べるポップアップ」構成を流用する。
function createRankStepper(label: string, ariaSideLabel: string, onChange: (value: number) => void): RankStepper {
  const row = document.createElement("div"); row.className = "damage-calc-rank-row";
  const decrementButton = document.createElement("button"); decrementButton.type = "button"; decrementButton.textContent = "−"; decrementButton.ariaLabel = `${ariaSideLabel}の${label}ランクを下げる`;
  const incrementButton = document.createElement("button"); incrementButton.type = "button"; incrementButton.textContent = "+"; incrementButton.ariaLabel = `${ariaSideLabel}の${label}ランクを上げる`;
  const pickerButton = document.createElement("button"); pickerButton.type = "button"; pickerButton.className = "number-stepper-value tnum"; pickerButton.setAttribute("aria-haspopup", "dialog"); pickerButton.setAttribute("aria-expanded", "false"); pickerButton.ariaLabel = `${ariaSideLabel}の${label}ランク`;
  const picker = document.createElement("div"); picker.className = "number-stepper-picker number-stepper-picker--rank"; picker.hidden = true; picker.setAttribute("role", "dialog");
  for (let value = -6; value <= 6; value += 1) {
    const option = document.createElement("button"); option.type = "button"; option.className = "tnum"; option.dataset.rankValue = String(value); option.textContent = formatRank(value);
    picker.append(option);
  }
  let current = 0;
  const closePicker = () => { picker.hidden = true; pickerButton.setAttribute("aria-expanded", "false"); };
  const openPicker = () => {
    document.body.append(picker); picker.hidden = false;
    const anchor = pickerButton.getBoundingClientRect(), pickerRect = picker.getBoundingClientRect();
    // 固定表示バーは画面下端にあるため、詳細設定モーダル版(下に開く)と異なりボタンの上に開く。
    picker.style.position = "fixed";
    picker.style.top = `${Math.max(8, Math.min(window.innerHeight - pickerRect.height - 8, anchor.top - pickerRect.height - 4))}px`;
    picker.style.left = `${Math.max(8, Math.min(window.innerWidth - pickerRect.width - 8, anchor.left + (anchor.width - pickerRect.width) / 2))}px`;
    pickerButton.setAttribute("aria-expanded", "true");
  };
  const refresh = () => {
    pickerButton.textContent = formatRank(current);
    pickerButton.classList.toggle("is-nonzero", current !== 0);
    decrementButton.disabled = current <= -6; incrementButton.disabled = current >= 6;
    picker.querySelectorAll<HTMLButtonElement>("[data-rank-value]").forEach((option) => option.setAttribute("aria-current", String(Number(option.dataset.rankValue) === current)));
  };
  const commit = (value: number) => { current = clampInt(value, -6, 6); refresh(); onChange(current); };
  pickerButton.addEventListener("click", () => { if (picker.hidden) openPicker(); else closePicker(); });
  picker.addEventListener("click", (event) => { const option = (event.target as Element).closest<HTMLButtonElement>("[data-rank-value]"); if (!option) return; commit(Number(option.dataset.rankValue)); closePicker(); pickerButton.focus(); });
  document.addEventListener("pointerdown", (event) => { if (picker.hidden || picker.contains(event.target as Node) || pickerButton.contains(event.target as Node)) return; closePicker(); });
  decrementButton.addEventListener("click", () => commit(current - 1));
  incrementButton.addEventListener("click", () => commit(current + 1));
  refresh();
  const stepperGroup = document.createElement("span"); stepperGroup.className = "rank-stepper-group number-stepper";
  stepperGroup.append(decrementButton, pickerButton, incrementButton, picker);
  row.append(stepperGroup);
  return { row, setValue: (value: number) => { current = value; refresh(); } };
}

function syncControlBarHeight(): void {
  const bar = document.querySelector<HTMLElement>(".damage-calc-control-bar");
  if (!bar) return;
  const update = () => document.documentElement.style.setProperty("--damage-calc-control-bar-height", `${bar.offsetHeight}px`);
  new ResizeObserver(update).observe(bar);
  update();
}

export function initControlPanel(): void {
  syncControlBarHeight();
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
  const fillSelect = (id: string, options: readonly { value: string; label: string }[]) => {
    const select = document.getElementById(id) as HTMLSelectElement;
    select.replaceChildren(...options.map((option) => new Option(option.label, option.value)));
  };
  // 共有配列DAMAGE_AILMENTSの空値ラベルは他画面向けの「なし」のまま保ち、
  // このページの表示だけ「状態異常」に差し替える(プレースホルダーとして何のセレクトか分かるように)。
  const ailmentOptions = DAMAGE_AILMENTS.map((option) => (option.value === "" ? { ...option, label: "状態異常" } : option));
  fillSelect("damage-calc-self-ailment", ailmentOptions); fillSelect("damage-calc-opponent-ailment", ailmentOptions);
  fillSelect("damage-calc-weather", [{ value: "", label: "なし" }, ...DAMAGE_WEATHERS]); fillSelect("damage-calc-terrain", [{ value: "", label: "なし" }, ...DAMAGE_TERRAINS]);
  // ダメージ計算詳細設定モーダル(box-id/right-panel.ts の buildIconToggleGroup)と同じく、
  // アイコンのみのボタンにする(「なし」用のボタンは置かず、選択中のボタンを再度押すと解除する)。
  const renderChoiceGroup = (rootId: string, selectId: string, options: readonly { value: string; label: string; icon: string }[]) => {
    const root = document.getElementById(rootId) as HTMLElement, select = document.getElementById(selectId) as HTMLSelectElement;
    root.replaceChildren(...options.map((option) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "damage-calc-icon-btn"; button.dataset.value = option.value;
      button.innerHTML = option.icon; button.title = option.label; button.ariaLabel = option.label;
      button.addEventListener("click", () => {
        select.value = select.value === option.value ? "" : option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return button;
    }));
  };
  renderChoiceGroup("damage-calc-weather-buttons", "damage-calc-weather", DAMAGE_WEATHERS);
  renderChoiceGroup("damage-calc-terrain-buttons", "damage-calc-terrain", DAMAGE_TERRAINS);
  const render = () => {
    const self = getSelfState(), opponent = getOpponentState(), field = getFieldState();
    (["self", "opponent"] as const).forEach((side) => {
      const state = side === "self" ? self : opponent;
      const control = rankControlBySide.get(side);
      control?.stepper.setValue(state.boosts[control.statIndex]);
    });
    (document.getElementById("damage-calc-self-ailment") as HTMLSelectElement).value = self.ailment;
    (document.getElementById("damage-calc-opponent-ailment") as HTMLSelectElement).value = opponent.ailment;
    (document.getElementById("damage-calc-weather") as HTMLSelectElement).value = field.weather;
    (document.getElementById("damage-calc-terrain") as HTMLSelectElement).value = field.terrain;
    (["weather", "terrain"] as const).forEach((kind) => { const select = document.getElementById(`damage-calc-${kind}`) as HTMLSelectElement; document.querySelectorAll<HTMLButtonElement>(`#damage-calc-${kind}-buttons button`).forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === select.value))); });
    const ownTera = getSelectedTeam()?.members.find((member) => member.ownedPokemon.id === getSelectedTeam()?.selectedMemberId)?.ownedPokemon.tera_type;
    const selfToggle = document.getElementById("damage-calc-self-tera") as HTMLInputElement, opponentToggle = document.getElementById("damage-calc-opponent-tera-toggle") as HTMLInputElement;
    selfToggle.disabled = !ownTera; selfToggle.checked = self.terastallized; opponentToggle.disabled = !getOpponentBuild().teraType; opponentToggle.checked = opponent.terastallized;
    (["self", "opponent"] as const).forEach((side) => {
      const toggle = document.getElementById(`damage-calc-${side === "self" ? "self-tera" : "opponent-tera-toggle"}`) as HTMLInputElement;
      const button = document.getElementById(`damage-calc-${side}-tera-button`) as HTMLButtonElement;
      button.disabled = toggle.disabled; button.classList.toggle("is-active", toggle.checked); button.setAttribute("aria-pressed", String(toggle.checked));
      const teraTypeName = side === "self" ? ownTera : getOpponentBuild().teraType;
      const icon = button.querySelector<HTMLImageElement>(".damage-calc-tera-icon");
      const iconUrl = teraTypeName ? teraTypeIconUrl(teraTypeName) : null;
      if (icon) { icon.hidden = !iconUrl; if (iconUrl) icon.src = iconUrl; }
    });
  };
  (document.getElementById("damage-calc-self-ailment") as HTMLSelectElement).addEventListener("change", (event) => { setSelfState({ ...getSelfState(), ailment: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-opponent-ailment") as HTMLSelectElement).addEventListener("change", (event) => { setOpponentState({ ...getOpponentState(), ailment: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-weather") as HTMLSelectElement).addEventListener("change", (event) => { setFieldState({ ...getFieldState(), weather: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-terrain") as HTMLSelectElement).addEventListener("change", (event) => { setFieldState({ ...getFieldState(), terrain: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-self-tera") as HTMLInputElement).addEventListener("change", (event) => { setSelfState({ ...getSelfState(), terastallized: (event.target as HTMLInputElement).checked }); emit(); });
  (document.getElementById("damage-calc-opponent-tera-toggle") as HTMLInputElement).addEventListener("change", (event) => { setOpponentState({ ...getOpponentState(), terastallized: (event.target as HTMLInputElement).checked }); emit(); });
  (["self", "opponent"] as const).forEach((side) => { const button = document.getElementById(`damage-calc-${side}-tera-button`) as HTMLButtonElement; const input = document.getElementById(side === "self" ? "damage-calc-self-tera" : "damage-calc-opponent-tera-toggle") as HTMLInputElement; button.addEventListener("click", () => { if (input.disabled) return; input.checked = !input.checked; input.dispatchEvent(new Event("change", { bubbles: true })); }); });
  document.addEventListener("damage-calc:change", render); render();
}
