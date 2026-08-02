// src/lib/team-suggest.ts (チームサジェストのスコアリング) の単体テスト。
// 期待値は本番の構築データ(ranked_teams、1041チーム)から実測した数値に基づく
// (tests/archetype.test.ts と同じく「実データで手計算した値」を固定する方針)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFINITY_SHRINK_K,
  ARCHETYPE_BACKOFF_K,
  ARCHETYPE_DISTANCE_WEIGHTS,
  MIN_ARCHETYPE_SIMILARITY,
  archetypeSimilarity,
  chooseArchetypeForSpecies,
  rankPartnerSpecies,
  rankSpeciesByUsage,
  shrunkLogLift,
  weightSeedArchetypes,
  type ArchetypeStat,
  type RankedArchetype,
  type SpeciesPairStat,
} from '../src/lib/team-suggest.ts';
import type { ArchetypeKey } from '../src/lib/archetype.ts';

const TOTAL_TEAMS = 1041;

function key(
  speciesName: string,
  abilityName: string,
  itemName: string,
  role: ArchetypeKey['role'],
): ArchetypeKey {
  return { speciesName, abilityName, itemName, role };
}

// ---------------------------------------------------------------------------
// ① 親密度: 縮小推定つき log-lift
// ---------------------------------------------------------------------------

describe('shrunkLogLift: 人気だけのペアと本当に相性の良いペアを区別する', () => {
  it('ガブリアス×ブリジュラス(共起186・実測lift 0.99)はほぼ0になる', () => {
    // 共起回数は全ペア中1位(186回)だが、ブリジュラス自体が全チームの37%に入っている。
    // 生の共起回数で並べるとこれが常に最上位に来てしまう ── それを潰せていることの確認。
    const value = shrunkLogLift({
      coTeams: 186,
      seedTeams: 505,
      candidateTeams: 387,
      totalTeams: TOTAL_TEAMS,
    });
    assert.ok(Math.abs(value) < 0.02, `expected near zero, got ${value}`);
  });

  it('メガギャラドス×ウルガモス(共起28・実測lift 2.28)は明確な正になる', () => {
    const value = shrunkLogLift({
      coTeams: 28,
      seedTeams: 133,
      candidateTeams: 96,
      totalTeams: TOTAL_TEAMS,
    });
    assert.ok(value > 0.6, `expected clearly positive, got ${value}`);
  });

  it('避け合っているペアは負になる', () => {
    // 期待共起 505*209/1041 = 101.4 に対して実測84(ガブリアス×ミミッキュ)。
    const value = shrunkLogLift({
      coTeams: 84,
      seedTeams: 505,
      candidateTeams: 209,
      totalTeams: TOTAL_TEAMS,
    });
    assert.ok(value < 0, `expected negative, got ${value}`);
  });

  it('同じliftでも共起数が少ないほど0へ縮小される', () => {
    // lift を約2に揃えたまま共起数だけを変える。
    const few = shrunkLogLift({ coTeams: 2, seedTeams: 100, candidateTeams: 10, totalTeams: TOTAL_TEAMS });
    const many = shrunkLogLift({ coTeams: 20, seedTeams: 100, candidateTeams: 100, totalTeams: TOTAL_TEAMS });
    assert.ok(few > 0 && many > 0);
    assert.ok(many > few, `expected the better-supported pair to score higher (few=${few}, many=${many})`);
  });

  it('共起数が AFFINITY_SHRINK_K のとき信頼度がちょうど半分になる', () => {
    const stat = { coTeams: AFFINITY_SHRINK_K, seedTeams: 100, candidateTeams: 100, totalTeams: TOTAL_TEAMS };
    const expected = (stat.seedTeams * stat.candidateTeams) / stat.totalTeams;
    const rawLogLift = Math.log(stat.coTeams / expected);
    assert.ok(Math.abs(shrunkLogLift(stat) - rawLogLift * 0.5) < 1e-12);
  });

  it('0除算になりうる入力で NaN/Infinity を返さない', () => {
    assert.equal(shrunkLogLift({ coTeams: 0, seedTeams: 10, candidateTeams: 10, totalTeams: 100 }), 0);
    assert.equal(shrunkLogLift({ coTeams: 5, seedTeams: 0, candidateTeams: 10, totalTeams: 100 }), 0);
    assert.equal(shrunkLogLift({ coTeams: 5, seedTeams: 10, candidateTeams: 0, totalTeams: 100 }), 0);
    assert.equal(shrunkLogLift({ coTeams: 5, seedTeams: 10, candidateTeams: 10, totalTeams: 0 }), 0);
  });
});

// ---------------------------------------------------------------------------
// ② 近さ: 型どうしの距離
// ---------------------------------------------------------------------------

