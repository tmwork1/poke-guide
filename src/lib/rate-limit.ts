// 書き込みAPI向けのベストエフォートなメモリ内レートリミッタ（固定ウィンドウ方式）。
// poke-research の src/lib/rate-limit.ts と同じ方針で移植する。
//
// Cloudflare Workers は Isolate ごとにメモリが独立しており、かつ Isolate は
// リクエストのたびに再利用されるとは限らないため、これは分散排他ではなく
// 「たまたま同じ Isolate にリクエストが集中した場合に軽く効く」程度のベストエフォートに過ぎない。
// 本命の防御は Cloudflare ダッシュボード側のレートリミットルール（WAF / Rate Limiting Rules）であり、
// ここでの実装はあくまで多層防御（defense in depth）の1層として位置づける。
//
// astro:middleware に依存しない純粋な実装として切り出し、ユニットテストで検証できるようにする。

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface WindowState {
  count: number;
  windowStart: number;
}

export interface FixedWindowRateLimiter {
  check(key: string, now?: number): RateLimitResult;
}

// key（session_hash 発行前の一時キー、またはIP）ごとに windowMs 間隔の固定ウィンドウで
// max 回まで許可する。
export function createFixedWindowRateLimiter(options: RateLimitOptions): FixedWindowRateLimiter {
  const store = new Map<string, WindowState>();

  function check(key: string, now: number = Date.now()): RateLimitResult {
    const existing = store.get(key);

    if (!existing || now - existing.windowStart >= options.windowMs) {
      store.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: options.max - 1, retryAfterMs: 0 };
    }

    if (existing.count >= options.max) {
      return { allowed: false, remaining: 0, retryAfterMs: options.windowMs - (now - existing.windowStart) };
    }

    existing.count += 1;
    return { allowed: true, remaining: options.max - existing.count, retryAfterMs: 0 };
  }

  return { check };
}

// POST /api/events に適用する既定設定・共有インスタンス。
// レートリミットのキーには IP（Cloudflare の cf-connecting-ip、無ければ session_hash 発行前の
// 一時セッションID）を使うが、いずれもメモリ上でのみ保持し DB には保存しない（開発プラン §2.4）。
// 単位時間あたりの計算・検索操作としては十分すぎるくらいの余裕を見て、60秒で60回まで。
export const EVENTS_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, max: 60 };
export const eventsRateLimiter = createFixedWindowRateLimiter(EVENTS_RATE_LIMIT);

// POST /api/owned-pokemon(個体の新規作成)に適用する専用インスタンス
// (育成データ管理計画.md §8 Phase C-1)。キーには匿名の session_hash/IP ではなく
// ログインユーザーの user.id を使う("別軸"にするため、eventsRateLimiter とは
// Mapを共有しない独立したインスタンスにしている)。設定値自体は同程度の余裕を持たせて
// eventsRateLimiter と揃えている。
export const ownedPokemonRateLimiter = createFixedWindowRateLimiter(EVENTS_RATE_LIMIT);

// POST /api/opponent-notes(対戦相手メモの新規作成)に適用する専用インスタンス
// (育成データ管理計画.md §8 Phase D-1)。ownedPokemonRateLimiter と同じ設定値・同じく
// user.id をキーにするが、Mapを共有しない独立したインスタンスにしている(別エンドポイント・
// 別軸で計測するため)。
export const opponentNotesRateLimiter = createFixedWindowRateLimiter(EVENTS_RATE_LIMIT);

// POST /api/teams(チーム新規作成)・PUT /api/teams/:id(メンバー編成の自動保存)に適用する
// 専用インスタンス(docs/plan/pages/team.md)。ownedPokemonRateLimiter/opponentNotesRateLimiter と
// 同じ設定値・同じく user.id をキーにするが、Mapを共有しない独立したインスタンスにしている
// (別エンドポイント・別軸で計測するため)。
export const teamsRateLimiter = createFixedWindowRateLimiter(EVENTS_RATE_LIMIT);
