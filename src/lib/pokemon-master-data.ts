// 個体編集ページ(box/[id].astro)でポケモン名からスプライト・タイプ・種族値を引く
// ブラウザ専用モジュール。autocomplete/pokemon.json(軽量、dexNo+imageId+types入り)と
// detail/pokemon.json(重め、baseStats入り)の2つの静的JSONを name をキーに参照する。
//
// 画像取得には dexNo(本来の全国図鑑番号)ではなく imageId(PokeAPIの画像ID)を使う。
// メガシンカ/キョダイマックス等の特殊フォルムは、scripts/build-master-data/extract_autocomplete.py が
// vendor/jpoke の ja_to_id_map.json (sections.pokemon.by_ja_name) からフォルム専用の10000番台IDを
// 解決して imageId に入れているため、スプライトも各フォルム固有の画像になる(解決できなかった
// ごく一部のフォルムのみ imageId が dexNo にフォールバックし、通常フォルムの画像になる)。

export interface PokemonMasterEntry {
  name: string;
  dexNo: number;
  imageId: number;
  forme: string | null;
  types: string[];
}

let masterCache: Promise<Map<string, PokemonMasterEntry>> | null = null;

function loadMasterMap(): Promise<Map<string, PokemonMasterEntry>> {
  if (!masterCache) {
    masterCache = fetch("/master-data/autocomplete/pokemon.json")
      .then((res) => res.json())
      .then((list: PokemonMasterEntry[]) => new Map(list.map((p) => [p.name, p])))
      .catch((err) => {
        console.warn("ポケモン一覧の読み込みに失敗しました", err);
        masterCache = null;
        return new Map<string, PokemonMasterEntry>();
      });
  }
  return masterCache;
}

// マスターJSONの挿入順(図鑑番号順・同種族のフォルムは隣接)を保った種族一覧。
export function loadPokemonMasterList(): Promise<PokemonMasterEntry[]> {
  return loadMasterMap().then((m) => [...m.values()]);
}

// 画像取得(championSpriteUrl/officialArtworkUrl)専用のIDマップ。dexNoではなくimageIdを返す
// (メガシンカ等の特殊フォルムをベース種族の画像にしないため)。
export async function loadImageIdMap(): Promise<Map<string, number>> {
  const master = await loadMasterMap();
  return new Map([...master].map(([name, entry]) => [name, entry.imageId]));
}

export async function loadTypesMap(): Promise<Map<string, string[]>> {
  const master = await loadMasterMap();
  return new Map([...master].map(([name, entry]) => [name, entry.types]));
}

// Pokemon.png ワイヤーフレームの「ポケモンアイコン(公式絵)」用。
// ドット絵と同じく public/pokemon-artwork/ から同一オリジンで配信するが、こちらは原画をそのまま
// 置いていない。原画は475x475/平均145.8KBで1284件=178.6MBになり、gitにもデプロイにも載らない。
// 原画よりはるかに小さいため、Retina(2倍)を見込んだ320pxに縮小しWebP(q82)で保存している
// (生成: scripts/pokemon-artwork/generate_pokemon_artwork.py。約1/8の22.6MB)。
export function officialArtworkUrl(imageId: number): string {
  return `/pokemon-artwork/${imageId}.webp`;
}

// Pokémon Champions公式のメニュー用アイコン(bulbagarden archives の
// Category:Champions_menu_sprites)。public/pokemon-champion-sprites/ から同一オリジンで配信する
// (生成: scripts/pokemon-champion-sprites/generate_pokemon_champion_sprites.py)。
// bulbagarden側はChampionsに現在実装済みのポケモン/フォルムしか提供していないため、
// 存在しないimageIdがある(2026-08時点で1284件中316件のみ)。呼び出し側はこの画像が
// 取得できない場合、officialArtworkUrl() → 頭文字バッジの順にフォールバックすること
// (shared-core.tsのapplySprite・owned-pokemon-card.tsのapplyCardArtwork参照)。
export function championSpriteUrl(imageId: number): string {
  return `/pokemon-champion-sprites/${imageId}.png`;
}

// Champions スプライトの小表示用派生画像。320px PNG は大きいプレビューに残し、
// 一覧やレールでは転送量を抑えた96px WebPを優先する。
export function championSpriteIconUrl(imageId: number): string {
  return `/pokemon-champion-sprites/icon/${imageId}.webp`;
}

