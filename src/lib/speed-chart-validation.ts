// すばやさ早見表(/speed-chart)の `?reg=` / `?owned=` クエリパラメータの検証、および
// 「この個体」カラムの適用候補(SpeedTargetSelection)の検証ロジック。
// 他の *-validation.ts ファイル(owned-pokemon-validation.ts・team-validation.ts)と同じく、
// Astro/Cloudflare ランタイム・Supabase・public/master-data/ の JSON import のいずれにも
// 依存しない純粋関数のみで構成する(node --test で DB・ネットワークを叩かずに書けるようにする)。
//
// src/lib/regulations.ts は public/master-data/autocomplete/regulations.json を静的import
// しており、生のNode ESM(node --test。Viteのようなバンドラを介さない)では
// `ERR_IMPORT_ATTRIBUTE_MISSING`(JSON importにimport attributeが要る)で読み込みに失敗する
// (実際にこのファイルからimportして確認した)。そのためレギュレーションの判定は
// regulations.ts をimportせず、known regulationsを引数で受け取る形にする(このファイル全体を
// 「呼び出し側がマスターデータを読んで渡す」純粋関数の方針に統一する。buildSpeedChartPopulation
// (src/lib/speed-chart.ts)と同じ設計判断)。呼び出し側(index.astro)は
// src/lib/regulations.ts の REGULATIONS をそのまま渡せばよい。
//
// src/lib/validation-primitives.ts(isPlainObject)の既存部品はそのまま使う。
// owned_pokemon.id の UUID 形式チェックは team-validation.ts の既存の流儀
// (lib層はpages/api配下に依存させないため、src/pages/api/_shared.ts のパターンを複製する)に倣う。

import { isPlainObject } from './validation-primitives.ts';

// ============================================================================
// `?owned=` の検証
// ============================================================================

// src/pages/api/_shared.ts の UUID_PATTERN / src/lib/team-validation.ts の UUID_PATTERN と
// 同じパターン(lib層はpages/api配下に依存させない方針のためここに複製する)。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuidString(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * `?owned=` クエリパラメータをUUID形式かどうかだけ検証する。
 *
 * この画面は「未ログイン/他人の個体/存在しないID」のいずれでも表(早見表本体)は表示し、
 * 右カラム(この個体)だけを出さないという設計(強制リダイレクトしない。/box/[id] と同じ方針)
 * のため、ここでは形式チェックのみを行い、不正/未指定は例外ではなく null として返す
 * (呼び出し側=index.astroが「右カラムを出さない」判断にそのまま使える)。
 * 実際に本人の個体かどうか(所有者チェック)はDBへのアクセスを伴うためこのファイルの範囲外。
 */
export function parseOwnedQueryParam(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' && isValidUuidString(trimmed) ? trimmed : null;
}

// ============================================================================
// `?reg=` の検証・レギュレーションの解決
// ============================================================================

// src/lib/regulations.ts の normalizeRegulation と同じ正規化規則(空文字・空白・未知の値は
// null に倒す)を、knownRegulations を引数で受け取る形で再実装したもの。
function normalizeRegulationValue(value: string | null | undefined, knownRegulations: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return knownRegulations.includes(trimmed) ? trimmed : null;
}

/**
 * `?reg=` クエリパラメータを検証する。knownRegulations に含まれない値・空文字・空白・
 * null/undefined はすべて null に正規化する(src/lib/regulations.ts の normalizeRegulation と
 * 同じ規則。呼び出し側は REGULATIONS をそのまま knownRegulations に渡せばよい)。
 */
export function validateRegulationQueryParam(
  value: string | null | undefined,
  knownRegulations: readonly string[],
): string | null {
  return normalizeRegulationValue(value, knownRegulations);
}

/**
 * この画面のレギュレーション決定順序(P1確定仕様): `?reg=` → 連携個体の regulation →
 * REGULATIONS の末尾(最新)。「レギュレーション未指定は許さない」ため、knownRegulations が
 * 空でない限り必ず何らかの文字列を返す(空なら null。マスターデータ自体が壊れている異常系)。
 */
export function resolveSpeedChartRegulation(
  queryReg: string | null | undefined,
  ownedRegulation: string | null | undefined,
  knownRegulations: readonly string[],
): string | null {
  const fromQuery = normalizeRegulationValue(queryReg, knownRegulations);
  if (fromQuery) return fromQuery;
  const fromOwned = normalizeRegulationValue(ownedRegulation, knownRegulations);
  if (fromOwned) return fromOwned;
  return knownRegulations.length > 0 ? knownRegulations[knownRegulations.length - 1] : null;
}

// ============================================================================
// 「この個体」カラムの適用候補(SpeedTargetSelection)の検証
// ============================================================================
// src/lib/speed-chart.ts の selectMinimalCostSpeedOption() が返す
// { evSpe, nature, usesScarf } をそのまま信頼せず、owned-panel.ts がDOMから受け取った値
// (クリックされた行のデータ属性等)を実際にPUTへ回す前にもう一段検証するための型・関数。
// R-1(全項目上書き)の実際のペイロード構築・送信自体は owned-panel.ts の責務であり、
// ここでは「nature/evSpe/itemName の3値」だけを検証する。

const MIN_EV_SPE = 0;
const MAX_EV_SPE = 32;

export interface SpeedChartApplyPayload {
  nature: string;
  evSpe: number;
  itemName: string | null;
}

export type SpeedChartApplyValidationResult =
  | { ok: true; value: SpeedChartApplyPayload }
  | { ok: false; error: string };

/**
 * 「ここにする」クリックで適用しようとしている組み合わせ(性格・S努力値・持ち物)を検証する。
 * evSpe は Champions形式の努力値(0〜32)。nature は空でない文字列であること以外は
 * マスターデータとの照合をしない(owned-pokemon-validation.ts の nature/item_name と同じ方針:
 * このファイルはこの層で完結する形式チェックのみを行う)。
 */
export function validateSpeedChartApplyPayload(payload: unknown): SpeedChartApplyValidationResult {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be a JSON object' };
  }

  const { nature, evSpe, itemName } = payload as Record<string, unknown>;

  if (typeof nature !== 'string' || nature.trim() === '') {
    return { ok: false, error: 'nature must be a non-empty string' };
  }
  if (typeof evSpe !== 'number' || !Number.isInteger(evSpe) || evSpe < MIN_EV_SPE || evSpe > MAX_EV_SPE) {
    return { ok: false, error: `evSpe must be an integer between ${MIN_EV_SPE} and ${MAX_EV_SPE}` };
  }
  if (itemName !== null && typeof itemName !== 'string') {
    return { ok: false, error: 'itemName must be a string or null' };
  }

  return {
    ok: true,
    value: {
      nature: nature.trim(),
      evSpe,
      itemName: typeof itemName === 'string' ? itemName : null,
    },
  };
}
