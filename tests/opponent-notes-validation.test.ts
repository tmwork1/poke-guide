// /api/opponent-notes・/api/opponent-notes/:id のリクエストボディ検証ロジックの回帰テスト
// (owned-pokemon-validation.test.ts と同じパターン)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateOpponentNoteRequestBody } from '../src/lib/opponent-notes-validation.ts';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

describe('validateOpponentNoteRequestBody', () => {
  it('新規作成(requireOwnedPokemonId: true)は最小限のリクエストを既定値付きで受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.owned_pokemon_id, VALID_UUID);
      assert.deepEqual(result.value.opponent_build, { name: 'カイリュー' });
      assert.deepEqual(result.value.field, {});
      assert.equal(result.value.move_name, null);
      assert.equal(result.value.client_result, null);
      assert.equal(result.value.memo, null);
    }
  });

  it('新規作成でowned_pokemon_idが無い場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { opponent_build: { name: 'カイリュー' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('新規作成でowned_pokemon_idがuuid形式でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: 'not-a-uuid', opponent_build: { name: 'カイリュー' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('更新(requireOwnedPokemonId: false)はowned_pokemon_idが無くても受け入れ、値はnullになる', () => {
    const result = validateOpponentNoteRequestBody(
      { opponent_build: { name: 'カイリュー' } },
      { requireOwnedPokemonId: false },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.owned_pokemon_id, null);
    }
  });

  it('全項目を指定したリクエストをそのまま受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: {
          name: 'カイリュー',
          level: 50,
          nature: 'いじっぱり',
          gender: 'male',
          abilityName: 'マルチスケイル',
          itemName: 'ゴツゴツメット',
          moveNames: ['じしん', 'げきりん'],
          teraType: 'はがね',
          evs: [32, 32, 0, 0, 4, 0],
          ivs: [31, 31, 31, 31, 31, 31],
        },
        field: { weather: 'はれ', terrain: 'エレキフィールド', defenderSideFields: ['リフレクター'], seed: 1, critical: true },
        move_name: '10まんボルト',
        client_result: { damages: [1, 2, 3] },
        memo: 'メモ',
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.move_name, '10まんボルト');
      assert.deepEqual(result.value.client_result, { damages: [1, 2, 3] });
      assert.equal(result.value.memo, 'メモ');
      assert.equal(result.value.opponent_build.name, 'カイリュー');
      assert.equal(result.value.opponent_build.level, 50);
      assert.equal(result.value.field.weather, 'はれ');
      assert.equal(result.value.field.seed, 1);
      assert.equal(result.value.field.critical, true);
    }
  });

  it('opponent_buildが無い場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody({ owned_pokemon_id: VALID_UUID }, { requireOwnedPokemonId: true });
    assert.equal(result.ok, false);
  });

  it('opponent_build.nameが空文字の場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: '' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('opponent_build.nameが無い場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { level: 50 } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('opponent_buildに未知のキーが含まれる場合は拒否する(PokemonSpec型に対応する項目のみ許容)', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー', trainerName: 'こっそり' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('opponent_build.genderが不正な値の場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー', gender: 'other' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('opponent_build.evsが範囲(0〜32)を超える場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー', evs: [33, 0, 0, 0, 0, 0] } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('opponent_build.ivsが範囲(0〜31)を超える場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー', ivs: [32, 31, 31, 31, 31, 31] } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('opponent_build.moveNamesが5件以上の場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー', moveNames: ['a', 'b', 'c', 'd', 'e'] } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('fieldに未知のキーが含まれる場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' }, field: { unknownKey: 'x' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.criticalが真偽値でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' }, field: { critical: 'yes' } },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('move_nameが文字列でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' }, move_name: 123 },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('client_resultがオブジェクトでない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' }, client_result: 'not-an-object' },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('空文字のmemo/move_nameはnullに正規化される(クリア操作の表現)', () => {
    const result = validateOpponentNoteRequestBody(
      { owned_pokemon_id: VALID_UUID, opponent_build: { name: 'カイリュー' }, memo: '', move_name: '' },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.memo, null);
      assert.equal(result.value.move_name, null);
    }
  });

  it('bodyが配列の場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody([1, 2, 3], { requireOwnedPokemonId: true });
    assert.equal(result.ok, false);
  });

  it('bodyがnullの場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(null, { requireOwnedPokemonId: true });
    assert.equal(result.ok, false);
  });

  // ##### 連結カード(1体の相手+複数攻撃の加算ダメージ計算)対応の追加スキーマ #####

  it('旧形式(attacksが無く、move_nameのみの単発メモ)は引き続き受け入れる(後方互換)', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { weather: 'はれ' },
        move_name: '10まんボルト',
        client_result: { damages: [1, 2, 3], lethal: [], defenderHp: 100 },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.move_name, '10まんボルト');
      assert.equal(result.value.field.attacks, undefined);
    }
  });

  it('新形式(attackerBoosts/defenderBoosts/ailment/terastallized/attacks)をすべて指定したリクエストを受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: {
          weather: 'はれ',
          attackerBoosts: [0, 2, -1, 0, 0, 1],
          attackerAilment: 'まひ',
          attackerTerastallized: true,
          defenderBoosts: [0, -6, 6, 0, 0, 0],
          defenderAilment: '',
          defenderTerastallized: false,
          attacks: [
            { moveName: 'じしん' },
            { moveName: 'げきりん', hitCount: 1 },
          ],
        },
        client_result: {
          defenderHp: 152,
          perAttackDamages: [[10, 11, 12], [20, 21, 22]],
          lethal: [
            { attackCount: 1, probability: 0 },
            { attackCount: 2, probability: 0.75 },
          ],
        },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.field.attackerBoosts, [0, 2, -1, 0, 0, 1]);
      assert.equal(result.value.field.attackerAilment, 'まひ');
      assert.equal(result.value.field.attackerTerastallized, true);
      assert.deepEqual(result.value.field.defenderBoosts, [0, -6, 6, 0, 0, 0]);
      assert.equal(result.value.field.defenderAilment, '');
      assert.equal(result.value.field.defenderTerastallized, false);
      assert.deepEqual(result.value.field.attacks, [{ moveName: 'じしん' }, { moveName: 'げきりん', hitCount: 1 }]);
      assert.deepEqual(result.value.client_result, {
        defenderHp: 152,
        perAttackDamages: [[10, 11, 12], [20, 21, 22]],
        lethal: [
          { attackCount: 1, probability: 0 },
          { attackCount: 2, probability: 0.75 },
        ],
      });
    }
  });

  it('field.attackerBoostsの長さが6でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attackerBoosts: [0, 1, 0, 0, 0] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.defenderBoostsが範囲(-6〜+6)を超える場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { defenderBoosts: [0, 7, 0, 0, 0, 0] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attackerBoostsが整数でない要素を含む場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attackerBoosts: [0, 1.5, 0, 0, 0, 0] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素にmoveNameが無い(空文字含む)場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: '' }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素のhitCountが範囲(1〜10)を超える場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', hitCount: 11 }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素のhitCountが0の場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', hitCount: 0 }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素数が上限(6件)を超える場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: {
          attacks: [
            { moveName: 'わざ1' },
            { moveName: 'わざ2' },
            { moveName: 'わざ3' },
            { moveName: 'わざ4' },
            { moveName: 'わざ5' },
            { moveName: 'わざ6' },
            { moveName: 'わざ7' },
          ],
        },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksがちょうど上限(6件)の場合は受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: {
          attacks: [
            { moveName: 'わざ1' },
            { moveName: 'わざ2' },
            { moveName: 'わざ3' },
            { moveName: 'わざ4' },
            { moveName: 'わざ5' },
            { moveName: 'わざ6' },
          ],
        },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
  });

  it('field.attackerAilment/defenderAilmentは任意の文字列であればどんな状態異常名でも受け入れる(許容リストをここに持たない)', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attackerAilment: 'みたことのないじょうたい', defenderAilment: 'こおり' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
  });

  it('field.attackerAilmentが文字列でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attackerAilment: 123 },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attackerTerastallizedが真偽値でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attackerTerastallized: 'yes' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksが空配列の場合は受け入れる(move_nameによる単発メモ扱い)', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [] },
        move_name: '10まんボルト',
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.field.attacks, []);
    }
  });

  it('新形式のclient_result(perAttackDamages/lethalの累計致死率形式)を受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        client_result: { defenderHp: 100, perAttackDamages: [[1, 2]], lethal: [{ attackCount: 1, probability: 1 }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
  });

  it('client_resultにperAttackLethal/cumulativeDamage(技カードごとの詳細設定に伴う新規追加値)を含めても受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        client_result: {
          defenderHp: 100,
          perAttackDamages: [[10, 11]],
          lethal: [{ attackCount: 1, probability: 0.5 }],
          perAttackLethal: [[{ attackCount: 1, probability: 0.5 }, { attackCount: 2, probability: 1 }]],
          cumulativeDamage: { min: 10, max: 11 },
        },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.client_result, {
        defenderHp: 100,
        perAttackDamages: [[10, 11]],
        lethal: [{ attackCount: 1, probability: 0.5 }],
        perAttackLethal: [[{ attackCount: 1, probability: 0.5 }, { attackCount: 2, probability: 1 }]],
        cumulativeDamage: { min: 10, max: 11 },
      });
    }
  });

  // ##### 技カードごとの詳細設定(per-attack条件)対応の追加スキーマ #####
  // ビルドカードではなく技カード単位でランク補正・状態異常・テラスタル・急所・天候・
  // 地形・壁を個別設定したいというUI要件に対応する、field.attacksの各要素の追加キー。

  it('field.attacksの要素にper-attack条件(critical/ランク補正/状態異常/テラスタル/壁/天候/地形)をすべて指定したものを受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: {
          attacks: [
            {
              moveName: 'じしん',
              critical: true,
              attackerBoosts: [0, 2, 0, 0, 0, 0],
              attackerAilment: 'まひ',
              attackerTerastallized: true,
              defenderBoosts: [0, 0, -2, 0, 0, 0],
              defenderAilment: '',
              defenderTerastallized: false,
              defenderSideFields: ['リフレクター'],
              weather: 'あめ',
              terrain: 'エレキフィールド',
            },
            { moveName: 'げきりん' },
          ],
        },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.field.attacks, [
        {
          moveName: 'じしん',
          critical: true,
          attackerBoosts: [0, 2, 0, 0, 0, 0],
          attackerAilment: 'まひ',
          attackerTerastallized: true,
          defenderBoosts: [0, 0, -2, 0, 0, 0],
          defenderAilment: '',
          defenderTerastallized: false,
          defenderSideFields: ['リフレクター'],
          weather: 'あめ',
          terrain: 'エレキフィールド',
        },
        { moveName: 'げきりん' },
      ]);
    }
  });

  it('field.attacksの要素のattackerBoostsが範囲(-6〜+6)を超える場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', attackerBoosts: [0, 7, 0, 0, 0, 0] }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素のcriticalが真偽値でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', critical: 'yes' }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素のdefenderSideFieldsが文字列配列でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', defenderSideFields: [1, 2] }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素のweather/terrainが文字列でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', weather: 123 }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  // ##### 揮発状態(volatile)対応の追加スキーマ(UI改善ラウンド20 20-R3) #####

  it('field.attacksの要素にattackerVolatiles/defenderVolatilesを指定したものを受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: {
          attacks: [
            { moveName: 'じしん', attackerVolatiles: ['じゅうでん'], defenderVolatiles: ['のろい', 'タールショット'] },
            { moveName: 'げきりん' },
          ],
        },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.field.attacks, [
        { moveName: 'じしん', attackerVolatiles: ['じゅうでん'], defenderVolatiles: ['のろい', 'タールショット'] },
        { moveName: 'げきりん' },
      ]);
    }
  });

  it('field.attacksの要素のattackerVolatilesが文字列配列でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', attackerVolatiles: [1, 2] }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素のdefenderVolatilesが文字列配列でない場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', defenderVolatiles: 'のろい' }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  it('field.attacksの要素に含まれる未知キーは既存の流儀どおりサイレントに読み捨てられる(拒否はしない)', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attacks: [{ moveName: 'じしん', secretAttackField: 'x' }] },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.field.attacks, [{ moveName: 'じしん' }]);
    }
  });

  it('field.attackerBoosts/defenderBoosts以外の未知キーは引き続き拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { attackerBoosts: [0, 0, 0, 0, 0, 0], secretField: 'x' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });

  // ##### 攻守切り替え(direction)対応の追加スキーマ #####

  it('field.directionが未指定の場合は受け入れる(既存データ互換)', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { weather: 'はれ' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.field.direction, undefined);
    }
  });

  it('field.direction=attackを受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { direction: 'attack' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.field.direction, 'attack');
    }
  });

  it('field.direction=defenseを受け入れる', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { direction: 'defense' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.field.direction, 'defense');
    }
  });

  it('field.directionが不正な文字列の場合は拒否する', () => {
    const result = validateOpponentNoteRequestBody(
      {
        owned_pokemon_id: VALID_UUID,
        opponent_build: { name: 'カイリュー' },
        field: { direction: 'both' },
      },
      { requireOwnedPokemonId: true },
    );
    assert.equal(result.ok, false);
  });
});
