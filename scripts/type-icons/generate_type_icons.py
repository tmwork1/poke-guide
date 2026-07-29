"""PokeAPI のタイプ画像(横長リボン: 左に丸いマーク+右に英字)から、
左側のマーク部分だけを正方形に切り出した画像を生成し、public/type-icons/ に置くスクリプト。

## 背景
src/lib/sprite-urls.ts の typeImageUrl() / teraTypeImageUrl() が返す画像は
https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/types/generation-ix/scarlet-violet/{id}.png
(テラスは .../Tera/{id}.png) で、"アイコン + 英字(例 FIRE)" の横長画像。
画面側でCSS(object-fit: cover; object-position: left center; border-radius: 50%)を使って
円形に切り出していたが、タイプごとにアイコンの位置・幅が違うため、フェアリー等でアイコンが
中央からずれて英字が混じって見える問題があった(2026-07-26 ユーザー報告)。

## 切り出し方針(実測に基づく)
19タイプ全てで画像は「アイコン(白色系の塗り) + 隙間 + 英字(白色系の塗り)」という
共通レイアウトだが、和了として実測すると:
  - アイコンの水平方向の中心はほぼ全タイプで画像内の x=30(通常タイプ, 画像高さ40の場合)
    ないし x=30(テラスタイプ, 画像高さ48の場合)に固定されている(テンプレート由来と推測)。
    ただしステラ等一部タイプはわずかにずれるため、全タイプ一律の固定座標にはせず、
    画像ごとに実際のピクセルを解析して中心を求める(要件どおり自動検出)。
  - アイコンと英字はいずれもほぼ純白(R,G,B が概ね245以上)で描画されている。
    背景色(タイプごとの色、テラスは虹色/グラデーション)は最大でも230程度までしか
    白に近づかないため、「まっしろに近い画素を含む列」を前景としてマークすれば
    アイコンと英字を検出でき、かつ背景色がグラデーションのタイプ(テラスのステラ・
    ノーマル等)でも誤検出しない(実測で確認済み)。
  - 列ごとに前景判定した結果を行方向にrun-length化し、最初に見つかる前景の並び
    (アイコン)を、アイコン内部の小さな隙間(例: くさタイプの葉が複数枚に
    分かれている等、数px程度)は同一クラスタとして許容してつなげつつ、
    アイコンと英字の間の隙間(実測で常に12px以上)に達したら打ち切ることで
    「アイコンだけ」の水平範囲を検出する。
  - 通常タイプ(角丸ピル)は、「画像の高さ」を一辺とする正方形を検出した中心に
    合わせて水平方向だけスライドさせて切り出す(縦方向は画像そのままの範囲=中央
    基準)。背景の縁(角丸ピル)はアイコン中心基準の正方形の内接円の中に収まる限り
    透明・欠けが生じないことを実測で確認済み(角の透明領域は表示側の
    border-radius: 50% でどのみち切り落とされる部分にしか出ない)。
  - テラスタイプ(宝石型のジグザグ縁)は上記の中心クロップ方式ではなく、
    stitch_tera_icon() で英字部分だけを削除して残りを繋ぎ合わせる方式にする
    (2026-07-29 ユーザー提案)。テラスタイプの縁は左端(3本トゲ)と右端がほぼ
    完全な鏡像であることを実測で確認済みのため、単純に中心で正方形に切り出すと
    右端の本物の尖った縁を取りこぼして非対称に見えてしまう。以前試した「切り出し後の
    正方形を合成(ミラーコピー/アルファのテーパー)で対称化する」案は、原画にない
    段差や非対称アイコンの絵柄破損を引き起こしたため不採用にした。詳細は
    stitch_tera_icon() のdocstring参照。

## 使い方
    python scripts/type-icons/generate_type_icons.py

    再実行可能(既存ファイルは上書き)。ネットワークアクセスが必要
    (raw.githubusercontent.com から都度取得する。ローカルキャッシュは持たない)。

## 依存
    Pillow (pip install Pillow)。このリポジトリの他スクリプト
    (scripts/build-master-data/extract_autocomplete.py)は依存ゼロの純Pythonだが、
    本スクリプトは画像処理のためPillowに依存する。
"""
from __future__ import annotations

import io
import sys
import urllib.error
import urllib.request
from collections import Counter
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
OUT_DIR = REPO_ROOT / "public" / "type-icons"
TERA_OUT_DIR = OUT_DIR / "tera"

SPRITES_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/types/generation-ix/scarlet-violet"

# 和名タイプ -> PokeAPI type ID (src/lib/sprite-urls.ts の TYPE_NAME_TO_ID と同じ内容。
# ファイル名にはIDのみ使うため、和名との対応はコメントとしてのみ保持する)。
TYPE_IDS_JA = {
    1: "ノーマル",
    2: "かくとう",
    3: "ひこう",
    4: "どく",
    5: "じめん",
    6: "いわ",
    7: "むし",
    8: "ゴースト",
    9: "はがね",
    10: "ほのお",
    11: "みず",
    12: "くさ",
    13: "でんき",
    14: "エスパー",
    15: "こおり",
    16: "ドラゴン",
    17: "あく",
    18: "フェアリー",
    19: "ステラ",
}

