// 保存済みの対戦相手メモ(opponent_notes の1レコード)を、読み取り専用の「圧縮表示」用の
// 文字列へ変換する純粋関数群。
//
// 【何のためにあるか】
// チーム編集画面(/team/[id])の右パネルに、選択した個体に登録済みのダメージ計算を
// 圧縮版で並べるため(ワイヤーフレーム docs/ui_proposal/ダメージカード_圧縮.png)。
// 表示内容は個体編集画面(/box/[id])のダメージカードを折りたたんだ状態と同じ:
//   アイコン | 種族名 / 攻撃 or 防御 / 特性 / H-A-B-C-D-S
//            | 技名 / 詳細設定 / 累計計算結果
//
// 【なぜ src/lib/box-id/damage-calc.ts から共有せず別ファイルにしたか】
// 個体編集画面の圧縮表示(refreshCollapsedSummary / refreshCollapsedTechniques /
// renderTotalDisplay)は、同等のロジックを initDamageCalc() のクロージャ内部に持っている。
// それらを export して再利用するには damage-calc.ts 自体を import する必要があるが、
// damage-calc.ts は src/lib/pyodide-engine.ts(ブラウザ専用・Pyodide/wheelのfetchを伴う
// 巨大モジュール)を静的importしているため、
//   - チーム編集画面が計算エンジン一式を読み込んでしまう(圧縮表示は保存済みスナップ
//     ショットを読むだけで計算エンジンを必要としない)
//   - node --test でユニットテストできない
// という2つの問題が起きる。そのため「DBに保存された形(OpponentBuildInput /
// OpponentFieldInput / OpponentClientResultInput)だけを入力に取る」純粋関数として
// ここに独立実装した。DOM・fetch・Node API に依存しないこと(src/lib/stats.ts と同じ制約)。
//
// ⚠️ 表示語彙(「確N」「10発以上」「攻撃側どく」「急所」「壁」など)は個体編集画面の
// 圧縮表示と一致させてある。damage-calc.ts 側の語彙を変えるときはこちらも合わせること
// (対応する実装: damage-calc.ts の describeSeriesVerdict / describeStandaloneLethal /
// describeExtendedTotalNoLethalLabel / formatCumulativeDamage /
// collectConditionChipsForCollapsed)。両者が食い違っていないことは
// tests/damage-summary.test.ts が実データ相当のケースで固定している。

import type {
	OpponentAttackInput,
	OpponentBuildInput,
	OpponentClientResultInput,
	OpponentFieldInput,
} from './opponent-notes-validation.ts';
import {
	calcHpStat,
	calcOtherStat,
	NATURE_STAT_MODIFIERS,
	STAT_KEYS,
	type StatKey,
} from './stats.ts';

// 技の分類。呼び出し元が public/master-data の技データ(loadMoveDetailMap)から解決して渡す
// ── このファイル自身は fetch しない。型だけ pokemon-master-data.ts から借りる(値をimportすると
// node --test で fetch に触れてしまうため import type にしてある)。
export type { MoveCategory } from './pokemon-master-data.ts';
import type { MoveCategory } from './pokemon-master-data.ts';
export type MoveCategoryResolver = (moveName: string) => MoveCategory | null;

/** .severity-bar[data-severity] に渡す値(src/styles/global.css)。 */
export type DamageSeverity = 'lethal' | 'risky' | 'safe' | 'none';

// damage-calc.ts の MAX_STANDALONE_ATTACKS / TEN_OR_MORE_LABEL と同じ値。
// 10発当てても全乱数分岐が致死に至らない場合は確定数を出さない(42-D3)。
export const MAX_STANDALONE_ATTACKS = 10;
export const TEN_OR_MORE_LABEL = `${MAX_STANDALONE_ATTACKS}発以上`;

// 一撃必殺技・はきだす・変化技の断り書き。damage-calc.ts の同名定数と同じ文面。
export const OHKO_MOVE_NAMES: ReadonlySet<string> = new Set(['じわれ', 'ハサミギロチン', 'ぜったいれいど', 'つのドリル']);
export const OHKO_NOTE =
	'一撃必殺技のため、命中すれば相手の残りHPに関わらず倒します(命中率30%。この計算は命中を前提にしています)。';
export const STATUS_MOVE_TOTAL_NOTE_ALL = '技列がすべて変化技のため、合計のダメージを算出できません。';
export const UNSUPPORTED_LETHAL_TOTAL_NOTE_ALL = '技列がすべて「はきだす」のため、合計のダメージを算出できません。';
export const STATUS_AND_UNSUPPORTED_TOTAL_NOTE_ALL =
	'技列がすべて変化技または「はきだす」のため、合計のダメージを算出できません。';
