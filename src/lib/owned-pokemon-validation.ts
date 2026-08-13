// /api/owned-pokemon・/api/owned-pokemon/:id のリクエストボディ検証ロジック。
// Astro/Cloudflare ランタイムに依存しない純粋な関数として切り出し、node --test で
// ユニットテストできるようにする。
//
// PUT(更新)は「全項目を毎回送る」楽観的自動保存の設計(育成データ管理計画.md §6.2)のため、
// POST(新規作成)と同じ形の全項目バリデーションを共有する(廃止済みの build-validation.ts と同様、
// evs/ivs は builds と同じ「6要素配列」形式に統一する。オブジェクト形式にはしない)。

import { isMoveNamesArray, isPlainObject, isStatArray, isStringArray } from './validation-primitives.ts';

export interface OwnedPokemonRequestBody {
  nickname: string | null;
  species_name: string;
  level: number | null;
  nature: string | null;
  ability_name: string | null;
  item_name: string | null;
  tera_type: string | null;
  // レギュレーション(migrations/013_regulation.sql)。値は jpoke 由来の 'M-A' 等、未指定は null。
  // nature/item_name/tera_type と同じく「任意の文字列 or null」としてしか検証しない
  // (マスタデータとの照合はこの純粋関数の層では行わない、というこのファイル既存の流儀。
  // 実際に送られる値の由来は src/lib/regulations.ts の REGULATIONS から描画した選択ボックスのみ)。
  regulation: string | null;
  // Champions形式 [HP, 攻撃, 防御, 特攻, 特防, 素早さ]、各0〜32。省略時は全0(builds.evsと同形式)。
  evs: number[];
  // 同順、各0〜31。省略時は全31。
  ivs: number[];
  // 最大4件。省略時は空配列。
  move_names: string[];
  memo: string | null;
  tags: string[];
  is_pinned: boolean;
}

export type OwnedPokemonValidationResult =
  | { ok: true; value: OwnedPokemonRequestBody }
  | { ok: false; error: string };

// validateOpponentNoteRequestBody(body, { requireOwnedPokemonId }) と同じ流儀の
// オプション引数。PUT(全項目を毎回送る「置換」契約)のときだけ 'replace' を渡すと、
// 置換対象の全フィールドが payload に「存在すること」(undefined=未送信は拒否、
// nullは許容)を必須にする。POST(新規作成)は省略したままでよく、その場合は従来どおり
// 全フィールド任意のまま(「＋ 個体を追加」による空個体の自動登録を壊さないため)。
//
// 背景: {} のようなpayloadは「全フィールド未送信」であり、置換契約のPUTに対しては
// 既存データの全消去を意味する。ボディの有無(readRequiredJsonBody)だけでは
// {} を検出できないため、フィールド単位の必須チェックをここに追加する。
export interface ValidateOwnedPokemonOptions {
  mode?: 'replace';
}

// buildPayload() (src/pages/box/[id].astro) が実際に自動保存で送る全キー。
// mode: 'replace' のときはこれら全キーの存在を必須にする。
const REPLACE_REQUIRED_FIELDS: Array<keyof OwnedPokemonRequestBody> = [
  'nickname',
  'species_name',
  'level',
  'nature',
  'ability_name',
  'item_name',
  'tera_type',
  'regulation',
  'evs',
  'ivs',
  'move_names',
  'memo',
  'tags',
  'is_pinned',
];

const DEFAULT_EVS = [0, 0, 0, 0, 0, 0];
const DEFAULT_IVS = [31, 31, 31, 31, 31, 31];
const MIN_LEVEL = 1;
const MAX_LEVEL = 100;

