// すばやさ早見表のSSR専用組み立て。KVと静的マスターをここだけで読み、ページには
// 描画に必要な行だけを渡す。speed-chart.tsは純粋関数のまま保つ。
import pokemonCoreRaw from '../../../public/master-data/detail/pokemon-core.json' with { type: 'json' };
import pokemonMasterRaw from '../../../public/master-data/autocomplete/pokemon.json' with { type: 'json' };
import speedLearnsetsRaw from '../../../public/master-data/detail/speed-modifier-learnset.json' with { type: 'json' };
import megaStonesRaw from '../../../public/master-data/autocomplete/mega-stones.json' with { type: 'json' };
import speedModifiersRaw from '../../../public/master-data/detail/speed-modifiers.json' with { type: 'json' };
import speedChartConfigRaw from '../../config/speed-chart.json' with { type: 'json' };
import { getOpggUsageList, getOpggUsageManifest, sortOpggSeasons, type OpggUsageSeason } from '../opgg-usage.ts';
import {
  buildOpggSpeedChartPopulation,
  buildSpeedChartRows,
  getEffectiveSpeedModifiers,
  type SpeedChartConfig,
  type SpeedModifiersData,
  type SpeedChartRow,
} from '../speed-chart.ts';

const config = speedChartConfigRaw as SpeedChartConfig;
const core = pokemonCoreRaw as Array<{ name: string; baseStats: number[]; abilities: string[] }>;
const pokemonIndex = pokemonMasterRaw as Array<{ name: string; dexNo: number; forme: string | null }>;
const learnsets = new Map(Object.entries(speedLearnsetsRaw as Record<string, string[]>));
const megaStones = megaStonesRaw as Array<{ species: string; item: string }>;

export interface SpeedChartSsrData {
  seasons: OpggUsageSeason[];
  selectedSeasonId: string | null;
  rows: SpeedChartRow[];
}

/** requestedSeasonが無効/未指定ならcurrentSeasonId(なければ表示順先頭)へ安全に戻す。 */
export async function loadSpeedChartSsr(
  kv: KVNamespace,
  requestedSeason: string | null | undefined,
  forceCurrent = false,
): Promise<SpeedChartSsrData> {
  const manifest = await getOpggUsageManifest(kv);
  const seasons = sortOpggSeasons(manifest);
  const currentId = manifest?.currentSeasonId;
  const selectedSeason = forceCurrent
    ? seasons.find((season) => season.id === currentId) ?? seasons[0]
    : seasons.find((season) => season.id === requestedSeason) ?? seasons.find((season) => season.id === currentId) ?? seasons[0];
  if (!selectedSeason) return { seasons, selectedSeasonId: null, rows: [] };

  const list = await getOpggUsageList(kv, selectedSeason);
  if (!list) return { seasons, selectedSeasonId: selectedSeason.id, rows: [] };
  const ranked = list.pokemon.map((entry, index) => ({
    name: entry.name,
    rank: entry.rank ?? index + 1,
    single: entry.single,
  }));
  const population = buildOpggSpeedChartPopulation(ranked, config.population.topN, core.map((entry) => ({ ...entry, learnset: [] })), pokemonIndex, megaStones, learnsets);
  const usageByName = new Map(ranked.map((entry) => [entry.name, entry.single]));
  return {
    seasons,
    selectedSeasonId: selectedSeason.id,
    rows: buildSpeedChartRows(population, getEffectiveSpeedModifiers(speedModifiersRaw as SpeedModifiersData, config), config.adoptionRate, usageByName, config.spreadConditions),
  };
}
