import { DAMAGE_AILMENTS, DAMAGE_TERRAINS, DAMAGE_WEATHERS, clampInt } from "../box-id/damage-calc";
import { getFieldState, getOpponentBuild, getOpponentState, getSelectedTeam, getSelfState, setFieldState, setOpponentState, setSelfState } from "./shared-core";

const labels = ["攻撃", "防御", "特攻", "特防", "素早さ"];
const emit = () => document.dispatchEvent(new CustomEvent("damage-calc:change", { detail: { reason: "controls" } }));

export function initControlPanel(): void {
  const rankRoots = Array.from(document.querySelectorAll<HTMLElement>(".damage-calc-ranks"));
  const fillSelect = (id: string, options: readonly { value: string; label: string }[]) => {
    const select = document.getElementById(id) as HTMLSelectElement;
    select.replaceChildren(...options.map((option) => new Option(option.label, option.value)));
  };
  fillSelect("damage-calc-self-ailment", DAMAGE_AILMENTS); fillSelect("damage-calc-opponent-ailment", DAMAGE_AILMENTS);
  fillSelect("damage-calc-weather", [{ value: "", label: "なし" }, ...DAMAGE_WEATHERS]); fillSelect("damage-calc-terrain", [{ value: "", label: "なし" }, ...DAMAGE_TERRAINS]);
  const render = () => {
    const self = getSelfState(), opponent = getOpponentState(), field = getFieldState();
    rankRoots.forEach((root) => {
      const state = root.dataset.side === "self" ? self : opponent;
      root.replaceChildren(...labels.map((label, index) => {
        const row = document.createElement("div"); row.className = "damage-calc-rank-row";
        const minus = document.createElement("button"); minus.type = "button"; minus.textContent = "−"; minus.ariaLabel = `${label}を下げる`;
        const value = document.createElement("output"); value.textContent = `${state.boosts[index + 1] >= 0 ? "+" : ""}${state.boosts[index + 1]}`;
        const plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+"; plus.ariaLabel = `${label}を上げる`;
        const change = (delta: number) => { const current = root.dataset.side === "self" ? getSelfState() : getOpponentState(); const boosts = [...current.boosts] as typeof current.boosts; boosts[index + 1] = clampInt(boosts[index + 1] + delta, -6, 6); if (root.dataset.side === "self") setSelfState({ ...current, boosts }); else setOpponentState({ ...current, boosts }); render(); emit(); };
        minus.addEventListener("click", () => change(-1)); plus.addEventListener("click", () => change(1)); row.append(label, minus, value, plus); return row;
      }));
    });
    (document.getElementById("damage-calc-self-ailment") as HTMLSelectElement).value = self.ailment;
    (document.getElementById("damage-calc-opponent-ailment") as HTMLSelectElement).value = opponent.ailment;
    (document.getElementById("damage-calc-weather") as HTMLSelectElement).value = field.weather;
    (document.getElementById("damage-calc-terrain") as HTMLSelectElement).value = field.terrain;
    const ownTera = getSelectedTeam()?.members.find((member) => member.ownedPokemon.id === getSelectedTeam()?.selectedMemberId)?.ownedPokemon.tera_type;
    const selfToggle = document.getElementById("damage-calc-self-tera") as HTMLInputElement, opponentToggle = document.getElementById("damage-calc-opponent-tera-toggle") as HTMLInputElement;
    selfToggle.disabled = !ownTera; selfToggle.checked = self.terastallized; opponentToggle.disabled = !getOpponentBuild().teraType; opponentToggle.checked = opponent.terastallized;
  };
  (document.getElementById("damage-calc-self-ailment") as HTMLSelectElement).addEventListener("change", (event) => { setSelfState({ ...getSelfState(), ailment: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-opponent-ailment") as HTMLSelectElement).addEventListener("change", (event) => { setOpponentState({ ...getOpponentState(), ailment: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-weather") as HTMLSelectElement).addEventListener("change", (event) => { setFieldState({ ...getFieldState(), weather: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-terrain") as HTMLSelectElement).addEventListener("change", (event) => { setFieldState({ ...getFieldState(), terrain: (event.target as HTMLSelectElement).value }); emit(); });
  (document.getElementById("damage-calc-self-tera") as HTMLInputElement).addEventListener("change", (event) => { setSelfState({ ...getSelfState(), terastallized: (event.target as HTMLInputElement).checked }); emit(); });
  (document.getElementById("damage-calc-opponent-tera-toggle") as HTMLInputElement).addEventListener("change", (event) => { setOpponentState({ ...getOpponentState(), terastallized: (event.target as HTMLInputElement).checked }); emit(); });
  document.addEventListener("damage-calc:change", render); render();
}
