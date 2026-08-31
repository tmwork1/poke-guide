// GET /api/opgg-usage-evs: box/[id].astro の育成タブで、種族確定時にOP.GG採用率1位の
// 努力値スプレッドを初期値として反映するための専用API。
// Cloudflare KV(OPGG_USAGE)に保存されたOP.GG使用率データのevsカテゴリはRankedRow
// ({rank, name, usageRate})ではなくEvRankedRow({rank, usageRate, values})の形を持つため、
// /api/opgg-usage(category=moves|items|abilities|natures)とはレスポンス形状が異なる
// 別エンドポイントとして切り出した(src/lib/opgg-usage.ts の getOpggUsageCategory参照)。
// values のキーは OP.GG 側の英語フルネーム(hp/attack/defense/specialAttack/
// specialDefense/speed)。取得元(scripts/opgg/fetch-champions-usage.mjs、
// op.gg/ja/pokemon-champions)は「ポケモンチャンピオンズ」専用ページで、値は同ゲーム
// 本来の0〜32スケール(本アプリのChampions形式と同じ)で既に表示されている
// (標準の0〜252スケールではない。ローカルKVの実データで複数種族分を確認済み)。
// そのため呼び出し側での変換は不要で、そのまま#ev-*入力へ設定できる。
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggUsageCategory } from '../../lib/opgg-usage';

export const prerender = false;

export async function GET({ request }: APIContext): Promise<Response> {
  const url = new URL(request.url);
  const species = url.searchParams.get('species')?.trim();
  if (!species) return badRequest('species is required');

  const rows = await getOpggUsageCategory(env.OPGG_USAGE, species, 'evs');
  const top = rows?.[0] ?? null;
  return jsonResponse(
    { values: top?.values ?? null },
    200,
    { 'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400' },
  );
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
