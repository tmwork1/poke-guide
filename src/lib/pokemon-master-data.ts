// UI刷新: 個体編集ページ(box/[id].astro)でポケモン名からスプライト・タイプ・種族値を
// 引くためのブラウザ専用モジュール。autocomplete/pokemon.json(軽量、dexNo+imageId+types入り)と
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

// 画像取得(spriteUrl/officialArtworkUrl)専用のIDマップ。dexNoではなくimageIdを返す
// (メガシンカ等の特殊フォルムをベース種族の画像にしないため)。
export async function loadImageIdMap(): Promise<Map<string, number>> {
  const master = await loadMasterMap();
  return new Map([...master].map(([name, entry]) => [name, entry.imageId]));
}

export async function loadTypesMap(): Promise<Map<string, string[]>> {
  const master = await loadMasterMap();
  return new Map([...master].map(([name, entry]) => [name, entry.types]));
}

export function spriteUrl(imageId: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${imageId}.png`;
}

// Pokemon.png ワイヤーフレームの「ポケモンアイコン(公式絵)」用。
export function officialArtworkUrl(imageId: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${imageId}.png`;
}

interface PokemonDetailEntry {
  name: string;
  baseStats: number[];
  learnset: string[];
}

let baseStatsCache: Promise<Map<string, number[]>> | null = null;

export function loadBaseStatsMap(): Promise<Map<string, number[]>> {
  if (!baseStatsCache) {
    baseStatsCache = fetch("/master-data/detail/pokemon.json")
      .then((res) => res.json())
      .then((list: PokemonDetailEntry[]) => new Map(list.map((p) => [p.name, p.baseStats])))
      .catch((err) => {
        console.warn("種族値データの読み込みに失敗しました", err);
        baseStatsCache = null;
        return new Map<string, number[]>();
      });
  }
  return baseStatsCache;
}

let learnsetCache: Promise<Map<string, string[]>> | null = null;

// 種族名 -> 覚え技一覧(learnset)。box/[id].astro の技名オートコンプリート(#move-list)を
// その種族の覚え技優先で並べ替えるために使う(loadBaseStatsMapと同じdetail/pokemon.jsonを
// ソースにしているが、キャッシュ済みPromiseパターンをloadMultiHitMoveMap等と揃えるため
// あえて別関数・別キャッシュにしている)。
export function loadLearnsetMap(): Promise<Map<string, string[]>> {
  if (!learnsetCache) {
    learnsetCache = fetch("/master-data/detail/pokemon.json")
      .then((res) => res.json())
      .then((list: PokemonDetailEntry[]) => new Map(list.map((p) => [p.name, p.learnset])))
      .catch((err) => {
        console.warn("覚え技データの読み込みに失敗しました", err);
        learnsetCache = null;
        return new Map<string, string[]>();
      });
  }
  return learnsetCache;
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
