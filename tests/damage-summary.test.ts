// src/lib/damage-summary.ts のユニットテスト。
//
// フィクスチャはローカルDBに実在する opponent_notes 4件(個体 c8680844-... メガリザードンX に
// 紐づくメモ)の実データをそのまま写したもの。チーム編集画面の右パネルに出る圧縮表示が、
// 個体編集画面のダメージカードを折りたたんだときと同じ文字列になることを固定する。
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	collectNoteConditionChips,
	computeBuildStatCells,
	describeNoteVerdict,
	formatCumulativeDamage,
	formatNoteConditionLine,
	formatNoteMoveLine,
	normalizeNoteAttacks,
	summarizeOpponentNote,
	validNoteAttacks,
	type MoveCategory,
} from '../src/lib/damage-summary.ts';

// 技の分類はマスタデータ(public/master-data/detail/moves.json)から引く想定なので、
// テストでは必要な技だけの固定表で代用する。
const CATEGORIES: Record<string, MoveCategory> = {
	あくのはどう: 'special',
	でんきショック: 'special',
	フレアドライブ: 'physical',
	スケイルショット: 'physical',
	まもる: 'status',
	はきだす: 'physical',
	じわれ: 'physical',
};
const categoryOf = (name: string): MoveCategory | null => CATEGORIES[name.trim()] ?? null;

// --- 実データ4件 -----------------------------------------------------------

const NOTE_KAMEX = {
	opponent_build: {
		evs: [0, 0, 0, 0, 0, 0],
		ivs: [31, 31, 31, 31, 31, 31],
		name: 'メガカメックス',
		nature: 'まじめ',
		itemName: 'カメックスナイト',
		abilityName: 'メガランチャー',
	},
	field: {
		attacks: [
			{
				terrain: 'グラスフィールド',
				weather: 'はれ',
				critical: false,
				hitCount: 1,
				moveName: 'あくのはどう',
				attackerBoosts: [0, 0, 0, 6, 0, 0],
				defenderBoosts: [0, 0, 0, 0, 6, 0],
				attackerAilment: '',
				defenderAilment: 'どく',
				attackerVolatiles: [],
				defenderVolatiles: [],
				defenderSideFields: [],
				attackerTerastallized: false,
				defenderTerastallized: false,
			},
		],
		direction: 'attack',
	},
	move_name: 'あくのはどう',
	client_result: {
		lethal: [{ attackCount: 1, probability: 0 }],
		defenderHp: 154,
		perAttackLethal: [
			[
				{ attackCount: 1, probability: 0 },
				{ attackCount: 2, probability: 0 },
				{ attackCount: 3, probability: 0 },
				{ attackCount: 4, probability: 1 },
			],
		],
		cumulativeDamage: { max: 37, min: 31 },
		perAttackDamages: [[31, 32, 33, 34, 35, 36, 37]],
	},
	memo: null,
};

const NOTE_KAIRYU = {
	opponent_build: {
		evs: [0, 32, 0, 0, 0, 16],
		ivs: [31, 31, 31, 31, 31, 31],
		name: 'カイリュー',
		nature: 'いじっぱり',
		itemName: 'あつぞこブーツ',
		abilityName: 'マルチスケイル',
		teraType: 'ノーマル',
	},
	field: {
		attacks: [
			{ moveName: 'スケイルショット', hitCount: 2, weather: '', terrain: '', critical: false, defenderSideFields: [] },
			{ moveName: 'フレアドライブ', hitCount: 1, weather: '', terrain: '', critical: false, defenderSideFields: ['リフレクター'] },
		],
		direction: 'attack',
	},
	move_name: 'スケイルショット',
	client_result: {
		lethal: [
			{ attackCount: 1, probability: 0 },
			{ attackCount: 2, probability: 0 },
		],
		defenderHp: 166,
		perAttackLethal: [
			[
				{ attackCount: 1, probability: 0 },
				{ attackCount: 2, probability: 0.755401611328125 },
				{ attackCount: 3, probability: 1 },
			],
			[
				{ attackCount: 1, probability: 0 },
				{ attackCount: 8, probability: 0.5047746219206601 },
				{ attackCount: 9, probability: 1 },
			],
		],
		cumulativeDamage: { max: 138, min: 113 },
		perAttackDamages: [
			[75, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93],
			[19, 20, 21, 22],
		],
	},
	memo: null,
};

