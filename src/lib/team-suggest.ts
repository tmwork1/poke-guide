// チーム編集画面のポケモンサジェスト(ユーザー要望、2026-08-02)のスコアリング。
// 「自チームの型」を起点に、上位入賞チーム(ranked_teams)の中でそれらとよく一緒にいる
// ポケモンの型をランキングする。
//
// 本モジュールは src/lib/stats.ts / src/lib/archetype.ts と同じ制約に従う純粋関数のみで構成し、
// DB にも DOM にも触れない(SQL の生カウントを受け取り、順位付けした結果を返すだけ)。
// migrations/016_team_partner_suggestions.sql が「数式をSQLに埋めない」方針を採っているのは、
// 判断がここに集まっていれば node --test から直接検証できるため(tests/team-suggest.test.ts)。
//
// =============================================================================
// 「型どうしの距離」に2つの定義が要る理由
// =============================================================================
// ユーザーの依頼は「型どうしの親密度(距離)を定義する必要がある」。実データを測ると、
// これは性質の異なる2つの量に分かれる。
//
// ① 親密度 affinity(A, B) — 「AとBはどれくらい一緒に使われるか」= 推薦の信号そのもの
//    素の共起回数では機能しない。実測でガブリアスの共起1位はブリジュラス(36.8%)だが、
//    ブリジュラスは全1041チームの37%が採用しているので lift は 0.99 ── ただ人気なだけで、
//    誰に対しても同じ顔ぶれを出すことになる。そこで lift(= 独立を仮定した期待値からの
//    ずれ)を使い、サンプル数が少ないペアの跳ねを縮小推定(shrinkage)で抑える。
//
// ② 近さ similarity(A, A') — 「AとA'はどれくらい同じ型か」= 疎さを埋めるための平滑化
//    型レベルの共起は疎く、ユーザーの型が構築データに1件も無いことも普通に起きる。そこで
//    「その型そのもの」ではなく「近い型」の観測を重み付きで寄せ集める。
//    (疎さは 017 で努力値未観測を、018 で特性未観測を型として拾えるようにしたことで
//     大きく改善したが、平滑化そのものは変わらず必要。)
//
// この2つを組み合わせると、型レベルの推定を種族レベルへ滑らかにバックオフさせられる。
// 種族レベルの共起は密で信頼でき(観測ペア3615、うち1760が2回以上)、型レベルは細かいが
// 疎い ── サンプル数に応じて両者を混ぜるのが本モジュールの中心的な判断。

import type { ArchetypeKey, ArchetypeRole } from './archetype.ts';

// =============================================================================
// ① 親密度: 縮小推定つき log-lift
// =============================================================================

/**
 * lift の縮小推定に使う擬似カウント。co_teams がこの値のとき信頼度がちょうど半分になる。
 * 実測のペア分布(共起1回が51%、2回が16%、3回が8%…)に対して、共起1回のペアの寄与を
 * 1/6 に、10回のペアを 2/3 に落とす。他のロジックから独立して調整できるよう定数で分離する
 * (src/lib/archetype.ts の ATTACKER_THRESHOLD_MULTIPLIER と同じ意図)。
 */
export const AFFINITY_SHRINK_K = 5;

export interface SpeciesPairStat {
  seedSpecies: string;
  candidateSpecies: string;
  coTeams: number;
  seedTeams: number;
  candidateTeams: number;
  totalTeams: number;
}

/**
 * 2種族(2型)の親密度。独立を仮定した期待共起数に対する実測の比(lift)の対数を、
 * 観測数による信頼度で縮小したもの。
 *
 * 正 = 期待より一緒に使われている / 0 = 独立と区別がつかない / 負 = 避け合っている。
 * 対数を採るのは、複数のチームメイトからの寄与を足し算で合成するため
 * (積の対数 = 対数の和。各メンバーが独立に候補を支持すると見なす素朴な合成)。
 */
export function shrunkLogLift(stat: {
  coTeams: number;
  seedTeams: number;
  candidateTeams: number;
  totalTeams: number;
}): number {
  const { coTeams, seedTeams, candidateTeams, totalTeams } = stat;
  if (totalTeams <= 0 || seedTeams <= 0 || candidateTeams <= 0) return 0;
  // 共起0は lift 0 → log が -∞ になるため、対数を取らず「情報なし」として0を返す。
  // 016 の p_min_co_teams で既に落としているが、0を渡されても壊れないようにしておく。
  if (coTeams <= 0) return 0;

  const expected = (seedTeams * candidateTeams) / totalTeams;
  const lift = coTeams / expected;
  const confidence = coTeams / (coTeams + AFFINITY_SHRINK_K);
  return Math.log(lift) * confidence;
}

