// 実数値(H/A/B/C/D/S)の計算式。チャンピオンズルール(IV=31固定・努力値0〜32スケール・
// Lv50固定)専用の純JS実装で、vendor/jpoke(Pyodide経由で動くPython実装)とは独立に動く。
// /box, /box/[id], /share/[slug], /pokemon/[name] の4画面に同じ計算関数がコピーされていたため
// このファイルへ統合した。振る舞いは一切変えていない(表示される数値は統合前後で完全一致する
// ことをPlaywrightで実測済み)。
//
// 【仕様の出典】 .claude/skills/jpoke/references/ruleset.md
// 「1. チャンピオンズルール」「2. 実数値の計算式」「3. 性格補正」に、vendor/jpoke の
// どのファイルの何行目が根拠かまで出典つきで要約されている。将来この式を疑う場合は
// まずそちらを読むこと(vendor/jpokeを直接読み直す前に)。要点だけ再掲する:
//   - 個体値は Pokemon コンストラクタで [31]*6 がデフォルト
//     (出典: vendor/jpoke/src/jpoke/model/pokemon.py:100, :742-758)。
//   - 努力値は0〜32の「Champions形式」で保持し、0〜252スケールの素の努力値へは
//     `chmp_to_legacy_effort()` で変換する: n=0のときだけ0、それ以外は 8n-4
//     (出典: vendor/jpoke/src/jpoke/model/stats.py:42-51)。
//   - HP: `((base*2+iv+effort//4)*level)//100 + level + 10`。ただし種族値HP=1
//     (ヌケニン)は個体値・努力値・レベルによらず常に1固定
//     (出典: vendor/jpoke/src/jpoke/model/stats.py:7-22)。
//   - HP以外: `int((((base*2+iv+effort//4)*level)//100 + 5) * nc)`。ncは性格補正
//     (上昇1.1倍/下降0.9倍/補正なし1.0倍)で、掛け算は性格補正のみに掛かる
//     (出典: vendor/jpoke/src/jpoke/model/stats.py:25-39)。
//   - 性格補正テーブルは vendor/jpoke/src/jpoke/data/nature.py:1-27 の NATURE_MODIFIER と
//     一致させてある。
//
// 【SSR/クライアント両対応の制約】 Astroのフロントマター(SSR、/share/[slug].astro・
// /pokemon/[name].astro)と、ブラウザ専用<script>(/box/index.astro・/box/[id].astro)の
// 両方からimportされる。そのため、このファイルはDOM・ブラウザAPI・Node APIに一切依存しない
// 純粋関数のみで構成すること(依存すると必ずどちらか片方が壊れる)。

/** evs/ivs配列の並び順([HP, 攻撃, 防御, 特攻, 特防, 素早さ])。box/index.astro等のUI側と揃えてある。 */
export const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export interface NatureStatModifier {
	up: StatKey | null;
	down: StatKey | null;
}

// 性格による実数値の上昇/下降ステータスの判定テーブル。
// 出典: vendor/jpoke/src/jpoke/data/nature.py:1-27 の NATURE_MODIFIER と同期させること
// (上昇1.1倍/下降0.9倍。まじめ・てれや・がんばりや・すなお・きまぐれの5つは補正なし)。
export const NATURE_STAT_MODIFIERS: Record<string, NatureStatModifier> = {
	"まじめ": { up: null, down: null },
	"さみしがり": { up: "atk", down: "def" },
	"いじっぱり": { up: "atk", down: "spa" },
	"やんちゃ": { up: "atk", down: "spd" },
	"ゆうかん": { up: "atk", down: "spe" },
	"ずぶとい": { up: "def", down: "atk" },
	"わんぱく": { up: "def", down: "spa" },
	"のうてんき": { up: "def", down: "spd" },
	"のんき": { up: "def", down: "spe" },
	"ひかえめ": { up: "spa", down: "atk" },
	"おっとり": { up: "spa", down: "def" },
	"うっかりや": { up: "spa", down: "spd" },
	"れいせい": { up: "spa", down: "spe" },
	"おだやか": { up: "spd", down: "atk" },
	"おとなしい": { up: "spd", down: "def" },
	"しんちょう": { up: "spd", down: "spa" },
	"なまいき": { up: "spd", down: "spe" },
	"おくびょう": { up: "spe", down: "atk" },
	"せっかち": { up: "spe", down: "def" },
	"ようき": { up: "spe", down: "spa" },
	"むじゃき": { up: "spe", down: "spd" },
	"てれや": { up: null, down: null },
	"がんばりや": { up: null, down: null },
	"すなお": { up: null, down: null },
	"きまぐれ": { up: null, down: null },
};

