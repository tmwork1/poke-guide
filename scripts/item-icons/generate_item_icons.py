"""PokeAPI のアイテム画像(各アイテムごとに独立したPNG。透明背景+中央に絵柄)から、
絵柄部分(透明ではないピクセル)のバウンディングボックスを実測し、それが出力キャンバスに
対して常に一定の比率を占めるよう拡大縮小・中央配置し直した画像を public/item-icons/ に
事前生成して置くスクリプト(scripts/type-icons/generate_type_icons.py のアイテム版)。

## 出力ファイル名(2026-08-12変更)
出力ファイル名は items.json の spritePath(PokeAPI固有のスラッグ、例 "choice-band" /
"gen9/booster-energy")ではなく、アイテムの和名(items.json の name、例
"こだわりハチマキ")を使う。spritePath はあくまで PokeAPI から画像を取得するための
ソースURL組み立てにのみ使い、リポジトリ内のファイル名・参照コード(sprite-urls.ts の
itemIconUrl())は和名で統一する。理由は、spritePath が存在しないアイテム(items.json で
spritePath: null、こんごうだま系の一部やチャンピオンズ限定アイテム等)にも将来
generate_item_icons_gamewith.py 等の別ソースから和名ベースでアイコンを追加できるように
するため(spritePath という PokeAPI 由来の識別子にファイル名を縛られない)。

## 背景
src/lib/sprite-urls.ts の itemImageUrl() が返す画像は
https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/{spritePath}.png
で、アイテムごとに完全に独立したPNG(透明背景、絵柄はほぼ中央寄せ)。タイプ画像(1本の
横長リボンから位置がずれた同じ絵柄を切り出す問題)とは違い、こちらは「絵柄自体の見かけの
大きさ(=キャンバス全体に対する不透明ピクセルの占有率)がアイテムごとにバラバラ」という
問題(2026-08-01 ユーザー報告「アイテムごとに(余白を除いた)アイコンサイズが異なり、
見た目の差に違和感を与える」)。画面側は全アイテムの画像を同じCSSサイズ(16〜36px、
object-fit: contain)で表示するため、絵柄がキャンバスに対して占める比率が低いアイテムほど
実際の見た目が小さく描画される。

## 実測(2026-08-01)
以下のURLからPillowで実際にfetchし、アルファ値が1以上のピクセルの外接矩形(バウンディング
ボックス)を求めた(スクリプトは本ファイルの履歴付近に残していないが、
scripts/item-icons/measure 相当の使い捨てコードで実行。再現手順は下記関数と同じロジック)。

    item                        canvas     bbox(alpha>=1)       bbox_w x_h  w比率  h比率  面積比
    kee-berry(きのみ)          30x30      (4,4,26,25)          22x21       0.733  0.700  0.513
    wiki-berry(きのみ)         30x30      (5,4,26,26)          21x22       0.700  0.733  0.513
    lansat-berry(きのみ)       30x30      (5,4,24,25)          19x21       0.633  0.700  0.443
    sky-plate(プレート)        30x30      (4,4,26,26)          22x22       0.733  0.733  0.538
    fist-plate(プレート)       30x30      (4,4,26,26)          22x22       0.733  0.733  0.538
    choice-band                30x30      (4,4,26,26)          22x22       0.733  0.733  0.538
    destiny-knot                30x30      (6,4,26,26)          20x22       0.667  0.733  0.489
    heat-rock                  30x30      (4,5,26,26)          22x21       0.733  0.700  0.513
    leftovers                  30x30      (8,5,21,25)          13x20       0.433  0.667  0.289
    float-stone                30x30      (7,8,23,21)          16x13       0.533  0.433  0.231
    big-nugget                 30x30      (6,6,24,24)          18x18       0.600  0.600  0.360
    black-glasses               30x30      (4,8,25,23)          21x15       0.700  0.500  0.350
    gengarite(メガストーン)    30x30      (8,8,22,22)          14x14       0.467  0.467  0.218
    latiasite(メガストーン)    30x30      (8,8,22,22)          14x14       0.467  0.467  0.218
    master-ball / poke-ball    30x30      (6,6,24,24)          18x18       0.600  0.600  0.360
    gen8/heavy-duty-boots      160x160    (16,22,147,142)      131x120     0.819  0.750  0.614
    gen9/loaded-dice           160x160    (17,25,145,140)      128x115     0.800  0.719  0.575
    gen9/covert-cloak          160x160    (28,13,126,151)      98x138      0.613  0.863  0.529
    gen9/punching-glove        160x160    (16,13,146,151)      130x138     0.813  0.863  0.701

判明したこと:
  1. **絵柄がキャンバスに占める面積比が、同じ30x30キャンバスの中だけでも0.218(メガ
     ストーン)〜0.538(プレート・こだわりハチマキ等)まで2.5倍近く開いている。** タイプ
     画像と違い、絵柄自体の「描かれた大きさ」がアイテムごとに違うため、単純な中央寄せ
     (クロップ+リセンター)では解決しない。絵柄そのものを拡大縮小して、キャンバスに
     対する占有率を揃える必要がある。
  2. **アイテムの原画キャンバスサイズが2種類混在している。** 素朴なアイテム(`choice-band`
     等)は30x30、`gen8/`・`gen9/`サブディレクトリのアイテム(フォルムアイテム類。
     `heavy-duty-boots`・`loaded-dice`・`covert-cloak`等)は160x160。後者は面積比が
     0.53〜0.70と前者(0.22〜0.54)より総じて高いため、この2群を混ぜて同じCSSサイズで
     並べるとサイズ差がさらに目立つ。
  3. **アルファしきい値は1では不十分。** 30x30群は alpha=1 のバウンディングボックスが
     alpha=200まで完全に安定しているが、160x160群(`heavy-duty-boots`等)は輪郭に薄い
     半透明のアンチエイリアス/影のハローがあり、alpha>=1 で計測すると本体より一回り
     大きい矩形を拾ってしまう(例: heavy-duty-boots は alpha>=1 で (8,16,156,152)、
     alpha>=5 で (16,22,147,142) に収束)。alpha=2〜3では一部アイテムでまだ数px
     ずれるが、alpha=5以降は4アイテム(heavy-duty-boots / loaded-dice / covert-cloak /
     punching-glove)全てで結果が安定した。安全マージンを取って ALPHA_MIN=8 を採用する。
  4. **PillowのImage.crop()はキャンバス範囲外の座標を指定すると自動的に透明(alpha=0)で
     パディングする**(RGBA画像で実測確認済み)。そのため「バウンディングボックス中心
     基準の正方形クロップ」がキャンバス端をはみ出す場合(160x160群など、絵柄が既に
     キャンバスの70〜90%を占めているケース)でも、クランプ処理を書かずにそのまま
     `im.crop(box)` すればよい。

## 採用した正規化方針
1. 各アイテム画像をalpha>=ALPHA_MIN(8)のピクセルでバウンディングボックス検出する。
2. バウンディングボックスの長辺(bbox_w, bbox_h の大きい方)が出力キャンバスに対して
   TARGET_FRACTION(0.8)を占めるよう、クロップする正方形の一辺
   `crop_side = bbox長辺 / TARGET_FRACTION` を求める。
3. バウンディングボックスの中心を基準に、一辺 crop_side の正方形をクロップする
   (Image.crop()の自動パディングにより、キャンバス外にはみ出しても透明で埋まる)。
4. クロップした正方形をOUTPUT_SIZE(96px)にLANCZOSで1回だけリサイズする(縮小・拡大を
   2回に分けない。type-icons生成スクリプトで「2回リサンプルするとボケる」ことが実測で
   判明した教訓を踏襲)。
   TARGET_FRACTION=0.8とすることで、絵柄の長辺は常にキャンバスの80%(=76.8px/96px)を
   占めるようになり、短辺側は元のアスペクト比のまま(絵柄の形は歪めない)。これにより
   「見た目の大きさ」(=長辺の占有率)が全アイテムで揃う。
   0.8という比率は、実測で最も余白が少なかったgen9/punching-glove(面積比0.701、
   長辺比0.863)より確実に小さく、かつ最も余白が多かったメガストーン群(長辺比0.467)
   を目立って拡大しすぎない中間値として選んだ(タイプアイコン生成スクリプトの
   MARK_SCALE=0.84などと同様、余白を残しつつアンチエイリアス縁が出力キャンバス端で
   欠けないよう10%ずつのマージンを両側に確保する設計)。
5. OUTPUT_SIZE=96は scripts/type-icons/generate_type_icons.py のOUTPUT_SIZE(96)と
   同じ値を踏襲した(新しい規格を作らない)。実際の画面上の表示サイズは16px(box一覧の
   狭幅時)〜36px(box一覧の.card-item-badge)なので、96pxは最大表示サイズの2.7倍以上を
   確保できている。

原画キャンバスサイズが30x30の場合、クロップ後(概ね26〜35px四方程度)から96pxへの
拡大が主なので多少ぼやけるが、これは正規化前から existing の itemImageUrl() でも起きて
いた劣化(30x30を16〜36pxのCSSボックスへブラウザが拡大表示していた)と同程度であり、
新たに悪化するものではない。160x160群はむしろ高精細のまま縮小されるため改善する。

## 使い方
    python scripts/item-icons/generate_item_icons.py

    public/master-data/autocomplete/items.json の(name, spritePath)一覧(spritePathが
    nullの項目は除外)を読み、全アイテムのアイコンを public/item-icons/{name}.png に
    生成する(サブディレクトリは持たない。取得元URLの gen8/gen9 はソース側のみ)。
    再実行可能(既存ファイルは上書き)。ネットワークアクセスが必要
    (raw.githubusercontent.com から都度取得、ローカルキャッシュは持たない)。

## 依存
    Pillow (pip install Pillow)。scripts/type-icons/generate_type_icons.py と同様。
"""
from __future__ import annotations

