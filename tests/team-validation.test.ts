// /api/teams・/api/teams/:id のリクエストボディ検証 + チーム編成ルール(G-1〜G-3)の回帰テスト。
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
    const members = Array.from({ length: 6 }, (_, i) => ({
      slot: i + 1,
      dexNo: i + 1,
      itemName: null,
    }));
    const result = validateTeamComposition(members);
    assert.equal(result.ok, true);
  });

  it('7体目はover-capacityで拒否する', () => {
    const members = Array.from({ length: 7 }, (_, i) => ({
      slot: i + 1,
      dexNo: i + 1,
      itemName: null,
    }));
    const result = validateTeamComposition(members);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violation, 'over-capacity');
    }
  });

  it('ロトム系統: dexNo=479が同じロトムとヒートロトムはduplicate-speciesで拒否する', () => {
    const result = validateTeamComposition([
      { slot: 1, dexNo: 479, itemName: null }, // ロトム
      { slot: 2, dexNo: 479, itemName: null }, // ヒートロトム(別名・同dexNo)
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violation, 'duplicate-species');
    }
  });

  it('メガシンカ: dexNo=26が同じライチュウとメガライチュウXはduplicate-speciesで拒否する', () => {
    const result = validateTeamComposition([
      { slot: 1, dexNo: 26, itemName: null }, // ライチュウ
      { slot: 2, dexNo: 26, itemName: null }, // メガライチュウX(別名・同dexNo)
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violation, 'duplicate-species');
    }
  });

  it('dexNoがnullの個体2体は同種族扱いにならず受け入れる(G-2対象外)', () => {
    const result = validateTeamComposition([
      { slot: 1, dexNo: null, itemName: null },
      { slot: 2, dexNo: null, itemName: null },
    ]);
    assert.equal(result.ok, true);
  });

  it('同じitemNameの2体はduplicate-itemで拒否する', () => {
    const result = validateTeamComposition([
      { slot: 1, dexNo: 1, itemName: 'こだわりハチマキ' },
      { slot: 2, dexNo: 2, itemName: 'こだわりハチマキ' },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violation, 'duplicate-item');
    }
  });

  it('itemNameがnullの2体は持ち物なし扱いで何体でも受け入れる', () => {
    const result = validateTeamComposition([
      { slot: 1, dexNo: 1, itemName: null },
      { slot: 2, dexNo: 2, itemName: null },
    ]);
    assert.equal(result.ok, true);
  });

  it('itemNameが空文字の2体も持ち物なし扱いで受け入れる', () => {
    const result = validateTeamComposition([
      { slot: 1, dexNo: 1, itemName: '' },
      { slot: 2, dexNo: 2, itemName: '' },
    ]);
    assert.equal(result.ok, true);
  });

  it('判定順の検証: 種族も持ち物も重複している組み合わせではduplicate-speciesが返る(G-2が先)', () => {
    // メガニャオニクス(オス)/メガニャオニクス(メス)相当: dexNoが同じ・itemNameも同じ「ニャオニクスナイト」。
    // 設計レビューR-18/R-10により、判定順(G-1→G-2→G-3)でG-2が先に検出され理由は1つだけ返る。
    const result = validateTeamComposition([
      { slot: 1, dexNo: 999, itemName: 'ニャオニクスナイト' },
      { slot: 2, dexNo: 999, itemName: 'ニャオニクスナイト' },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.violation, 'duplicate-species');
    }
  });

  it('0体(空配列)は受け入れる(未完成チームの保存を許容)', () => {
    const result = validateTeamComposition([]);
    assert.equal(result.ok, true);
  });
});

describe('selectionBlockReason', () => {
  it('現在のメンバーに無ければブロックしない(null)', () => {
    const result = selectionBlockReason(
      { dexNo: 25, itemName: null, ownedPokemonId: 'a' },
      [{ dexNo: 1, itemName: null, ownedPokemonId: 'b' }],
    );
    assert.equal(result, null);
  });

  it('既にチームにいる個体そのものはalready-in-team', () => {
    const result = selectionBlockReason(
      { dexNo: 25, itemName: null, ownedPokemonId: 'a' },
      [{ dexNo: 25, itemName: null, ownedPokemonId: 'a' }],
    );
    assert.equal(result, 'already-in-team');
  });

  it('6体埋まっている場合はteam-full', () => {
    const current = Array.from({ length: 6 }, (_, i) => ({
      dexNo: i + 1,
      itemName: null,
      ownedPokemonId: `existing-${i}`,
    }));
    const result = selectionBlockReason({ dexNo: 100, itemName: null, ownedPokemonId: 'new' }, current);
    assert.equal(result, 'team-full');
  });

  it('同じdexNoの個体が既にいる場合はduplicate-species', () => {
    const result = selectionBlockReason(
      { dexNo: 479, itemName: null, ownedPokemonId: 'a' },
      [{ dexNo: 479, itemName: null, ownedPokemonId: 'b' }],
    );
    assert.equal(result, 'duplicate-species');
  });

  it('同じitemNameの個体が既にいる場合はduplicate-item', () => {
    const result = selectionBlockReason(
      { dexNo: 1, itemName: 'いのちのたま', ownedPokemonId: 'a' },
      [{ dexNo: 2, itemName: 'いのちのたま', ownedPokemonId: 'b' }],
    );
    assert.equal(result, 'duplicate-item');
  });

  it('持ち物なし(null)同士はduplicate-itemにならない', () => {
    const result = selectionBlockReason(
      { dexNo: 1, itemName: null, ownedPokemonId: 'a' },
      [{ dexNo: 2, itemName: null, ownedPokemonId: 'b' }],
    );
    assert.equal(result, null);
  });

  it('already-in-teamはteam-fullより優先される(6体埋まっていてもその個体自身は理由がalready-in-team)', () => {
    const current = Array.from({ length: 6 }, (_, i) => ({
      dexNo: i + 1,
      itemName: null,
      ownedPokemonId: `existing-${i}`,
    }));
    const result = selectionBlockReason({ dexNo: 1, itemName: null, ownedPokemonId: 'existing-0' }, current);
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
