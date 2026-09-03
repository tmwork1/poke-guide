import { getFieldState, getOpponentBuild, getOpponentState, getSelfState, type TeamMemberSpecInput } from "./shared-core";
import { buildDamageCalcCalculations, formatDamageCalcResult, type DamageCalcMoveInput, type DamageCalcPatternKey } from "./spec-builder";
import { calcLethalSequence, initEngine, isEngineReady, type PokemonSpec } from "../pyodide-engine";

export interface DamageCalcPatternResult {
  damage: string;
  verdict: string;
}

export interface DamageCalcDirectionResult {
  results: Map<string, Partial<Record<DamageCalcPatternKey, DamageCalcPatternResult>>>;
  skipped: Map<string, "status" | "unsupported">;
}

export interface DamageCalcMemberResult {
  attack: DamageCalcDirectionResult;
  defense: DamageCalcDirectionResult;
}

function selfSpec(member: TeamMemberSpecInput): PokemonSpec {
  const pokemon = member.ownedPokemon;
  return {
    name: pokemon.species_name,
    level: pokemon.level ?? 50,
    nature: pokemon.nature ?? undefined,
    abilityName: pokemon.ability_name ?? undefined,
    itemName: member.itemOverride ?? pokemon.item_name ?? undefined,
    teraType: pokemon.tera_type,
    moveNames: pokemon.move_names,
    evs: pokemon.evs,
    ivs: pokemon.ivs,
  };
}

async function calculateDirection(
  member: TeamMemberSpecInput,
  direction: "attack" | "defense",
  moves: readonly DamageCalcMoveInput[],
): Promise<DamageCalcDirectionResult> {
  const built = buildDamageCalcCalculations({
    selfSpec: selfSpec(member),
    opponentBuild: getOpponentBuild(),
    selfState: getSelfState(),
    opponentState: getOpponentState(),
    fieldState: getFieldState(),
    direction,
    moves,
  });
  const results = new Map<string, Partial<Record<DamageCalcPatternKey, DamageCalcPatternResult>>>();
  const skipped = new Map<string, "status" | "unsupported">();
  for (const skippedMove of built.skipped) skipped.set(skippedMove.moveName, skippedMove.kind);

  for (const calculation of built.calculations) {
    // 同じ物理/特殊カテゴリの技を1回に束ねる。3パターン x 2カテゴリなので最大6回。
    (globalThis as typeof globalThis & { __damageCalcLethalCalls?: number }).__damageCalcLethalCalls =
      ((globalThis as typeof globalThis & { __damageCalcLethalCalls?: number }).__damageCalcLethalCalls ?? 0) + 1;
    // eslint-disable-next-line no-console
    console.info("[damage-calc] calcLethalSequence", { direction, pattern: calculation.pattern, count: calculation.attacks.length });
    const result = await calcLethalSequence(
      calculation.attackerSpec,
      calculation.defenderSpec,
      calculation.attacks,
      calculation.options,
    );
    calculation.attacks.forEach((attack, index) => {
      const byPattern = results.get(attack.moveName) ?? {};
      byPattern[calculation.pattern] = formatDamageCalcResult(result, index);
      results.set(attack.moveName, byPattern);
    });
  }
  return { results, skipped };
}

/** ブラウザ専用。必要な対面を初めて描く時だけPyodideを起動する。 */
export async function calculateMemberDamage(
  member: TeamMemberSpecInput,
  selfMoves: readonly DamageCalcMoveInput[],
  opponentMoves: readonly DamageCalcMoveInput[],
  onProgress?: (message: string) => void,
): Promise<DamageCalcMemberResult> {
  // 表示中の1メンバーぶんを測るため、呼び出し回数カウンタを計算単位でリセットする。
  (globalThis as typeof globalThis & { __damageCalcLethalCalls?: number }).__damageCalcLethalCalls = 0;
  if (!isEngineReady()) {
    onProgress?.("計算エンジンを読み込んでいます…");
    await initEngine((progress) => onProgress?.(progress.message));
  }
  // PyodideのWASMヒープを同時に叩かず、カード内の6バッチを順に実行する。
  const attack = await calculateDirection(member, "attack", selfMoves);
  const defense = await calculateDirection(member, "defense", opponentMoves);
  return { attack, defense };
}
