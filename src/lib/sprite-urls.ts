// アイテム画像・タイプ画像・テラスタイプ画像のURLを組み立てるブラウザ専用モジュール。
// URLの組み立て規則は vendor/jpoke/src/jpoke/utils/pokeapi.py (get_item_image_url /
// get_type_image_url / get_tera_type_image_url) を参照実装とし、同じ流儀に揃えている
// (画像は https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/... を
// 実行時に参照する方式。pokemon-master-data.ts の officialArtworkUrl と同様)。

const SPRITES_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites";

// タイプ画像は世代・作品ごとにディレクトリが分かれており、Gen9(スカーレット・バイオレット)配下に
// 通常タイプバッジ(*.png)とテラスタルタイプアイコン(Tera/*.png)が両方存在する
// (pokeapi.py の TYPE_SPRITES_DIR と同じ)。
const TYPE_SPRITES_DIR = "types/generation-ix/scarlet-violet";

// 和名タイプ -> PokeAPI type ID。19種類のみのため、専用のJSONは持たずコード内に直接持たせる
// (pokeapi.py の TYPE_NAME_TO_ID から正確に転記)。
const TYPE_NAME_TO_ID: Record<string, number> = {
  ノーマル: 1,
  かくとう: 2,
  ひこう: 3,
  どく: 4,
  じめん: 5,
  いわ: 6,
  むし: 7,
  ゴースト: 8,
  はがね: 9,
  ほのお: 10,
  みず: 11,
  くさ: 12,
  でんき: 13,
  エスパー: 14,
  こおり: 15,
  ドラゴン: 16,
  あく: 17,
  フェアリー: 18,
  ステラ: 19,
};

interface ItemAutocompleteEntry {
  name: string;
  spritePath: string | null;
}

let itemSpriteMapCache: Promise<Map<string, string>> | null = null;

// アイテム和名 -> sprite相対パス(例 "choice-band" / "gen9/booster-energy")のマップをロードする。
// public/master-data/autocomplete/items.json 由来
// (scripts/build-master-data/extract_autocomplete.py の build_items が生成する spritePath)。
// spritePath が解決できなかったアイテムはマップに含めない。
export async function loadItemSpriteMap(): Promise<Map<string, string>> {
  if (!itemSpriteMapCache) {
    itemSpriteMapCache = fetch("/master-data/autocomplete/items.json")
      .then((res) => res.json())
      .then((list: ItemAutocompleteEntry[]) => {
        const entries: [string, string][] = [];
        for (const item of list) {
          if (item.spritePath) {
            entries.push([item.name, item.spritePath]);
          }
        }
        return new Map(entries);
      })
      .catch((err) => {
        console.warn("アイテム画像パス一覧の読み込みに失敗しました", err);
        itemSpriteMapCache = null;
        return new Map<string, string>();
      });
  }
  return itemSpriteMapCache;
}

// sprite相対パス(例 "choice-band" / "gen9/booster-energy")からアイテム画像URLを返す。
export function itemImageUrl(spritePath: string): string {
  return `${SPRITES_BASE}/items/${spritePath}.png`;
}

// itemImageUrl()が返すPokeAPIのアイテム画像は、アイテムごとに絵柄がキャンバスに占める
// 面積比がバラバラ(実測でメガストーン0.22〜こだわりハチマキ等0.54、かつアイテムに
// よってキャンバス自体が30x30/160x160の2種類混在)なため、画面上で同じCSSサイズ
// (object-fit: contain)に並べると見た目の大きさが揃わない。加えて30x30原画のアイテムは
// 96pxへの拡大でぼやける問題もある。
// scripts/item-icons/generate_item_icons.py が、絵柄の不透明ピクセルの外接矩形を検出し、
// それが出力キャンバスに対して常に同じ比率を占めるよう拡大縮小・中央配置し直した画像を
// public/item-icons/ 配下にビルド時ではなく事前生成し、リポジトリにコミットしている
// (type-icons/typeIconUrl()と同じ「生成済み画像を事前コミットする」方式)。ぼやけの解消策
// として、取得元を高解像度な別ソース(serebii.net)へ一本化している。
// 以下はその生成済み画像のURL(ルート相対パス)を返す。

// アイテム和名(items.json の name。例 "こだわりハチマキ")から、見た目の大きさを
// 正規化したアイテムアイコン画像のURLを返す。画像本体は
// public/item-icons/{アイテム和名}.png (生成: scripts/item-icons/generate_item_icons.py)。
// ファイル名は和名で統一しており、items.json の
// spritePath(PokeAPI固有のスラッグ)には依存しない(spritePathが存在しないアイテムにも
// 別ソースからアイコンを追加できるようにするため)。ファイルが存在しない場合の判定は
// 呼び出し側の<img>のonerrorに委ねる(事前のexistsチェックは行わない)。
export function itemIconUrl(itemName: string): string {
  return `/item-icons/${encodeURIComponent(itemName)}.png`;
}

// 和名タイプ名から通常タイプバッジ画像URLを返す。未知の型名なら null。
export function typeImageUrl(typeNameJa: string): string | null {
  const typeId = TYPE_NAME_TO_ID[typeNameJa];
  if (typeId === undefined) return null;
  return `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/${typeId}.png`;
}

// 和名タイプ名からテラスタルタイプアイコン画像URLを返す。未知の型名なら null。
export function teraTypeImageUrl(typeNameJa: string): string | null {
  const typeId = TYPE_NAME_TO_ID[typeNameJa];
  if (typeId === undefined) return null;
  return `${SPRITES_BASE}/${TYPE_SPRITES_DIR}/Tera/${typeId}.png`;
}

// typeImageUrl / teraTypeImageUrl が返すPokeAPIの横長リボン画像(左に丸いマーク、右に
// "FIRE" 等の英字)は、CSSの object-fit: cover; object-position: left center だけでは
// タイプごとにマークの位置・幅が違うために円形トリミングがずれ、フェアリー等でマークが
// 中央からずれて英字が混じって見える問題があった(2026-07-26 実測)。
// scripts/type-icons/generate_type_icons.py が、マーク部分だけを画像内容から自動検出して
// 正方形に切り出した画像を public/type-icons/ 配下にビルド時ではなく事前生成し、
// リポジトリにコミットしている(public/master-data/ と同様、生成物をコミットする方式)。
// 以下の2関数はその生成済み画像のURL(ルート相対パス)を返す。

// 和名タイプ名から、マーク部分だけを丸く切り出した通常タイプアイコン画像のURLを返す。
// 未知の型名なら null。画像本体は public/type-icons/{typeId}.png
// (生成: scripts/type-icons/generate_type_icons.py)。
export function typeIconUrl(typeNameJa: string): string | null {
  const typeId = TYPE_NAME_TO_ID[typeNameJa];
  if (typeId === undefined) return null;
  return `/type-icons/${typeId}.png`;
}

// 和名タイプ名から、マーク部分だけを丸く切り出したテラスタルタイプアイコン画像のURLを返す。
// 未知の型名なら null。画像本体は public/type-icons/tera/{typeId}.png
// (生成: scripts/type-icons/generate_type_icons.py)。
export function teraTypeIconUrl(typeNameJa: string): string | null {
  const typeId = TYPE_NAME_TO_ID[typeNameJa];
  if (typeId === undefined) return null;
  return `/type-icons/tera/${typeId}.png`;
}
