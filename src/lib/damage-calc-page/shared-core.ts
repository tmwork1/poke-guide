import type { OwnedPokemonRecord } from "../owned-pokemon";
import type { Team, TeamMember } from "../team";

/** ランク補正の並び。HP は PokemonSpec.boosts と揃えるためだけのプレースホルダー。 */
export type DamageCalcBoosts = [number, number, number, number, number, number];

export interface SelfState {
  boosts: DamageCalcBoosts;
  ailment: string;
  terastallized: boolean;
}

export interface OpponentState {
  boosts: DamageCalcBoosts;
  ailment: string;
  terastallized: boolean;
}

/** 壁はその壁を受けている陣営ごとに保持し、計算時に defenderSideFields へ写す。 */
export interface FieldState {
  weather: string;
  terrain: string;
  selfSideFields: string[];
  opponentSideFields: string[];
}

/** TeamMember のうち、ダメージページが保持する最小の選択情報。 */
export interface TeamMemberSpecInput {
  slot: TeamMember["slot"];
  itemOverride: TeamMember["item_override"];
  ownedPokemon: Pick<
    OwnedPokemonRecord,
    "id" | "species_name" | "level" | "nature" | "ability_name" | "item_name" | "tera_type" | "evs" | "ivs" | "move_names"
  >;
}

/** SSR で取得した Team から、クライアント状態へ渡す選択済みチーム。 */
export interface SelectedTeam {
  id: Team["id"];
  members: TeamMemberSpecInput[];
  selectedMemberId: OwnedPokemonRecord["id"] | null;
}

/** 相手の手動入力。努力値・性格は3パターン計算側が一貫して決定する。 */
export interface OpponentBuild {
  speciesName: string;
  abilityName: string;
  itemName: string;
  teraType: string;
  moveNames: string[];
}

export type ActiveTab = "6v1" | "1v1";

export interface DamageCalcPageState {
  activeTab: ActiveTab;
  selectedTeam: SelectedTeam | null;
  opponentBuild: OpponentBuild;
  selfState: SelfState;
  opponentState: OpponentState;
  fieldState: FieldState;
}

export const DEFAULT_DAMAGE_CALC_BOOSTS: DamageCalcBoosts = [0, 0, 0, 0, 0, 0];

export const DEFAULT_SELF_STATE: SelfState = {
  boosts: [...DEFAULT_DAMAGE_CALC_BOOSTS],
  ailment: "",
  terastallized: false,
};

export const DEFAULT_OPPONENT_STATE: OpponentState = {
  boosts: [...DEFAULT_DAMAGE_CALC_BOOSTS],
  ailment: "",
  terastallized: false,
};

export const DEFAULT_FIELD_STATE: FieldState = {
  weather: "",
  terrain: "",
  selfSideFields: [],
  opponentSideFields: [],
};

export const DEFAULT_OPPONENT_BUILD: OpponentBuild = {
  speciesName: "",
  abilityName: "",
  itemName: "",
  teraType: "",
  moveNames: [],
};

let state: DamageCalcPageState = {
  activeTab: "6v1",
  selectedTeam: null,
  opponentBuild: { ...DEFAULT_OPPONENT_BUILD },
  selfState: { ...DEFAULT_SELF_STATE, boosts: [...DEFAULT_SELF_STATE.boosts] },
  opponentState: { ...DEFAULT_OPPONENT_STATE, boosts: [...DEFAULT_OPPONENT_STATE.boosts] },
  fieldState: { ...DEFAULT_FIELD_STATE, selfSideFields: [], opponentSideFields: [] },
};

export function getDamageCalcPageState(): DamageCalcPageState {
  return state;
}

export function setDamageCalcPageState(next: DamageCalcPageState): void {
  state = next;
}

export function getActiveTab(): ActiveTab { return state.activeTab; }
export function setActiveTab(activeTab: ActiveTab): void { state = { ...state, activeTab }; }
export function getSelectedTeam(): SelectedTeam | null { return state.selectedTeam; }
export function setSelectedTeam(selectedTeam: SelectedTeam | null): void { state = { ...state, selectedTeam }; }
export function getOpponentBuild(): OpponentBuild { return state.opponentBuild; }
export function setOpponentBuild(opponentBuild: OpponentBuild): void { state = { ...state, opponentBuild }; }
export function getSelfState(): SelfState { return state.selfState; }
export function setSelfState(selfState: SelfState): void { state = { ...state, selfState }; }
export function getOpponentState(): OpponentState { return state.opponentState; }
export function setOpponentState(opponentState: OpponentState): void { state = { ...state, opponentState }; }
export function getFieldState(): FieldState { return state.fieldState; }
export function setFieldState(fieldState: FieldState): void { state = { ...state, fieldState }; }
