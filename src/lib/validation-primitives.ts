// src/lib/owned-pokemon-validation.ts と src/lib/opponent-notes-validation.ts で共通に使う
// 型検証プリミティブ。両ファイルとも Astro/Cloudflare ランタイムに依存しない純粋な関数として
// 切り出す方針(各ファイル冒頭のコメント参照)のため、このファイルも同じ方針を踏襲する。
//
// 注意: src/lib/event-validation.ts・src/lib/damage-calc-validation.ts・
// src/lib/opponent-note-anonymize.ts にも同名の関数が個別に存在するが、それらは
// 意図的に「他ファイルに依存しない純粋関数」という設計方針のため、このファイルへの
// 統合対象ではない(重複はowned-pokemon-validation.tsとopponent-notes-validation.tsの間のみ)。

export const STAT_COUNT = 6;
export const MAX_MOVE_COUNT = 4;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// evs/ivs 用: 長さ6の数値配列で、各要素が [0, max] の整数であることを検証する。
export function isStatArray(value: unknown, max: number): value is number[] {
  if (!Array.isArray(value) || value.length !== STAT_COUNT) return false;
  return value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max);
}

export function isMoveNamesArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_MOVE_COUNT) return false;
  return value.every((v) => typeof v === 'string');
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
