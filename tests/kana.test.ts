import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { kanaIncludes, kanaStartsWith, normalizeForSearch, toKatakana } from '../src/lib/kana.ts';

describe('かな表記を揃える検索ヘルパー', () => {
  it('ひらがなだけをカタカナへ変換する', () => {
    assert.equal(toKatakana('ぴかちゅう'), 'ピカチュウ');
    assert.equal(toKatakana('かみなりパンチー'), 'カミナリパンチー');
    // かな以外まで変換対象に巻き込まないことを明示して、検索元の表記を守る。
    assert.equal(toKatakana('炎・ほのお!'), '炎・ホノオ!');
  });

  it('幅・かな・英字・前後空白を検索用に正規化する', () => {
    assert.equal(normalizeForSearch(' ｶﾞﾌﾞﾘｱｽ '), 'ガブリアス');
    assert.equal(normalizeForSearch(' ＨＰ '), 'hp');
  });

  it('混在表記の候補へひらがなの入力で部分一致できる', () => {
    assert.equal(kanaIncludes('かみなりパンチ', 'かみなりぱんち'), true);
    assert.equal(kanaIncludes('ピカチュウ', 'ぴかちゅう'), true);
    assert.equal(kanaIncludes('ガブリアス', 'ｶﾞﾌﾞﾘｱｽ'), true);
    // 空入力では全候補を表示できるよう、String.includesと同じ結果を維持する。
    assert.equal(kanaIncludes('ピカチュウ', ''), true);
    assert.equal(kanaIncludes('フシギダネ', 'ぴか'), false);
  });

  it('前方一致もかな表記に依存しない', () => {
    assert.equal(kanaStartsWith('ガブリアス', 'ｶﾞﾌﾞ'), true);
    assert.equal(kanaStartsWith('メガガブリアス', 'がぶ'), false);
  });
});