const NOTE_HABATAKU = {
	opponent_build: {
		evs: [0, 0, 0, 32, 0, 32],
		ivs: [31, 31, 31, 31, 31, 31],
		name: 'ハバタクカミ',
		nature: 'おくびょう',
		itemName: 'ブーストエナジー',
		abilityName: 'こだいかっせい',
		teraType: 'フェアリー',
	},
	field: {
		attacks: [{ moveName: 'フレアドライブ', hitCount: 1 }],
		direction: 'attack',
	},
	move_name: 'フレアドライブ',
	client_result: {
		lethal: [{ attackCount: 1, probability: 1 }],
		defenderHp: 130,
		cumulativeDamage: { max: 277, min: 235 },
		perAttackDamages: [[235, 240, 245, 250, 255, 260, 265, 277]],
	},
	memo: null,
};

const NOTE_FUSHIGIBANA = {
	opponent_build: {
		evs: [32, 32, 32, 0, 16, 0],
		ivs: [31, 31, 31, 31, 31, 31],
		name: 'フシギバナ(キョダイ)',
		nature: 'ゆうかん',
		itemName: 'たべのこし',
		abilityName: 'しんりょく',
	},
	field: {
		attacks: [{ moveName: 'でんきショック', hitCount: 1 }],
		direction: 'defense',
	},
	move_name: 'でんきショック',
	client_result: {
		lethal: [{ attackCount: 1, probability: 0 }],
		defenderHp: 153,
		// 10発当てても致死率0(たべのこしの回復が上回る)。確定数を出さないケースの実データ。
		perAttackLethal: [Array.from({ length: 10 }, (_, i) => ({ attackCount: i + 1, probability: 0 }))],
		cumulativeDamage: { max: 11, min: 9 },
		perAttackDamages: [[9, 10, 11]],
	},
	memo: null,
};

// --- 攻撃列の正規化 --------------------------------------------------------

test('normalizeNoteAttacks: 技カードごとの値をそのまま読む', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAMEX.field, NOTE_KAMEX.move_name);
	assert.equal(attacks.length, 1);
	assert.equal(attacks[0].moveName, 'あくのはどう');
	assert.equal(attacks[0].weather, 'はれ');
	assert.equal(attacks[0].terrain, 'グラスフィールド');
	assert.equal(attacks[0].defenderAilment, 'どく');
	// attackerBoosts の spa=+6 → 攻撃側ランク+6(atkが0なのでspaを採る)
	assert.equal(attacks[0].attackerRank, 6);
	// defenderBoosts の spd=+6 → 防御側ランク+6
	assert.equal(attacks[0].defenderRank, 6);
	assert.equal(attacks[0].wallEnabled, false);
});

test('normalizeNoteAttacks: 旧形式(field直下の共通条件)を全技カードへ引き継ぐ', () => {
	const attacks = normalizeNoteAttacks(
		{
			weather: 'あられ',
			critical: true,
			defenderSideFields: ['リフレクター'],
			attackerBoosts: [0, 2, 0, 0, 0, 0],
			attacks: [{ moveName: 'じしん' }, { moveName: 'まもる', weather: 'すなあらし' }],
		},
		null,
	);
	assert.equal(attacks[0].weather, 'あられ');
	assert.equal(attacks[0].critical, true);
	assert.equal(attacks[0].wallEnabled, true);
	assert.equal(attacks[0].attackerRank, 2);
	// 技カード側に値があればそちらが勝つ
	assert.equal(attacks[1].weather, 'すなあらし');
});

test('normalizeNoteAttacks: attacksが無いメモは move_name の単発1件に畳む', () => {
	const attacks = normalizeNoteAttacks({ direction: 'attack' }, 'じしん');
	assert.deepEqual(attacks.map((a) => a.moveName), ['じしん']);
	assert.equal(attacks[0].hitCount, 1);
});