# 最終出力の一辺(px)。画面上の表示サイズ(14〜28px)の3倍以上を確保する。
OUTPUT_SIZE = 96

# 前景(アイコン・英字)判定のしきい値。背景色は最大でも230程度までしか白に近づかない
# 実測結果を踏まえ、余裕を持って245とする(テラスタイプのノーマル等、明るいグレー系の
# 背景を持つタイプで誤検出しないことを確認済み)。
WHITE_CHANNEL_MIN = 245
ALPHA_MIN = 100

# アイコン内部の小さな隙間(例: くさタイプの葉の間)を同一クラスタとして許容する上限。
# アイコン-英字間の隙間は実測で常に12px以上あり、これより明確に小さい値にしている。
GAP_MERGE_THRESHOLD = 6


def fetch_image(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": "poke-commons-type-icon-generator"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
    except urllib.error.URLError as exc:
        raise RuntimeError(f"画像の取得に失敗しました: {url}\n{exc}") from exc
    return Image.open(io.BytesIO(data)).convert("RGBA")


def _is_white_fg(pixel: tuple[int, int, int, int]) -> bool:
    r, g, b, a = pixel
    return a >= ALPHA_MIN and min(r, g, b) >= WHITE_CHANNEL_MIN


def detect_icon_x_range(im: Image.Image) -> tuple[int, int]:
    """左側マーク部分の水平ピクセル範囲 [x0, x1) を検出する。"""
    w, h = im.size
    px = im.load()
    fg_cols = [any(_is_white_fg(px[x, y]) for y in range(h)) for x in range(w)]

    i = 0
    while i < w and not fg_cols[i]:
        i += 1
    if i == w:
        raise RuntimeError("前景(白色系)ピクセルが1つも見つかりませんでした。しきい値を見直してください。")

    start = i
    end = i
    while i < w:
        if fg_cols[i]:
            end = i + 1
            i += 1
        else:
            gap_start = i
            while i < w and not fg_cols[i]:
                i += 1
            if (i - gap_start) >= GAP_MERGE_THRESHOLD:
                break
    return start, end


def crop_icon_square(im: Image.Image) -> Image.Image:
    """アイコン中心に合わせて「画像高さ×画像高さ」の正方形を切り出し、OUTPUT_SIZE にリサイズする。
    通常タイプ用(角丸ピル。両端に尖った縁がないため単純な中心クロップで問題ない)。
    """
    w, h = im.size
    x0, x1 = detect_icon_x_range(im)
    cx = (x0 + x1) / 2

    side = h
    crop_x0 = round(cx - side / 2)
    # 画像端をはみ出さないようにクランプ(実測ではほぼ発生しないが安全のため)。
    crop_x0 = max(0, min(crop_x0, w - side))
    box = (crop_x0, 0, crop_x0 + side, h)

    cropped = im.crop(box)
    return cropped.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS), box


def _column_alpha_span(im: Image.Image, x: int) -> tuple[int, int] | None:
    """列xで不透明(アルファ>ALPHA_MIN)なピクセルの (最小y, 最大y)。全透明なら None。"""
    h = im.size[1]
    px = im.load()
    ys = [y for y in range(h) if px[x, y][3] > ALPHA_MIN]
    return (ys[0], ys[-1]) if ys else None


def detect_frame_taper(im: Image.Image) -> tuple[tuple[int, int], int]:
    """テラスタイプのリボンの「胴体(プラトー)の上下位置」と「両端の尖った縁の幅」を返す。

    テラスのリボンは [左の尖った縁] + [上下が平らな胴体] + [右の尖った縁] という構造で、
    胴体は全幅200pxのうち170px以上を占める。そのため列ごとの不透明範囲 (min_y, max_y) の
    最頻値をとれば胴体の上下位置(プラトー)が確実に求まる。プラトーと完全一致する列の
    最初/最後の位置が、そのまま左右の尖った縁の幅になる。

    最頻値方式にしている理由(2026-07-29 実測):
      - 「アイコン開始位置の1つ左の列」を胴体の基準にする方式は、アイコンが他タイプより
        幅広く縁のすぐ隣から始まるステラ(x0=12)で基準列自体が縁の一部になり破綻する。
      - 「縦に隙間なく埋まっていて十分高い列」を縁の終わりとみなす方式は、縁が胴体より
        背が高く膨らんでいる区間(タイプ1なら x=8〜12 が上下46px、胴体は40px)を
        胴体と誤判定し、縁の幅を13pxではなく8pxと算出してしまう。この5px不足により
        右側の縁が膨らみの途中で断ち切られ、繋ぎ目で上下に段差が出ていた
        (=右上・右下に角が飛び出して見える不具合)。
    実測では全19タイプで左右の縁の幅が完全に一致する(通常18タイプは13px、ステラは12px)
    ため、両端は正確な鏡像であり、右端の実ピクセルをそのまま使えば左右対称になる。
    """
    w = im.size[0]
    spans = [_column_alpha_span(im, x) for x in range(w)]
    plateau = Counter(s for s in spans if s is not None).most_common(1)[0][0]
    left_width = next(x for x in range(w) if spans[x] == plateau)
    right_width = w - 1 - max(x for x in range(w) if spans[x] == plateau)
    # 実測では常に一致するが、万一ずれても縁を切り落とさないよう広い方を採る。
    return plateau, max(left_width, right_width)


