"""serebii.net の高解像度アイテム画像を面積基準で正規化して public/item-icons/ に生成する。

PokeAPI 原画は素朴なアイテムで 30x30 と低解像度であり、96px 出力に拡大するとぼやけることが
2026-08-12 の調査で判明した。そのため画像取得元は serebii.net に一本化している。160x160 の
``itemdex/sprites/za/`` と ``itemdex/sprites/sv/`` を優先し、両方にない旧世代アイテムのみ
40x40 の ``itemdex/sprites/`` をフォールバックとして使う。Serebii の一覧ページから構築した
ファイル名索引を使い、spritePath の末尾スラッグを実画像名へ解決する。

## 出力ファイル名
出力ファイル名は items.json の spritePath ではなく、アイテムの和名(items.json の name、例
"こだわりハチマキ")を使う。リポジトリ内のファイル名・参照コード(sprite-urls.ts の
itemIconUrl())を和名で統一することで、spritePath がないアイテムも
MANUAL_ENGLISH_SLUG の英語識別子から同じパイプラインで追加できる。

## 正規化設計の背景
この正規化方針の実測時、src/lib/sprite-urls.ts の itemImageUrl() が返す画像は
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
2. バウンディングボックスの幅・高さの幾何平均が出力キャンバスに対して
   TARGET_AREA_SIDE_FRACTION(0.8)を占めるよう、クロップする正方形の一辺
   `crop_side = sqrt(bbox幅 * bbox高さ) / TARGET_AREA_SIDE_FRACTION` を求める。
   ただし長辺がMAX_LONG_SIDE_FRACTION(0.94)を超えないようにして、細長い絵柄を
   キャンバス外へ切り落とさない。
3. バウンディングボックスの中心を基準に、一辺 crop_side の正方形をクロップする
   (Image.crop()の自動パディングにより、キャンバス外にはみ出しても透明で埋まる)。
4. クロップした正方形をOUTPUT_SIZE(96px)にLANCZOSで1回だけリサイズする(縮小・拡大を
   2回に分けない。type-icons生成スクリプトで「2回リサンプルするとボケる」ことが実測で
   判明した教訓を踏襲)。
   TARGET_AREA_SIDE_FRACTION=0.8とすることで、正方形に近い絵柄は従来どおり
   80%四方(面積64%)を占める。細長い絵柄は見た目の面積を補うために拡大するが、
   長辺は94%で止めて約3pxの安全余白を残す。
5. OUTPUT_SIZE=96は scripts/type-icons/generate_type_icons.py のOUTPUT_SIZE(96)と
   同じ値を踏襲した(新しい規格を作らない)。実際の画面上の表示サイズは16px(box一覧の
   狭幅時)〜36px(box一覧の.card-item-badge)なので、96pxは最大表示サイズの2.7倍以上を
   確保できている。

当時の 30x30 原画ではクロップ後の 96px への拡大でぼやけたため、現在はこの正規化ロジックを
維持したまま、Serebii の高解像度画像を入力に使う。これにより一回の LANCZOS リサイズという
方針は保ちつつ、入力解像度に起因する劣化を避ける。

## 使い方
    python scripts/item-icons/generate_item_icons.py

    public/master-data/autocomplete/items.json の(name, spritePath)一覧を読み、既知の
    spritePath欠損はMANUAL_ENGLISH_SLUGで補完して、全アイテムのアイコンを
    public/item-icons/{name}.png に生成する(サブディレクトリは持たない)。
    再実行可能(既存ファイルは上書き)。ネットワークアクセスが必要
    (serebii.net のカテゴリ一覧ページと画像を都度取得、ローカルキャッシュは持たない)。

## 依存
    Pillow (pip install Pillow)。scripts/type-icons/generate_type_icons.py と同様。
"""
from __future__ import annotations

import io
import json
import math
import re
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

SPRITES_BASE = "https://www.serebii.net/itemdex/sprites"