import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    print(
        "Pillow が見つかりません。`pip install Pillow` を実行してから再実行してください。",
        file=sys.stderr,
    )
    raise SystemExit(1) from exc


REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "public" / "item-icons"
ITEMS_JSON = REPO_ROOT / "public" / "master-data" / "autocomplete" / "items.json"

SPRITES_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items"

# 最終出力の一辺(px)。scripts/type-icons/generate_type_icons.py のOUTPUT_SIZEと同じ値を
# 踏襲する(新しい規格を作らない)。画面上の最大表示サイズ(.card-item-badge、36px)の
# 2.7倍弱を確保できる。
OUTPUT_SIZE = 96

# 前景(絵柄)判定のアルファしきい値。30x30系アイテムはalpha>=1で安定するが、
# gen8/gen9サブディレクトリの160x160系アイテムは輪郭に薄い半透明のハローがあり、
# alpha>=5以降でバウンディングボックスが安定することを実測で確認した。安全マージンを
# 取って8とする(冒頭docstring「実測」参照)。
ALPHA_MIN = 8

# バウンディングボックスの長辺が出力キャンバスに占める比率。0.8を採用した根拠は
# 冒頭docstring「採用した正規化方針」参照。
TARGET_FRACTION = 0.8


def fetch_image(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": "poke-commons-item-icon-generator"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
    except urllib.error.URLError as exc:
        raise RuntimeError(f"画像の取得に失敗しました: {url}\n{exc}") from exc
    return Image.open(io.BytesIO(data)).convert("RGBA")


def detect_alpha_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    """alpha>=ALPHA_MINのピクセルの外接矩形 [x0, y0, x1, y1) を返す(x1, y1は排他)。
    見つからない場合はRuntimeError。
    """
    alpha = im.split()[-1]
    bbox = alpha.point(lambda a: 255 if a >= ALPHA_MIN else 0).getbbox()
    if bbox is None:
        raise RuntimeError("不透明ピクセルが1つも見つかりませんでした。ALPHA_MINを見直してください。")
    return bbox


def build_normalized_icon(im: Image.Image) -> Image.Image:
    """絵柄のバウンディングボックスの長辺がOUTPUT_SIZEに対してTARGET_FRACTIONを
    占めるよう、中心基準で正方形にクロップしてから1回だけリサイズする。
    """
    x0, y0, x1, y1 = detect_alpha_bbox(im)
    bbox_w = x1 - x0
    bbox_h = y1 - y0
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2

    crop_side = max(bbox_w, bbox_h) / TARGET_FRACTION
    half = crop_side / 2
    # Image.crop()はキャンバス範囲外を自動的に透明パディングするため、クランプ不要
    # (冒頭docstring「実測」4.参照)。
    box = (
        round(cx - half),
        round(cy - half),
        round(cx + half),
        round(cy + half),
    )
    cropped = im.crop(box)
    return cropped.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)