// =============================================================================
// ② 近さ: 型の識別キーどうしの重み付き距離
// =============================================================================

/**
 * 型の近さを決める重み。距離が大きいほど「別の型」で、similarity = exp(-距離)。
 *
 * role は「物理/特殊の軸違い」と「アタッカー/耐久の違い」で段差をつける ── 前者は同じ攻撃役の
 * 中での違いだが、後者はチームでの仕事が別だからである。持ち物の違いはその中間に置く。
 *
 * 特性は migrations/018 で識別キーから外れたため、ここにも項が無い(構築データでの観測率が
 * 58.7%しかなく、キーに入れると型レイヤが半分のデータでしか成立しなかった)。
 *
 * 目安: 持ち物だけ違う exp(-0.7)=0.50 / 物理特殊の軸だけ違う exp(-0.45)=0.64 /
 *       持ち物もアタッカー/耐久も違う exp(-1.6)=0.20
 */
export const ARCHETYPE_DISTANCE_WEIGHTS = {
  item: 0.7,
  /** physical_attacker ↔ special_attacker(同じアタッカーの中での軸違い) */
  roleAxis: 0.45,
  /** アタッカー ↔ bulky(チームでの役割が別) */
  roleKind: 0.9,
  /**
   * 既知の role ↔ 'unknown'(努力値が未観測で判定できなかった、migrations/017)。
   * 'unknown' は「別の役割」ではなく既知 role の部分観測なので roleKind(0.9)より近くし、
   * かといって同一視もできないので0にはしない。同じ役割かもしれないし違うかもしれない、
   * という中間の位置づけを一つの定数で表す。
   */
  roleUnknown: 0.5,
} as const;

function roleDistance(a: ArchetypeRole, b: ArchetypeRole): number {
  if (a === b) return 0;
  if (a === 'unknown' || b === 'unknown') return ARCHETYPE_DISTANCE_WEIGHTS.roleUnknown;
  const isAttacker = (r: ArchetypeRole) => r === 'physical_attacker' || r === 'special_attacker';
  if (isAttacker(a) && isAttacker(b)) return ARCHETYPE_DISTANCE_WEIGHTS.roleAxis;
  return ARCHETYPE_DISTANCE_WEIGHTS.roleKind;
}

/**
 * 2つの型の近さを 0〜1 で返す(1 = 完全一致)。
 * 種族が違えば 0 ── 「近い型」はあくまで同じポケモンの別調整を指し、
 * 別のポケモンどうしの類似度はここでは扱わない(それは①の親密度の仕事)。
 */
export function archetypeSimilarity(a: ArchetypeKey, b: ArchetypeKey): number {
  if (a.speciesName !== b.speciesName) return 0;
  let distance = 0;
  if (a.itemName !== b.itemName) distance += ARCHETYPE_DISTANCE_WEIGHTS.item;
  distance += roleDistance(a.role, b.role);
  return Math.exp(-distance);
}

/**
 * これ未満の近さの型は「別物」として重み付けの対象から外す。
 * 「種族が同じというだけ」の弱い情報も捨てない、という意思表示の閾値。
 *
 * 現行の重みでは最も遠い組(持ち物もアタッカー/耐久も違う)でも 0.20 でこの閾値に届かず、
 * 実際には一度も発火しない ── 018 で特性の項(1.0)が消えて距離の上限が下がったため。
 * 重みを見直したときに「同種族なのに切り捨てる」挙動へ静かに変わらないよう関門として残す。
 */
export const MIN_ARCHETYPE_SIMILARITY = 0.05;

export interface RankedArchetype extends ArchetypeKey {
  id: string;
}

export interface WeightedSeedArchetype {
  id: string;
  weight: number;
}