test('normalizeNoteAttacks: 技も attacks も無ければ空配列', () => {
	assert.deepEqual(normalizeNoteAttacks({}, null), []);
	assert.deepEqual(normalizeNoteAttacks(null, ''), []);
});

test('validNoteAttacks: 技名が空の列は除外する', () => {
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'じしん' }, { moveName: '' }] }, null);
	assert.equal(attacks.length, 2);
	assert.equal(validNoteAttacks(attacks).length, 1);
});

// --- 1段目: 技名 -----------------------------------------------------------

test('formatNoteMoveLine: 複数回ヒットには(N発)を付け、+ で連結する', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAIRYU.field, NOTE_KAIRYU.move_name);
	assert.equal(formatNoteMoveLine(attacks), 'スケイルショット(2発) + フレアドライブ');
});

test('formatNoteMoveLine: 技が1件も無ければ(技未設定)', () => {
	assert.equal(formatNoteMoveLine([]), '(技未設定)');
});

// --- 2段目: 詳細設定 -------------------------------------------------------

test('collectNoteConditionChips: 特殊技はランクを特攻/特防と表記する', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAMEX.field, NOTE_KAMEX.move_name);
	assert.deepEqual(collectNoteConditionChips(attacks[0], 'special'), [
		'はれ',
		'グラスフィールド',
		'防御側どく',
		'攻撃側特攻+6',
		'防御側特防+6',
	]);
});

test('collectNoteConditionChips: 物理技/分類不明はランクを攻撃/防御と表記する', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAMEX.field, NOTE_KAMEX.move_name);
	assert.deepEqual(collectNoteConditionChips(attacks[0], 'physical').slice(3), ['攻撃側攻撃+6', '防御側防御+6']);
	assert.deepEqual(collectNoteConditionChips(attacks[0], null).slice(3), ['攻撃側攻撃+6', '防御側防御+6']);
});

test('collectNoteConditionChips: 壁・ステルスロック・急所・テラス・下降ランクも漏れなく出す', () => {
	const attacks = normalizeNoteAttacks(
		{
			attacks: [
				{
					moveName: 'じしん',
					critical: true,
					stealthRock: true,
					defenderSideFields: ['リフレクター'],
					attackerAilment: 'やけど',
					attackerTerastallized: true,
					defenderTerastallized: true,
					defenderBoosts: [0, 0, -1, 0, 0, 0],
				},
			],
		},
		null,
	);
	assert.deepEqual(collectNoteConditionChips(attacks[0], 'physical'), [
		'壁',
		'ステルスロック',
		'急所',
		'攻撃側やけど',
		'攻撃側テラスタル',
		'防御側テラスタル',
		'防御側防御-1',
	]);
});

test('formatNoteConditionLine: 条件が無ければ空文字', () => {
	const attacks = normalizeNoteAttacks(NOTE_FUSHIGIBANA.field, NOTE_FUSHIGIBANA.move_name);
	assert.equal(formatNoteConditionLine(attacks, categoryOf), '');
});

test('formatNoteConditionLine: 条件が1列だけでも技が複数あれば列番号を付ける', () => {
	// カイリューは2列目(フレアドライブ)だけに defenderSideFields=["リフレクター"] が付いている
	const attacks = normalizeNoteAttacks(NOTE_KAIRYU.field, NOTE_KAIRYU.move_name);
	assert.equal(formatNoteConditionLine(attacks, categoryOf), '2: 壁');
});

test('formatNoteConditionLine: 単一技なら列番号を付けない', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAMEX.field, NOTE_KAMEX.move_name);
	assert.equal(
		formatNoteConditionLine(attacks, categoryOf),
		'はれ・グラスフィールド・防御側どく・攻撃側特攻+6・防御側特防+6',
	);
});

test('formatNoteConditionLine: 技が複数あるときは列番号を付けて ｜ で区切る', () => {
	const attacks = normalizeNoteAttacks(
		{
			attacks: [
				{ moveName: 'スケイルショット', weather: 'はれ' },
				{ moveName: 'フレアドライブ', critical: true },
			],
		},
		null,
	);
	assert.equal(formatNoteConditionLine(attacks, categoryOf), '1: はれ ｜ 2: 急所');
});

