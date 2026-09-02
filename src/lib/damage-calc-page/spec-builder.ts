import { isUnsupportedLethalMove } from "../damage-summary.ts";
import type { MoveCategory } from "../pokemon-master-data";
import type { CalcDamagesOptions, CalcLethalSequenceResult, FieldSpec, PokemonSpec, SequenceAttack } from "../pyodide-engine";
import type { FieldState, OpponentBuild, OpponentState, SelfState } from "./shared-core";

export type DamageCalcDirection = "attack" | "defense";
export type DamageCalcPatternKey = "uninvested" | "invested" | "specialized";
export type DamageCalcStat = "attack" | "defense" | "specialAttack" | "specialDefense";

export interface DamageCalcMoveInput {
  moveName: string;
  category: MoveCategory;
}

export interface DamageCalcBuildInput {
  selfSpec: PokemonSpec;
  opponentBuild: OpponentBuild;
  selfState: SelfState;
  opponentState: OpponentState;
  fieldState: FieldState;
  direction: DamageCalcDirection;
  moves: readonly DamageCalcMoveInput[];
}

export interface DamageCalcCalculation {
  direction: DamageCalcDirection;
  category: Exclude<MoveCategory, "status">;
  pattern: DamageCalcPatternKey;
  adjustedStat: DamageCalcStat;
  attackerSpec: PokemonSpec;
  defenderSpec: PokemonSpec;
  attacks: SequenceAttack[];
  field: FieldSpec;
  options: CalcDamagesOptions;
}

export type DamageCalcSkippedMove =
  | { kind: "status"; moveName: string }
  | { kind: "unsupported"; moveName: string };

export interface DamageCalcBuildOutput {
  calculations: DamageCalcCalculation[];
  skipped: DamageCalcSkippedMove[];
}

export interface DamageCalcDisplay {
  damage: string;
  verdict: string;
}

const PATTERNS: readonly DamageCalcPatternKey[] = ["uninvested", "invested", "specialized"];
const NEUTRAL_NATURE = "まじめ";
const NATURE_BY_STAT: Record<DamageCalcStat, string> = {
  attack: "いじっぱり",
  defense: "ずぶとい",
  specialAttack: "ひかえめ",
  specialDefense: "おだやか",
};
const EV_INDEX: Record<DamageCalcStat, number> = {
  attack: 1,
  defense: 2,
  specialAttack: 3,
  specialDefense: 4,
};

function stateSpec(base: PokemonSpec, current: SelfState | OpponentState): PokemonSpec {
  return {
    ...base,
    boosts: [...current.boosts],
    ailment: current.ailment || undefined,
    terastallized: current.terastallized && !!base.teraType,
  };
}

function baseOpponentSpec(build: OpponentBuild): PokemonSpec {
  return {
    name: build.speciesName.trim(),
    level: 50,
    nature: NEUTRAL_NATURE,
    abilityName: build.abilityName.trim() || undefined,
    itemName: build.itemName.trim() || undefined,
    teraType: build.teraType.trim() || undefined,
    moveNames: build.moveNames.map((name) => name.trim()).filter(Boolean),
    evs: [0, 0, 0, 0, 0, 0],
    ivs: [31, 31, 31, 31, 31, 31],
  };
}

/** 対象ステータスだけを Champions の0/32/32+補正性格に差し替える。HPは常に0。 */
export function buildOpponentPatternSpec(
  build: OpponentBuild,
  opponentState: OpponentState,
  stat: DamageCalcStat,
  pattern: DamageCalcPatternKey,
): PokemonSpec {
  const base = stateSpec(baseOpponentSpec(build), opponentState);
  const evs = [0, 0, 0, 0, 0, 0];
  if (pattern !== "uninvested") evs[EV_INDEX[stat]] = 32;
  return {
    ...base,
    evs,
    nature: pattern === "specialized" ? NATURE_BY_STAT[stat] : NEUTRAL_NATURE,
  };
}

/** 物理/特殊と欄の向きから、相手ビルドで仮定する唯一の能力値を返す。 */
export function adjustedOpponentStat(
  direction: DamageCalcDirection,
  category: Exclude<MoveCategory, "status">,
): DamageCalcStat {
  if (direction === "attack") return category === "physical" ? "defense" : "specialDefense";
  return category === "physical" ? "attack" : "specialAttack";
}