def load_items() -> list[tuple[str, str]]:
    """(name, spritePath)の一覧を返す。spritePathがnullの項目は除外する。"""
    data = json.loads(ITEMS_JSON.read_text(encoding="utf-8"))
    items = []
    seen = set()
    for entry in data:
        name = entry.get("name")
        sprite_path = entry.get("spritePath")
        if not name or not sprite_path or name in seen:
            continue
        seen.add(name)
        items.append((name, sprite_path))
    return items


def generate_one(name: str, sprite_path: str) -> Path:
    url = f"{SPRITES_BASE}/{sprite_path}.png"
    im = fetch_image(url)
    result = build_normalized_icon(im)

    out_path = OUT_DIR / f"{name}.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(out_path)
    return out_path


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    items = load_items()

    total_bytes = 0
    failures: list[tuple[str, str]] = []
    print(f"出力先: {OUT_DIR}")
    print(f"対象: {len(items)} 件")
    for i, (name, sprite_path) in enumerate(items, 1):
        try:
            out_path = generate_one(name, sprite_path)
        except Exception as exc:  # noqa: BLE001 - 1件失敗しても残りを続ける
            failures.append((name, str(exc)))
            print(f"[{i}/{len(items)}] {name} ({sprite_path}): FAILED - {exc}")
            continue
        size = out_path.stat().st_size
        total_bytes += size
        rel = out_path.relative_to(REPO_ROOT)
        print(f"[{i}/{len(items)}] {name} ({sprite_path}) -> {rel} ({size}B)")

    ok = len(items) - len(failures)
    print(f"\n完了: {ok}/{len(items)} 枚生成。合計サイズ: {total_bytes:,} バイト ({total_bytes / 1024:.1f} KiB)")
    if failures:
        print(f"\n失敗 {len(failures)} 件:")
        for name, reason in failures:
            print(f"  - {name}: {reason}")


if __name__ == "__main__":
    main()
