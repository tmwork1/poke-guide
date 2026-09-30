import type { PokemonMasterEntry } from "../pokemon-master-data";

// ps-champ-ja/pokedex.json 由来の forme のうち、選出時ではなく対戦中の状態変化で
// 行き来するフォルム。地方・性別・姿違い、キョダイマックス等は含めない。
// 判定は表示名ではなくマスターデータの forme を正とする。
// "Crowned"(ザシアン/ザマゼンタの王の姿)はメガシンカと同じ「対応アイテムを持っている
// ときだけ対戦開始時に変化する」フォルムのため、ここに含めた上でメガシンカと同様の
// アイテム所持チェックを別途行う(下のCROWNED_ITEM_BY_SPECIES参照)。
const BATTLE_FORMES = new Set([
	"Ash",
	"Blade",
	"Complete",
	"Crowned",
	"Galar-Zen",
	"Gorging",
	"Gulping",
	"Hangry",
	"Hero",
	"Meteor",
	"Noice",
	"Pirouette",
	"Primal",
	"Rainy",
	"School",
	"Snowy",
	"Stellar",
	"Sunny",
	"Terastal",
	"Ultra",
	"Zen",
	"Teal-Tera",
	"Wellspring-Tera",
	"Hearthflame-Tera",
	"Cornerstone-Tera",
]);

// メガストーンと同じ「対応アイテムを持っているときだけ候補に出す」フォルム変化。
// キー: 変化後の種族名(マスターデータのname)、値: 必要な持ち物名。
const CROWNED_ITEM_BY_SPECIES = new Map<string, string>([
	["ザシアン(けんのおう)", "くちたけん"],
	["ザマゼンタ(たてのおう)", "くちたたて"],
]);

function isMegaForme(forme: string | null): boolean {
	return forme?.includes("Mega") ?? false;
}

export function isBattleSwitchableForm(entry: PokemonMasterEntry): boolean {
	return isMegaForme(entry.forme) || (entry.forme != null && BATTLE_FORMES.has(entry.forme));
}

function sourceFormeFor(forme: string): string | null {
	if (forme === "Galar-Zen") return "Galar";
	if (forme.endsWith("-Tera")) return forme.slice(0, -"-Tera".length);
	return null;
}

function isCompatibleBattleForm(current: PokemonMasterEntry, candidate: PokemonMasterEntry): boolean {
	const candidateForme = candidate.forme;
	if (!candidateForme) return false;
	const sourceForme = sourceFormeFor(candidateForme);
	if (sourceForme !== null) {
		return current.forme === sourceForme || current.forme === candidateForme;
	}
	// ジガルデ・テラパゴスは複数の対戦中フォルム間を遷移する。
	if (candidateForme === "Complete") {
		return current.forme === null || current.forme === "10%" || current.forme === "Complete";
	}
	if (candidateForme === "Terastal" || candidateForme === "Stellar") {
		return current.forme === null || current.forme === "Terastal" || current.forme === "Stellar";
	}
	return current.forme === null || isBattleSwitchableForm(current);
}

/**
 * 育成画面の現在種族を先頭にし、この対戦行だけで選べる対戦中フォルムを返す。
 * メガシンカは対応するメガストーンを現在持っている候補だけを許可する。
 */
export function getBattleFormOptions(
	currentSpeciesName: string,
	heldItemName: string,
	master: readonly PokemonMasterEntry[],
	megaStoneBySpecies: ReadonlyMap<string, string>,
): PokemonMasterEntry[] {
	const current = master.find((entry) => entry.name === currentSpeciesName);
	if (!current) return [];

	const alternatives = master.filter((candidate) => {
		if (candidate.name === current.name || candidate.dexNo !== current.dexNo) return false;
		if (!isBattleSwitchableForm(candidate)) return false;
		if (isMegaForme(candidate.forme)) {
			return !isMegaForme(current.forme) && megaStoneBySpecies.get(candidate.name) === heldItemName;
		}
		if (candidate.forme === "Crowned") {
			return current.forme !== "Crowned" && CROWNED_ITEM_BY_SPECIES.get(candidate.name) === heldItemName;
		}
		return isCompatibleBattleForm(current, candidate);
	});

	// 保存種族自体が戦闘中フォルムだった場合も、その変化元へ戻して比較できるようにする。
	if (!isMegaForme(current.forme) && current.forme && BATTLE_FORMES.has(current.forme)) {
		const sourceForme = sourceFormeFor(current.forme);
		const source = master.find((candidate) =>
			candidate.dexNo === current.dexNo
			&& !isBattleSwitchableForm(candidate)
			&& (candidate.forme ?? null) === sourceForme,
		);
		if (source && !alternatives.some((candidate) => candidate.name === source.name)) alternatives.unshift(source);
	}

	return [current, ...alternatives];
}
