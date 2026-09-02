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
	/** ランキング表記の種族名(メガシンカは進化前+メガストーンのまま)。突き合わせには使わない。 */
	speciesName: string;
	/**
	 * アプリ内語彙の種族名(owned_pokemon.species_name と同じ、migrations/011)。
	 * メガシンカ個体は「メガ」+進化前名になり、進化前とは別種族として扱われる。
	 * 種族の同定・メガ判定は必ずこちらを使う(speciesName はメガと進化前が同名に潰れている)。
	 */
	speciesKey?: string | null;
}

const MEGA_EVOLUTION_BONUS = 3;

function isMegaEvolution(target: TeamSimilarityTarget): boolean {
	return target.speciesKey?.startsWith("メガ") ?? false;
}

export function calculateTeamSimilarity(
	team: readonly TeamSimilaritySource[],
	rankedMembers: readonly TeamSimilarityTarget[],
): number {
	return team.reduce((score, member) => {
		const matched = rankedMembers.find((rankedMember) => !!rankedMember.speciesKey && rankedMember.speciesKey === member.species_name);
		return matched
			? score + 1 + calculateBuildSimilarity(member, matched) + (isMegaEvolution(matched) ? MEGA_EVOLUTION_BONUS : 0)
			: score;
	}, 0);
}