/** 状態の陣営を attacker/defender の役割へ写し、壁を常に defender 側にだけ渡す。 */
export function buildCalculationField(direction: DamageCalcDirection, fieldState: FieldState): FieldSpec {
  return {
    weather: fieldState.weather || undefined,
    terrain: fieldState.terrain || undefined,
    defenderSideFields: direction === "attack" ? [...fieldState.opponentSideFields] : [...fieldState.selfSideFields],
  };
}

/**
 * 同じ分類の技を attacks にまとめた、engine-bridge がそのまま1回渡せる計算要求を作る。
 * 変化技・calc_lethal 非対応技は calls から除外し、個別表示用の skipped に残す。
 */
export function buildDamageCalcCalculations(input: DamageCalcBuildInput): DamageCalcBuildOutput {
  const skipped: DamageCalcSkippedMove[] = [];
  const byCategory: Record<Exclude<MoveCategory, "status">, SequenceAttack[]> = { physical: [], special: [] };
  for (const move of input.moves) {
    const moveName = move.moveName.trim();
    if (!moveName) continue;
    if (move.category === "status") {
      skipped.push({ kind: "status", moveName });
    } else if (isUnsupportedLethalMove(moveName)) {
      skipped.push({ kind: "unsupported", moveName });
    } else {
      byCategory[move.category].push({ moveName });
    }
  }

  const self = stateSpec(input.selfSpec, input.selfState);
  const field = buildCalculationField(input.direction, input.fieldState);
  const calculations: DamageCalcCalculation[] = [];
  for (const category of ["physical", "special"] as const) {
    const attacks = byCategory[category];
    if (attacks.length === 0) continue;
    const adjustedStat = adjustedOpponentStat(input.direction, category);
    for (const pattern of PATTERNS) {
      const opponent = buildOpponentPatternSpec(input.opponentBuild, input.opponentState, adjustedStat, pattern);
      calculations.push({
        direction: input.direction,
        category,
        pattern,
        adjustedStat,
        attackerSpec: input.direction === "attack" ? self : opponent,
        defenderSpec: input.direction === "attack" ? opponent : self,
        attacks: attacks.map((attack) => ({ ...attack })),
        field: { ...field, defenderSideFields: [...(field.defenderSideFields ?? [])] },
        options: { field: { ...field, defenderSideFields: [...(field.defenderSideFields ?? [])] } },
      });
    }
  }
  return { calculations, skipped };
}

/**
 * 確定数ラベルの規則。damage-summary.ts の describeSeriesVerdict(非export)と同じ規則を
 * ここに複製する: 最初に probability>0 になる位置を採用し、probability>=0.9999 なら「確N」、
 * それ未満なら「乱N xx.xx%」。全滅しないなら「-」。
 * (damage-summary.ts の describeNoteVerdict はカード1枚=複数技の"累積"逐次使用を前提にしており、
 * result.lethal もその累積系列を指すため、技ごとに独立した確定数を出したい本ページでは使えない。
 * 技ごとの独立系列は CalcLethalSequenceResult.perAttackLethal[moveIndex] から直接組み立てる。)
 */
function formatLethalLabel(series: readonly { attackCount: number; probability: number }[] | undefined): string {
  if (!Array.isArray(series) || series.length === 0) return "-";
  const firstLethal = series.find((l) => l.probability > 0);
  if (!firstLethal) return "-";
  if (firstLethal.probability >= 0.9999) return `確${firstLethal.attackCount}`;
  return `乱${firstLethal.attackCount} (${(firstLethal.probability * 100).toFixed(2)}%)`;
}

/**
 * calcLethalSequence の技1つぶんの結果を、既存 damage-summary と同じ丸め・確定数表記で整形する。
 * `moveIndex` は buildDamageCalcCalculations() が返した attacks 配列内でのその技の位置
 * (バッチ化された計算では perAttackDamages/perAttackLethal も同じ並びで返る)。
 */
export function formatDamageCalcResult(result: CalcLethalSequenceResult, moveIndex: number): DamageCalcDisplay {
  const damages = result.perAttackDamages[moveIndex] ?? [];
  const hp = result.defenderHp;
  const damage = damages.length > 0 && hp > 0
    ? `${((Math.min(...damages) / hp) * 100).toFixed(1)}〜${((Math.max(...damages) / hp) * 100).toFixed(1)}%`
    : "-";
  const verdict = formatLethalLabel(result.perAttackLethal[moveIndex]);
  return { damage, verdict };
}