export const UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME =
	'技列に「はきだす」を含むため、算出できる技だけを合算した参考値です(はきだすは0ダメージとして計算されています)。';

/** 「はきだす」だけは calc_lethal 経路でダメージを算出できない(damage-calc.ts と同じ判定)。 */
export function isUnsupportedLethalMove(name: string): boolean {
	return name.trim() === 'はきだす';
}

/**
 * 1件の攻撃(技カード1枚)の条件を、旧形式(field直下に共通で持っていた時代)の値で
 * 埋めたうえでスカラーへ正規化したもの。damage-calc.ts の DamageColumnState のうち、
 * 圧縮表示に必要な項目だけを持つ。
 */
export interface NormalizedNoteAttack {
	moveName: string;
	hitCount: number;
	critical: boolean;
	weather: string;
	terrain: string;
	/** 壁(リフレクター/ひかりのかべ/オーロラベール)がどれか1つでも立っているか。 */
	wallEnabled: boolean;
	stealthRock: boolean;
	attackerAilment: string;
	defenderAilment: string;
	attackerTerastallized: boolean;
	defenderTerastallized: boolean;
	/** 攻撃側のランク補正。物理ならA、特殊ならCのうち最初に非ゼロの値(damage-calc.ts の rankFromLegacyBoosts と同じ)。 */
	attackerRank: number;
	/** 防御側のランク補正。物理ならB、特殊ならDのうち最初に非ゼロの値。 */
	defenderRank: number;
}

/** jpoke Battle.modify_hp(r=...) と同じ丸めで、ステルスロックの削り量を返す。 */
export function calcStealthRockDamage(maxHp: number, rockTypeModifier: number): number {
	if (!Number.isFinite(maxHp) || maxHp <= 0 || !Number.isFinite(rockTypeModifier) || rockTypeModifier < 0) return 0;
	return Math.max(1, Math.trunc((maxHp * rockTypeModifier) / 8));
}

function rankFrom(boosts: number[] | undefined, primary: StatKey, secondary: StatKey): number {
	if (!Array.isArray(boosts)) return 0;
	const p = boosts[STAT_KEYS.indexOf(primary)] ?? 0;
	if (p !== 0) return p;
	return boosts[STAT_KEYS.indexOf(secondary)] ?? 0;
}

/**
 * opponent_notes.field(+旧形式の move_name)を、表示用の攻撃列へ正規化する。
 * damage-calc.ts の rowFromNote()(legacyConditions → columnFromAttack)と同じ優先順位:
 * 技カードごとの値(field.attacks[i])があればそれを使い、無い項目だけ field 直下の
 * 旧形式の値で埋める。field.attacks が空なら move_name の単発メモとして1件に畳む。
 */
export function normalizeNoteAttacks(
	field: OpponentFieldInput | null | undefined,
	moveName: string | null | undefined,
): NormalizedNoteAttack[] {
	const f = field ?? {};
	const fromAttack = (attack: OpponentAttackInput): NormalizedNoteAttack => {
		const attackerBoosts = attack.attackerBoosts ?? f.attackerBoosts;
		const defenderBoosts = attack.defenderBoosts ?? f.defenderBoosts;
		const sideFields = attack.defenderSideFields ?? f.defenderSideFields ?? [];
		return {
			moveName: (attack.moveName ?? '').trim(),
			hitCount: attack.hitCount ?? 1,
			critical: attack.critical ?? f.critical ?? false,
			weather: attack.weather ?? f.weather ?? '',
			terrain: attack.terrain ?? f.terrain ?? '',
			wallEnabled: Array.isArray(sideFields) && sideFields.length > 0,
			stealthRock: attack.stealthRock ?? false,
			attackerAilment: attack.attackerAilment ?? f.attackerAilment ?? '',
			defenderAilment: attack.defenderAilment ?? f.defenderAilment ?? '',
			attackerTerastallized: attack.attackerTerastallized ?? f.attackerTerastallized ?? false,
			defenderTerastallized: attack.defenderTerastallized ?? f.defenderTerastallized ?? false,
			attackerRank: rankFrom(attackerBoosts, 'atk', 'spa'),
			defenderRank: rankFrom(defenderBoosts, 'def', 'spd'),
		};
	};
	if (Array.isArray(f.attacks) && f.attacks.length > 0) return f.attacks.map(fromAttack);
	if (moveName != null && moveName.trim() !== '') return [fromAttack({ moveName })];
	return [];
}