# 最終出力の一辺(px)。scripts/type-icons/generate_type_icons.py のOUTPUT_SIZEと同じ値を
# 踏襲する(新しい規格を作らない)。画面上の最大表示サイズ(.card-item-badge、36px)の
# 2.7倍弱を確保できる。
OUTPUT_SIZE = 96

# 前景(絵柄)判定のアルファしきい値。30x30系アイテムはalpha>=1で安定するが、
# gen8/gen9サブディレクトリの160x160系アイテムは輪郭に薄い半透明のハローがあり、
# alpha>=5以降でバウンディングボックスが安定することを実測で確認した。安全マージンを
# 取って8とする(冒頭docstring「実測」参照)。
ALPHA_MIN = 8

# 絵柄の面積を揃える基準。bboxの幾何平均を出力キャンバスの80%にそろえるので、
# 正方形に近い絵柄の占有面積は従来と同じ64%になる。
TARGET_AREA_SIDE_FRACTION = 0.8

# 面積基準だけでは横長・縦長の絵柄がキャンバス外へ出るため、長辺は94%までに制限する。
# 約3pxの余白を残せる値で、こだわりメガネ程度（約1.5:1）でも面積は正方形に近い絵柄へ
# 十分に近づく。一方で極端な細長い絵柄を無理に拡大して切り落とすことを防ぐ。
MAX_LONG_SIDE_FRACTION = 0.94

# LANCZOS拡大時に透明縁へ生じるごく薄いリンギングを除去するしきい値。元画像の検出
# しきい値より高くすることで、実体の輪郭ではない1〜15/255のアルファがbboxをキャンバス
# 端まで広げるのを防ぐ。
OUTPUT_ALPHA_MIN = 16

# serebii.net の itemdex カテゴリ一覧ページ。メガストーンはどのカテゴリページにも
# 一覧されないが、画像自体は itemdex/sprites/za/ 等に単独で存在するため、
# ハイフン除去した spritePath そのものを候補1として直接試すことでカバーする。
LIST_PAGES = [
    "pokeball",
    "recovery",
    "holditem",
    "evolutionary",
    "berry",
    "gsberry",
    "battleeffect",
    "vitamins",
    "fossil",
    "mail",
    "miscellaneous",
    "keyitem",
    "eventitem",
    "decorations",
]

# 160x160 の高解像度画像を持つバージョン別ディレクトリ。za を先に試すのは、
# メガストーン等 sv 側に存在しないアイテムを za が補完しているため。
# "" はバージョンなしの itemdex/sprites/ 直下（40x40、フォールバック用）を表す。
IMAGE_DIRS = ["za", "sv", ""]

# spritePath が null のアイテムのうち、英語識別子が判明しているものの手動対応表。
MANUAL_ENGLISH_SLUG: dict[str, str] = {
    "ウォーターメモリ": "water-memory",
    "ファイアーメモリ": "fire-memory",
    "こうてつのプレート": "iron-plate",
    "たまむしのプレート": "insect-plate",
    "もりのプレート": "meadow-plate",
    "アブソルナイトZ": "absolite",
    "ガブリアスナイトZ": "garchompite",
}

STEM_IMG_RE = re.compile(r"/itemdex/sprites/([a-zA-Z0-9\-]+)\.png")


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
    """絵柄の面積を基準に、中心基準で正方形にクロップしてから1回だけリサイズする。

    bboxの幅・高さの幾何平均を基準にすることで、細長い絵柄も正方形に近い絵柄と
    同程度の占有面積になる。ただし長辺をMAX_LONG_SIDE_FRACTION以下に保つため、
    極端なアスペクト比でも絵柄をクロップしない。
    """
    x0, y0, x1, y1 = detect_alpha_bbox(im)
    bbox_w = x1 - x0
    bbox_h = y1 - y0
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2

    area_based_side = math.sqrt(bbox_w * bbox_h) / TARGET_AREA_SIDE_FRACTION
    containment_side = max(bbox_w, bbox_h) / MAX_LONG_SIDE_FRACTION
    crop_side = max(area_based_side, containment_side)
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
    result = cropped.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
    alpha = result.getchannel("A")
    result.putalpha(alpha.point(lambda value: 0 if value < OUTPUT_ALPHA_MIN else value))
    return result


