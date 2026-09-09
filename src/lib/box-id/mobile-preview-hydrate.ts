// データ系ページではSSR中にlocalStorageを読めないため、MobilePokemonPreview.astroが出力した
// 空のプレビューをクライアントで実データへ置き換える。
import type { OwnedPokemonRecord } from '../owned-pokemon';
import { getGuestPokemon } from '../data/guest-store';
import { isGuestMode } from '../data/guest-mode';
import { loadBaseStatsMap, loadPokemonMasterList } from '../pokemon-master-data';
import { applyPokemonPreview } from './preview-apply';
import { buildPokemonPreviewViewModel, type PreviewPokemonDetailEntry } from './preview-view-model';

/** Apply an owned Pokemon to the read-only mobile preview shared by data pages. */
export async function applyPokemonToMobilePreview(pokemon: OwnedPokemonRecord): Promise<void> {
  // 種族名・画像・タイプ・背景は軽量なautocompleteだけで先に反映する。
  // 実数値に必要なdetailは後から到着しても、表の固定幅によって配置を動かさない。
  const master = await loadPokemonMasterList();
  const species = master.find((entry) => entry.name === pokemon.species_name);
  applyPokemonPreview(buildPokemonPreviewViewModel(pokemon, { species }), { applyStats: false });

  const baseStatsByName = await loadBaseStatsMap();
  const baseStats = baseStatsByName.get(pokemon.species_name);
  applyPokemonPreview(buildPokemonPreviewViewModel(pokemon, {
    species,
    detail: baseStats ? { name: pokemon.species_name, baseStats } satisfies PreviewPokemonDetailEntry : undefined,
  }), { applyContent: false });
}

/** Read one guest record and apply it to the mobile preview. Returns null when it no longer exists. */
export async function hydrateGuestMobilePreview(id: string): Promise<OwnedPokemonRecord | null> {
  if (!isGuestMode() || !id) return null;
  const pokemon = getGuestPokemon(id);
  if (pokemon) await applyPokemonToMobilePreview(pokemon);
  return pokemon;
}