/** 技名が設定されている攻撃列だけ(client_result の配列の並び順と対応する)。 */
export function validNoteAttacks(attacks: NormalizedNoteAttack[]): NormalizedNoteAttack[] {
	return attacks.filter((a) => a.moveName !== '');
}

/**
 * 1段目: 技名。複数回ヒットする技には「(N発)」を付ける。
 * 例: 「スケイルショット(2発) + フレアドライブ」。
 */
export function formatNoteMoveLine(attacks: NormalizedNoteAttack[]): string {
	const named = validNoteAttacks(attacks);
	if (named.length === 0) return '(技未設定)';
	return named.map((a) => (a.hitCount > 1 ? `${a.moveName}(${a.hitCount}発)` : a.moveName)).join(' + ');
}

/**
 * 既定以外の条件を短いラベルの配列にする。
 * damage-calc.ts の collectConditionChipsForCollapsed() と同じ語彙・同じ順序
 * (全チップに「攻撃側」「防御側」の側prefixを付ける圧縮表示向けの版)。
 */
export function collectNoteConditionChips(attack: NormalizedNoteAttack, category: MoveCategory | null): string[] {
	const chips: string[] = [];
	if (attack.weather) chips.push(attack.weather);
	if (attack.terrain) chips.push(attack.terrain);
	if (attack.wallEnabled) chips.push('壁');
	if (attack.stealthRock) chips.push('ステルスロック');
	if (attack.critical) chips.push('急所');
	if (attack.attackerAilment) chips.push(`攻撃側${attack.attackerAilment}`);
	if (attack.defenderAilment) chips.push(`防御側${attack.defenderAilment}`);
	if (attack.attackerTerastallized) chips.push('攻撃側テラスタル');
	if (attack.defenderTerastallized) chips.push('防御側テラスタル');
	const atkLabel = category === 'special' ? '特攻' : '攻撃';
	const defLabel = category === 'special' ? '特防' : '防御';
	if (attack.attackerRank !== 0) chips.push(`攻撃側${atkLabel}${attack.attackerRank > 0 ? '+' : ''}${attack.attackerRank}`);
	if (attack.defenderRank !== 0) chips.push(`防御側${defLabel}${attack.defenderRank > 0 ? '+' : ''}${attack.defenderRank}`);
	return chips;
}

/**
 * 2段目: 詳細設定。技列が複数あり、条件が付いている列も複数あるときだけ列番号を頭に付ける
 * (damage-calc.ts の refreshCollapsedTechniques と同じ規則)。条件が1つも無ければ空文字。
 */
export function formatNoteConditionLine(
	attacks: NormalizedNoteAttack[],
	categoryOf: MoveCategoryResolver,
): string {
	const named = validNoteAttacks(attacks);
	const groups: { index: number; chips: string[] }[] = [];
	attacks.forEach((a, i) => {
		if (a.moveName === '') return;
		const chips = collectNoteConditionChips(a, categoryOf(a.moveName));
		if (chips.length > 0) groups.push({ index: i + 1, chips });
	});
	if (groups.length === 0) return '';
	const showIndex = named.length > 1;
	return groups.map((g) => (showIndex ? `${g.index}: ${g.chips.join('・')}` : g.chips.join('・'))).join(' ｜ ');
}

/** 累計致死率の系列から「確N」を求める。全乱数分岐が致死(probability≒1)になる最初の位置だけを採る。 */
function describeSeriesVerdict(
	series: Array<{ attackCount: number; probability: number }> | undefined,
	noLethalLabel: string,
): { label: string; severity: DamageSeverity } {
	if (!Array.isArray(series) || series.length === 0) return { label: '-', severity: 'none' };
	const confirmed = series.find((l) => l.probability >= 0.9999);
	if (!confirmed) return { label: noLethalLabel, severity: 'safe' };
	const severity: DamageSeverity =
		confirmed.attackCount === 1 ? 'lethal' : confirmed.attackCount === 2 ? 'risky' : 'safe';
	return { label: `確${confirmed.attackCount}`, severity };
}

/**
 * 攻撃列の範囲内で確殺に届かなかったときの延長見積り。
 * 有効な攻撃列が1件だけなら perAttackLethal[0](エンジンの厳密値)をそのまま使い、
 * それ以外は perAttackDamages を先頭から繰り返し当てたHP分布で近似する
 * (damage-calc.ts の describeExtendedTotalNoLethalLabel と同じ)。
 */
