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
	let score = 0;
	if (pokemon.ability_name && target.ability && pokemon.ability_name === target.ability) score += 1;
	if (pokemon.item_name && target.itemName && pokemon.item_name === target.itemName) score += 1;

	if (target.moveNames.length > 0) {
		const matchingMoves = target.moveNames.filter((moveName) => pokemon.move_names.includes(moveName)).length;
		score += matchingMoves / 4;
	}

	return score;
}

export interface TeamSimilaritySource extends BuildSimilaritySource {
	species_name: string;
}

export interface TeamSimilarityTarget extends BuildSimilarityTarget {
	speciesName: string;
	/** ランク構築側のフォルム名。メガシンカの一致を強く評価するために使う。 */
	formName?: string | null;
}

const MEGA_EVOLUTION_BONUS = 3;

function isMegaEvolution(target: TeamSimilarityTarget): boolean {
	return target.formName?.startsWith("Mega") ?? false;
}

export function calculateTeamSimilarity(
	team: readonly TeamSimilaritySource[],
	rankedMembers: readonly TeamSimilarityTarget[],
): number {
	return team.reduce((score, member) => {
		const matched = rankedMembers.find((rankedMember) => rankedMember.speciesName === member.species_name);
		return matched
			? score + 1 + calculateBuildSimilarity(member, matched) + (isMegaEvolution(matched) ? MEGA_EVOLUTION_BONUS : 0)
			: score;
	}, 0);
}
