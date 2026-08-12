export interface BuildSimilaritySource {
  ability_name: string | null;
  item_name: string | null;
  move_names: readonly string[];
}

export interface BuildSimilarityTarget {
  ability: string | null;
  itemName: string | null;
  moveNames: readonly string[];
}

export function calculateBuildSimilarity(
  pokemon: BuildSimilaritySource,
  target: BuildSimilarityTarget,
): number {
  let similarity = 0;

  if (pokemon.ability_name && target.ability && pokemon.ability_name === target.ability) {
    similarity += 1;
  }
  if (pokemon.item_name && target.itemName && pokemon.item_name === target.itemName) {
    similarity += 1;
  }
  if (target.moveNames.length > 0) {
    const matchedMoves = target.moveNames.filter((moveName) => pokemon.move_names.includes(moveName)).length;
    similarity += Math.min(matchedMoves / 4, 1);
  }

  return similarity;
}