function describeExtendedNoLethalLabel(
	validAttackCount: number,
	result: OpponentClientResultInput,
): string {
	if (validAttackCount === 1 && Array.isArray(result.perAttackLethal?.[0])) {
		return describeSeriesVerdict(result.perAttackLethal[0], TEN_OR_MORE_LABEL).label;
	}
	const per = result.perAttackDamages;
	const hp = result.defenderHp;
	if (!Array.isArray(per) || per.length === 0 || !hp || hp <= 0) return TEN_OR_MORE_LABEL;
	const extended: Array<{ attackCount: number; probability: number }> = [];
	let dist = new Map<number, number>([[hp, 1]]);
	for (let attack = 1; attack <= MAX_STANDALONE_ATTACKS; attack += 1) {
		const damages = per[(attack - 1) % per.length];
		if (!Array.isArray(damages) || damages.length === 0) continue;
		const next = new Map<number, number>();
		for (const [remain, freq] of dist) {
			for (const d of damages) {
				const value = Math.max(0, remain - d);
				next.set(value, (next.get(value) ?? 0) + freq);
			}
		}
		dist = next;
		let total = 0;
		for (const freq of dist.values()) total += freq;
		const zero = dist.get(0) ?? 0;
		extended.push({ attackCount: attack, probability: total > 0 ? zero / total : 0 });
	}
	return describeSeriesVerdict(extended, TEN_OR_MORE_LABEL).label;
}

/**
 * 累計ダメージ「31〜37 (20〜25%)」。cumulativeDamage(エンジンの厳密値)があればそれを使い、
 * 無い古いスナップショットだけ perAttackDamages の最小同士・最大同士の単純加算で近似する。
 */
export function formatCumulativeDamage(validAttackCount: number, result: OpponentClientResultInput): string {
	const exact = result.cumulativeDamage;
	let min: number;
	let max: number;
	if (exact && Number.isFinite(exact.min) && Number.isFinite(exact.max)) {
		min = exact.min;
		max = exact.max;
	} else {
		const per = result.perAttackDamages;
		if (!Array.isArray(per) || validAttackCount === 0) return '';
		min = 0;
		max = 0;
		for (let i = 0; i < validAttackCount; i += 1) {
			const damages = per[i];
			if (!Array.isArray(damages) || damages.length === 0) return '';
			min += Math.min(...damages);
			max += Math.max(...damages);
		}
	}
	const hp = result.defenderHp;
	if (hp && hp > 0) {
		const pctMin = Math.floor((min / hp) * 100);
		const pctMax = Math.ceil((max / hp) * 100);
		const pct = pctMin === pctMax ? `${pctMin}%` : `${pctMin}〜${pctMax}%`;
		return `${min}〜${max} (${pct})`;
	}
	return `${min}〜${max}`;
}

/**
 * 3段目: 累計計算結果。
 * label は「確N」(10発以内に確殺できないときは空文字。42-D3「10発以上のときは確定数表記をしない」)、
 * detail はダメージ量、note は断り書き(一撃必殺技・はきだす等。無ければ空文字)。
 */
export interface DamageVerdict {
	label: string;
	detail: string;
	note: string;
	severity: DamageSeverity;
}

export function describeNoteVerdict(
	attacks: NormalizedNoteAttack[],
	result: OpponentClientResultInput | null | undefined,
	categoryOf: MoveCategoryResolver,
): DamageVerdict {
	const valid = validNoteAttacks(attacks);
	if (valid.length === 0) return { label: '', detail: '(技未設定)', note: '', severity: 'none' };

	const hasUnsupported = valid.some((a) => isUnsupportedLethalMove(a.moveName));
	const hasStatus = valid.some((a) => categoryOf(a.moveName) === 'status');
	const allNoDamage = valid.every((a) => categoryOf(a.moveName) === 'status' || isUnsupportedLethalMove(a.moveName));
	if (allNoDamage && (hasStatus || hasUnsupported)) {
		const note = hasStatus && hasUnsupported
			? STATUS_AND_UNSUPPORTED_TOTAL_NOTE_ALL
			: hasStatus
				? STATUS_MOVE_TOTAL_NOTE_ALL
				: UNSUPPORTED_LETHAL_TOTAL_NOTE_ALL;
		return { label: '', detail: '', note, severity: 'none' };
	}
	if (!result || !Array.isArray(result.perAttackDamages)) {
		// 圧縮表示は保存済みスナップショットを読むだけで、この画面では再計算しない。
		return { label: '', detail: '(計算結果が未保存)', note: '', severity: 'none' };
	}

	const damageText = formatCumulativeDamage(valid.length, result);
	const { label, severity } = describeSeriesVerdict(
		result.lethal,
		describeExtendedNoLethalLabel(valid.length, result),
	);
	const notes: string[] = [];
	if (valid.some((a) => OHKO_MOVE_NAMES.has(a.moveName))) notes.push(OHKO_NOTE);
	if (hasUnsupported) notes.push(UNSUPPORTED_LETHAL_TOTAL_NOTE_SOME);
	return {
		// 「10発以上」は確定数ではないのでラベルとして出さない(42-D3)。
		label: label === TEN_OR_MORE_LABEL || label === '-' ? '' : label,
		detail: damageText,
		note: notes.join(' '),
		// はきだすを含む合算値は参考値なので色で確定的な印象を与えない。
		severity: hasUnsupported ? 'none' : severity,
	};
}