/**
 * 自チームの各メンバーについて、構築データ側の「近い型」に重みを割り当てる。
 * migrations/016 の team_partner_archetype_stats(p_seed_ids, p_seed_weights) にそのまま渡す。
 *
 * メンバーの型が判定できなかった場合(特性や持ち物が未入力で classifyArchetype が null)は、
 * その種族の全ての型を重み1で返す ── これは「型を問わずその種族と共起したチーム」を
 * 見ることに等しく、型レベルの条件付けが種族レベルへ退化した状態になる。
 * 同じ関数・同じSQLで両端を表現できるようにしてあるのは、片方を特別扱いすると
 * 「型が分かるメンバーと分からないメンバーが混在するチーム」で経路が分岐するため。
 */
export function weightSeedArchetypes(
  seedKeys: ReadonlyArray<ArchetypeKey | null>,
  seedSpeciesNames: readonly string[],
  rankedArchetypes: readonly RankedArchetype[],
): WeightedSeedArchetype[] {
  const byId = new Map<string, number>();

  const put = (id: string, weight: number) => {
    // 同じ型に複数のメンバーから重みが付くことは種族が違う以上ほぼ無いが、
    // 起きた場合は最大値を採る(和にすると「近いメンバーが2体いる」ことが
    // 共起の強さとして二重に効いてしまう)。
    const previous = byId.get(id);
    if (previous === undefined || weight > previous) byId.set(id, weight);
  };

  // 型が判定できたメンバー: 近さで重み付け
  for (const key of seedKeys) {
    if (!key) continue;
    for (const ranked of rankedArchetypes) {
      const similarity = archetypeSimilarity(key, ranked);
      if (similarity >= MIN_ARCHETYPE_SIMILARITY) put(ranked.id, similarity);
    }
  }

  // 型が判定できなかったメンバーの種族: その種族の全型を重み1(= 種族レベルの条件付け)
  const unclassifiedSpecies = new Set(seedSpeciesNames);
  for (const key of seedKeys) {
    if (key) unclassifiedSpecies.delete(key.speciesName);
  }
  for (const ranked of rankedArchetypes) {
    if (unclassifiedSpecies.has(ranked.speciesName)) put(ranked.id, 1);
  }

  return [...byId.entries()].map(([id, weight]) => ({ id, weight }));
}

// =============================================================================
// 段1: おすすめ種族の順位付け
// =============================================================================

export interface SpeciesScore {
  speciesKey: string;
  score: number;
  candidateTeams: number;
  totalTeams: number;
  /** 最も強く推した自チームメンバー(表示する根拠テキストの主語になる) */
  topSeed: {
    speciesKey: string;
    coTeams: number;
    seedTeams: number;
    /** その種族を採用したチームのうち、候補も併用していた割合 */
    ratio: number;
    lift: number;
  } | null;
}

/**
 * 自チームの種族それぞれからの親密度を足し合わせ、候補種族を順位付けする。
 *
 * 合成を単純和にしているのは、各メンバーが独立に候補を支持すると見なす素朴な仮定による
 * (厳密には「自チーム全員と同時に共起したチーム」を数えるべきだが、6体の組み合わせで
 * 条件付けると母集団が数チームまで落ちて推定が成立しない ── 疎さの制約から来る妥協で、
 * 型レベルの推定を種族レベルへバックオフさせるのと同じ性質の判断)。
 */
export function rankPartnerSpecies(pairStats: readonly SpeciesPairStat[]): SpeciesScore[] {
  const byCandidate = new Map<string, SpeciesScore>();

  for (const stat of pairStats) {
    const affinity = shrunkLogLift(stat);
    const expected = (stat.seedTeams * stat.candidateTeams) / stat.totalTeams;
    const lift = expected > 0 ? stat.coTeams / expected : 0;
    const seed = {
      speciesKey: stat.seedSpecies,
      coTeams: stat.coTeams,
      seedTeams: stat.seedTeams,
      ratio: stat.seedTeams > 0 ? stat.coTeams / stat.seedTeams : 0,
      lift,
    };

    const existing = byCandidate.get(stat.candidateSpecies);
    if (!existing) {
      byCandidate.set(stat.candidateSpecies, {
        speciesKey: stat.candidateSpecies,
        score: affinity,
        candidateTeams: stat.candidateTeams,
        totalTeams: stat.totalTeams,
        topSeed: seed,
      });
      continue;
    }
    existing.score += affinity;
    // 根拠として見せるのは寄与が最大のメンバー。同点なら共起数が多いほうを採る。
    if (existing.topSeed === null || lift > existing.topSeed.lift) existing.topSeed = seed;
  }

  return [...byCandidate.values()].sort((a, b) => b.score - a.score || b.candidateTeams - a.candidateTeams);
}

