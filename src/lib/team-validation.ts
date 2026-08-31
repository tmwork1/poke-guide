// /api/teams・/api/teams/:id のリクエストボディ検証 + チーム編成ルール(G-1〜G-3)の判定ロジック。
// docs/plan/pages/team.md「確定した設計 > 検証層」で確定したシグネチャをそのまま実装する。
//
// 純粋関数のみ(重要): このファイルは Astro/Cloudflare ランタイム・Supabase・
// public/master-data/ の JSON import のいずれにも依存しない(設計レビュー R-6)。
// species_name → dexNo の解決は呼び出し元(src/lib/species-dex.ts を使う側)の責任であり、
// このファイルには一切 import しない。これにより tests/team-validation.test.ts が
// DB・ネットワークいずれも叩かずに書ける。
import { isPlainObject } from './validation-primitives.ts';

export type TeamValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ------------------------------------------------------------------------------------------
// validateTeamRequestBody: PUT/POST のリクエストボディの型・範囲チェック
// ------------------------------------------------------------------------------------------

export interface TeamMemberInput {
  slot: number;
  owned_pokemon_id: string;
}

export interface TeamRequestBody {
  memo: string | null;
  members: TeamMemberInput[];
}

// validateOwnedPokemonRequestBody(body, { mode: 'replace' }) と同じ流儀のオプション引数。
// PUT(全項目を毎回送る「置換」契約)のときだけ 'replace' を渡すと、memo/members が
// payload に「存在すること」(undefined=未送信は拒否、nullは許容)を必須にする。
//
// 背景(owned-pokemon-validation.ts と同じ理由で必須): {} のようなpayloadは「全フィールド
// 未送信」であり、置換契約のPUTに対しては既存のメンバー構成の全消去を意味しかねない
// (2026-07に owned_pokemon で実際に起きたデータ消失バグの再発防止。
// src/pages/api/owned-pokemon/[id].ts:55-58 のコメント参照)。
export interface ValidateTeamRequestBodyOptions {
  mode?: 'replace';
}

const REPLACE_REQUIRED_FIELDS: Array<keyof TeamRequestBody> = ['memo', 'members'];

const MIN_SLOT = 1;
const MAX_SLOT = 6;

// owned_pokemon_id の形式チェック用。src/pages/api/_shared.ts の UUID_PATTERN と同じパターンだが、
// lib層(検証層)は pages/api 配下に依存させない方針(stack.md の層分割)のためここに複製する
// (_shared.ts 自身も「他ファイルに依存しない純粋関数」を個別に持つ既存の流儀と同じ扱い)。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// 空文字は「未指定/クリア」として null に正規化する(owned-pokemon-validation.ts の
// normalizeOptionalString と同じ方針)。
function normalizeOptionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function validateTeamRequestBody(
  body: unknown,
  options: ValidateTeamRequestBodyOptions = {},
): TeamValidationResult<TeamRequestBody> {
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

  const { memo, members } = body as Record<string, unknown>;
  if (memo !== undefined && memo !== null && typeof memo !== 'string') {
    return { ok: false, error: 'memo must be a string' };
  }
  const normalizedMembers: TeamMemberInput[] = [];
  if (members !== undefined) {
    if (!Array.isArray(members)) {
      return { ok: false, error: 'members must be an array' };
    }
    // 6枠しか存在しないため、それを超える要素数はこの時点で拒否する(G-1と同じ上限だが、
    // ここは「payloadの形」の検証であり、編成ルールの判定は validateTeamComposition が別途行う)。
    if (members.length > MAX_SLOT) {
      return { ok: false, error: `members must have at most ${MAX_SLOT} elements` };
    }

    const seenSlots = new Set<number>();
    const seenIds = new Set<string>();
    for (const raw of members) {
      if (!isPlainObject(raw)) {
        return { ok: false, error: 'each member must be a JSON object' };
      }
      const { slot, owned_pokemon_id } = raw;
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
        return { ok: false, error: `slot must be an integer between ${MIN_SLOT} and ${MAX_SLOT}` };
      }
      if (!isValidUuidString(owned_pokemon_id)) {
        return { ok: false, error: 'owned_pokemon_id must be a valid uuid string' };
      }
      if (seenSlots.has(slot)) {
        return { ok: false, error: `duplicate slot in members: ${slot}` };
      }
      if (seenIds.has(owned_pokemon_id)) {
        return { ok: false, error: `duplicate owned_pokemon_id in members: ${owned_pokemon_id}` };
      }
      seenSlots.add(slot);
      seenIds.add(owned_pokemon_id);
      normalizedMembers.push({ slot, owned_pokemon_id });
    }
  }

  return {
    ok: true,
    value: {
      memo: typeof memo === 'string' ? normalizeOptionalString(memo) : null,
      members: normalizedMembers,
    },
  };
}

// ------------------------------------------------------------------------------------------
// validateTeamComposition: 編成ルール G-1(サーバー側強制。設計レビュー R-3)
// 種族重複禁止(旧G-2)・持ち物重複禁止(旧G-3)は撤廃済み(2026-08、ユーザー指示により
// 種族・持ち物とも重複を許可する仕様に変更)。
// ------------------------------------------------------------------------------------------

export type TeamCompositionViolation = 'over-capacity';

export interface TeamCompositionMember {
  slot: number;
}

const MAX_TEAM_SIZE = 6;

// G-1: 6体上限のみを判定する。
export function validateTeamComposition(
  members: TeamCompositionMember[],
): { ok: true } | { ok: false; error: string; violation: TeamCompositionViolation } {
  if (members.length > MAX_TEAM_SIZE) {
    return {
      ok: false,
      error: `A team can have at most ${MAX_TEAM_SIZE} members (got ${members.length})`,
      violation: 'over-capacity',
    };
  }

  return { ok: true };
}

// ------------------------------------------------------------------------------------------
// selectionBlockReason: 選択バーのグレーアウト理由を1件だけ返す(設計レビュー R-10)
// ------------------------------------------------------------------------------------------

export interface SelectionCandidate {
  ownedPokemonId: string;
}

export type SelectionBlockReason = null | 'already-in-team' | 'team-full';

// 判定順: ①already-in-team(この枠に既に入っている個体そのもの)→ ②team-full(6体上限)。
// 種族重複禁止(旧duplicate-species)・持ち物重複禁止(旧duplicate-item)は撤廃済み
// (2026-08、ユーザー指示により種族・持ち物とも重複を許可する仕様に変更)。
// already-in-team を team-full より先に見る理由: 6体埋まっている状態で「既に入っている
// その個体自身」を選択バー上で再評価すると、current に候補自身が含まれているため
// team-full の条件(current.length >= 6)も真になる。しかしこの場合の正しい理由は
// 「既に編成済み」であって「6体編成済みだから新規に入れられない」ではないため、
// より具体的な already-in-team を先に判定する。
export function selectionBlockReason(
  candidate: SelectionCandidate,
  current: SelectionCandidate[],
): SelectionBlockReason {
  if (current.some((member) => member.ownedPokemonId === candidate.ownedPokemonId)) {
    return 'already-in-team';
  }

  if (current.length >= MAX_TEAM_SIZE) {
    return 'team-full';
  }

  return null;
}
