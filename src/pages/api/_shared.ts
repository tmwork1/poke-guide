// API ルートで共通に使うレスポンス生成・入力検証ヘルパーをまとめる。
// 各エンドポイントの本体を短く保つための基盤ファイル (poke-research の同名ファイルを移植)。
export function jsonResponse(body: unknown, status = 200): Response {
  // すべての API で JSON レスポンスのヘッダを揃える。
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function methodNotAllowed(allowed: string[]): Response {
  // 許可メソッドをレスポンスに含めて、クライアント側の切り分けをしやすくする。
  return jsonResponse(
    {
      error: 'Method not allowed',
      allowed,
    },
    405,
  );
}

export function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

// owned_pokemon.id / opponent_notes.id 等の uuid 列のパスパラメータ・クエリパラメータを
// 早期に検証するためのパターン。DBへ投げて Postgrest の invalid input syntax エラーを
// 露出させないための、各APIエンドポイント共通のチェック。
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | undefined | null): value is string {
  return !!value && UUID_PATTERN.test(value);
}

// リクエストボディの文字数上限(64K文字)。このアプリのJSONペイロード(計算条件・育成データ)は
// 実際には数百文字〜数KB程度で収まるため、巨大なペイロードを送りつけて jsonb 列の
// ストレージ・帯域を消費させる行為への歯止めとして十分すぎる余裕を持たせている。
// (text.length は UTF-16 コード単位数でバイト数の厳密な上限ではないが、
// 「桁違いに巨大なペイロードを弾く」という目的には十分な精度)
export const MAX_REQUEST_BODY_LENGTH = 64 * 1024;

// ログインユーザーの Cookie セッションで認可される書き込みAPI(owned-pokemon等)向けの
// 簡易CSRF対策。既存の匿名書き込みAPI(builds.ts/damage-calcs.ts)はログインCookieを
// 前提にしないため対象外(Phase A残課題、育成データ管理計画.md §8 Phase A-3の指摘を反映)。
// Origin ヘッダを送らない一部の非ブラウザ/古いブラウザのリクエストまで一律に弾くと
// 正当な同一オリジンの fetch まで壊しかねないため、Origin ヘッダがある場合のみ検証する
// (Same-Site Cookie が既定で有効なモダンブラウザに対しては十分な多層防御になる)。
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function readJsonBody<T>(request: Request): Promise<{ data: T | null; response?: Response }> {
  try {
    // 空ボディは null として扱い、JSON でない入力だけをエラーにする。
    const text = await request.text();
    if (!text.trim()) {
      return { data: null };
    }
    if (text.length > MAX_REQUEST_BODY_LENGTH) {
      return {
        data: null,
        response: badRequest('Request body too large'),
      };
    }
    return { data: JSON.parse(text) as T };
  } catch {
    return {
      data: null,
      response: badRequest('Invalid JSON payload'),
    };
  }
}