/**
 * チームが空(共起の起点が無い)ときのフォールバック。単純な採用率順に並べる。
 * 「まず1体目に何を入れるか」に対しては環境で最もよく使われている種族が素直な答えになる。
 */
export function rankSpeciesByUsage(
  usage: ReadonlyArray<{ speciesKey: string; teams: number; totalTeams: number }>,
): SpeciesScore[] {
  return usage
    .map((u) => ({
      speciesKey: u.speciesKey,
      // 採用率をそのままスコアにする(段1の log-lift とは別尺度だが、
      // 両者が同時に使われることは無いので正規化しない)。
      score: u.totalTeams > 0 ? u.teams / u.totalTeams : 0,
      candidateTeams: u.teams,
      totalTeams: u.totalTeams,
      topSeed: null,
    }))
    .sort((a, b) => b.score - a.score);
}

// =============================================================================
// 段2: 候補種族の中でどの型を薦めるか
// =============================================================================

/**
 * 型の選択における文脈情報の縮小推定パラメータ。段1の AFFINITY_SHRINK_K より大きいのは、
 * ここでの分母が「候補種族を採用したチーム数」で桁が一つ大きく、かつ型の分布は
 * 種族の分布より裾が長いため(実測で1種族あたり平均3型、多いものは10型を超える)。
 */
export const ARCHETYPE_BACKOFF_K = 8;

export interface ArchetypeStat {
  archetypeId: string;
  speciesKey: string;
  /**
   * 型の識別子ではなく、その型に分類された個体の中での最頻特性(migrations/018 の
   * archetype_modal_ability)。特性が1件も判明していない型では null になる。
   */
  abilityName: string | null;
  itemName: string;
  role: ArchetypeRole;
  /** この型が出現したチーム数(文脈を無視した素の人気) */
  teamsTotal: number;
  /** 自チームの種族のいずれかと同居したチーム数(密・粗い文脈) */
  teamsCoSpecies: number;
  /** 自チームの型に近い型と同居したチーム数の重み付き和(疎・細かい文脈) */
  weightedCoArchetype: number;
}

export interface ArchetypeChoice extends ArchetypeStat {
  /** 0〜1。その種族を薦めるとき、この型である確からしさ */
  share: number;
  /** 持ち物が自チームの誰かと重複する(team-validation.ts の duplicate-item に抵触する) */
  itemConflict: boolean;
}

/**
 * role: 'unknown' の観測を、同じ (種族, 持ち物) を持つ既知 role の型へ按分して畳み込む。
 *
 * 'unknown' は第4の役割ではなく既知 role の部分観測(migrations/017)なので、独立した候補として
 * 残すと2つの害がある: ①同じ型の証拠が2つの行に割れて share が薄まる、②役割を提示できない型が
 * 推薦結果として表に出る。按分の比率は既知 role 側の teams_total ── 「努力値が分からなかった
 * この個体は、努力値が分かっている同じ構成の個体と同じ割合で各roleだったはず」という素朴な推定。
 *
 * 既知 role の兄弟が1つも無い (種族, 持ち物) は畳み込む先が無いため 'unknown' のまま残す。
 * この場合だけ役割不明の型が推薦されうるが、種族・持ち物は確定しているので
 * 「役割は分からないがこの構成が使われている」という提示自体は成立する。
 *
 * 兄弟の判定に特性を使わないのは、018 で特性が識別キーから外れ abilityName が型ごとの最頻値
 * (推定値)になったため ── 推定値の一致で「同じ構成か」を決めてはならない。
 */
