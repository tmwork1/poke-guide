import type { APIContext } from 'astro';
import { jsonResponse, methodNotAllowed } from './_shared';
import { getSupabasePublicClient } from '../../lib/supabase';

export const prerender = false;

type MoveAdoptionBySpecies = Record<string, Record<string, Record<string, number>>>;
type PopularMoveRow = {
  subject_key: string;
  payload: { options?: Array<{ value: string; ratio: number }> } | null;
};

// ダメージ計算の相手技候補を採用率順に並べるための全種族共通集計。
// 個別ページのHTMLへ重複して含めず、共有キャッシュから配信できるようAPIに分離する。
export async function GET(_context: APIContext): Promise<Response> {
  const supabase = await getSupabasePublicClient();
  const { data, error } = await supabase
    .from('suggestions')
    .select('subject_key, payload')
    .eq('kind', 'popular_move');

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch move adoption data:', error);
    return jsonResponse({ error: 'Failed to fetch move adoption data' }, 500);
  }

  const moveAdoptionBySpecies: MoveAdoptionBySpecies = {};
  for (const row of (data ?? []) as PopularMoveRow[]) {
    if (!row.payload || !Array.isArray(row.payload.options)) continue;
    const separator = row.subject_key.indexOf('|');
    const species = separator === -1 ? row.subject_key : row.subject_key.slice(0, separator);
    const regulationKey = separator === -1 ? 'all' : row.subject_key.slice(separator + 1);
    const bySpecies = (moveAdoptionBySpecies[species] ??= {});
    bySpecies[regulationKey] = Object.fromEntries(
      row.payload.options.map((option) => [option.value, option.ratio]),
    );
  }

  return jsonResponse(moveAdoptionBySpecies, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400',
  });
}

export const POST = () => methodNotAllowed(['GET']);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
