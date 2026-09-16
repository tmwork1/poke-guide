// <script type="application/json"> 用の直列化が、自由入力を含んでもHTMLとして解釈されず、
// JSONとしては元の値を維持することを確認する回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readJsonScriptRankedSpecies, toJsonScriptContent } from '../src/lib/json-script.ts';

test('script要素を閉じる文字列をUnicodeエスケープし、JSONとして元の値へ戻せる', () => {
  const value = { '</script><script>alert(1)</script>': 1 };
  const content = toJsonScriptContent(value);

  assert.equal(content.includes('</script>'), false);
  assert.deepEqual(JSON.parse(content), value);
});

test('U+2028とU+2029をUnicodeエスケープしてもJSONとして元の文字列へ戻せる', () => {
  const value = { text: 'before\u2028middle\u2029after' };
  const content = toJsonScriptContent(value);

  assert.equal(content.includes('\u2028'), false);
  assert.equal(content.includes('\u2029'), false);
  assert.equal(content.includes('\\u2028'), true);
  assert.equal(content.includes('\\u2029'), true);
  assert.deepEqual(JSON.parse(content), value);
});

test('undefinedはJSON.parse可能なnullへ正規化する', () => {
  assert.equal(toJsonScriptContent(undefined), 'null');
});

// box/[id].astro が {name, rank} 形式へ変わった際、文字列専用の読み出しを使っていた
// pokemon-list datalist だけが順位を失い図鑑順へ退化した回帰。両形式を受け付けることを確認する。
test('readJsonScriptRankedSpeciesは文字列配列と{name, rank}配列の両方を順位付き種族へ正規化する', () => {
  const originalDocument = globalThis.document;
  const stub = (textContent: string) => ({
    getElementById: () => ({ textContent }),
  });
  try {
    (globalThis as { document: unknown }).document = stub(JSON.stringify([
      { name: 'サーフゴー', rank: 1 },
      { name: 'カイリュー', rank: 2 },
      'ガブリアス',
      { rank: 4 },
      3,
    ]));
    assert.deepEqual(readJsonScriptRankedSpecies('x'), [
      { name: 'サーフゴー', rank: 1 },
      { name: 'カイリュー', rank: 2 },
      { name: 'ガブリアス', rank: null },
    ]);

    (globalThis as { document: unknown }).document = stub('not json');
    assert.deepEqual(readJsonScriptRankedSpecies('x'), []);
  } finally {
    (globalThis as { document: unknown }).document = originalDocument;
  }
});