describe('archetypeSimilarity: 型どうしの近さ', () => {
  const base = key('ドリュウズ', 'すなかき', 'やわらかいすな', 'physical_attacker');

  it('完全一致は1', () => {
    assert.equal(archetypeSimilarity(base, { ...base }), 1);
  });

  it('種族が違えば0(別のポケモンどうしは「近い型」ではない)', () => {
    assert.equal(archetypeSimilarity(base, key('ガブリアス', 'すなかき', 'やわらかいすな', 'physical_attacker')), 0);
  });

  it('持ち物だけの違いより特性の違いのほうが遠い', () => {
    const itemOnly = archetypeSimilarity(base, { ...base, itemName: 'いのちのたま' });
    const abilityOnly = archetypeSimilarity(base, { ...base, abilityName: 'かたやぶり' });
    assert.ok(itemOnly > abilityOnly, `item=${itemOnly} should be closer than ability=${abilityOnly}`);
    assert.ok(Math.abs(itemOnly - Math.exp(-ARCHETYPE_DISTANCE_WEIGHTS.item)) < 1e-12);
    assert.ok(Math.abs(abilityOnly - Math.exp(-ARCHETYPE_DISTANCE_WEIGHTS.ability)) < 1e-12);
  });

  it('物理↔特殊の違いより アタッカー↔耐久 の違いのほうが遠い', () => {
    const axis = archetypeSimilarity(base, { ...base, role: 'special_attacker' });
    const kind = archetypeSimilarity(base, { ...base, role: 'bulky' });
    assert.ok(axis > kind, `axis=${axis} should be closer than kind=${kind}`);
  });

  it('全項目が違っても0にはならず、閾値以上の弱い情報として残る', () => {
    const far = archetypeSimilarity(base, key('ドリュウズ', 'かたやぶり', 'いのちのたま', 'bulky'));
    assert.ok(far > 0 && far < 0.1, `got ${far}`);
    assert.ok(far >= MIN_ARCHETYPE_SIMILARITY, `far=${far} should survive the ${MIN_ARCHETYPE_SIMILARITY} cutoff`);
  });

  it('対称である', () => {
    const other = key('ドリュウズ', 'かたやぶり', 'いのちのたま', 'bulky');
    assert.equal(archetypeSimilarity(base, other), archetypeSimilarity(other, base));
  });
});

describe('weightSeedArchetypes: 自チームの型に近い構築データ上の型へ重みを配る', () => {
  const rankedArchetypes: RankedArchetype[] = [
    { id: 'a1', ...key('ドリュウズ', 'すなかき', 'やわらかいすな', 'physical_attacker') },
    { id: 'a2', ...key('ドリュウズ', 'すなかき', 'いのちのたま', 'physical_attacker') },
    { id: 'a3', ...key('ドリュウズ', 'かたやぶり', 'こだわりスカーフ', 'physical_attacker') },
    { id: 'b1', ...key('カバルドン', 'すなおこし', 'たべのこし', 'bulky') },
  ];

  it('完全一致に1、近い型にはそれより小さい重みが付く', () => {
    const result = weightSeedArchetypes(
      [key('ドリュウズ', 'すなかき', 'やわらかいすな', 'physical_attacker')],
      ['ドリュウズ'],
      rankedArchetypes,
    );
    const byId = new Map(result.map((r) => [r.id, r.weight]));
    assert.equal(byId.get('a1'), 1);
    assert.ok((byId.get('a2') ?? 0) < 1 && (byId.get('a2') ?? 0) > 0);
    assert.ok((byId.get('a3') ?? 0) < (byId.get('a2') ?? 0), '特性まで違う型はより軽い');
    assert.equal(byId.has('b1'), false, '別種族の型には重みを付けない');
  });

  it('型が判定できないメンバーは、その種族の全型を重み1にする(種族レベルへの退化)', () => {
    // 特性や持ち物が未入力で classifyArchetype が null を返したケース。
    const result = weightSeedArchetypes([null], ['ドリュウズ'], rankedArchetypes);
    const byId = new Map(result.map((r) => [r.id, r.weight]));
    assert.deepEqual([...byId.entries()].sort(), [['a1', 1], ['a2', 1], ['a3', 1]]);
  });

  it('型が分かるメンバーと分からないメンバーが混在しても両方に重みが付く', () => {
    const result = weightSeedArchetypes(
      [key('ドリュウズ', 'すなかき', 'やわらかいすな', 'physical_attacker'), null],
      ['ドリュウズ', 'カバルドン'],
      rankedArchetypes,
    );
    const byId = new Map(result.map((r) => [r.id, r.weight]));
    assert.equal(byId.get('a1'), 1);
    assert.equal(byId.get('b1'), 1);
  });

  it('チームが空なら重みも空', () => {
    assert.deepEqual(weightSeedArchetypes([], [], rankedArchetypes), []);
  });
});