def stitch_tera_icon(im: Image.Image, icon_x_range: tuple[int, int]) -> Image.Image:
    """テラスタイプ用: 英字部分だけを削除し、アイコンを挟む左右の残り(左端の本物の
    尖った縁 + アイコン + 右端の本物の尖った縁)をそのまま繋ぎ合わせる。

    2026-07-29 ユーザー提案: 「元画像から英語タイプ表記の部分だけ削除して、残りを
    つなぎ合わせるだけで所望の画像になるはず」。実測(2026-07-29)で確認したところ、
    テラスタイプの横長リボン画像は左端の尖った縁(3本トゲ)と右端の尖った縁が
    ほぼ完全な鏡像になっている(縦の不透明範囲を1px単位で比較して確認済み)。
    そのため合成(ミラーコピーやアルファのテーパー)は一切不要で、右端の本物の
    ピクセルをそのまま使えば自然に左右対称になる。
    以前試した「アイコン中心基準で正方形に切り出す」「その正方形の縁を合成で
    対称化する」という3案(mirror_symmetrize_frame/taper_symmetrize_corners、
    いずれもこの関数に置き換える形で不採用にした)は、右端が縁の途中でカットされる
    問題や、合成による段差・非対称アイコンの破損を引き起こしていた。

    手順:
      1. detect_frame_taper() で尖った縁の幅(tw)を求める。
      2. 英字を切り捨てる位置 cut = x0 + x1 - tw を求める。こうすると出力幅が
         (cut + tw) = (x0 + x1) となり、その中心 (x0 + x1) / 2 がアイコンの中心と
         一致する ⇒ アイコンの左右に残る地の余白が必ず等しくなる。
      3. 元画像の [0, cut) (真の左端の縁+アイコン+右余白) と [w-tw, w) (真の右端の
         縁そのもの)を横に繋ぎ合わせる。英字と、英字と縁の間の余分な地の部分は
         丸ごと削除される。
    繋ぎ目は「胴体の最後の列」と「右の縁が広がり始める最初の列」が隣り合うだけなので、
    左端で胴体から縁へ移るときと同じ並びになり、原画にない段差は生じない。
    結果は (x0 + x1) x 元画像高さ の横長になる。呼び出し側で正方形へ整形する。
    """
    w, h = im.size
    x0, x1 = icon_x_range
    _plateau, taper_width = detect_frame_taper(im)
    cut = x0 + x1 - taper_width

    left_piece = im.crop((0, 0, cut, h))
    right_piece = im.crop((w - taper_width, 0, w, h))

    assembled = Image.new("RGBA", (cut + taper_width, h), (0, 0, 0, 0))
    assembled.paste(left_piece, (0, 0))
    assembled.paste(right_piece, (cut, 0))
    return assembled


def pad_to_square(im: Image.Image) -> Image.Image:
    """縦横比が横長の画像を、透明ピクセルで上下に足して正方形にする(内容は縮小しない)。"""
    w, h = im.size
    side = max(w, h)
    result = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    result.paste(im, ((side - w) // 2, (side - h) // 2))
    return result


def generate_one(type_id: int, *, tera: bool) -> tuple[Path, tuple[int, int, int, int]]:
    url = f"{SPRITES_BASE}/Tera/{type_id}.png" if tera else f"{SPRITES_BASE}/{type_id}.png"
    im = fetch_image(url)
    if tera:
        icon_x_range = detect_icon_x_range(im)
        stitched = stitch_tera_icon(im, icon_x_range)
        box = (0, 0, stitched.width, stitched.height)
        result = pad_to_square(stitched).resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
    else:
        result, box = crop_icon_square(im)

    out_dir = TERA_OUT_DIR if tera else OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{type_id}.png"
    result.save(out_path)
    return out_path, box


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    TERA_OUT_DIR.mkdir(parents=True, exist_ok=True)

    total_bytes = 0
    print(f"出力先: {OUT_DIR}")
    print(f"{'type':>4} {'ja':<8} {'kind':<6} {'crop-box':<20} {'file':<40} size")
    for type_id, ja in TYPE_IDS_JA.items():
        for tera in (False, True):
            out_path, box = generate_one(type_id, tera=tera)
            size = out_path.stat().st_size
            total_bytes += size
            kind = "tera" if tera else "normal"
            rel = out_path.relative_to(REPO_ROOT)
            print(f"{type_id:>4} {ja:<8} {kind:<6} {str(box):<20} {str(rel):<40} {size}B")

    print(f"\n完了: {len(TYPE_IDS_JA) * 2} 枚生成。合計サイズ: {total_bytes:,} バイト ({total_bytes / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
