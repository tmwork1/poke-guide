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

export interface SimilarTeamEntry<T> {
	team: T;
	similarity: number;
	hasBuildMatch: boolean;
}

/**
 * 類似チーム画面の既存順序を、クライアントとAPIで共有する。
 * 育成内容一致を先頭にし、その中は類似度降順・順位昇順、種族のみ一致は順位昇順にする。
 */
export function rankSimilarTeams<T extends { rank: number; members: readonly TeamSimilarityTarget[] }>(
	team: readonly TeamSimilaritySource[],
	rankedTeams: readonly T[],
): SimilarTeamEntry<T>[] {
	const scored = rankedTeams
		.map((rankedTeam, index) => ({
			team: rankedTeam,
			index,
			similarity: calculateTeamSimilarity(team, rankedTeam.members),
			hasBuildMatch: rankedTeam.members.some((rankedMember) =>
				team.some((member) => !!rankedMember.speciesKey
					&& rankedMember.speciesKey === member.species_name
					&& calculateBuildSimilarity(member, rankedMember) > 0),
			),
		}))
		.filter((entry) => entry.similarity > 0);

	const exactBuilds = scored
		.filter((entry) => entry.hasBuildMatch)
		.sort((a, b) => b.similarity - a.similarity || a.team.rank - b.team.rank || a.index - b.index);
	const speciesOnlyBuilds = scored
		.filter((entry) => !entry.hasBuildMatch)
		.sort((a, b) => a.team.rank - b.team.rank || b.similarity - a.similarity || a.index - b.index);

	return [...exactBuilds, ...speciesOnlyBuilds].map(({ index: _index, ...entry }) => entry);
}
