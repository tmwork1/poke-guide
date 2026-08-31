// /api/teams・/api/teams/:id のリクエストボディ検証 + チーム編成ルール(G-1)の回帰テスト。
// 種族重複禁止(旧G-2)・持ち物重複禁止(旧G-3)は撤廃済み(2026-08、ユーザー指示により
// 種族・持ち物とも重複を許可する仕様に変更)。
// src/lib/team-validation.ts は純粋関数のみ(DB・JSON import に依存しない)なので、
// このテストもDBやネットワークを一切叩かない(owned-pokemon-validation.test.ts と同じ方針)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectionBlockReason,
  validateTeamComposition,
  validateTeamRequestBody,
} from '../src/lib/team-validation.ts';

describe('validateTeamComposition', () => {
  it('6体ちょうどは受け入れる', () => {
    const members = Array.from({ length: 6 }, (_, i) => ({ slot: i + 1 }));
    const result = validateTeamComposition(members);
    assert.equal(result.ok, true);
  });

  it('7体目はover-capacityで拒否する', () => {
    const members = Array.from({ length: 7 }, (_, i) => ({ slot: i + 1 }));
    const result = validateTeamComposition(members);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violation, 'over-capacity');
    }
  });

  it('種族が重複していても受け入れる(種族重複禁止は撤廃済み)', () => {
    const result = validateTeamComposition([{ slot: 1 }, { slot: 2 }]);
    assert.equal(result.ok, true);
  });

  it('0体(空配列)は受け入れる(未完成チームの保存を許容)', () => {
    const result = validateTeamComposition([]);
    assert.equal(result.ok, true);
  });
});

describe('selectionBlockReason', () => {
  it('現在のメンバーに無ければブロックしない(null)', () => {
    const result = selectionBlockReason({ ownedPokemonId: 'a' }, [{ ownedPokemonId: 'b' }]);
    assert.equal(result, null);
  });

  it('既にチームにいる個体そのものはalready-in-team', () => {
    const result = selectionBlockReason({ ownedPokemonId: 'a' }, [{ ownedPokemonId: 'a' }]);
    assert.equal(result, 'already-in-team');
  });

  it('6体埋まっている場合はteam-full', () => {
    const current = Array.from({ length: 6 }, (_, i) => ({ ownedPokemonId: `existing-${i}` }));
    const result = selectionBlockReason({ ownedPokemonId: 'new' }, current);
    assert.equal(result, 'team-full');
  });

  it('already-in-teamはteam-fullより優先される(6体埋まっていてもその個体自身は理由がalready-in-team)', () => {
    const current = Array.from({ length: 6 }, (_, i) => ({ ownedPokemonId: `existing-${i}` }));
    const result = selectionBlockReason({ ownedPokemonId: 'existing-0' }, current);
    assert.equal(result, 'already-in-team');
  });
});

describe('validateTeamRequestBody', () => {
  it('空オブジェクトを既定値付きで受け入れる(mode省略時)', () => {
    const result = validateTeamRequestBody({});
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.memo, null);
      assert.deepEqual(result.value.members, []);
    }
  });

  it('全項目を指定したリクエストをそのまま受け入れる', () => {
    const result = validateTeamRequestBody({
      memo: '対面構成',
      members: [
        { slot: 1, owned_pokemon_id: '11111111-1111-1111-1111-111111111111' },
        { slot: 2, owned_pokemon_id: '22222222-2222-2222-2222-222222222222' },
      ],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.memo, '対面構成');
      assert.equal(result.value.members.length, 2);
      assert.equal(result.value.members[0].slot, 1);
    }
  });

  it('空文字のmemoはnullに正規化される(クリア操作の表現)', () => {
    const result = validateTeamRequestBody({ memo: '  ' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.memo, null);
    }
  });

  it('bodyが配列の場合は拒否する', () => {
    const result = validateTeamRequestBody([1, 2, 3]);
    assert.equal(result.ok, false);
  });

  it('bodyがnullの場合は拒否する', () => {
    const result = validateTeamRequestBody(null);
    assert.equal(result.ok, false);
  });

  it('membersが配列でない場合は拒否する', () => {
    const result = validateTeamRequestBody({ members: 'not-an-array' });
    assert.equal(result.ok, false);
  });

  it('membersが7件以上の場合は拒否する', () => {
    const members = Array.from({ length: 7 }, (_, i) => ({
      slot: (i % 6) + 1,
      owned_pokemon_id: `11111111-1111-1111-1111-11111111111${i}`,
    }));
    const result = validateTeamRequestBody({ members });
    assert.equal(result.ok, false);
  });

  it('slotが範囲(1〜6)を超える場合は拒否する', () => {
    const result = validateTeamRequestBody({
      members: [{ slot: 7, owned_pokemon_id: '11111111-1111-1111-1111-111111111111' }],
    });
    assert.equal(result.ok, false);
  });

  it('owned_pokemon_idがuuid形式でない場合は拒否する', () => {
    const result = validateTeamRequestBody({
      members: [{ slot: 1, owned_pokemon_id: 'not-a-uuid' }],
    });
    assert.equal(result.ok, false);
  });

  it('slotが重複する場合は拒否する', () => {
    const result = validateTeamRequestBody({
      members: [
        { slot: 1, owned_pokemon_id: '11111111-1111-1111-1111-111111111111' },
        { slot: 1, owned_pokemon_id: '22222222-2222-2222-2222-222222222222' },
      ],
    });
    assert.equal(result.ok, false);
  });

  it('owned_pokemon_idが重複する場合は拒否する(同一個体の二重登録)', () => {
    const result = validateTeamRequestBody({
      members: [
        { slot: 1, owned_pokemon_id: '11111111-1111-1111-1111-111111111111' },
        { slot: 2, owned_pokemon_id: '11111111-1111-1111-1111-111111111111' },
      ],
    });
    assert.equal(result.ok, false);
  });

  describe('mode: "replace"', () => {
    const FULL_REPLACE_BODY = {
      memo: null,
      // migrations/013_regulation.sql で追加した置換対象フィールド。
      regulation: null,
      members: [] as Array<{ slot: number; owned_pokemon_id: string }>,
    };

    it('{} (全フィールド未送信) は拒否する(owned-pokemonと同じデータ消失バグの再発防止)', () => {
      const result = validateTeamRequestBody({}, { mode: 'replace' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /is required \(missing or undefined\) for a PUT \(replace\) request/);
      }
    });

    it('全フィールドを指定したPUTは受け入れる', () => {
      const result = validateTeamRequestBody(FULL_REPLACE_BODY, { mode: 'replace' });
      assert.equal(result.ok, true);
    });

    it('membersだけ欠けたPUTは拒否し、membersが足りないことをエラーメッセージに含める', () => {
      const { members, ...withoutMembers } = FULL_REPLACE_BODY;
      const result = validateTeamRequestBody(withoutMembers, { mode: 'replace' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /members/);
      }
    });

    it('memoキー自体が無い(undefined)PUTは、値がnullでも拒否する(undefinedとnullを区別する)', () => {
      const { memo, ...withoutMemo } = FULL_REPLACE_BODY;
      const result = validateTeamRequestBody(withoutMemo, { mode: 'replace' });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /memo/);
      }
    });

    it('mode指定なしの従来呼び出しは{}を引き続き受け入れる(POST/既存呼び出しへの非退行)', () => {
      const result = validateTeamRequestBody({});
      assert.equal(result.ok, true);
    });
  });
});
