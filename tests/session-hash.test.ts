// session_hash 生成ロジックの回帰テスト (開発プラン §2.4)。
// 同一セッション・同一日付なら同じハッシュになり、日付が変われば別のハッシュになることを検証する。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSessionHash, getUtcDateString } from '../src/lib/session-hash.ts';

describe('computeSessionHash', () => {
  it('同じセッションID・同じ日付・同じシークレットなら同じハッシュになる', async () => {
    const hash1 = await computeSessionHash('session-abc', 'secret-1', '2026-07-23');
    const hash2 = await computeSessionHash('session-abc', 'secret-1', '2026-07-23');
    assert.equal(hash1, hash2);
  });

  it('日付が変わると別のハッシュになる (長期追跡不可)', async () => {
    const hashDay1 = await computeSessionHash('session-abc', 'secret-1', '2026-07-23');
    const hashDay2 = await computeSessionHash('session-abc', 'secret-1', '2026-07-24');
    assert.notEqual(hashDay1, hashDay2);
  });

  it('セッションIDが変わると別のハッシュになる', async () => {
    const hashA = await computeSessionHash('session-a', 'secret-1', '2026-07-23');
    const hashB = await computeSessionHash('session-b', 'secret-1', '2026-07-23');
    assert.notEqual(hashA, hashB);
  });

  it('シークレットが変わると別のハッシュになる', async () => {
    const hash1 = await computeSessionHash('session-abc', 'secret-1', '2026-07-23');
    const hash2 = await computeSessionHash('session-abc', 'secret-2', '2026-07-23');
    assert.notEqual(hash1, hash2);
  });

  it('64文字の16進文字列 (SHA-256) を返す', async () => {
    const hash = await computeSessionHash('session-abc', 'secret-1', '2026-07-23');
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('dateStr省略時は当日の日付 (UTC) を使う', async () => {
    const explicit = await computeSessionHash('session-abc', 'secret-1', getUtcDateString());
    const implicit = await computeSessionHash('session-abc', 'secret-1');
    assert.equal(explicit, implicit);
  });

  it('空文字または空白だけのシークレットは匿名化を保証できないため拒否する', () => {
    assert.throws(
      () => computeSessionHash('session-abc', '   ', '2026-07-23'),
      /SESSION_HASH_SECRET is not configured/,
    );
  });
});

describe('getUtcDateString', () => {
  it('YYYY-MM-DD 形式 (UTC) を返す', () => {
    const date = new Date('2026-07-23T23:59:59.000Z');
    assert.equal(getUtcDateString(date), '2026-07-23');
  });

  it('UTC日付をまたぐ時刻でも正しくロールオーバーする', () => {
    // ローカルタイムゾーンに関わらず UTC 基準で日付が変わることを確認する。
    const beforeMidnightUtc = new Date('2026-07-23T23:00:00.000Z');
    const afterMidnightUtc = new Date('2026-07-24T01:00:00.000Z');
    assert.equal(getUtcDateString(beforeMidnightUtc), '2026-07-23');
    assert.equal(getUtcDateString(afterMidnightUtc), '2026-07-24');
  });
});
