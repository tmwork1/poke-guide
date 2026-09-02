// GET /api/opgg-usage: box/[id].astro のわざ/持ち物/特性/性格選択UIの「人気」列用。
// Cloudflare KV(OPGG_USAGE)に保存されたOP.GG使用率データから、指定種族の
// シングルバトル使用率一覧(category=moves|items|abilities|natures)を返す(メガフォルムは
// ベースフォルム名で検索する。src/lib/opgg-usage.ts の resolveOpggSpeciesName参照)。
// 努力値(evs)だけ戻り値の形が異なる(名前ごとではなくステータスごとの値を持つ)ため
// このエンドポイントの対象外。/api/opgg-usage-evs を使うこと。
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggUsageCategory, getOpggUsageSingle, type OpggUsageCategory } from '../../lib/opgg-usage';

export const prerender = false;

type NamedOpggUsageCategory = Exclude<OpggUsageCategory, 'evs'>;

const CATEGORIES: readonly NamedOpggUsageCategory[] = ['moves', 'items', 'abilities', 'natures'];

function isOpggUsageCategory(value: string | null): value is NamedOpggUsageCategory {
  return CATEGORIES.includes(value as NamedOpggUsageCategory);
}

export async function GET({ request }: APIContext): Promise<Response> {
  const url = new URL(request.url);
  const species = url.searchParams.get('species')?.trim();
  if (!species) return badRequest('species is required');

  const category = url.searchParams.get('category');
  // /box/data のゲスト表示はSSRでlocalStorageを読めないため、種族名が判明した後に
  // この読み取り専用APIからカード全体を取得する。個体情報は送らない。
  if (category === 'all') {
    return jsonResponse({ single: await getOpggUsageSingle(env.OPGG_USAGE, species) }, 200, {
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
    });
  }
  if (!isOpggUsageCategory(category)) {
    return badRequest(`category must be one of: ${CATEGORIES.join(', ')}`);
  }

  const options = await getOpggUsageCategory(env.OPGG_USAGE, species, category);
  return jsonResponse({ options: options ?? [] }, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