def fetch_url(url: str) -> bytes | None:
    req = urllib.request.Request(url, headers={"User-Agent": "poke-commons-item-icon-collector"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read()
    except urllib.error.URLError:
        return None


def build_stem_index() -> dict[str, str]:
    """一覧ページから「ハイフン除去キー→実ファイル名」の索引を作る。"""
    index: dict[str, str] = {}
    for page in LIST_PAGES:
        url = f"https://www.serebii.net/itemdex/list/{page}.shtml"
        data = fetch_url(url)
        if data is None:
            print(f"  [警告] 一覧ページの取得に失敗: {url}")
            continue
        html = data.decode("utf-8", errors="ignore")
        for stem in STEM_IMG_RE.findall(html):
            key = stem.replace("-", "").lower()
            index.setdefault(key, stem)
    return index


def resolve_image(spritePath_or_slug: str, stem_index: dict[str, str]) -> tuple[bytes, str] | None:
    """spritePath末尾セグメントまたは手動スラッグから実画像を解決する。"""
    base = spritePath_or_slug.split("/")[-1]
    stripped = base.replace("-", "").lower()

    candidates = [stripped]
    looked_up = stem_index.get(stripped)
    if looked_up and looked_up != stripped:
        candidates.append(looked_up)
    if base != stripped:
        candidates.append(base)

    for candidate in dict.fromkeys(candidates):
        for image_dir in IMAGE_DIRS:
            prefix = f"{image_dir}/" if image_dir else ""
            url = f"{SPRITES_BASE}/{prefix}{candidate}.png"
            data = fetch_url(url)
            if data is not None:
                return data, url
    return None


def load_targets() -> list[tuple[str, str]]:
    """(アイテム和名, spritePath末尾セグメント/手動スラッグ) の一覧を返す。"""
    data = json.loads(ITEMS_JSON.read_text(encoding="utf-8"))
    targets: list[tuple[str, str]] = []
    seen: set[str] = set()
    for entry in data:
        name = entry.get("name")
        if not name or name in seen:
            continue
        sprite_path = entry.get("spritePath") or MANUAL_ENGLISH_SLUG.get(name)
        if not sprite_path:
            continue
        seen.add(name)
        targets.append((name, sprite_path))
    return targets


def main() -> None:
    print("serebii.net のカテゴリ一覧ページを取得中...")
    stem_index = build_stem_index()
    print(f"  索引エントリ数: {len(stem_index)}")

    targets = load_targets()
    print(f"対象: {len(targets)} 件")

    total_bytes = 0
    failures: list[tuple[str, str]] = []
    for i, (name, sprite_path) in enumerate(targets, 1):
        resolved = resolve_image(sprite_path, stem_index)
        if resolved is None:
            failures.append((name, sprite_path))
            print(f"[{i}/{len(targets)}] {name} ({sprite_path}): FAILED - 画像が見つかりませんでした")
            continue
        image_bytes, source_url = resolved
        try:
            im = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
            result = build_normalized_icon(im)
            out_path = OUT_DIR / f"{name}.png"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            result.save(out_path)
        except Exception as exc:  # noqa: BLE001 - 1件失敗しても残りを続ける
            failures.append((name, sprite_path))
            print(f"[{i}/{len(targets)}] {name} ({sprite_path}): FAILED - {exc}")
            continue
        size = out_path.stat().st_size
        total_bytes += size
        rel = out_path.relative_to(REPO_ROOT)
        print(f"[{i}/{len(targets)}] {name} -> {rel} ({size}B, source: {source_url})")

    ok = len(targets) - len(failures)
    print(
        f"\n完了: {ok}/{len(targets)} 枚生成。合計サイズ: {total_bytes:,} バイト "
        f"({total_bytes / 1024:.1f} KiB)"
    )
    if failures:
        print(f"\n失敗 {len(failures)} 件:")
        for name, sprite_path in failures:
            print(f"  - {name} ({sprite_path})")


if __name__ == "__main__":
    main()
