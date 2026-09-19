// チーム編集画面「相性チェック」の純粋ロジック。
//
// 使用率上位N体の相手に対して、自チームの「最大ダメージでHPを半分超削れる/削られる
// メンバーが何体居るか」を数え、その人数でアイコンの濃さを変えて有利・不利を一目で
// 分かるようにする機能の、数値部分だけを切り出したモジュール。
//
// src/lib/team-suggest.ts / src/lib/stats.ts と同じ制約に従い、DOM にも DB にも
// Pyodide にも触れない純粋関数だけで構成する(node --test から直接検証できるようにするため。
// tests/team-matchup.test.ts)。実際のダメージ計算は src/lib/pyodide-engine.ts の
// calcMaxDamageMatrix()、相手ポケモンの取得は GET /api/matchup-targets が担う。
//
// =============================================================================
// 仕様
// =============================================================================
// 相手ポケモンの想定個体(攻守共通):
//   特性・性格・努力値は OP.GG の採用率1位を使う(GET /api/matchup-targets が載せる)。
//   採用率データが無い種族と、OP.GG が特性・性格・努力値を持たないメガフォルムだけ、
//   下の OPPONENT_NATURE / OPPONENT_EVS(性格補正なし・H32振り)へ退避する。
// 攻撃:
//   1. チームポケモンを1体選び、覚えているすべての攻撃技で与ダメージを計算し、
//      最大ダメージのHP割合(0〜1)を記録する。
//   2. 1をチーム全員で行い、HP半分超(MEMBER_DAMAGE_THRESHOLD)を削れたメンバーの
//      人数がチームに占める割合を得る。
//   3. 2を反転し、防御と同じ「大きいほど不利」のスコアに揃えて濃く表示する。
//   4. 1〜3をすべての相手ポケモンに対して行う。
// 防御:
//   1. 相手の技構成は攻撃技のみを採用率20%以上の技すべて。
//   2〜4は相手からチームへの最大ダメージ割合を使い、HP半分超を削られたメンバーの
//      割合をスコアにする。大きいほど不利 = 濃く表示。

/** 相手ポケモンの努力値(Champions形式 0〜32)。採用率データが無いときのみ使う退避値。 */
export const OPPONENT_EVS: readonly number[] = [32, 0, 0, 0, 0, 0];

/**
 * OP.GG の努力値キー(英語フルネーム)を [H,A,B,C,D,S] の並びへ写す。
 * 値は OP.GG のポケモンチャンピオンズ版がそのまま 0〜32 スケールで返す
 * (src/pages/api/opgg-usage-evs.ts のコメント参照)ので、換算はしない。
 */
const OPGG_EV_KEYS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'] as const;

/**
 * OP.GG の採用率1位の努力値を、jpoke に渡す努力値配列へ直す。
 * キーが1つも無い(=努力値データを持たない種族)ときは null を返し、呼び出し側が
 * OPPONENT_EVS へ退避できるようにする ── 全て0の「無振り」で計算すると、
 * データが無いだけの相手を実際より脆く見せてしまうため。
 */
export function opponentEvsFromOpgg(values: Record<string, number> | null | undefined): number[] | null {
	if (!values) return null;
	if (!OPGG_EV_KEYS.some((key) => Number.isFinite(values[key]))) return null;
	return OPGG_EV_KEYS.map((key) => {
		const value = values[key];
		return Number.isFinite(value) ? Math.min(32, Math.max(0, Math.round(value))) : 0;
	});
}

/** 相手ポケモンの性格。「性格補正なし」= jpoke の無補正性格(src/lib/stats.ts の NATURE_STAT_MODIFIERS 参照)。 */
export const OPPONENT_NATURE = 'まじめ';

/**
 * 防御側の相手に持たせる技の、採用率の下限。
 *
 * OP.GG の usageRate は**パーセント(0〜100)**で届く(実測: 最大100・最小0.4)。
 * ここを 0.2 にしていたため実質「0.2%以上」= ほぼ全技が通り、相手が平均10本の
 * 攻撃技を持つ非現実的な個体になって被ダメージを過大評価していた。20%で揃える。
 */