// 64〜128px表示(カード・プレビュー・相性グリッド等)用の派生画像。
// 320px PNG(平均74KB)に対して192px WebPは平均約10KBで、実機の表示解像度には十分。
export function championSpriteMediumUrl(imageId: number): string {
  return `/pokemon-champion-sprites/medium/${imageId}.webp`;
}

export interface PokemonCoreDetailEntry {
  name: string;
  types: string[];
  baseStats: number[];
  abilities: string[];
}

export interface PokemonDetailEntry extends PokemonCoreDetailEntry {
  learnset: string[];
}

// detail/pokemon.json は learnset が全体の約79%(1.6MB中)を占める。種族値・タイプ・特性しか
// 要らない画面の方が多いので、learnset を落とした detail/pokemon-core.json(約215KB、
// scripts/build-master-data/build.mjs が生成)を既定の取得先にする。
//
// どちらのファイルも「1回だけ fetch + JSON.parse して共有する」。以前は
// loadBaseStatsMap / loadLearnsetMap / loadAbilitiesMap が別々にfetchしており、
// HTTPキャッシュが効いても1.6MBのJSON.parseが用途の数だけ走っていた。
let coreDetailCache: Promise<PokemonCoreDetailEntry[]> | null = null;
let fullDetailCache: Promise<PokemonDetailEntry[]> | null = null;

export function loadCoreDetailList(): Promise<PokemonCoreDetailEntry[]> {
  if (!coreDetailCache) {
    coreDetailCache = fetch("/master-data/detail/pokemon-core.json")
      .then((res) => res.json() as Promise<PokemonCoreDetailEntry[]>)
      .catch((err) => {
        console.warn("種族データ(軽量版)の読み込みに失敗しました", err);
        coreDetailCache = null;
        return [] as PokemonCoreDetailEntry[];
      });
  }
  return coreDetailCache;
}

export function loadFullDetailList(): Promise<PokemonDetailEntry[]> {
  if (!fullDetailCache) {
    fullDetailCache = fetch("/master-data/detail/pokemon.json")
      .then((res) => res.json() as Promise<PokemonDetailEntry[]>)
      .catch((err) => {
        console.warn("種族データの読み込みに失敗しました", err);
        fullDetailCache = null;
        return [] as PokemonDetailEntry[];
      });
  }
  return fullDetailCache;
}

/** 種族名 -> 種族値・タイプ・特性。learnset を含まない軽量ファイルから引く。 */
export function loadPokemonCoreDetailMap(): Promise<Map<string, PokemonCoreDetailEntry>> {
  return loadCoreDetailList().then((list) => new Map(list.map((p) => [p.name, p])));
}

export function loadBaseStatsMap(): Promise<Map<string, number[]>> {
  return loadCoreDetailList().then((list) => new Map(list.map((p) => [p.name, p.baseStats])));
}

// 種族名 -> 覚え技一覧(learnset)。box/[id].astro の技名オートコンプリート(#move-list)を
// その種族の覚え技優先で並べ替えるために使う。learnset を使う唯一の用途なので、
// ここだけが重い detail/pokemon.json を読む。
export function loadLearnsetMap(): Promise<Map<string, string[]>> {
  return loadFullDetailList().then((list) => new Map(list.map((p) => [p.name, p.learnset])));
}

// 種族名 -> その種族が持ちうる特性名の配列。box/[id].astro 左パネルの特性selectを、
// 種族に属する特性だけに絞り込むために使う(21-L5)。
// 隠れ特性(夢特性)の区別データは存在しない。abilities は単なるフラット配列で、
// どれが隠れ特性かを示すキーは vendor/jpoke の生データ(ps-champ-ja/pokedex.json)の
// 時点で既に失われている。区別しようとしないこと。
export function loadAbilitiesMap(): Promise<Map<string, string[]>> {
  return loadCoreDetailList().then((list) => new Map(list.map((p) => [p.name, p.abilities])));
}

// autocomplete/moves.json の各レコードが持ちうる "hits" キー([最小ヒット数, 最大ヒット数])。
// 連続技(1ターンに複数回ヒットする技)にだけ付与される
// (scripts/build-master-data/extract_autocomplete.py の build_moves を参照)。
interface MoveAutocompleteEntry {
  name: string;
  hits?: [number, number];
  type: string | null;
}

let multiHitCache: Promise<Map<string, [number, number]>> | null = null;

