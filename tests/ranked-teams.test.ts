import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rankedSeasonExists } from '../src/lib/ranked-teams.ts';

function createSeasonExistenceClient(result: { data: { id: string }[] | null; error: unknown }) {
  const calls: Array<[string, unknown]> = [];
  const query = {
    select(columns: string) {
      calls.push(['select', columns]);
      return this;
    },
    eq(column: string, value: string) {
      calls.push(['eq', [column, value]]);
      return this;
    },
    limit(value: number) {
      calls.push(['limit', value]);
      return Promise.resolve(result);
    },
  };
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('rankedSeasonExists', () => {
  it('対象シーズンを1件だけ取得して存在を判定する', async () => {
    const { client, calls } = createSeasonExistenceClient({ data: [{ id: 'team-id' }], error: null });

    assert.equal(await rankedSeasonExists('M-3', client), true);
    assert.deepEqual(calls, [
      ['from', 'ranked_teams'],
      ['select', 'id'],
      ['eq', ['season', 'M-3']],
      ['limit', 1],
    ]);
  });

  it('対象行がなければ存在しないと判定する', async () => {
    const { client } = createSeasonExistenceClient({ data: [], error: null });
    assert.equal(await rankedSeasonExists('M-999', client), false);
  });

  it('DBエラーを成功扱いにしない', async () => {
    const cause = new Error('query failed');
    const { client } = createSeasonExistenceClient({ data: null, error: cause });
    await assert.rejects(
      rankedSeasonExists('M-3', client),
      (error: Error) => error.message === '上位構築のシーズンを確認できませんでした' && error.cause === cause,
    );
  });
});
