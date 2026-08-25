// GET /api/opgg-move-usage: box/[id].astro のわざ選択モーダル「人気」列用。
// Cloudflare KV(OPGG_USAGE)に保存されたOP.GG使用率データから、指定種族のシングルバトル
// 使用わざ一覧を返す(メガフォルムはベースフォルム名で検索する。opgg-usage.ts参照)。
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { badRequest, jsonResponse, methodNotAllowed } from './_shared';
import { getOpggMoves } from '../../lib/opgg-usage';

export const prerender = false;

export async function GET({ request }: APIContext): Promise<Response> {
  const url = new URL(request.url);
  const species = url.searchParams.get('species')?.trim();
  if (!species) return badRequest('species is required');

  const moves = await getOpggMoves(env.OPGG_USAGE, species);
  return jsonResponse({ moves: moves ?? [] }, 200);
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