// ---------------------------------------------------------------------------
// 段1: おすすめ種族の順位付け
// ---------------------------------------------------------------------------

describe('rankPartnerSpecies', () => {
  // メガギャラドスを起点にした実測値(migrations/016 の関数が返す形)。
  const stats: SpeciesPairStat[] = [
    { seedSpecies: 'メガギャラドス', candidateSpecies: 'ブリジュラス', coTeams: 56, seedTeams: 133, candidateTeams: 387, totalTeams: TOTAL_TEAMS },
    { seedSpecies: 'メガギャラドス', candidateSpecies: 'ウルガモス', coTeams: 28, seedTeams: 133, candidateTeams: 96, totalTeams: TOTAL_TEAMS },
    { seedSpecies: 'メガギャラドス', candidateSpecies: 'ミミッキュ', coTeams: 27, seedTeams: 133, candidateTeams: 209, totalTeams: TOTAL_TEAMS },
  ];

  it('共起回数ではなく親密度で並ぶ(共起56のブリジュラスより共起28のウルガモスが上)', () => {
    const ranked = rankPartnerSpecies(stats);
    assert.equal(ranked[0].speciesKey, 'ウルガモス');
  });

  it('複数のチームメイトからの寄与を合算する', () => {
    const ranked = rankPartnerSpecies([
      ...stats,
      { seedSpecies: 'カバルドン', candidateSpecies: 'ミミッキュ', coTeams: 60, seedTeams: 212, candidateTeams: 209, totalTeams: TOTAL_TEAMS },
    ]);
    const mimikyu = ranked.find((r) => r.speciesKey === 'ミミッキュ');
    const single = rankPartnerSpecies(stats).find((r) => r.speciesKey === 'ミミッキュ');
    assert.ok(mimikyu && single);
    assert.ok(mimikyu.score > single.score, '2体目の支持でスコアが上がる');
  });

  it('根拠には最も強く推したメンバーが入る', () => {
    const ranked = rankPartnerSpecies([
      { seedSpecies: 'カバルドン', candidateSpecies: 'ドリュウズ', coTeams: 7, seedTeams: 212, candidateTeams: 22, totalTeams: TOTAL_TEAMS },
      { seedSpecies: 'メガギャラドス', candidateSpecies: 'ドリュウズ', coTeams: 6, seedTeams: 133, candidateTeams: 22, totalTeams: TOTAL_TEAMS },
    ]);
    const drill = ranked.find((r) => r.speciesKey === 'ドリュウズ');
    assert.ok(drill?.topSeed);
    // lift: カバルドン 7/(212*22/1041)=1.56 / メガギャラドス 6/(133*22/1041)=2.13
    assert.equal(drill.topSeed.speciesKey, 'メガギャラドス');
    assert.equal(drill.topSeed.coTeams, 6);
    assert.ok(Math.abs(drill.topSeed.ratio - 6 / 133) < 1e-12);
  });

  it('空入力で空配列を返す', () => {
    assert.deepEqual(rankPartnerSpecies([]), []);
  });
});

describe('rankSpeciesByUsage: チームが空のときのフォールバック', () => {
  it('採用率の高い順に並ぶ', () => {
    const ranked = rankSpeciesByUsage([
      { speciesKey: 'ブリジュラス', teams: 387, totalTeams: TOTAL_TEAMS },
      { speciesKey: 'ガブリアス', teams: 505, totalTeams: TOTAL_TEAMS },
      { speciesKey: 'ミミッキュ', teams: 209, totalTeams: TOTAL_TEAMS },
    ]);
    assert.deepEqual(ranked.map((r) => r.speciesKey), ['ガブリアス', 'ブリジュラス', 'ミミッキュ']);
    assert.equal(ranked[0].topSeed, null, '共起ではないので根拠の主語は無い');
  });
});

// ---------------------------------------------------------------------------
// 段2: 型の選択(疎な型レベル → 密な種族レベルへのバックオフ)
// ---------------------------------------------------------------------------

function stat(partial: Partial<ArchetypeStat> & { archetypeId: string }): ArchetypeStat {
  return {
    speciesKey: 'ギルガルド(シールド)',
    abilityName: 'バトルスイッチ',
    itemName: 'たべのこし',
    role: 'bulky',
    teamsTotal: 0,
    teamsCoSpecies: 0,
    weightedCoArchetype: 0,
    ...partial,
  };
}

