import assert from 'node:assert/strict';
import test from 'node:test';
import { calcStealthRockDamage } from '../src/lib/damage-summary.ts';

test('ステルスロックはいわ相性に応じて最大HPを削る', () => {
  const hp = 160;
  assert.equal(calcStealthRockDamage(hp, 1), 20);    // 1/8
  assert.equal(calcStealthRockDamage(hp, 2), 40);    // 1/4
  assert.equal(calcStealthRockDamage(hp, 4), 80);    // 1/2
  assert.equal(calcStealthRockDamage(hp, 0.5), 10);  // 1/16
});

test('割合ダメージはjpoke同様に切り捨て、最低1ダメージ', () => {
  assert.equal(calcStealthRockDamage(161, 1), 20);
  assert.equal(calcStealthRockDamage(1, 0.25), 1);
});
