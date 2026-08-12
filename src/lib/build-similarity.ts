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
}

export function calculateTeamSimilarity(
	team: readonly TeamSimilaritySource[],
	rankedMembers: readonly TeamSimilarityTarget[],
): number {
	return team.reduce((score, member) => {
		const matched = rankedMembers.find((rankedMember) => rankedMember.speciesName === member.species_name);
		return matched ? score + 1 + calculateBuildSimilarity(member, matched) : score;
	}, 0);
}
