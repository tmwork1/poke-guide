// アイテム画像・タイプ画像・テラスタイプ画像のローカルURLを組み立てるブラウザ専用モジュール。
// 画像は poke-sprites を一次ソースとして同期済みであり、実行時に外部画像を参照しない。
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

// アイテム原画は余白・解像度がまちまちで、同じCSSサイズでは見た目の大きさが揃わない。
// poke-sprites 側で不透明ピクセルの外接矩形を基準に正規化したWebPを生成し、ここでは
// 同期済みファイルのルート相対URLだけを返す。

// アイテム和名(items.json の name。例 "こだわりハチマキ")から、見た目の大きさを
// 正規化したアイテムアイコン画像のURLを返す。画像本体は
// public/item-icons/{アイテム和名}.webp（poke-sprites から同期）。
// ファイル名は和名で統一しており、items.json の
// spritePath(PokeAPI固有のスラッグ)には依存しない(spritePathが存在しないアイテムにも
// 別ソースからアイコンを追加できるようにするため)。ファイルが存在しない場合の判定は
// 呼び出し側の<img>のonerrorに委ねる(事前のexistsチェックは行わない)。
export function itemIconUrl(itemName: string): string {
  return `/item-icons/${encodeURIComponent(itemName)}.webp`;
}

// メガストーンは今後も新種族の実装が続き、専用画像の生成
// （poke-sprites 側の画像追加と同期が必要）が追いつかないことがある。
// ユーザー指示により、専用画像が無いメガストーンは他のメガストーンの画像で代用する。
// 個別のアイテム名を列挙すると新規メガストーン追加のたびに追記が必要になるため、
// 「読み込みに失敗した画像が /item-icons/ 配下かつ名前がメガストーンの命名規則
// (〜ナイト/〜ナイトZ)に一致する」ことをランタイムに判定する汎用フォールバックにする
// (setupItemIconFallback。AppLayout.astro から1回だけ呼ぶ)。
const MEGA_STONE_NAME_SUFFIXES = ["ナイトZ", "ナイト"];
const MEGA_STONE_ICON_FALLBACK_NAME = "アブソルナイト";
const ITEM_ICON_PATH_RE = /\/item-icons\/([^/]+)\.webp$/;

function isMegaStoneItemName(itemName: string): boolean {
  return MEGA_STONE_NAME_SUFFIXES.some((suffix) => itemName.endsWith(suffix));
}

/** Set an item icon and retry once with the shared Mega Stone icon on failure. */
export function applyItemIconWithFallback(
  img: HTMLImageElement,
  itemName: string,
  onFinalError?: () => void,
): void {
  const name = itemName.trim();
  let usedFallback = false;
  img.onerror = () => {
    if (!usedFallback && isMegaStoneItemName(name) && name !== MEGA_STONE_ICON_FALLBACK_NAME) {
      usedFallback = true;
      img.src = itemIconUrl(MEGA_STONE_ICON_FALLBACK_NAME);
      return;
    }
    img.onerror = null;
    onFinalError?.();
  };
  img.src = itemIconUrl(name);
}

// SSR で描画されたアイテム画像(個別の onerror を持たない <img>)が最終的に読み込めなかった
// ときの後始末。以前は各テンプレートの inline onerror が担っていたが、メガストーンの
// フォールバック差し替え後にも inline onerror が走って代替画像まで隠してしまうため、
// 失敗時の非表示処理もここに集約する。
function hideFailedSsrItemIcon(img: HTMLImageElement): void {
  // バトルデータカードのアイテム行: アイコン列を落として2列レイアウトに切り替える
  // (battle-data-card-html.ts の trend-rank-row--icon3 / --text2)。
  const trendRow = img.closest<HTMLElement>(".trend-rank-row");
  if (trendRow) {
    trendRow.classList.replace("trend-rank-row--icon3", "trend-rank-row--text2");
    img.parentElement?.remove();
    return;
  }
  img.hidden = true;
  // class 側で display を持つ画像(プレビューのもちもの画像など)は hidden だけでは消えない。
  img.style.setProperty("display", "none");
  const badge = img.closest<HTMLElement>(".item-image-badge");
  if (badge) badge.hidden = true;
}

export function setupItemIconFallback(): void {
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      // applyItemIconWithFallback() で個別の onerror を持つ画像はそちらに任せる。
      if (!(img instanceof HTMLImageElement) || img.onerror) return;
      const match = img.src.match(ITEM_ICON_PATH_RE);
      if (!match) return;
      const itemName = decodeURIComponent(match[1]);
      if (!img.dataset.megaStoneIconFallback && itemName !== MEGA_STONE_ICON_FALLBACK_NAME && isMegaStoneItemName(itemName)) {
        img.dataset.megaStoneIconFallback = "true";
        img.src = itemIconUrl(MEGA_STONE_ICON_FALLBACK_NAME);
        return;
      }
      hideFailedSsrItemIcon(img);
    },
    true,
  );
}

// タイプの横長リボン原画はマーク位置・幅が型ごとに異なり、CSSだけでは円形トリミングがずれる。
// poke-sprites 側でマーク部分を正方形に切り出したWebPを生成し、以下は同期済み画像のURLを返す。

// 和名タイプ名から、マーク部分だけを丸く切り出した通常タイプアイコン画像のURLを返す。
// 未知の型名なら null。画像本体は public/type-icons/{typeId}.webp（poke-sprites から同期）。
export function typeIconUrl(typeNameJa: string): string | null {
  const typeId = TYPE_NAME_TO_ID[typeNameJa];
  if (typeId === undefined) return null;
  return `/type-icons/${typeId}.webp`;
}

// 和名タイプ名から、マーク部分だけを丸く切り出したテラスタルタイプアイコン画像のURLを返す。
// 未知の型名なら null。画像本体は public/type-icons/tera/{typeId}.webp（poke-sprites から同期）。
export function teraTypeIconUrl(typeNameJa: string): string | null {
  const typeId = TYPE_NAME_TO_ID[typeNameJa];
  if (typeId === undefined) return null;
  return `/type-icons/tera/${typeId}.webp`;
}

/** 同期済みのテラスタル発動ボタン画像。 */
export function genericTeraIconUrl(): string {
  return '/ui-icons/テラスタル.webp';
}