function foldUnknownRoleStats(stats: readonly ArchetypeStat[]): ArchetypeStat[] {
  if (!stats.some((s) => s.role === 'unknown')) return [...stats];

  // 区切りに US(0x1F)を使うのは、種族名や持ち物名に現れない文字で連結の曖昧さを消すため。
  const buildKey = (s: ArchetypeStat) => s.speciesKey + String.fromCharCode(31) + s.itemName;
  const knownByBuild = new Map<string, ArchetypeStat[]>();
  for (const s of stats) {
    if (s.role === 'unknown') continue;
    const key = buildKey(s);
    const list = knownByBuild.get(key);
    if (list) list.push(s);
    else knownByBuild.set(key, [s]);
  }

  // 按分先の型は元の値を壊さずコピーしてから加算する(呼び出し元の配列は純粋に読むだけ)。
  const folded = new Map<string, ArchetypeStat>();
  for (const s of stats) {
    if (s.role !== 'unknown') folded.set(s.archetypeId, { ...s });
  }

  const result: ArchetypeStat[] = [];
  for (const s of stats) {
    if (s.role !== 'unknown') continue;
    const siblings = knownByBuild.get(buildKey(s));
    if (!siblings || siblings.length === 0) {
      result.push({ ...s });
      continue;
    }
    const denominator = siblings.reduce((acc, k) => acc + k.teamsTotal, 0);
    for (const sibling of siblings) {
      const target = folded.get(sibling.archetypeId);
      if (!target) continue;
      // teams_total が全て0(理論上は起きないが防御)の場合は均等割り。
      const share = denominator > 0 ? sibling.teamsTotal / denominator : 1 / siblings.length;
      target.teamsTotal += s.teamsTotal * share;
      target.teamsCoSpecies += s.teamsCoSpecies * share;
      target.weightedCoArchetype += s.weightedCoArchetype * share;
    }
  }

  return [...folded.values(), ...result];
}

/**
 * 候補種族ごとに、薦める型を1つ選ぶ。
 *
 * 3つの観測を、それぞれのサンプル数に応じた信頼度で入れ子に混ぜる:
 *
 *   share = λa·P(型 | 自チームの型と共起)
 *         + (1-λa)·( λc·P(型 | 自チームの種族と共起) + (1-λc)·P(型) )
 *
 * λ は「その文脈で何チーム観測できたか」から決まるので、データが十分あるときだけ
 * 細かい条件付けが効き、足りなければ自動的に粗い条件付け → 素の人気へと退く。
 * 疎さの度合いが種族ごとに大きく違う(ガブリアス505チーム vs ドリュウズ22チーム)ため、
 * 一律の閾値で分岐させるのではなく連続的に混ぜている。
 *
 * usedItemNames は自チームが既に使っている持ち物。重複はルール違反(duplicate-item)なので
 * 抵触しない型を優先するが、全ての型が抵触する場合は最良の型に itemConflict を立てて返す
 * (「持ち物を変えれば使える」という情報自体は捨てないほうが親切なため)。
 */
export function chooseArchetypeForSpecies(
  inputStats: readonly ArchetypeStat[],
  usedItemNames: ReadonlySet<string>,
): ArchetypeChoice | null {
  if (inputStats.length === 0) return null;

  // 役割が未観測の観測(role: 'unknown')を既知 role へ寄せてから確率を計算する。
  const stats = foldUnknownRoleStats(inputStats);

  const sum = (pick: (s: ArchetypeStat) => number) => stats.reduce((acc, s) => acc + pick(s), 0);
  const totalAll = sum((s) => s.teamsTotal);
  const totalCtx = sum((s) => s.teamsCoSpecies);
  const totalArch = sum((s) => s.weightedCoArchetype);

  const lambdaCtx = totalCtx / (totalCtx + ARCHETYPE_BACKOFF_K);
  const lambdaArch = totalArch / (totalArch + ARCHETYPE_BACKOFF_K);

  const scored: ArchetypeChoice[] = stats.map((s) => {
    const pPrior = totalAll > 0 ? s.teamsTotal / totalAll : 0;
    const pCtx = totalCtx > 0 ? s.teamsCoSpecies / totalCtx : 0;
    const pArch = totalArch > 0 ? s.weightedCoArchetype / totalArch : 0;
    const coarse = lambdaCtx * pCtx + (1 - lambdaCtx) * pPrior;
    const share = lambdaArch * pArch + (1 - lambdaArch) * coarse;
    return { ...s, share, itemConflict: usedItemNames.has(s.itemName) };
  });

  scored.sort((a, b) => b.share - a.share || b.teamsTotal - a.teamsTotal);

  // 持ち物が重複しない型を優先。無ければ先頭(= 最良だが抵触する型)を返す。
  return scored.find((s) => !s.itemConflict) ?? scored[0];
}
