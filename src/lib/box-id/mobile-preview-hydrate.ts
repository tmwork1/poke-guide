// データ系ページではSSR中にlocalStorageを読めないため、MobilePokemonPreview.astroが出力した
// 空のプレビューをクライアントで実データへ置き換える。
import type { OwnedPokemonRecord } from '../owned-pokemon';
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
