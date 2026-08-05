// チーム編集画面「相性チェック」(ユーザー要望、2026-08-02)の純粋ロジック。
//
// 使用率上位N体の相手に対して、自チーム全員の「最大ダメージのHP割合」を平均し、
// その値でアイコンの濃さを変えて有利・不利を一目で分かるようにする機能の、
// 数値部分だけを切り出したモジュール。
//
// src/lib/team-suggest.ts / src/lib/stats.ts と同じ制約に従い、DOM にも DB にも
// Pyodide にも触れない純粋関数だけで構成する(node --test から直接検証できるようにするため。
// tests/team-matchup.test.ts)。実際のダメージ計算は src/lib/pyodide-engine.ts の
// calcMaxDamageMatrix()、相手ポケモンの取得は GET /api/matchup-targets が担う。
//
// =============================================================================
// 仕様(ユーザー指示、2026-08-02)
// =============================================================================
// 攻撃:
//   1. 相手ポケモンを1体選ぶ。性格補正なし、努力値はH32振り。
//   2. チームポケモンを1体選び、覚えているすべての攻撃技で与ダメージを計算し、
//      最大ダメージのHP割合(0〜1)を記録する。
//   3. チーム全員で2を行い、最大ダメージ割合の平均値を得る。
//   4. 3を反転し、防御と同じ「大きいほど不利」のスコアに揃えて濃く表示する。
//   5. 1〜4をすべての相手ポケモンに対して行う。
// 防御:
//   1. 相手ポケモンを1体選ぶ。性格補正なし、努力値はH32振り。技構成は攻撃技のみを
//      採用率の上から順に最大4つ。
//   2〜4は相手からチームへの最大ダメージ割合を使う。大きいほど不利 = 濃く表示。

/** 相手ポケモンの努力値(Champions形式 0〜32)。仕様どおりHのみ32、他は0。 */
export const OPPONENT_EVS: readonly number[] = [32, 0, 0, 0, 0, 0];

/** 相手ポケモンの性格。「性格補正なし」= jpoke の無補正性格(src/lib/stats.ts の NATURE_STAT_MODIFIERS 参照)。 */
export const OPPONENT_NATURE = 'まじめ';

/** 防御側の相手が持つ技の最大数(実機の4枠に合わせる)。 */
export const OPPONENT_MAX_MOVES = 4;

/** 相性チェックの対象にする使用率上位の体数(ユーザー指示「N=20」)。 */
export const MATCHUP_TOP_N = 20;

/**
 * アイコンの最小不透明度。0にすると完全に消えてどのポケモンだったか分からなくなるため、
 * 「最も薄い」状態でも輪郭と色が判別できる下限を残す。
 */
export const MATCHUP_MIN_OPACITY = 0.25;

/**
 * 濃淡の正規化に使う「最小の想定レンジ」。
 *
 * 生の割合をそのまま不透明度に写すと、実データでは20体の平均値が狭い帯
 * (例: 防御側は相手の攻撃側努力値が0のため 0.15〜0.45 程度)に集まり、
 * 濃淡の差がほとんど見えない。一方で単純な min-max 正規化は、20体が本当に横並びの
 * ときに誤差レベルの差を最大コントラストまで拡大してしまう。
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
	max: number = OPPONENT_MAX_MOVES,
): string[] {
	const attacks = options.filter((o) => isAttackMove(o.value));
	// 安定ソート(Array.prototype.sort は ES2019 以降で安定)。
	const sorted = [...attacks].sort((a, b) => b.ratio - a.ratio);
	const picked: string[] = [];
	for (const option of sorted) {
		if (picked.length >= max) break;
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
 * 1を超えるダメージ(確1)は1に丸める ── 仕様が「HP割合(0〜1)」と定めているのに加え、
 * 丸めないと「HPの3倍を出せる相手」が平均値を独りで引き上げ、他の5体が全く通らない
 * 編成でも有利に見えてしまうため。maxHp が 0 以下(データ欠損)のときは 0 を返す。
 */
export function damageRatio(maxDamage: number, maxHp: number): number {
	if (!Number.isFinite(maxDamage) || !Number.isFinite(maxHp) || maxHp <= 0) return 0;
	if (maxDamage <= 0) return 0;
	return Math.min(1, maxDamage / maxHp);
}

/**
 * チーム全員ぶんの割合の平均。メンバーが0人なら null(「まだ計算できない」)を返す。
 *
 * 攻撃技を1本も持たないメンバーは 0 として平均に含める ── 「その相手に何も通せない
 * メンバーが居る」ことは不利さそのものであり、母数から外すと逆に有利側へ寄ってしまうため。
 */
export function averageRatio(ratios: readonly number[]): number | null {
	if (ratios.length === 0) return null;
	return ratios.reduce((acc, r) => acc + r, 0) / ratios.length;
}

/**
 * UI改修依頼(2026-08-05)「攻撃側もスコアが高いほど不利にする」対応。
 * 生の攻撃スコアだけを反転し、防御側と同じ「大きいほど不利」の向きへ揃える。
 */
export function matchupDisadvantageScore(rawScore: number, direction: MatchupDirection): number {
	return direction === 'attack' ? 1 - rawScore : rawScore;
}

/**
 * 平均割合(score)を、アイコンの不透明度(MATCHUP_MIN_OPACITY〜1)へ写す。
 *
 * UI改修依頼(2026-08-05)により攻守とも score が大きい = 不利へ統一したため、
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
	// UI改修依頼(2026-08-05)「攻守とも高いほど不利」対応。_directionは呼び出し契約を保つため受け取るが、同じ向きなので分岐しない。
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
