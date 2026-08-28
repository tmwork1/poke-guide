// GET /api/opgg-usage: box/[id].astro のわざ/持ち物/特性選択UIの「人気」列用。
// Cloudflare KV(OPGG_USAGE)に保存されたOP.GG使用率データから、指定種族の
// シングルバトル使用率一覧(category=moves|items|abilities)を返す(メガフォルムは
// ベースフォルム名で検索する。src/lib/opgg-usage.ts の resolveOpggSpeciesName参照)。
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggUsageCategory, type OpggUsageCategory } from '../../lib/opgg-usage';

export const prerender = false;

const CATEGORIES: readonly OpggUsageCategory[] = ['moves', 'items', 'abilities'];

function isOpggUsageCategory(value: string | null): value is OpggUsageCategory {
  return CATEGORIES.includes(value as OpggUsageCategory);
}

export async function GET({ request }: APIContext): Promise<Response> {
  const url = new URL(request.url);
  const species = url.searchParams.get('species')?.trim();
  if (!species) return badRequest('species is required');

  const category = url.searchParams.get('category');
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
