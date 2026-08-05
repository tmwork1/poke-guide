// ダメージ計算のサジェスト(ユーザー要望、2026-08-05)の純粋ロジック。
// 個体育成画面の右パネルに「そのポケモンの型でよく行われているダメージ計算」を出すために、
// suggestions テーブル(migrations/020_damage_calc_suggestions.sql が書き込む
// kind='popular_damage_calc_archetype' / 'popular_damage_calc_species')の payload を
// 読み取り可能な形へ正規化する。
//
// src/lib/stats.ts / src/lib/archetype.ts / src/lib/team-suggest.ts と同じ制約に従い、
// DOM にも fetch にも DB にも触れない純粋関数だけで構成する(node --test から直接検証できる。
// tests/damage-calc-suggest.test.ts)。実際の取得・描画は src/lib/box-id/damage-suggest.ts。
//
// ■ 新しいAPIルートを作らない理由
// 集計結果は既存の suggestions テーブルに入り、GET /api/suggestions は kind + subject_key を
// そのまま引ける汎用の読み出し口として既にある(左パネルの人気度サジェストが同じ経路を
// 使っている。src/lib/box-id/left-panel.ts の fetchSuggestionPayload)。型の判定も
// classifyArchetype がブラウザ側で動く(同ファイルの currentArchetype)ため、サーバに
// 個体IDを渡して分類し直させる必要が無い。むしろクライアントで分類するほうが、
// 保存前の編集中の値(持ち物や努力値を触っている最中)にそのまま追随できる。

import type { ArchetypeKey } from './archetype.ts';

/**
 * 攻守の向き。'attack' = この所持ポケモンが攻撃側(相手へのダメージを計算する)、
 * 'defense' = 相手が攻撃側(自分が受けるダメージを計算する)。
 * src/lib/opponent-notes-validation.ts の OpponentFieldInput.direction と同じ語彙。
 */
export type DamageCalcDirection = 'attack' | 'defense';

/** 相手の想定ビルド。集計側(020)が項目ごとの最頻値として算出するため、全項目が任意。 */
export interface SuggestedOpponentBuild {
  nature?: string;
  abilityName?: string;
  itemName?: string;
  teraType?: string;
  evs?: number[];
}

export interface DamageCalcSuggestion {
  direction: DamageCalcDirection;
  /** 相手の種族名(opponent_build.name)。 */
  opponentName: string;
  /** 攻撃側が使う技名。direction='defense' のときは相手の技。 */
  moveName: string;
  /** この計算をしていた個体数。 */
  count: number;
  /** count / sample_size(0〜1)。 */
  ratio: number;
  opponentBuild: SuggestedOpponentBuild;
}

export interface DamageCalcSuggestionPayload {
  /** 母集団(同じ型/種族で、ダメージ計算を1件以上持つ個体数)。 */
  sampleSize: number;
  options: DamageCalcSuggestion[];
}

export const DAMAGE_CALC_SUGGESTION_KINDS = {
  archetype: 'popular_damage_calc_archetype',
  species: 'popular_damage_calc_species',
} as const;

/**
 * 引く順に subject_key の候補を返す。型が判定できていれば型キーを先に、
 * その後は必ず種族キーを試す(依頼「型が判別できない場合は種族のみで集計したサジェストを行う」。
 * 型が判定できていても、その型の母集団が k-匿名性の閾値に届かず行が無いことがあるため、
 * 型キーが空振りしたときも同じ経路で種族キーへ落ちる)。
 *
 * 型キーの連結順(種族名|持ち物名|role)は migrations/020 の subject_key 生成と、
 * 既存の popular_move_archetype(019 / left-panel.ts の popularMoveSubjectKeys)に揃える。
 * レギュレーション別スコープは作らない(020 のコメント参照)。
 */
