import assert from 'node:assert/strict';
import test from 'node:test';
import { describeNoteVerdict, normalizeNoteAttacks } from '../src/lib/damage-summary.ts';

test('describeNoteVerdict labels a partial lethal chance as a random KO with two decimal places', () => {
	const attacks = normalizeNoteAttacks({ attacks: [{ moveName: 'test-move' }] }, null);
	const verdict = describeNoteVerdict(
		attacks,
		{
			lethal: [
				{ attackCount: 1, probability: 0 },
				{ attackCount: 2, probability: 0.755401611328125 },
				{ attackCount: 3, probability: 1 },
			],
			defenderHp: 100,
			cumulativeDamage: { min: 50, max: 60 },
			perAttackDamages: [[50, 60]],
		},
		() => 'physical',
	);
	assert.equal(verdict.label, '\u4e712 75.54%');
	assert.equal(verdict.severity, 'risky');
});