/**
 * Champions形式の努力値(0〜32)を素の努力値(0〜252)へ変換する。
 * 出典: vendor/jpoke/src/jpoke/model/stats.py:42-51 (chmp_to_legacy_effort)。
 * n=0のときだけ特例で0(通常の式 8n-4 だと-4になってしまうため)。
 */
export function chmpToLegacyEffort(evChamp: number): number {
	return evChamp === 0 ? 0 : 8 * evChamp - 4;
}

/**
 * chmpToLegacyEffort() の逆関数。素の努力値(0〜252)をChampions形式(0〜32)へ変換する。
 * legacy=0のときだけ0(通常の逆算式 (n+4)/8 でも0になるが、0〜32へのクランプも含めて明示する)。
 *
 * 注意: OP.GG使用率データ(/api/opgg-usage-evs)のEVスプレッドは、取得元が
 * 「ポケモンチャンピオンズ」専用ページ(op.gg/ja/pokemon-champions)であるため、既に
 * 本アプリと同じ0〜32スケールで返ってくる(実データで確認済み)。そちらの変換にはこの
 * 関数を使わないこと(box-id/left-panel.ts の applyTopOpggBuild 参照)。標準の0〜252
 * スケールの値を変換する必要が生じたときのための汎用ユーティリティとして用意する。
 */
export function legacyToChmpEffort(legacyEffort: number): number {
	if (legacyEffort <= 0) return 0;
	return Math.min(32, Math.max(0, Math.round((legacyEffort + 4) / 8)));
}

/**
 * HPの実数値を計算する。
 * 出典: vendor/jpoke/src/jpoke/model/stats.py:7-22 (calc_hp)。
 * ヌケニン特例: 種族値HP=1のポケモンは個体値・努力値・レベルによらず常に1固定。
 */
export function calcHpStat(level: number, base: number, iv: number, evChamp: number): number {
	if (base === 1) return 1; // ヌケニン特例(vendor/jpoke/src/jpoke/model/stats.pyと同じ)
	const effort = chmpToLegacyEffort(evChamp);
	return Math.floor(((base * 2 + iv + Math.floor(effort / 4)) * level) / 100) + level + 10;
}

/**
 * HP以外(攻撃/防御/特攻/特防/素早さ)の実数値を計算する。
 * 出典: vendor/jpoke/src/jpoke/model/stats.py:25-39 (calc_stat)。
 * nc は性格補正(上昇1.1/下降0.9/補正なし1.0)。
 */
export function calcOtherStat(level: number, base: number, iv: number, evChamp: number, nc: number): number {
	const effort = chmpToLegacyEffort(evChamp);
	return Math.floor((Math.floor(((base * 2 + iv + Math.floor(effort / 4)) * level) / 100) + 5) * nc);
}

// /pokemon/[name].astro (種族単位ページ)専用の薄いラッパー。
// このページは「特定の個体」ではなく「種族の基礎データ」を示す画面のため、level/ivを
// 引数に取らず常にLv50・IV31固定(チャンピオンズルール)、性格補正なし(nc=1.0固定)で計算する。
// 呼び出し側の使い勝手(引数がbaseとevChampの2つだけ)を変えないよう、calcHpStat/calcOtherStatに
// デフォルト引数を足すのではなく専用の薄いラッパー関数として分離した
// (box/[id].astro側などlevel/ivを明示的に渡す呼び出しのシグネチャに影響を与えないため)。
export const SPECIES_PAGE_LEVEL = 50;
export const SPECIES_PAGE_IV = 31;

/** /pokemon/[name].astro 用: Lv50・IV31固定でHP実数値を計算する。 */
export function calcHpStatAtLv50Iv31(base: number, evChamp: number): number {
	return calcHpStat(SPECIES_PAGE_LEVEL, base, SPECIES_PAGE_IV, evChamp);
}

/** /pokemon/[name].astro 用: Lv50・IV31固定・性格補正なしでHP以外の実数値を計算する。 */
export function calcOtherStatAtLv50Iv31(base: number, evChamp: number): number {
	return calcOtherStat(SPECIES_PAGE_LEVEL, base, SPECIES_PAGE_IV, evChamp, 1.0);
}