export const OPPONENT_MIN_MOVE_RATIO = 20;

/**
 * 相性チェックで通常・メガフォルムを候補に残す、メガストーンの所持率(パーセント)の下限。
 *
 * OP.GG の usageRate は 0〜100 のパーセント表記。通常フォルムは全メガストーンの
 * 所持率を 100 から引いた値で判定する。
 */
export const MATCHUP_FORM_MIN_RATE = 20;

/** 相性チェックで一度に表示する使用率上位の件数。 */
export const MATCHUP_TOP_N = 30;

/** 段階表示用に一度だけ取得する使用率ランキングの上限。 */
export const MATCHUP_TARGET_LIMIT = 200;

/**
 * ランキングの添字と対応するスコアキャッシュを、既計算分を保ったまま拡張する。
 * `undefined` は未計算、`null` は計算不可を表す。スコア(number)だけでなく、
 * 相手ごとのメンバー別ダメージ割合(number[])のキャッシュにも同じ規約で使う。
 */
export function extendMatchupScores<T = number>(
	scores: (T | null | undefined)[] | undefined,
	targetCount: number,
): (T | null | undefined)[] {
	if (scores && scores.length >= targetCount) return scores;
	return [...(scores ?? []), ...new Array<T | null | undefined>(targetCount - (scores?.length ?? 0))];
}

/**
 * アイコンの最小不透明度。0にすると完全に消えてどのポケモンだったか分からなくなるため、
 * 「最も薄い」状態でも輪郭と色が判別できる下限を残す。
 */
export const MATCHUP_MIN_OPACITY = 0.25;

/**
 * 濃淡の正規化に使う「最小の想定レンジ」。
 *
 * スコアをそのまま不透明度に写すと、相手20体のスコアが狭い帯に集まったときに
 * 濃淡の差がほとんど見えない。一方で単純な min-max 正規化は、20体が本当に横並びの
 * ときに誤差レベルの差を最大コントラストまで拡大してしまう。
 * 0.25 は6体チームなら「1.5体ぶんの差でフルコントラスト」に当たる。
 *
 * そこで「実際のレンジ」と「この最小レンジ」の大きい方で割る。実レンジがこの値より
 * 広ければ通常の min-max 正規化と同じになり、狭ければコントラストがレンジに比例して
 * 弱まる ── 差が無いときは見た目にも差が出ない、という素直な振る舞いになる。
 */
export const MATCHUP_SCORE_MIN_RANGE = 0.25;

export type MatchupDirection = 'attack' | 'defense';

/** GET /api/matchup-targets が返す、1つの技の採用率。 */
export interface PopularMoveOption {
	value: string;
	ratio: number;
}

/** 相性チェックの候補カードに必要な種族情報。 */
export interface MatchupTargetForm {
	speciesName: string;
	dexNo: number | null;
	/**
	 * メガフォルムとして展開したカードかどうか。
	 * OP.GG の特性・性格・努力値はベースフォルムのものなので、メガでは特性を引き継がない
	 * (「いかく」のまま メガボーマンダ を計算してしまわないようにする)。
	 */
	isMega?: boolean;
}

/** メガフォルムと、その唯一の対応情報源であるメガストーン名。 */
export interface MatchupMegaForm extends MatchupTargetForm {
	megaStoneName: string;
}

/** OP.GG の item 使用率。null は未取得として 0% 扱いにする。 */
export interface MatchupItemUsage {
	name: string;
	usageRate: number | null;
}

/**
 * OP.GG のベース種族の item 使用率から、表示する通常・メガフォルムを決める。
 *
 * メガストーンが items に無い、または usageRate が null の場合は 0% として扱う。
 * 通常フォルムは先頭、続くメガフォルムは渡された順序のまま返すため、呼び出し側は
 * MASTER_LIST の順で megaForms を渡す。
 */