export function damageCalcSubjectKeys(
  speciesName: string,
  archetype: ArchetypeKey | null,
): { kind: string; subjectKey: string }[] {
  const species = speciesName.trim();
  if (!species) return [];
  const keys: { kind: string; subjectKey: string }[] = [];
  if (archetype) {
    keys.push({
      kind: DAMAGE_CALC_SUGGESTION_KINDS.archetype,
      subjectKey: `${archetype.speciesName}|${archetype.itemName}|${archetype.role}`,
    });
  }
  keys.push({ kind: DAMAGE_CALC_SUGGESTION_KINDS.species, subjectKey: species });
  return keys;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readEvs(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 6) return undefined;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  return value as number[];
}

function parseOpponentBuild(value: unknown): SuggestedOpponentBuild {
  if (!isPlainObject(value)) return {};
  const build: SuggestedOpponentBuild = {};
  const nature = readString(value.nature);
  const abilityName = readString(value.abilityName);
  const itemName = readString(value.itemName);
  const teraType = readString(value.teraType);
  const evs = readEvs(value.evs);
  if (nature) build.nature = nature;
  if (abilityName) build.abilityName = abilityName;
  if (itemName) build.itemName = itemName;
  if (teraType) build.teraType = teraType;
  if (evs) build.evs = evs;
  return build;
}

/**
 * suggestions.payload(jsonb、集計バッチが書いたもの)を検証しながら読み取る。
 * 形が想定と違う行は「無かったこと」にする(null を返す)── 集計側の変更や、まだ
 * 020 を適用していない環境で画面が壊れるより、サジェストが出ないほうが害が小さい。
 * 個々の option の不備はその1件だけを落とす(他の候補は出す)。
 */
export function parseDamageCalcSuggestionPayload(raw: unknown): DamageCalcSuggestionPayload | null {
  if (!isPlainObject(raw)) return null;
  const sampleSize = typeof raw.sample_size === 'number' && Number.isFinite(raw.sample_size) ? raw.sample_size : 0;
  if (!Array.isArray(raw.options)) return null;

  const options: DamageCalcSuggestion[] = [];
  for (const entry of raw.options) {
    if (!isPlainObject(entry)) continue;
    const direction = entry.direction === 'defense' ? 'defense' : entry.direction === 'attack' ? 'attack' : null;
    const opponentName = readString(entry.opponent_name);
    const moveName = readString(entry.move_name);
    if (!direction || !opponentName || !moveName) continue;
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0;
    const ratio = typeof entry.ratio === 'number' && Number.isFinite(entry.ratio) ? entry.ratio : 0;
    options.push({ direction, opponentName, moveName, count, ratio, opponentBuild: parseOpponentBuild(entry.opponent_build) });
  }
  return { sampleSize, options };
}

/**
 * 「同じダメージ計算」の同一性キー。向き・相手・技の3つ組で1件を表す(020 の集計単位と同じ)。
 * 区切りに US(0x1F)を使うのは、種族名や技名に現れない文字で連結の曖昧さを消すため
 * (src/lib/team-suggest.ts の foldUnknownRoleStats と同じ理由)。
 */
export function damageCalcSuggestionKey(
  suggestion: { direction: DamageCalcDirection; opponentName: string; moveName: string },
): string {
  const separator = String.fromCharCode(31);
  return [suggestion.direction, suggestion.opponentName.trim(), suggestion.moveName.trim()].join(separator);
}

/**
 * 既に中央パネルに存在するダメージ計算(向き・相手・技が一致するもの)を候補から外し、
 * 上位 limit 件へ切り詰める。
 *
 * 既にあるものを消すのは「押しても何も新しく起きないカード」を出さないため ── 押すと
 * 同じ内容のカードがもう1枚増えるだけになり、提案としての意味が無い。表示件数の上限が
 * あるので、先に除外してから切り詰めないと「見えている候補が全部すでに追加済み」で
 * 一覧が実質空になることがある。
 */
export function filterNewDamageCalcSuggestions(
  options: readonly DamageCalcSuggestion[],
  existingKeys: ReadonlySet<string>,
  limit: number,
): DamageCalcSuggestion[] {
  const result: DamageCalcSuggestion[] = [];
  for (const option of options) {
    if (existingKeys.has(damageCalcSuggestionKey(option))) continue;
    result.push(option);
    if (result.length >= limit) break;
  }
  return result;
}