// 空文字は「未指定/クリア」として null に正規化する(フォームの自動保存が毎回全項目を
// 送ってくる設計上、空欄に戻された項目を null として保存できるようにするため)。
function normalizeOptionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function validateOwnedPokemonRequestBody(
  body: unknown,
  options: ValidateOwnedPokemonOptions = {},
): OwnedPokemonValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  if (options.mode === 'replace') {
    for (const field of REPLACE_REQUIRED_FIELDS) {
      if ((body as Record<string, unknown>)[field] === undefined) {
        return { ok: false, error: `${field} is required (missing or undefined) for a PUT (replace) request` };
      }
    }
  }

  const {
    nickname,
    species_name,
    level,
    nature,
    ability_name,
    item_name,
    tera_type,
    regulation,
    evs,
    ivs,
    move_names,
    memo,
    tags,
    is_pinned,
  } = body;

  // 「＋ 個体を追加」による空個体の自動登録(ボックス一覧UI改修)のため、
  // species_name は空文字/未指定を許容する(未指定は空文字として扱う)。
  // DB(migrations/004_owned_pokemon.sql)側は NOT NULL のみでCHECK制約が無いため
  // 空文字を保存できる。ただし string 以外の型(nullを含む)は従来どおり拒否する
  // (nullを許容するとNOT NULL制約に反するDBエラーになるため)。
  if (species_name !== undefined && typeof species_name !== 'string') {
    return { ok: false, error: 'species_name must be a string' };
  }
  if (nickname !== undefined && nickname !== null && typeof nickname !== 'string') {
    return { ok: false, error: 'nickname must be a string' };
  }
  if (level !== undefined && level !== null) {
    if (typeof level !== 'number' || !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
      return { ok: false, error: `level must be an integer between ${MIN_LEVEL} and ${MAX_LEVEL}` };
    }
  }
  if (nature !== undefined && nature !== null && typeof nature !== 'string') {
    return { ok: false, error: 'nature must be a string' };
  }
  if (ability_name !== undefined && ability_name !== null && typeof ability_name !== 'string') {
    return { ok: false, error: 'ability_name must be a string' };
  }
  if (item_name !== undefined && item_name !== null && typeof item_name !== 'string') {
    return { ok: false, error: 'item_name must be a string' };
  }
  if (tera_type !== undefined && tera_type !== null && typeof tera_type !== 'string') {
    return { ok: false, error: 'tera_type must be a string' };
  }
  if (regulation !== undefined && regulation !== null && typeof regulation !== 'string') {
    return { ok: false, error: 'regulation must be a string' };
  }
  if (evs !== undefined && !isStatArray(evs, 32)) {
    return { ok: false, error: 'evs must be an array of 6 integers between 0 and 32' };
  }
  if (ivs !== undefined && !isStatArray(ivs, 31)) {
    return { ok: false, error: 'ivs must be an array of 6 integers between 0 and 31' };
  }
  if (move_names !== undefined && !isMoveNamesArray(move_names)) {
    return { ok: false, error: 'move_names must be an array of at most 4 strings' };
  }
  if (memo !== undefined && memo !== null && typeof memo !== 'string') {
    return { ok: false, error: 'memo must be a string' };
  }
  if (tags !== undefined && !isStringArray(tags)) {
    return { ok: false, error: 'tags must be an array of strings' };
  }
  if (is_pinned !== undefined && typeof is_pinned !== 'boolean') {
    return { ok: false, error: 'is_pinned must be a boolean' };
  }

  return {
    ok: true,
    value: {
      nickname: typeof nickname === 'string' ? normalizeOptionalString(nickname) : null,
      species_name: typeof species_name === 'string' ? species_name.trim() : '',
      level: (level as number | undefined) ?? null,
      nature: typeof nature === 'string' ? normalizeOptionalString(nature) : null,
      ability_name: typeof ability_name === 'string' ? normalizeOptionalString(ability_name) : null,
      item_name: typeof item_name === 'string' ? normalizeOptionalString(item_name) : null,
      tera_type: typeof tera_type === 'string' ? normalizeOptionalString(tera_type) : null,
      regulation: typeof regulation === 'string' ? normalizeOptionalString(regulation) : null,
      evs: (evs as number[] | undefined) ?? DEFAULT_EVS,
      ivs: (ivs as number[] | undefined) ?? DEFAULT_IVS,
      move_names: (move_names as string[] | undefined) ?? [],
      memo: typeof memo === 'string' ? normalizeOptionalString(memo) : null,
      tags: ((tags as string[] | undefined) ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
      is_pinned: (is_pinned as boolean | undefined) ?? false,
    },
  };
}
