import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listRankedTeamsBySpeciesKeys, rankedSeasonExists } from '../src/lib/ranked-teams.ts';

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

describe('listRankedTeamsBySpeciesKeys', () => {
  const fullMember = (slot: number, speciesKey: string) => ({
    slot, species_key: speciesKey, species_name: speciesKey, form_name: null,
    item_name: null, ability: null, nature: null, evs: null, move_names: null, type1: null, type2: null,
  });
  const rawTeam = (id: string, members: ReturnType<typeof fullMember>[]) => ({
    id, season: 'M-1', rank: 1, rating: null, rule: 'シングル',
    trainer_name: null, article_url: null, article_title: null, article_host: null,
    ranked_team_members: members, match: [{ species_key: 'ピカチュウ' }],
  });

  function createClient(pages: unknown[][]) {
    const calls: Array<[string, unknown]> = [];
    let pageIndex = 0;
    const query = {
      select(columns: string) { calls.push(['select', columns]); return this; },
      in(column: string, values: string[]) { calls.push(['in', [column, values]]); return this; },
      eq(column: string, value: string) { calls.push(['eq', [column, value]]); return this; },
      order(column: string, options: unknown) { calls.push(['order', [column, options]]); return this; },
      range(from: number, to: number) {
        calls.push(['range', [from, to]]);
        return Promise.resolve({ data: pages[pageIndex++] ?? [], error: null });
      },
    };
    const client = {
      from(name: string) { calls.push(['from', name]); return query; },
    } as unknown as SupabaseClient;
    return { client, calls };
  }

  it('別名の inner 埋め込みで種族を絞り、候補チームの全メンバーを1クエリで取得する', async () => {
    const { client, calls } = createClient([
      [rawTeam('team-1', [fullMember(1, 'ピカチュウ'), fullMember(2, 'イーブイ')])],
    ]);

    const teams = await listRankedTeamsBySpeciesKeys(['ピカチュウ', 'ピカチュウ'], client, 'M-1');

    assert.equal(teams.length, 1);
    // 絞り込みに使った種族だけでなく、チームの全メンバーが残る。
    assert.deepEqual(teams[0]?.members.map((member) => member.speciesKey), ['ピカチュウ', 'イーブイ']);
    assert.deepEqual(calls.filter(([name]) => name === 'from'), [['from', 'ranked_teams']]);
    assert.ok(calls.some(([name, value]) => name === 'select'
      && String(value).includes('match:ranked_team_members!inner(species_key)')));
    assert.ok(calls.some(([name, value]) => name === 'in'
      && JSON.stringify(value) === JSON.stringify(['match.species_key', ['ピカチュウ']])));
    assert.ok(calls.some(([name, value]) => name === 'eq'
      && JSON.stringify(value) === JSON.stringify(['season', 'M-1'])));
  });

  it('max-rows で切られないよう、1000件ちょうどのページの後も続けて取得する', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, index) => rawTeam(`team-${index}`, [fullMember(1, 'ピカチュウ')]));
    const { client, calls } = createClient([fullPage, [rawTeam('team-last', [fullMember(1, 'ピカチュウ')])]]);

    const teams = await listRankedTeamsBySpeciesKeys(['ピカチュウ'], client);

    assert.equal(teams.length, 1001);
    assert.deepEqual(calls.filter(([name]) => name === 'range').map(([, value]) => value), [[0, 999], [1000, 1999]]);
    assert.equal(calls.some(([name]) => name === 'eq'), false);
  });

  it('種族が空ならDBへ問い合わせない', async () => {
    const { client, calls } = createClient([]);
    assert.deepEqual(await listRankedTeamsBySpeciesKeys([], client), []);
    assert.deepEqual(calls, []);
  });
});
