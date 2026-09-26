// species_name(owned_pokemon.species_name)→dexNo(全国図鑑番号)の逆引きモジュール。
//
// なぜ必要か(docs/plan/pages/team.md 設計レビュー R-1): チーム編成ルール G-2(同種族の重複禁止)を
// species_name で判定すると、1つの dexNo に複数の name が対応する組(ロトム6種・オーガポン8種・
// メガシンカ各種など public/master-data/autocomplete/pokemon.json 全1290件中205件)が素通りする。
// そのため G-2 の判定キーは dexNo にする必要があり、その解決をこのモジュールが担う。
//
// src/pages/api/search.ts:22 と同じ方式(ビルド時にVite/Astroのjsonローダで静的importする)を
// そのまま踏襲する。この方式はサーバー側(Cloudflare Workers上のSSR)でも動く実績がある
// (search.ts が同じ import を既に本番で使っている)。
//
// 重要: このモジュールは src/lib/team-validation.ts から import させない(R-6)。
// 検証層は「JSON importにもDBにも依存しない純粋関数」のままにする必要があり、dexNoの解決は
// 呼び出し元(APIルート・ページ)の責任にする。
import pokemonList from '../../public/master-data/autocomplete/pokemon.json';

interface PokemonDexEntry {
  name: string;
  dexNo: number;
  imageId: number;
  forme: string | null;
  types: string[];
}

// pokemon.json 内の name は重複が無いこと(=1 name → 1 dexNo)を実データで確認済み
// (R-1 調査。重複が0件なのは name→dexNo 方向であり、その逆(dexNo→複数name)は205件ある)。
const NAME_TO_DEX_NO: ReadonlyMap<string, number> = new Map(
  (pokemonList as PokemonDexEntry[]).map((entry) => [entry.name, entry.dexNo]),
);

// 解決できない場合(空文字・マスターデータに無い名前)は null を返す(R-15)。
// null は「G-2の判定対象外」として扱われることが呼び出し元(team-validation.ts の
// validateTeamComposition / selectionBlockReason)の契約になっている。
export function resolveDexNo(speciesName: string | null | undefined): number | null {
  if (!speciesName) return null;
  const trimmed = speciesName.trim();
  if (trimmed === '') return null;
  return NAME_TO_DEX_NO.get(trimmed) ?? null;
}
