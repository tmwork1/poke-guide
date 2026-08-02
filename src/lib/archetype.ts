// 育成データ(owned_pokemon)を「型(アーキタイプ)」に分類する純粋関数。
// 型の識別キーは 種族名・持ち物名・role(物理アタッカー/特殊アタッカー/耐久/判定不能) のみ
// (migrations/015_archetypes.sql + 017 + 018 の archetypes テーブルと一致させる)。
// 性格・わざ・テラスタルは個体差が大きいため識別キーに含めないが、わざは「物理/特殊どちらで
// 攻めているか」の判定シグナルとしてのみ使う(ユーザー要望、2026-08-02)。
//
// 特性は当初キーに含めていたが 018 で外した。構築データ上の観測率が持ち物 99.5% に対し
// 特性は 58.7%(構築記事のある個体にしか無い)で、キーに入れると型レイヤが半分のデータでしか
// 成立しないため。特性は識別子ではなく型ごとの最頻値(migrations/018 の
// archetype_modal_ability ビュー)として推定・表示する。理由と実測値は 018 のコメント。
//
// src/lib/species-dex.ts と同じ「ビルド時JSON import」方式を踏襲する(Cloudflare Workers上の
// SSR/APIルートでも動く実績あり。src/lib/pokemon-master-data.ts の fetch() ベースのローダーは
// ブラウザ専用のためここでは使えない)。
//
// src/lib/stats.ts と同じ制約(DOM/Node APIに一切依存しない純粋関数のみで構成)に従う。
import pokemonDetailList from '../../public/master-data/detail/pokemon.json' with { type: 'json' };
import moveDetailList from '../../public/master-data/detail/moves.json' with { type: 'json' };
import { STAT_KEYS, NATURE_STAT_MODIFIERS, calcHpStat, calcOtherStat, type StatKey } from './stats.ts';

interface PokemonDetailEntry {
  name: string;
  baseStats: number[];
}

type MoveCategory = 'physical' | 'special' | 'status';

interface MoveDetailEntry {
  name: string;
  category: MoveCategory;
}

const BASE_STATS_BY_SPECIES: ReadonlyMap<string, number[]> = new Map(
  (pokemonDetailList as PokemonDetailEntry[]).map((p) => [p.name, p.baseStats]),
);

const MOVE_CATEGORY_BY_NAME: ReadonlyMap<string, MoveCategory> = new Map(
  (moveDetailList as MoveDetailEntry[]).map((m) => [m.name, m.category]),
);

// チャンピオンズルール固定(src/lib/stats.tsのSPECIES_PAGE_LEVELと同値だが、
// 「個体単位の実データ」を扱う本モジュール専用の定数として分離)。
const ARCHETYPE_LEVEL = 50;

/**
 * 'unknown' は「第4の役割」ではなく、努力値が未観測で role を計算できなかったことを表す
 * **部分観測**の印(migrations/017_archetype_role_unknown.sql)。役割が分からないことを
 * 理由に個体ごと捨てると、構築データの 14.9%(実測546体)を失うために導入した。
 * ユーザー自身の育成データは努力値が必ずあるため 'unknown' にはならない。
 */
export type ArchetypeRole = 'physical_attacker' | 'special_attacker' | 'bulky' | 'unknown';

export interface ArchetypeKey {
  speciesName: string;
  itemName: string;
  role: ArchetypeRole;
}

export interface ArchetypeClassificationInput {
  speciesName: string | null | undefined;
  itemName: string | null | undefined;
  nature: string | null | undefined;
  evs: number[] | null | undefined;
  ivs: number[] | null | undefined;
  moveNames: string[] | null | undefined;
}

// 攻撃実数値が耐久平均のこの倍率以上なら「アタッカー」、未満なら「耐久」と判定する暫定閾値。
// 実データに基づく調整を前提とした経験則の初期値。この定数だけを見て後から調整できるよう
// 他のロジックから分離してある。
export const ATTACKER_THRESHOLD_MULTIPLIER = 1.15;

/**
 * 種族名・持ち物名・性格・evs/ivs・move_namesから型(archetype識別キー)を判定する。
 * 分類不能(種族名/持ち物名のいずれかが空/null、種族がマスターデータに無い)の場合は
 * null を返す。呼び出し側はこの場合 archetype_id を null のまま保存すること
 * (この関数自体は例外を投げない)。
 *
 * evs/ivs が6要素でない場合は null ではなく role: 'unknown' の型を返す。役割は努力値からしか
 * 計算できないが、種族・持ち物までは確定しており、そこまでの情報を捨てないための分岐
 * (経緯と実測値は migrations/017_archetype_role_unknown.sql)。
 */
export function classifyArchetype(input: ArchetypeClassificationInput): ArchetypeKey | null {
  const speciesName = input.speciesName?.trim();
  const itemName = input.itemName?.trim();
  if (!speciesName || !itemName) return null;

  // 種族がマスターデータに無い場合だけは型を作らない。role の計算に種族値が要るからではなく
  // (role: 'unknown' なら要らない)、archetypes に語彙外の種族名を作らせないための門番。
  const baseStats = BASE_STATS_BY_SPECIES.get(speciesName);
  if (!baseStats || baseStats.length !== 6) return null;

  const evs = input.evs ?? [];
  const ivs = input.ivs ?? [];
  if (evs.length !== 6 || ivs.length !== 6) {
    return { speciesName, itemName, role: 'unknown' };
  }

  const modifier = (input.nature && NATURE_STAT_MODIFIERS[input.nature]) || { up: null, down: null };
  const realStats: Record<StatKey, number> = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  STAT_KEYS.forEach((key, i) => {
    if (key === 'hp') {
      realStats.hp = calcHpStat(ARCHETYPE_LEVEL, baseStats[i], ivs[i], evs[i]);
    } else {
      const nc = modifier.up === key ? 1.1 : modifier.down === key ? 0.9 : 1.0;
      realStats[key] = calcOtherStat(ARCHETYPE_LEVEL, baseStats[i], ivs[i], evs[i], nc);
    }
  });

  const axis = determinePhysicalOrSpecialAxis(input.moveNames ?? [], realStats.atk, realStats.spa);
  const attackStat = axis === 'physical' ? realStats.atk : realStats.spa;
  const bulkAverage = (realStats.hp + realStats.def + realStats.spd) / 3;
  const role: ArchetypeRole =
    attackStat >= bulkAverage * ATTACKER_THRESHOLD_MULTIPLIER
      ? axis === 'physical'
        ? 'physical_attacker'
        : 'special_attacker'
      : 'bulky';

  return { speciesName, itemName, role };
}

// 物理/特殊の軸判定: move_namesの技分類(detail/moves.json)の本数差で決め、同数
// (status技のみ・技情報なしを含む)の場合だけ実数値(atk/spa、同値なら物理)にフォールバックする。
function determinePhysicalOrSpecialAxis(
  moveNames: string[],
  atkStat: number,
  spaStat: number,
): 'physical' | 'special' {
  let physicalCount = 0;
  let specialCount = 0;
  for (const name of moveNames) {
    const category = MOVE_CATEGORY_BY_NAME.get(name);
    if (category === 'physical') physicalCount += 1;
    else if (category === 'special') specialCount += 1;
  }
  if (physicalCount !== specialCount) {
    return physicalCount > specialCount ? 'physical' : 'special';
  }
  return atkStat >= spaStat ? 'physical' : 'special';
}