export function expandMatchupTargetForms(
	baseForm: MatchupTargetForm,
	megaForms: readonly MatchupMegaForm[],
	itemUsage: readonly MatchupItemUsage[] | null | undefined,
): MatchupTargetForm[] {
	const usageByItem = new Map<string, number>();
	for (const item of itemUsage ?? []) {
		if (item.usageRate === null || !Number.isFinite(item.usageRate)) continue;
		usageByItem.set(item.name, item.usageRate);
	}
	const megaRates = megaForms.map((megaForm) => usageByItem.get(megaForm.megaStoneName) ?? 0);
	const normalRate = 100 - megaRates.reduce((total, rate) => total + rate, 0);
	const forms: MatchupTargetForm[] = [];
	if (normalRate >= MATCHUP_FORM_MIN_RATE) forms.push(baseForm);
	for (let index = 0; index < megaForms.length; index += 1) {
		if (megaRates[index] >= MATCHUP_FORM_MIN_RATE) {
			forms.push({ speciesName: megaForms[index].speciesName, dexNo: megaForms[index].dexNo, isMega: true });
		}
	}
	return forms;
}

/**
 * 相手ポケモンの技構成を決める(防御側の計算に使う)。
 *
 * 採用率の高い順に攻撃技(物理・特殊)だけを拾い、最大 max 本まで埋める。
 * 変化技を除くのは、被ダメージの計算に一切寄与しないのに4枠を食い潰してしまうため
 * (実データでは「まもる」「みがわり」「つるぎのまい」等が上位に入る種族が多い)。
 *
 * options は採用率の降順で渡される前提だが、API の並び順に依存しないよう
 * ここでも明示的に並べ替える(同率のときは元の順序を保つ安定ソート)。
 * isAttackMove は技名 → 攻撃技かどうかの判定(呼び出し側が detail/moves.json の
 * category から作る。このモジュールは静的JSONに依存しない)。
 */
export function pickOpponentAttackMoves(
	options: readonly PopularMoveOption[],
	isAttackMove: (moveName: string) => boolean,
): string[] {
	const attacks = options.filter((o) => o.ratio >= OPPONENT_MIN_MOVE_RATIO && isAttackMove(o.value));
	// 安定ソート(Array.prototype.sort は ES2019 以降で安定)。
	const sorted = [...attacks].sort((a, b) => b.ratio - a.ratio);
	const picked: string[] = [];
	for (const option of sorted) {
		// 同じ技が2行で届いても4枠を二重に食わないよう畳む(集計側では起きない想定の防御)。
		if (picked.includes(option.value)) continue;
		picked.push(option.value);
	}
	return picked;
}

/**
 * 自チームのポケモンが「覚えているすべての攻撃技」を取り出す(攻撃側の計算に使う)。
 * 空文字・重複・変化技を落とすだけで、順序は登録順のまま(最大ダメージを採るので順序は結果に影響しない)。
 */
export function pickTeamAttackMoves(
	moveNames: readonly (string | null | undefined)[],
	isAttackMove: (moveName: string) => boolean,
): string[] {
	const picked: string[] = [];
	for (const raw of moveNames) {
		const name = raw?.trim();
		if (!name) continue;
		if (!isAttackMove(name)) continue;
		if (picked.includes(name)) continue;
		picked.push(name);
	}
	return picked;
}

/**
 * ダメージをHP割合(0〜1)に直す。
 *
 * 1を超えるダメージ(確1)は1に丸める ── 仕様が「HP割合(0〜1)」と定めているため。
 * スコアは MEMBER_DAMAGE_THRESHOLD による二値判定なので、丸めても人数は変わらない。
 * maxHp が 0 以下(データ欠損)のときは 0 を返す。
 */
export function damageRatio(maxDamage: number, maxHp: number): number {
	if (!Number.isFinite(maxDamage) || !Number.isFinite(maxHp) || maxHp <= 0) return 0;
	if (maxDamage <= 0) return 0;
	return Math.min(1, maxDamage / maxHp);
}