// H/A/B/C/D/S の1項目。label は性格補正の上昇/下降を「A▲」「C▼」のように付記済み。
// 色だけで状態を伝えないため(WCAG 1.4.1)、個体編集画面の折りたたみ表示
// (damage-calc.ts の refreshCollapsedStats、47-A-7で+/-から▲/▼へ戻した)と同じグリフを使う。
export interface BuildStatCell {
	key: StatKey;
	label: string;
	value: number;
	mod: 'up' | 'down' | null;
}

const STAT_KANJI: Record<StatKey, string> = { hp: 'H', atk: 'A', def: 'B', spa: 'C', spd: 'D', spe: 'S' };

/**
 * 相手ビルドの実数値6項目。計算式は src/lib/stats.ts(チャンピオンズルール)をそのまま使う。
 * baseStats は public/master-data の種族値([H,A,B,C,D,S])。未知の種族なら null を返す。
 */
export function computeBuildStatCells(
	build: OpponentBuildInput | null | undefined,
	baseStats: number[] | undefined,
): BuildStatCell[] | null {
	if (!build || !Array.isArray(baseStats) || baseStats.length < STAT_KEYS.length) return null;
	const level = build.level ?? 50;
	const nature = NATURE_STAT_MODIFIERS[build.nature ?? ''] ?? { up: null, down: null };
	return STAT_KEYS.map((key, i) => {
		const iv = build.ivs?.[i] ?? 31;
		const ev = build.evs?.[i] ?? 0;
		const mod: 'up' | 'down' | null = key === 'hp' ? null : nature.up === key ? 'up' : nature.down === key ? 'down' : null;
		const value =
			key === 'hp'
				? calcHpStat(level, baseStats[i], iv, ev)
				: calcOtherStat(level, baseStats[i], iv, ev, mod === 'up' ? 1.1 : mod === 'down' ? 0.9 : 1.0);
		return { key, label: STAT_KANJI[key] + (mod === 'up' ? '▲' : mod === 'down' ? '▼' : ''), value, mod };
	});
}

/** 圧縮カード1枚ぶんの表示内容。 */
export interface OpponentNoteSummary {
	/** この個体が攻撃側か防御側か。field.direction 未指定は既存データ互換で 'attack'。 */
	direction: 'attack' | 'defense';
	directionLabel: '攻撃' | '防御';
	opponentName: string;
	abilityName: string;
	itemName: string;
	teraType: string;
	moveLine: string;
	conditionLine: string;
	verdict: DamageVerdict;
	memo: string;
}

export interface OpponentNoteLike {
	opponent_build: Record<string, unknown> | null;
	field: Record<string, unknown> | null;
	move_name: string | null;
	client_result: Record<string, unknown> | null;
	memo?: string | null;
}

export function summarizeOpponentNote(
	note: OpponentNoteLike,
	categoryOf: MoveCategoryResolver,
): OpponentNoteSummary {
	const build = (note.opponent_build ?? {}) as unknown as OpponentBuildInput;
	const field = (note.field ?? {}) as unknown as OpponentFieldInput;
	const result = (note.client_result ?? null) as unknown as OpponentClientResultInput | null;
	const attacks = normalizeNoteAttacks(field, note.move_name);
	const direction = field.direction === 'defense' ? 'defense' : 'attack';
	return {
		direction,
		directionLabel: direction === 'defense' ? '防御' : '攻撃',
		opponentName: (build.name ?? '').trim() || '(名前未設定)',
		abilityName: (build.abilityName ?? '').trim() || '(特性未設定)',
		itemName: (build.itemName ?? '').trim(),
		teraType: (build.teraType ?? '')?.trim() ?? '',
		moveLine: formatNoteMoveLine(attacks),
		conditionLine: formatNoteConditionLine(attacks, categoryOf),
		verdict: describeNoteVerdict(attacks, result, categoryOf),
		memo: (note.memo ?? '').trim(),
	};
}
