// アイテム画像・タイプ画像・テラスタイプ画像URLの組み立てロジックの回帰テスト。
// 画像はすべて poke-sprites から同期した同一オリジンのファイルを指す(CSPの img-src が
// 'self' data: のみのため、外部ホストのURLを組み立てる関数は廃止済み)。タイプIDの
// 期待値は vendor/jpoke/src/jpoke/utils/pokeapi.py の TYPE_NAME_TO_ID から導いたもので、
// src/lib/sprite-urls.ts の実装をそのまま転記したものではない。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  itemIconUrl,
  typeIconUrl,
  teraTypeIconUrl,
} from '../src/lib/sprite-urls.ts';

// src/lib/sprite-urls.ts の TYPE_NAME_TO_ID をそのまま転記(19タイプ全数の存在確認に使う)。
const ALL_TYPE_NAMES_JA = [
  'ノーマル', 'かくとう', 'ひこう', 'どく', 'じめん', 'いわ', 'むし', 'ゴースト', 'はがね',
  'ほのお', 'みず', 'くさ', 'でんき', 'エスパー', 'こおり', 'ドラゴン', 'あく', 'フェアリー',
  'ステラ',
];

describe('itemIconUrl', () => {
  // ファイル名は items.json の spritePath(英語スラッグ)ではなくアイテム和名で統一している。
  it('アイテム和名をURLエンコードした同一オリジンのアイコンURLを返す', () => {
    assert.equal(
      itemIconUrl('こだわりハチマキ'),
      `/item-icons/${encodeURIComponent('こだわりハチマキ')}.webp`,
    );
    assert.ok(itemIconUrl('こだわりハチマキ').startsWith('/item-icons/%'));
  });
});

describe('typeIconUrl', () => {
  it('既知のタイプ(ほのお, ID=10)は生成済みアイコン画像のルート相対URLを返す', () => {
    assert.equal(typeIconUrl('ほのお'), '/type-icons/10.webp');
  });

  it('既知のタイプ(フェアリー, ID=18)は生成済みアイコン画像のルート相対URLを返す', () => {
    assert.equal(typeIconUrl('フェアリー'), '/type-icons/18.webp');
  });

  it('未知のタイプ名はnullを返す', () => {
    assert.equal(typeIconUrl('存在しないタイプ'), null);
  });
});

describe('teraTypeIconUrl', () => {
  it('既知のタイプ(フェアリー, ID=18)はtera/配下の生成済みアイコン画像URLを返す', () => {
    assert.equal(teraTypeIconUrl('フェアリー'), '/type-icons/tera/18.webp');
  });

  it('ステラタイプ(ID=19)もtera/配下の生成済みアイコン画像URLを返す', () => {
    assert.equal(teraTypeIconUrl('ステラ'), '/type-icons/tera/19.webp');
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
