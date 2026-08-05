import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  DAMAGE_CALC_SUGGESTION_KINDS,
  damageCalcSubjectKeys,
  damageCalcSuggestionKey,
  filterNewDamageCalcSuggestions,
  parseDamageCalcSuggestionPayload,
  type DamageCalcSuggestion,
} from '../src/lib/damage-calc-suggest.ts';

function suggestion(overrides: Partial<DamageCalcSuggestion> = {}): DamageCalcSuggestion {
  return {
    direction: 'attack',
    opponentName: 'ドヒドイデ',
    moveName: 'じしん',
    count: 6,
    ratio: 0.75,
    opponentBuild: {},
    ...overrides,
  };
}

describe('damageCalcSubjectKeys', () => {
  it('型が判定できたときは型キー→種族キーの順で返す', () => {
    const keys = damageCalcSubjectKeys('カイリュー', {
      speciesName: 'カイリュー',
      itemName: 'こだわりハチマキ',
      role: 'physical_attacker',
    });
    assert.deepEqual(keys, [
      { kind: DAMAGE_CALC_SUGGESTION_KINDS.archetype, subjectKey: 'カイリュー|こだわりハチマキ|physical_attacker' },
      { kind: DAMAGE_CALC_SUGGESTION_KINDS.species, subjectKey: 'カイリュー' },
    ]);
  });

  it('型が判定できないときは種族キーだけを返す(依頼の「型が判別できない場合」の経路)', () => {
    const keys = damageCalcSubjectKeys('カイリュー', null);
    assert.deepEqual(keys, [{ kind: DAMAGE_CALC_SUGGESTION_KINDS.species, subjectKey: 'カイリュー' }]);
  });

  it('種族名が空なら候補を1つも作らない(種族名なしでは引きようがない)', () => {
    assert.deepEqual(damageCalcSubjectKeys('   ', null), []);
  });
});

describe('parseDamageCalcSuggestionPayload', () => {
  const payload = {
    sample_size: 8,
    options: [
      {
        direction: 'attack',
        opponent_name: 'ドヒドイデ',
        move_name: 'じしん',
        count: 6,
        ratio: 0.75,
        opponent_build: {
          nature: 'ずぶとい',
          abilityName: 'さいせいりょく',
          itemName: 'くろいヘドロ',
          teraType: 'はがね',
          evs: [32, 0, 32, 0, 2, 0],
        },
      },
    ],
  };

  it('集計バッチ(migrations/020)が書く形をそのまま読める', () => {
    const parsed = parseDamageCalcSuggestionPayload(payload);
    assert.ok(parsed);
    assert.equal(parsed.sampleSize, 8);
    assert.equal(parsed.options.length, 1);
    assert.deepEqual(parsed.options[0], {
      direction: 'attack',
      opponentName: 'ドヒドイデ',
      moveName: 'じしん',
      count: 6,
      ratio: 0.75,
      opponentBuild: {
        nature: 'ずぶとい',
        abilityName: 'さいせいりょく',
        itemName: 'くろいヘドロ',
        teraType: 'はがね',
        evs: [32, 0, 32, 0, 2, 0],
      },
    });
  });

  it('相手ビルドの欠けている項目はキーごと落とす(未入力として扱えるように)', () => {
    const parsed = parseDamageCalcSuggestionPayload({
      sample_size: 5,
      options: [{ direction: 'defense', opponent_name: 'ハバタクカミ', move_name: 'ムーンフォース', count: 3, ratio: 0.6 }],
    });
    assert.deepEqual(parsed?.options[0].opponentBuild, {});
  });

  it('努力値は6要素の数値配列でなければ捨てる', () => {
    const parsed = parseDamageCalcSuggestionPayload({
      sample_size: 5,
      options: [
        {
          direction: 'attack',
          opponent_name: 'カイリュー',
          move_name: 'じしん',
          count: 3,
          ratio: 0.6,
          opponent_build: { evs: [0, 0, 0] },
        },
      ],
    });
    assert.deepEqual(parsed?.options[0].opponentBuild, {});
  });

  it('向き・相手・技のどれかが欠けた候補はその1件だけを落とす', () => {
    const parsed = parseDamageCalcSuggestionPayload({
      sample_size: 5,
      options: [
        { direction: 'sideways', opponent_name: 'カイリュー', move_name: 'じしん' },
        { direction: 'attack', opponent_name: '', move_name: 'じしん' },
        { direction: 'attack', opponent_name: 'カイリュー', move_name: '  ' },
        { direction: 'defense', opponent_name: 'カイリュー', move_name: 'しんそく', count: 2, ratio: 0.4 },
      ],
    });
    assert.equal(parsed?.options.length, 1);
    assert.equal(parsed?.options[0].moveName, 'しんそく');
  });

  it('payload自体の形が違えばnullを返す(画面を壊すよりサジェストを出さない)', () => {
    assert.equal(parseDamageCalcSuggestionPayload(null), null);
    assert.equal(parseDamageCalcSuggestionPayload({ sample_size: 5 }), null);
    assert.equal(parseDamageCalcSuggestionPayload([]), null);
  });
});

