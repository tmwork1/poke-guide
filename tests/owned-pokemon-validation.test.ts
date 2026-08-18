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

  it('bodyが配列の場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody([1, 2, 3]);
    assert.equal(result.ok, false);
  });

  it('bodyがnullの場合は拒否する', () => {
    const result = validateOwnedPokemonRequestBody(null);
    assert.equal(result.ok, false);
  });
});

// mode: 'replace' (PUT /api/owned-pokemon/:id 用) の回帰テスト。
// 直前の修正(readRequiredJsonBody追加)は「ボディが無い」ケースしか塞いでおらず、
// {} のような「ボディはあるが全フィールド未送信」のPUTは validateOwnedPokemonRequestBody(body)
// (optionsなし=従来の全項目任意)を素通りして既存個体の全消去を招いていた
// (2026-07に実際に発生し、フィクスチャが1件消えた)。
// mode: 'replace' は「置換対象の全フィールドがpayloadに存在すること」(undefined=未送信は拒否、
// nullは許容)を検証することでこの穴を塞ぐ。
describe('validateOwnedPokemonRequestBody(body, { mode: "replace" })', () => {
  const FULL_REPLACE_BODY = {
    nickname: null,
    species_name: 'メガリザードンX',
    level: null,
    nature: 'いじっぱり',
    ability_name: 'かたいツメ',
    item_name: 'こだわりハチマキ',
    tera_type: null,
    evs: [0, 32, 0, 0, 0, 16],
    ivs: [31, 31, 31, 31, 31, 31],
    move_names: ['フレアドライブ', 'がんせきふうじ'],
    memo: null,
    tags: [],
  };

  it('{} (全フィールド未送信) は拒否する(今回のバグの直接的な再現テスト)', () => {
    const result = validateOwnedPokemonRequestBody({}, { mode: 'replace' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      // REPLACE_REQUIRED_FIELDS の先頭(nickname)で最初に引っかかる。
      // どのキーが足りないかがエラーメッセージに含まれることが本質のため、対象キー名は問わない。
      assert.match(result.error, /is required \(missing or undefined\) for a PUT \(replace\) request/);
    }
  });

  it('全フィールドを指定したPUTは従来どおり受け入れる(退行がないことの確認)', () => {
    const result = validateOwnedPokemonRequestBody(FULL_REPLACE_BODY, { mode: 'replace' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.species_name, 'メガリザードンX');
      assert.deepEqual(result.value.evs, [0, 32, 0, 0, 0, 16]);
      assert.deepEqual(result.value.move_names, ['フレアドライブ', 'がんせきふうじ']);
    }
  });

  it('species_nameだけ欠けたPUTは拒否し、species_nameが足りないことをエラーメッセージに含める', () => {
    const { species_name, ...withoutSpeciesName } = FULL_REPLACE_BODY;
    const result = validateOwnedPokemonRequestBody(withoutSpeciesName, { mode: 'replace' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /species_name/);
    }
  });

  it('move_namesだけ欠けたPUTは拒否し、どのキーが足りないかをエラーメッセージに含める', () => {
    const { move_names, ...withoutMoveNames } = FULL_REPLACE_BODY;
    const result = validateOwnedPokemonRequestBody(withoutMoveNames, { mode: 'replace' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /move_names/);
    }
  });

  it('evs/ivsだけ欠けたPUTも拒否する', () => {
    const { evs, ivs, ...rest } = FULL_REPLACE_BODY;
    const result = validateOwnedPokemonRequestBody(rest, { mode: 'replace' });
    assert.equal(result.ok, false);
  });

  it('nickname/tera_type/level/memo等のnull許容フィールドはnullのまま(キーが存在すれば)受け入れる', () => {
    // FULL_REPLACE_BODY は nickname/level/tera_type/memo をすでに null にしているため、
    // これがそのまま通ることを確認するだけで「undefinedとの区別」の要点をカバーする。
    const result = validateOwnedPokemonRequestBody(FULL_REPLACE_BODY, { mode: 'replace' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.nickname, null);
      assert.equal(result.value.level, null);
      assert.equal(result.value.tera_type, null);
      assert.equal(result.value.memo, null);
    }
  });

  it('nicknameキー自体が無い(undefined)PUTは、値がnullでも拒否する(undefinedとnullを区別する)', () => {
    const { nickname, ...withoutNickname } = FULL_REPLACE_BODY;
    const result = validateOwnedPokemonRequestBody(withoutNickname, { mode: 'replace' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /nickname/);
    }
  });

  it('mode指定なしの従来呼び出しは{}を引き続き受け入れる(POST/既存呼び出しへの非退行)', () => {
    const result = validateOwnedPokemonRequestBody({});
    assert.equal(result.ok, true);
  });
});
