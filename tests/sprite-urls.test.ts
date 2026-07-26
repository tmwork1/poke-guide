// アイテム画像・タイプ画像・テラスタイプ画像URLの組み立てロジックの回帰テスト。
// 期待値は vendor/jpoke/src/jpoke/utils/pokeapi.py (get_item_image_url /
// get_type_image_url / get_tera_type_image_url / TYPE_NAME_TO_ID) の実装から導いたもので、
// src/lib/sprite-urls.ts の実装をそのまま転記したものではない。
// ネットワークアクセスを伴う loadItemSpriteMap() はここでは検証しない。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  itemImageUrl,
  typeImageUrl,
  teraTypeImageUrl,
  typeIconUrl,
  teraTypeIconUrl,
} from '../src/lib/sprite-urls.ts';

const SPRITES_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites';
const TYPE_SPRITES_DIR = 'types/generation-ix/scarlet-violet';

// src/lib/sprite-urls.ts の TYPE_NAME_TO_ID をそのまま転記(19タイプ全数の存在確認に使う)。
const ALL_TYPE_NAMES_JA = [
  'ノーマル', 'かくとう', 'ひこう', 'どく', 'じめん', 'いわ', 'むし', 'ゴースト', 'はがね',
  'ほのお', 'みず', 'くさ', 'でんき', 'エスパー', 'こおり', 'ドラゴン', 'あく', 'フェアリー',
  'ステラ',
];

describe('itemImageUrl', () => {
  it('サブディレクトリ無しのアイテムは items/ 直下のURLを組み立てる', () => {
    assert.equal(itemImageUrl('choice-band'), `${SPRITES_BASE}/items/choice-band.png`);
  });

  it('サブディレクトリ有りのアイテムはそのサブディレクトリを含むURLを組み立てる', () => {
    assert.equal(
      itemImageUrl('gen9/booster-energy'),
      `${SPRITES_BASE}/items/gen9/booster-energy.png`,
    );
  });

  it('gen8サブディレクトリのアイテムも同様に組み立てる', () => {
    assert.equal(
      itemImageUrl('gen8/heavy-duty-boots'),
      `${SPRITES_BASE}/items/gen8/heavy-duty-boots.png`,
    );
  });
});

describe('typeImageUrl', () => {
  it('既知のタイプ(ほのお, ID=10)は通常タイプバッジURLを返す', () => {
    assert.equal(typeImageUrl('ほのお'), `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/10.png`);
  });

  it('既知のタイプ(みず, ID=11)は通常タイプバッジURLを返す', () => {
    assert.equal(typeImageUrl('みず'), `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/11.png`);
  });

  it('ステラタイプ(ID=19)も通常タイプバッジURLを返す', () => {
    assert.equal(typeImageUrl('ステラ'), `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/19.png`);
  });

  it('未知のタイプ名はnullを返す', () => {
    assert.equal(typeImageUrl('存在しないタイプ'), null);
  });
});

describe('teraTypeImageUrl', () => {
  it('既知のタイプ(フェアリー, ID=18)はTeraディレクトリ配下のURLを返す', () => {
    assert.equal(teraTypeImageUrl('フェアリー'), `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/Tera/18.png`);
  });

  it('ステラタイプ(ID=19)もTeraディレクトリ配下のURLを返す', () => {
    assert.equal(teraTypeImageUrl('ステラ'), `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/Tera/19.png`);
  });

  it('未知のタイプ名はnullを返す', () => {
    assert.equal(teraTypeImageUrl('存在しないタイプ'), null);
  });
});

describe('typeIconUrl', () => {
  it('既知のタイプ(ほのお, ID=10)は生成済みアイコン画像のルート相対URLを返す', () => {
    assert.equal(typeIconUrl('ほのお'), '/type-icons/10.png');
  });

  it('既知のタイプ(フェアリー, ID=18)は生成済みアイコン画像のルート相対URLを返す', () => {
    assert.equal(typeIconUrl('フェアリー'), '/type-icons/18.png');
  });

  it('未知のタイプ名はnullを返す', () => {
    assert.equal(typeIconUrl('存在しないタイプ'), null);
  });
});

describe('teraTypeIconUrl', () => {
  it('既知のタイプ(フェアリー, ID=18)はtera/配下の生成済みアイコン画像URLを返す', () => {
    assert.equal(teraTypeIconUrl('フェアリー'), '/type-icons/tera/18.png');
  });

  it('ステラタイプ(ID=19)もtera/配下の生成済みアイコン画像URLを返す', () => {
    assert.equal(teraTypeIconUrl('ステラ'), '/type-icons/tera/19.png');
  });

  it('未知のタイプ名はnullを返す', () => {
    assert.equal(teraTypeIconUrl('存在しないタイプ'), null);
  });
});

describe('生成済みタイプアイコン画像ファイル(回帰テスト)', () => {
  // typeIconUrl/teraTypeIconUrl が返すURLに対応する実ファイルが、
  // scripts/type-icons/generate_type_icons.py によって19タイプ+テラス19タイプ分
  // すべて生成・コミットされていることを検証する。
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(__dirname, '..', 'public');

  for (const typeNameJa of ALL_TYPE_NAMES_JA) {
    it(`${typeNameJa}: 通常タイプアイコン画像ファイルが存在する`, () => {
      const url = typeIconUrl(typeNameJa);
      assert.ok(url, `${typeNameJa} のURLがnullでないこと`);
      const filePath = path.join(publicDir, url!.replace(/^\//, ''));
      assert.ok(existsSync(filePath), `${filePath} が存在すること`);
    });

    it(`${typeNameJa}: テラスタイプアイコン画像ファイルが存在する`, () => {
      const url = teraTypeIconUrl(typeNameJa);
      assert.ok(url, `${typeNameJa} のURLがnullでないこと`);
      const filePath = path.join(publicDir, url!.replace(/^\//, ''));
      assert.ok(existsSync(filePath), `${filePath} が存在すること`);
    });
  }
});