// --- 3段目: 累計計算結果 ---------------------------------------------------

test('formatCumulativeDamage: cumulativeDamage があればそれを使いHP比を添える', () => {
	assert.equal(formatCumulativeDamage(1, NOTE_KAMEX.client_result), '31〜37 (20〜25%)');
	assert.equal(formatCumulativeDamage(2, NOTE_KAIRYU.client_result), '113〜138 (68〜84%)');
});

test('formatCumulativeDamage: cumulativeDamage が無い古いスナップショットは単純加算で近似する', () => {
	const result = { defenderHp: 100, perAttackDamages: [[10, 12], [20, 24]] };
	assert.equal(formatCumulativeDamage(2, result), '30〜36 (30〜36%)');
});

test('describeNoteVerdict: 累計が確殺していれば確1(lethal)', () => {
	const attacks = normalizeNoteAttacks(NOTE_HABATAKU.field, NOTE_HABATAKU.move_name);
	const v = describeNoteVerdict(attacks, NOTE_HABATAKU.client_result, categoryOf);
	assert.equal(v.label, '確1');
	assert.equal(v.severity, 'lethal');
	assert.equal(v.detail, '235〜277 (180〜214%)');
	assert.equal(v.note, '');
});

test('describeNoteVerdict: 攻撃列内で確殺しない単一技は perAttackLethal の厳密値で延長する', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAMEX.field, NOTE_KAMEX.move_name);
	const v = describeNoteVerdict(attacks, NOTE_KAMEX.client_result, categoryOf);
	// perAttackLethal[0] は4発目で probability=1 → 確4
	assert.equal(v.label, '確4');
	assert.equal(v.severity, 'safe');
	assert.equal(v.detail, '31〜37 (20〜25%)');
});

test('describeNoteVerdict: 複数技で確殺しない場合は perAttackDamages を繰り返して延長見積りする', () => {
	const attacks = normalizeNoteAttacks(NOTE_KAIRYU.field, NOTE_KAIRYU.move_name);
	const v = describeNoteVerdict(attacks, NOTE_KAIRYU.client_result, categoryOf);
	// 攻撃列(スケイルショット→フレアドライブ)を先頭から繰り返し当てると、
	// 残りHPは 73〜91 → 51〜72 と減り、3発目(スケイルショット75〜93)で全分岐が致死。
	assert.equal(v.label, '確3');
	assert.equal(v.severity, 'safe');
	assert.equal(v.detail, '113〜138 (68〜84%)');
});

test('describeNoteVerdict: 10発当てても確殺しないときは確定数を出さない', () => {
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'でんきショック' }] }, null);
	const result = {
		lethal: [{ attackCount: 1, probability: 0 }],
		defenderHp: 200,
		cumulativeDamage: { min: 1, max: 2 },
		perAttackDamages: [[1, 2]],
	};
	const v = describeNoteVerdict(attacks, result, categoryOf);
	assert.equal(v.label, '');
	assert.equal(v.detail, '1〜2 (0〜1%)');
	assert.equal(v.severity, 'safe');
});

test('describeNoteVerdict: 技未設定・計算結果未保存はそれぞれの断りを出す', () => {
	assert.deepEqual(describeNoteVerdict([], null, categoryOf), {
		label: '',
		detail: '(技未設定)',
		note: '',
		severity: 'none',
	});
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'じしん' }] }, null);
	assert.equal(describeNoteVerdict(attacks, null, categoryOf).detail, '(計算結果が未保存)');
});

test('describeNoteVerdict: 全技が変化技ならダメージを出さず理由を示す', () => {
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'まもる' }] }, null);
	const v = describeNoteVerdict(attacks, { defenderHp: 100, perAttackDamages: [[0]] }, categoryOf);
	assert.equal(v.label, '');
	assert.equal(v.detail, '');
	assert.equal(v.note, '技列がすべて変化技のため、合計のダメージを算出できません。');
	assert.equal(v.severity, 'none');
});

