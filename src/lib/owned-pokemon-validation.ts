// /api/owned-pokemon・/api/owned-pokemon/:id のリクエストボディ検証ロジック。
// Astro/Cloudflare ランタイムに依存しない純粋な関数として切り出し、node --test で
// ユニットテストできるようにする。
//
// PUT(更新)は「全項目を毎回送る」楽観的自動保存の設計(育成データ管理計画.md §6.2)のため、
// POST(新規作成)と同じ形の全項目バリデーションを共有する(廃止済みの build-validation.ts と同様、
// evs/ivs は builds と同じ「6要素配列」形式に統一する。オブジェクト形式にはしない)。

import { isMoveNamesArray, isPlainObject, isStatArray, isStringArray } from './validation-primitives.ts';

export interface OwnedPokemonRequestBody {
  species_name: string;
  level: number | null;
  nature: string | null;
  ability_name: string | null;
  item_name: string | null;
  tera_type: string | null;
  // Champions形式 [HP, 攻撃, 防御, 特攻, 特防, 素早さ]、各0〜32。省略時は全0(builds.evsと同形式)。
  evs: number[];
  // 同順、各0〜31。省略時は全31。
  ivs: number[];
  // 最大4件。省略時は空配列。
  move_names: string[];
  memo: string | null;
  tags: string[];
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
  'species_name',
  'level',
  'nature',
  'ability_name',
  'item_name',
  'tera_type',
  'evs',
  'ivs',
  'move_names',
  'memo',
  'tags',
];

const DEFAULT_EVS = [0, 0, 0, 0, 0, 0];
const DEFAULT_IVS = [31, 31, 31, 31, 31, 31];
const MIN_LEVEL = 1;
const MAX_LEVEL = 100;
// 実在する日本語名は最長でも十数文字だが、メガフォルム名など将来の表記ゆれにも十分余裕を持たせつつ、
// 匿名集計へ流れる自由入力を肥大化させないため、種族・技・特性・持ち物・性格・テラスタイプは64文字までにする。
const MAX_POKEMON_TEXT_LENGTH = 64;
// メモは個人用の補足を保存できる量を確保しつつ、1レコードでリクエスト上限を消費し切らないよう2000文字までにする。
const MAX_MEMO_LENGTH = 2000;
// タグは絞り込み用途の短い分類だけを想定し、一覧・匿名集計の負荷を抑えるため20件までにする。
const MAX_TAG_COUNT = 20;
// タグは表示用の短い分類名として十分な余裕を持たせ、自由入力の肥大化を防ぐため32文字までにする。
const MAX_TAG_LENGTH = 32;

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
    species_name,
    level,
    nature,
    ability_name,
    item_name,
    tera_type,
    evs,
    ivs,
    move_names,
    memo,
    tags,
  } = body;

  // 「＋ 個体を追加」による空個体の自動登録(ボックス一覧UI改修)のため、
  // species_name は空文字/未指定を許容する(未指定は空文字として扱う)。
  // DB(migrations/004_owned_pokemon.sql)側は NOT NULL のみでCHECK制約が無いため
  // 空文字を保存できる。ただし string 以外の型(nullを含む)は従来どおり拒否する
  // (nullを許容するとNOT NULL制約に反するDBエラーになるため)。
  if (species_name !== undefined && typeof species_name !== 'string') {
    return { ok: false, error: 'species_name must be a string' };
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

  if (typeof species_name === 'string' && species_name.trim().length > MAX_POKEMON_TEXT_LENGTH) {
    return { ok: false, error: `species_name must be at most ${MAX_POKEMON_TEXT_LENGTH} characters` };
  }
  if (typeof nature === 'string' && nature.trim().length > MAX_POKEMON_TEXT_LENGTH) {
    return { ok: false, error: `nature must be at most ${MAX_POKEMON_TEXT_LENGTH} characters` };
  }
  if (typeof ability_name === 'string' && ability_name.trim().length > MAX_POKEMON_TEXT_LENGTH) {
    return { ok: false, error: `ability_name must be at most ${MAX_POKEMON_TEXT_LENGTH} characters` };
  }
  if (typeof item_name === 'string' && item_name.trim().length > MAX_POKEMON_TEXT_LENGTH) {
    return { ok: false, error: `item_name must be at most ${MAX_POKEMON_TEXT_LENGTH} characters` };
  }
  if (typeof tera_type === 'string' && tera_type.trim().length > MAX_POKEMON_TEXT_LENGTH) {
    return { ok: false, error: `tera_type must be at most ${MAX_POKEMON_TEXT_LENGTH} characters` };
  }
  if (Array.isArray(move_names) && move_names.some((move) => move.trim().length > MAX_POKEMON_TEXT_LENGTH)) {
    return { ok: false, error: `move_names entries must be at most ${MAX_POKEMON_TEXT_LENGTH} characters` };
  }
  if (typeof memo === 'string' && memo.trim().length > MAX_MEMO_LENGTH) {
    return { ok: false, error: `memo must be at most ${MAX_MEMO_LENGTH} characters` };
  }
  if (Array.isArray(tags) && tags.length > MAX_TAG_COUNT) {
    return { ok: false, error: `tags must contain at most ${MAX_TAG_COUNT} entries` };
  }
  if (Array.isArray(tags) && tags.some((tag) => tag.trim().length > MAX_TAG_LENGTH)) {
    return { ok: false, error: `tags entries must be at most ${MAX_TAG_LENGTH} characters` };
  }

  return {
    ok: true,
    value: {
      species_name: typeof species_name === 'string' ? species_name.trim() : '',
      level: (level as number | undefined) ?? null,
      nature: typeof nature === 'string' ? normalizeOptionalString(nature) : null,
      ability_name: typeof ability_name === 'string' ? normalizeOptionalString(ability_name) : null,
      item_name: typeof item_name === 'string' ? normalizeOptionalString(item_name) : null,
      tera_type: typeof tera_type === 'string' ? normalizeOptionalString(tera_type) : null,
      evs: (evs as number[] | undefined) ?? DEFAULT_EVS,
      ivs: (ivs as number[] | undefined) ?? DEFAULT_IVS,
      move_names: (move_names as string[] | undefined) ?? [],
      memo: typeof memo === 'string' ? normalizeOptionalString(memo) : null,
      tags: ((tags as string[] | undefined) ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
    },
  };
}