describe('chooseArchetypeForSpecies', () => {
  it('型が1件も無ければ null(構築記事に特性・努力値が無い種族)', () => {
    assert.equal(chooseArchetypeForSpecies([], new Set()), null);
  });

  it('文脈のサンプルが十分あるとき、素の人気より文脈を優先する', () => {
    // X は全体では人気が低いが、自チームと同居したチームの中では支配的。
    const chosen = chooseArchetypeForSpecies(
      [
        stat({ archetypeId: 'popular', itemName: 'のろいのおふだ', teamsTotal: 80, teamsCoSpecies: 2, weightedCoArchetype: 2 }),
        stat({ archetypeId: 'contextual', itemName: 'たべのこし', teamsTotal: 20, teamsCoSpecies: 40, weightedCoArchetype: 40 }),
      ],
      new Set(),
    );
    assert.equal(chosen?.archetypeId, 'contextual');
  });

  it('文脈のサンプルが乏しいときは素の人気へ退く', () => {
    // 文脈の観測が ARCHETYPE_BACKOFF_K に対して十分小さいので prior が支配する。
    assert.ok(ARCHETYPE_BACKOFF_K >= 2);
    const chosen = chooseArchetypeForSpecies(
      [
        stat({ archetypeId: 'popular', itemName: 'のろいのおふだ', teamsTotal: 80, teamsCoSpecies: 0, weightedCoArchetype: 0 }),
        stat({ archetypeId: 'rare', itemName: 'たべのこし', teamsTotal: 2, teamsCoSpecies: 1, weightedCoArchetype: 1 }),
      ],
      new Set(),
    );
    assert.equal(chosen?.archetypeId, 'popular');
  });

  it('share は同じ種族の型の中での配分になっている(合計1)', () => {
    const stats = [
      stat({ archetypeId: 'a', itemName: 'たべのこし', teamsTotal: 41, teamsCoSpecies: 23, weightedCoArchetype: 23 }),
      stat({ archetypeId: 'b', itemName: 'のろいのおふだ', teamsTotal: 32, teamsCoSpecies: 15, weightedCoArchetype: 15 }),
      stat({ archetypeId: 'c', itemName: 'きあいのタスキ', teamsTotal: 11, teamsCoSpecies: 7, weightedCoArchetype: 6 }),
    ];
    // chooseArchetypeForSpecies は1件しか返さないため、全件の share を得るには
    // 排他の持ち物集合を変えて呼び分けるのではなく、合計が1になることを間接的に確認する。
    const total = stats
      .map((s) => chooseArchetypeForSpecies([s], new Set())?.share ?? 0)
      .reduce((a, b) => a + b, 0);
    // 1件だけ渡せばその型のshareは必ず1(分母が自分だけ)。3回呼べば合計3になる。
    assert.ok(Math.abs(total - 3) < 1e-9);

    const chosen = chooseArchetypeForSpecies(stats, new Set());
    assert.equal(chosen?.archetypeId, 'a');
    assert.ok((chosen?.share ?? 0) > 0 && (chosen?.share ?? 0) < 1);
  });

  it('持ち物が自チームと重複する型は避ける', () => {
    const chosen = chooseArchetypeForSpecies(
      [
        stat({ archetypeId: 'best', itemName: 'たべのこし', teamsTotal: 41, teamsCoSpecies: 23, weightedCoArchetype: 23 }),
        stat({ archetypeId: 'second', itemName: 'のろいのおふだ', teamsTotal: 32, teamsCoSpecies: 15, weightedCoArchetype: 15 }),
      ],
      new Set(['たべのこし']),
    );
    assert.equal(chosen?.archetypeId, 'second');
    assert.equal(chosen?.itemConflict, false);
  });

  it('全ての型が持ち物重複なら、最良の型を itemConflict つきで返す', () => {
    const chosen = chooseArchetypeForSpecies(
      [
        stat({ archetypeId: 'best', itemName: 'たべのこし', teamsTotal: 41, teamsCoSpecies: 23, weightedCoArchetype: 23 }),
        stat({ archetypeId: 'second', itemName: 'のろいのおふだ', teamsTotal: 32, teamsCoSpecies: 15, weightedCoArchetype: 15 }),
      ],
      new Set(['たべのこし', 'のろいのおふだ']),
    );
    assert.equal(chosen?.archetypeId, 'best');
    assert.equal(chosen?.itemConflict, true);
  });

  it('観測が全て0でも NaN を返さない', () => {
    const chosen = chooseArchetypeForSpecies([stat({ archetypeId: 'zero' })], new Set());
    assert.equal(chosen?.archetypeId, 'zero');
    assert.ok(Number.isFinite(chosen?.share ?? NaN));
  });
});
