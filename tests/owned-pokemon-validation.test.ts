// /api/owned-pokemon・/api/owned-pokemon/:id のリクエストボディ検証ロジックの回帰テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateOwnedPokemonRequestBody } from '../src/lib/owned-pokemon-validation.ts';

describe('validateOwnedPokemonRequestBody', () => {
  it('species_nameのみのリクエストを既定値付きで受け入れる', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.species_name, 'ピカチュウ');
      assert.equal(result.value.nickname, null);
      assert.equal(result.value.level, null);
      assert.deepEqual(result.value.evs, [0, 0, 0, 0, 0, 0]);
      assert.deepEqual(result.value.ivs, [31, 31, 31, 31, 31, 31]);
      assert.deepEqual(result.value.move_names, []);
      assert.deepEqual(result.value.tags, []);
      assert.equal(result.value.is_pinned, false);
    }
  });

  it('全項目を指定したリクエストをそのまま受け入れる', () => {
    const result = validateOwnedPokemonRequestBody({
      nickname: 'エース',
      species_name: 'ピカチュウ',
      level: 50,
      nature: 'ようき',
      ability_name: 'せいでんき',
      item_name: 'いのちのたま',
      tera_type: 'でんき',
      evs: [4, 0, 0, 32, 0, 32],
      ivs: [31, 31, 31, 0, 31, 31],
      move_names: ['でんきショック', '10まんボルト'],
      memo: 'メモ',
      tags: ['エース', ' 対面 '],
      is_pinned: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.nickname, 'エース');
      assert.equal(result.value.level, 50);
      assert.equal(result.value.nature, 'ようき');
      assert.equal(result.value.ability_name, 'せいでんき');
      assert.equal(result.value.item_name, 'いのちのたま');
      assert.equal(result.value.tera_type, 'でんき');
      assert.deepEqual(result.value.evs, [4, 0, 0, 32, 0, 32]);
      assert.deepEqual(result.value.ivs, [31, 31, 31, 0, 31, 31]);
      assert.deepEqual(result.value.move_names, ['でんきショック', '10まんボルト']);
      assert.equal(result.value.memo, 'メモ');
      assert.deepEqual(result.value.tags, ['エース', '対面']);
      assert.equal(result.value.is_pinned, true);
    }
  });

  it('空文字のオプション項目はnullに正規化される(クリア操作の表現)', () => {
    const result = validateOwnedPokemonRequestBody({
      nickname: '',
      species_name: 'ピカチュウ',
      nature: '   ',
      memo: '',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.nickname, null);
      assert.equal(result.value.nature, null);
      assert.equal(result.value.memo, null);
    }
  });

  it('species_nameが空文字の場合は受け入れる(空個体の自動登録用)', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: '' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.species_name, '');
    }
  });

  it('species_nameが無い場合は受け入れ、空文字に正規化される(空個体の自動登録用)', () => {
    const result = validateOwnedPokemonRequestBody({});
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.species_name, '');
    }
  });

  it('species_nameが文字列でない場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 12345 });
    assert.equal(result.ok, false);
  });

  it('levelが範囲(1〜100)を超える場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ', level: 101 });
    assert.equal(result.ok, false);
  });

  it('levelが0以下の場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ', level: 0 });
    assert.equal(result.ok, false);
  });

  it('levelが整数でない場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ', level: 50.5 });
    assert.equal(result.ok, false);
  });

  it('levelがnullの場合は受け入れる(未設定を表す)', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ', level: null });
    assert.equal(result.ok, true);
  });

  it('evsの長さが6でない場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ', evs: [0, 0, 0] });
    assert.equal(result.ok, false);
  });

  it('evsが範囲(0〜32)を超える場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({
      species_name: 'ピカチュウ',
      evs: [33, 0, 0, 0, 0, 0],
    });
    assert.equal(result.ok, false);
  });

  it('ivsが範囲(0〜31)を超える場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({
      species_name: 'ピカチュウ',
      ivs: [32, 31, 31, 31, 31, 31],
    });
    assert.equal(result.ok, false);
  });

  it('move_namesが5件以上の場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({
      species_name: 'ピカチュウ',
      move_names: ['a', 'b', 'c', 'd', 'e'],
    });
    assert.equal(result.ok, false);
  });

  it('tagsが文字列でない要素を含む場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({
      species_name: 'ピカチュウ',
      tags: ['a', 1],
    });
    assert.equal(result.ok, false);
  });

  it('is_pinnedが真偽値でない場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody({ species_name: 'ピカチュウ', is_pinned: 'true' });
    assert.equal(result.ok, false);
  });

  it('bodyが配列の場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody([1, 2, 3]);
    assert.equal(result.ok, false);
  });

  it('bodyがnullの場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody(null);
    assert.equal(result.ok, false);
  });
});