test('describeNoteVerdict: 「はきだす」を含む合算は参考値として色を付けない', () => {
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'フレアドライブ' }, { moveName: 'はきだす' }] }, null);
	const v = describeNoteVerdict(
		attacks,
		{
			lethal: [{ attackCount: 1, probability: 1 }],
			defenderHp: 100,
			cumulativeDamage: { min: 120, max: 130 },
			perAttackDamages: [[120, 130], [0]],
		},
		categoryOf,
	);
	assert.equal(v.label, '確1');
	assert.equal(v.severity, 'none');
	assert.ok(v.note.includes('はきだす'));
});

test('describeNoteVerdict: 一撃必殺技には命中率の断りを添える', () => {
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'じわれ' }] }, null);
	const v = describeNoteVerdict(
		attacks,
		{
			lethal: [{ attackCount: 1, probability: 1 }],
			defenderHp: 150,
			cumulativeDamage: { min: 150, max: 150 },
			perAttackDamages: [[150]],
		},
		categoryOf,
	);
	assert.equal(v.label, '確1');
	assert.ok(v.note.includes('命中率30%'));
});

// --- 実数値 ----------------------------------------------------------------

test('computeBuildStatCells: 性格補正をラベルの▲/▼で表す(個体編集画面の折りたたみ表示と同じグリフ)', () => {
	// カイリューの種族値 [91, 134, 95, 100, 100, 80]、いじっぱり(A上昇/C下降)
	const cells = computeBuildStatCells(NOTE_KAIRYU.opponent_build, [91, 134, 95, 100, 100, 80]);
	assert.ok(cells);
	assert.deepEqual(cells.map((c) => c.label), ['H', 'A▲', 'B', 'C▼', 'D', 'S']);
	assert.deepEqual(cells.map((c) => c.mod), [null, 'up', null, 'down', null, null]);
	// 実数値は src/lib/stats.ts と同じ式(Lv50・IV31・努力値はChampionsスケール)。
	// H は努力値0なので ((91*2+31+0)*50)//100 + 50 + 10 = 166。
	assert.equal(cells[0].value, 166);
	assert.ok(cells[1].value > cells[3].value);
});

test('computeBuildStatCells: 種族値が引けなければ null', () => {
	assert.equal(computeBuildStatCells(NOTE_KAIRYU.opponent_build, undefined), null);
	assert.equal(computeBuildStatCells(null, [91, 134, 95, 100, 100, 80]), null);
});

// --- まとめ ----------------------------------------------------------------

test('summarizeOpponentNote: direction=defense は「防御」', () => {
	const s = summarizeOpponentNote(NOTE_FUSHIGIBANA, categoryOf);
	assert.equal(s.direction, 'defense');
	assert.equal(s.directionLabel, '防御');
	assert.equal(s.opponentName, 'フシギバナ(キョダイ)');
	assert.equal(s.abilityName, 'しんりょく');
	assert.equal(s.itemName, 'たべのこし');
	assert.equal(s.teraType, '');
	assert.equal(s.moveLine, 'でんきショック');
	assert.equal(s.conditionLine, '');
});

test('summarizeOpponentNote: direction 未指定は既存データ互換で「攻撃」', () => {
	const s = summarizeOpponentNote({ ...NOTE_KAMEX, field: { attacks: NOTE_KAMEX.field.attacks } }, categoryOf);
	assert.equal(s.direction, 'attack');
	assert.equal(s.directionLabel, '攻撃');
});

test('summarizeOpponentNote: 名前・特性が空ならフォールバック文言を出す', () => {
	const s = summarizeOpponentNote(
		{ opponent_build: { name: '  ' }, field: {}, move_name: null, client_result: null },
		categoryOf,
	);
	assert.equal(s.opponentName, '(名前未設定)');
	assert.equal(s.abilityName, '(特性未設定)');
	assert.equal(s.verdict.detail, '(技未設定)');
});

test('summarizeOpponentNote: テラスタイプはそのまま返す(未設定なら空文字)', () => {
	assert.equal(summarizeOpponentNote(NOTE_KAIRYU, categoryOf).teraType, 'ノーマル');
	assert.equal(summarizeOpponentNote(NOTE_KAMEX, categoryOf).teraType, '');
});
