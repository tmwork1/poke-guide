// POST /api/search: ポケモン・技・特性・持ち物の横断検索 (開発プラン §2.3, §2.4, §3 Phase4-1)。
// マスタデータ(オートコンプリート用軽量JSON)をビルド時にバンドルへ取り込み、単純な部分一致で
// フィルタする(全文検索エンジン・形態素解析は導入しない、YAGNI)。検索ログは searches +
// events へ二重記録する (damage-calcs.ts / builds.ts と同じ流儀)。
import type { APIContext } from 'astro';
import { badRequest, jsonResponse, methodNotAllowed, readRequiredJsonBody } from './_shared';
import { validateSearchRequestBody, type SearchCategory } from '../../lib/search-validation';
import {
  computeSessionHash,
  generateSessionId,
  getUtcDateString,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from '../../lib/session-hash';
import { eventsRateLimiter } from '../../lib/rate-limit';
import { getSupabaseAdminClient } from '../../lib/supabase';
import { readEnv } from '../../config/env';

// マスタデータはビルド時にJSONとしてバンドルへ静的import(Viteのjsonローダ)する。
// jpoke → public/master-data/autocomplete/*.json の生成は
// scripts/build-master-data/{build.mjs,extract_autocomplete.py} を参照(開発プラン §2.3)。
import pokemonList from '../../../public/master-data/autocomplete/pokemon.json';
import moveList from '../../../public/master-data/autocomplete/moves.json';
import abilityList from '../../../public/master-data/autocomplete/abilities.json';
import itemList from '../../../public/master-data/autocomplete/items.json';

export const prerender = false;

// 全文検索エンジンではないため、レスポンス肥大化を避ける簡易な打ち切り(YAGNI)。
const MAX_RESULTS_PER_CATEGORY = 30;

interface NamedRecord {
  name: string;
}

const CATEGORY_SOURCES: Record<SearchCategory, NamedRecord[]> = {
  pokemon: pokemonList,
  move: moveList,
  ability: abilityList,
  item: itemList,
};

// 日本語は大文字小文字の概念が薄いため、単純な部分一致(includes)で十分とする方針
// (開発プランのタスク仕様どおり)。
function matches(record: NamedRecord, query: string): boolean {
  return record.name.includes(query);
}

function searchCategory(category: SearchCategory, query: string): { hits: NamedRecord[]; hitCount: number } {
  const source = CATEGORY_SOURCES[category];
  const allHits = source.filter((record) => matches(record, query));
  return { hits: allHits.slice(0, MAX_RESULTS_PER_CATEGORY), hitCount: allHits.length };
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const body = await readRequiredJsonBody<unknown>(request);
  if (body.response) return body.response;

  const validation = validateSearchRequestBody(body.data);
  if (!validation.ok) return badRequest(validation.error);

  const { query, category } = validation.value;
  const categories: SearchCategory[] = category ? [category] : ['pokemon', 'move', 'ability', 'item'];

  // セッションCookie (pc_sid): 非個人情報のランダムID。無ければここで発行する (damage-calcs.ts と同じ)。
  let sessionId = cookies.get(SESSION_COOKIE_NAME)?.value;
  const isNewSession = !sessionId;
  if (!sessionId) {
    sessionId = generateSessionId();
  }

  // レートリミットは events.ts / damage-calcs.ts と同じ書き込みAPI向け設定を流用する。
  const rateLimitKey = request.headers.get('cf-connecting-ip') ?? sessionId;
  const rateLimit = eventsRateLimiter.check(rateLimitKey);
  if (!rateLimit.allowed) {
    return jsonResponse({ error: 'Too many requests' }, 429);
  }

  if (isNewSession) {
    cookies.set(SESSION_COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // astro dev (http://localhost) では secure Cookie がセットされないため開発時のみ無効化する。
      secure: !import.meta.env.DEV,
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
  }

  const secret = readEnv('SESSION_HASH_SECRET');

  const results: Record<SearchCategory, NamedRecord[]> = { pokemon: [], move: [], ability: [], item: [] };
  let hitCount = 0;
  for (const c of categories) {
    const { hits, hitCount: categoryHitCount } = searchCategory(c, query);
    results[c] = hits;
    hitCount += categoryHitCount;
  }

  let sessionHash: string;
  try {
    sessionHash = await computeSessionHash(sessionId, secret, getUtcDateString());
  } catch (error) {
    // 検索結果はバンドル済みマスタデータだけで既に算出済みであり、記録は副次的な処理に過ぎない。
    // 匿名化を保証できない場合はログを書かず、検索という主目的の結果だけを200で返す。
    // eslint-disable-next-line no-console
    console.error('Skipping search logging because session hash is not configured:', error);
    return jsonResponse({ data: { query, category: category ?? null, hitCount, results } }, 200);
  }

  const supabase = await getSupabaseAdminClient();

  // searches / events への記録はどちらも集計用の副次的な記録であり、検索結果自体は
  // マスタデータ(バンドル済みJSON)からDB非依存で既に計算できているため、
  // 記録が失敗してもユーザーへのレスポンス(results)は返す
  // (damage-calcs.ts / builds.ts で修正した「主目的の達成をログ書き込み失敗で
  // 台無しにしない」方針と同じ。検索の主目的は検索結果を返すことであり、
  // searchesテーブルへの記録はdamage_calcs/buildsのように結果そのものではない)。
  const { error } = await supabase.from('searches').insert({
    query,
    category: category ?? null,
    hit_count: hitCount,
    session_hash: sessionHash,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to insert searches:', error);
  }
  const { error: eventError } = await supabase.from('events').insert({
    event_type: 'search',
    payload: { query, category: category ?? null, hit_count: hitCount },
    session_hash: sessionHash,
  });

  if (eventError) {
    // eslint-disable-next-line no-console
    console.error('Failed to insert events (search):', eventError);
  }

  return jsonResponse({ data: { query, category: category ?? null, hitCount, results } }, 200);
}

export const GET = () => methodNotAllowed(['POST']);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