/**
 * メンバー1体ぶんの「大きく削った/削られた」判定のしきい値(最大ダメージのHP割合)。
 *
 * 以前は割合をそのまま平均していたが、平均は「全員が少しずつ通る」編成と
 * 「1体だけ刺さって残りが無力」な編成を同じ値にしてしまい、判定が甘く見えた。
 * HP半分超を削れるかどうかの二値にして、その人数で評価する。
 */
export const MEMBER_DAMAGE_THRESHOLD = 0.5;

/** 最大ダメージのHP割合が、しきい値を超えているか(超えれば1、超えなければ0として数える)。 */
export function isHeavyDamage(ratio: number): boolean {
	return ratio > MEMBER_DAMAGE_THRESHOLD;
}

/**
 * しきい値を超えたメンバーの人数を、チーム人数に対する割合(0〜1)で返す。
 * メンバーが0人なら null(「まだ計算できない」)。
 *
 * 人数そのものではなく割合にするのは、後段の matchupOpacity の正規化
 * (MATCHUP_SCORE_MIN_RANGE)が 0〜1 のスコアを前提にしているため。同じチーム内の
 * 比較では人数の合計と順序が変わらない。
 *
 * 攻撃技を1本も持たないメンバーは割合0として母数に含める ── 「その相手に何も通せない
 * メンバーが居る」ことは不利さそのものであり、母数から外すと逆に有利側へ寄ってしまうため。
 */
export function heavyDamageShare(ratios: readonly number[]): number | null {
	if (ratios.length === 0) return null;
	return ratios.filter((ratio) => isHeavyDamage(ratio)).length / ratios.length;
}

/**
 * 生の攻撃スコアだけを反転し、防御側と同じ「大きいほど不利」の向きへ揃える。
 */
export function matchupDisadvantageScore(rawScore: number, direction: MatchupDirection): number {
	return direction === 'attack' ? 1 - rawScore : rawScore;
}

/**
 * スコア(不利なメンバーの割合)を、アイコンの不透明度(MATCHUP_MIN_OPACITY〜1)へ写す。
 *
 * 攻守とも score が大きいほど不利という向きに統一されているため、
 * 大きい(不利な)相手ほど濃く残して目に留まるようにする。
 *
 * min/max は同時に表示している相手全員の score の最小・最大。正規化の理由は
 * MATCHUP_SCORE_MIN_RANGE のコメント参照。
 */
export function matchupOpacity(
	score: number,
	min: number,
	max: number,
	_direction: MatchupDirection,
): number {
	const range = Math.max(max - min, MATCHUP_SCORE_MIN_RANGE);
	const normalized = range > 0 ? Math.min(1, Math.max(0, (score - min) / range)) : 0;
	// _directionは呼び出し契約を保つため受け取るが、同じ向きなので分岐しない。
	const disadvantage = normalized;
	return MATCHUP_MIN_OPACITY + (1 - MATCHUP_MIN_OPACITY) * disadvantage;
}

/**
 * 表示に必要な値を一度に組み立てる。score が null(計算できなかった相手)の要素は
 * 正規化の min/max の母数から外し、opacity も null にする ── 「データが無い」を
 * 「有利」や「不利」として塗ってしまわないため(UI側は別の見せ方をする)。
 */
export interface MatchupScored<T> {
	item: T;
	score: number | null;
	opacity: number | null;
}

export function scoreToOpacities<T>(
	entries: readonly { item: T; score: number | null }[],
	direction: MatchupDirection,
): MatchupScored<T>[] {
	const scores = entries.map((e) => e.score).filter((s): s is number => s !== null);
	if (scores.length === 0) {
		return entries.map((e) => ({ item: e.item, score: e.score, opacity: null }));
	}
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	return entries.map((e) => ({
		item: e.item,
		score: e.score,
		opacity: e.score === null ? null : matchupOpacity(e.score, min, max, direction),
	}));
}
