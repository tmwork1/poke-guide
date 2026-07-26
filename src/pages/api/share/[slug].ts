// GET /api/share/:slug: 公開個体(owned_pokemon, is_public = true)の共有スラッグ閲覧API
// (docs/plan/ui_plan.md、旧 src/pages/api/builds/[slug].ts の置き換え)。
// 公開閲覧のみなので service_role は使わず、RLS の owned_pokemon_select_public ポリシー
// (migrations/006_owned_pokemon_sharing.sql, is_public = true の行のみ) を経由する
// anon クライアントで読む(builds/[slug].ts と同じ最小権限の方針)。
// 非公開/存在しない個体は自然に0件になり404を返す。
import type { APIContext } from 'astro';
import { jsonResponse, methodNotAllowed } from '../_shared';
import { getSupabasePublicClient } from '../../../lib/supabase';
import { getPublicOwnedPokemonBySlug } from '../../../lib/owned-pokemon';

export const prerender = false;

export async function GET({ params }: APIContext): Promise<Response> {
  const slug = params.slug;
  if (!slug) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const supabase = await getSupabasePublicClient();
  const result = await getPublicOwnedPokemonBySlug(slug, supabase);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  if (!result.data) return jsonResponse({ error: 'Not found' }, 404);

  return jsonResponse({ data: result.data }, 200);
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
