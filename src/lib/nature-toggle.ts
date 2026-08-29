import type { StatKey } from "./stats.ts";

export type NatureNeutralAssignment = "up" | "down";

// 無補正からの最初のタップは、必ず既存の性格になるよう上昇・下降を同時に決める。
// A/C を最初に選んだ場合は、その反対側を下降にする。防御系を最初に選んだ場合は、
// 特攻下降を既定値として補う（どの入口でも片側だけの補正を作らないため）。
function initialNatureDownFor(up: StatKey): StatKey {
	return up === "spa" ? "atk" : "spa";
}

// 性格補正ボタンの遷移。
//
// - 無補正からは、タップした能力を上昇・A/C のもう片方を下降にして一発で性格を確定する。
// - 性格が確定済みのときに未選択の能力をタップすると、下降→上昇→下降…と交互に
//   入れ替える。次に入れ替える側は呼び出し側で保持する。
// - 上昇・下降いずれかを再タップすると、両方とも無補正へ戻す。
//
// 返り値は常に「両方未選択」または「上昇・下降が異なる両選択」のどちらかであり、
// 実在しない片側だけの補正を作らない。
export function nextNatureBoosts(
	current: { up: StatKey | null; down: StatKey | null },
	key: StatKey,
	nextNeutralAssignment: NatureNeutralAssignment = "down",
): { up: StatKey | null; down: StatKey | null; nextNeutralAssignment: NatureNeutralAssignment } {
	if (current.up === key || current.down === key) {
		return { up: null, down: null, nextNeutralAssignment: "up" };
	}

	// 古い保存値などで片側だけになっていても、その状態を引き継がず完全な性格へ正規化する。
	if (current.up === null || current.down === null) {
		return { up: key, down: initialNatureDownFor(key), nextNeutralAssignment: "down" };
	}

	if (nextNeutralAssignment === "up") {
		return { up: key, down: current.down, nextNeutralAssignment: "down" };
	}
	return { up: current.up, down: key, nextNeutralAssignment: "up" };
}