describe('damageCalcSuggestionKey', () => {
  it('向き・相手・技の3つ組が同じなら同じキーになる', () => {
    assert.equal(
      damageCalcSuggestionKey({ direction: 'attack', opponentName: 'ドヒドイデ', moveName: 'じしん' }),
      damageCalcSuggestionKey({ direction: 'attack', opponentName: ' ドヒドイデ ', moveName: ' じしん ' }),
    );
  });

  it('向きだけが違えば別のダメージ計算として扱う', () => {
    assert.notEqual(
      damageCalcSuggestionKey({ direction: 'attack', opponentName: 'ドヒドイデ', moveName: 'じしん' }),
      damageCalcSuggestionKey({ direction: 'defense', opponentName: 'ドヒドイデ', moveName: 'じしん' }),
    );
  });
});

describe('filterNewDamageCalcSuggestions', () => {
  it('既に画面にあるダメージ計算を除いてから件数を切る', () => {
    const options = [
      suggestion({ moveName: 'じしん' }),
      suggestion({ moveName: 'しんそく' }),
      suggestion({ moveName: 'げきりん' }),
    ];
    const existing = new Set([
      damageCalcSuggestionKey({ direction: 'attack', opponentName: 'ドヒドイデ', moveName: 'じしん' }),
    ]);
    const filtered = filterNewDamageCalcSuggestions(options, existing, 2);
    // 先に切ってから除外すると「しんそく」1件しか残らない。除外が先であることを固定する。
    assert.deepEqual(filtered.map((o) => o.moveName), ['しんそく', 'げきりん']);
  });

  it('全部すでに追加済みなら空になる(呼び出し側はこれで空状態へ落ちる)', () => {
    const options = [suggestion()];
    const existing = new Set([damageCalcSuggestionKey(options[0])]);
    assert.deepEqual(filterNewDamageCalcSuggestions(options, existing, 6), []);
  });
});

describe('subject_keyの契約(クライアントとDBの一致)', () => {
  it('型キーは種族名|持ち物名|role で、集計SQLと同じ連結順である', async () => {
    const migration = await readFile(new URL('../migrations/020_damage_calc_suggestions.sql', import.meta.url), 'utf8');
    assert.match(migration, /s\.species_name \|\| '\|' \|\| s\.item_name \|\| '\|' \|\| s\.role/);
    assert.match(migration, /'popular_damage_calc_archetype'/);
    assert.match(migration, /'popular_damage_calc_species'/);
  });

  it('k未満のキーは行を作らず、候補はtop_n件までに制限する', async () => {
    const migration = await readFile(new URL('../migrations/020_damage_calc_suggestions.sql', import.meta.url), 'utf8');
    assert.match(migration, /WHERE ss\.sample_size >= min_sample_size/);
    assert.match(migration, /WHERE rn <= top_n/);
  });

  it('収集拒否(008)の個体を集計から外している', async () => {
    const migration = await readFile(new URL('../migrations/020_damage_calc_suggestions.sql', import.meta.url), 'utf8');
    assert.match(migration, /collection_opt_out_until IS NULL OR p\.collection_opt_out_until < now\(\)/);
  });
});