// 技名 -> [最小ヒット数, 最大ヒット数]。連続技のみを含む(単発技はキーが存在しない)。
// ダメージ計算カードの「連続回数」入力を連続技の時だけ表示するために使う
// (単発技は常に1回ヒットなので入力欄自体が不要)。
export function loadMultiHitMoveMap(): Promise<Map<string, [number, number]>> {
  if (!multiHitCache) {
    multiHitCache = fetch("/master-data/autocomplete/moves.json")
      .then((res) => res.json())
      .then((list: MoveAutocompleteEntry[]) => {
        const entries: [string, [number, number]][] = [];
        for (const m of list) {
          if (m.hits) {
            entries.push([m.name, m.hits]);
          }
        }
        return new Map(entries);
      })
      .catch((err) => {
        console.warn("連続技データの読み込みに失敗しました", err);
        multiHitCache = null;
        return new Map<string, [number, number]>();
      });
  }
  return multiHitCache;
}

let moveTypeCache: Promise<Map<string, string>> | null = null;

// 技名 -> タイプ("わるあがき"のようにtypeがnullの技はキーが存在しない)。
// box/[id].astro の技入力欄(#move-1〜#move-4)をタイプ色に染めるために使う。
export function loadMoveTypeMap(): Promise<Map<string, string>> {
  if (!moveTypeCache) {
    moveTypeCache = fetch("/master-data/autocomplete/moves.json")
      .then((res) => res.json())
      .then((list: MoveAutocompleteEntry[]) => {
        const entries: [string, string][] = [];
        for (const m of list) {
          if (m.type) {
            entries.push([m.name, m.type]);
          }
        }
        return new Map(entries);
      })
      .catch((err) => {
        console.warn("技タイプデータの読み込みに失敗しました", err);
        moveTypeCache = null;
        return new Map<string, string>();
      });
  }
  return moveTypeCache;
}

export type MoveCategory = "physical" | "special" | "status";

export interface MoveDetail {
  name: string;
  type: string | null;
  category: MoveCategory;
  power: number | null;
  accuracy: number | null;
  pp: number;
}

let moveDetailCache: Promise<Map<string, MoveDetail>> | null = null;

// 技名 -> 詳細情報(タイプ/分類/威力/命中/PP)。全716件。
export function loadMoveDetailMap(): Promise<Map<string, MoveDetail>> {
  if (!moveDetailCache) {
    moveDetailCache = fetch("/master-data/detail/moves.json")
      .then((res) => res.json())
      .then((list: MoveDetail[]) => new Map(list.map((m) => [m.name, m])))
      .catch((err) => {
        console.warn("技詳細データの読み込みに失敗しました", err);
        moveDetailCache = null;
        return new Map<string, MoveDetail>();
      });
  }
  return moveDetailCache;
}

// autocomplete/mega-stones.json の各レコード
// (scripts/build-master-data/extract_autocomplete.py の build_mega_stones を参照)。
interface MegaStoneAutocompleteEntry {
  species: string;
  item: string;
}

let megaStoneCache: Promise<Map<string, string>> | null = null;

// メガ後種族名 -> メガストーン名(例: "メガリザードンX" -> "リザードナイトX")。
// 前向き(種族 -> アイテム)の対応表なので、jpoke.data.megaevol.
// MEGA_STONES(逆引き)では曖昧になって漏れる「メガニャオニクス(オス)/(メス)」も含む。
// 「ニャオニクスナイト」自体はjpokeのITEMS(=items.json)に存在しないという
// 既知の不整合がある(build_mega_stonesのdocstring参照)。呼び出し側は値をそのまま
// items.json の存在確認なしに信用しないこと。
// 命名規則("メガXXX"→"XXXナイト")では導出できない例が85件中32件(約38%)あるため、
// 必ずこの静的JSONを情報源にすること(命名規則から推測しない)。
export function loadMegaStoneMap(): Promise<Map<string, string>> {
  if (!megaStoneCache) {
    megaStoneCache = fetch("/master-data/autocomplete/mega-stones.json")
      .then((res) => res.json())
      .then((list: MegaStoneAutocompleteEntry[]) => new Map(list.map((m) => [m.species, m.item])))
      .catch((err) => {
        console.warn("メガストーンデータの読み込みに失敗しました", err);
        megaStoneCache = null;
        return new Map<string, string>();
      });
  }
  return megaStoneCache;
}
