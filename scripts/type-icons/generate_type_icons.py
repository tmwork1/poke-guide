"""PokeAPI のタイプ画像(横長リボン: 左に丸いマーク+右に英字)から、
左側のマーク部分だけを切り出し、通常タイプは円形アルファマスクを適用した
画像ファイル自体が円形のPNG(四隅が透明)を生成し、public/type-icons/ に置く
スクリプト(テラスタイプは従来どおり横長リボンを繋ぎ合わせた正方形のまま)。

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
    基準)。
    🔴 2026-07-30 ユーザー報告「一部タイプでタイプアイコンの模様(マーク)が見切れる」
    を受けて実測し直したところ、上記の前提(「アイコン中心基準の正方形の内接円の
    中に収まる限り欠けが生じない」)は誤りだったと判明した。alpha>0の外接範囲は
    19タイプ全部で正方形の角まで達しており(背景の角丸ピルが正方形の隅を透明
    ではなく塗りつぶしていることが多いため)、そもそも「不透明ピクセル=マーク」
    という判定は使えない。実際に見るべきは「白色系のマーク自体」の外接範囲で、
    これをWHITE_CHANNEL_MIN(245)相当のしきい値で測ると、19タイプ中
    ひこう・くさ・フェアリーの3タイプで内接円(半径48px、96x96キャンバス)から
    はみ出す量が-1.3px〜+0.1px(ほぼゼロ、しきい値や丸め誤差次第でどちらにも
    転びうる)という「実質マージンほぼゼロ」の状態だったことを確認した
    (実測スクリプトはround-42.md 42-T1のコメント参照)。マージンがほぼゼロだと、
    ブラウザ側のリサイズ・アンチエイリアシングの実装差でどちら側に転ぶかが
    変わるため、「一部タイプで見切れる」というユーザー報告と矛盾しない。
    対策として、背景(角丸ピルの塗り)はそのまま維持しつつ、マーク(白色系の
    絵柄)だけを検出・分離し、中心基準で少し縮小してから再合成する方式にした
    (build_mark_shrunk_icon()参照)。背景を一切いじらないため、「マークだけを
    縮小した」ことによる余分な透明の縁(ハロー)が生じない
    (背景全体を縮小してから透明パディングで埋め戻す案も試したが、LANCZOS
    リサイズによる縁の半透明化が薄い縁取り状のハローとして視認でき、
    見た目の劣化が大きかったため不採用にした)。
    🔴 2026-07-30 追加報告「中央の模様がかすんでしまっている」。実測で原因を2つ特定した。
    (1) リサンプルが2回かかっていた: マーク縮小を元解像度(40x40)で行ってから
        OUTPUT_SIZE(96)へ拡大していたため、40 -> 34 -> 96 と2回リサンプルされ、
        1回目の縮小で捨てた細部が2回目の拡大で戻らずボケていた。マークの縮小は
        「元解像度 -> round(OUTPUT_SIZE * MARK_SCALE)」の1回のリサンプルで済むので、
        build_mark_shrunk_icon() が出力解像度まで面倒を見る形に変えた。
    (2) 元位置にマークの残像(ゴースト)が残っていた: _row_fill_background() が
        「マークらしき画素(ROUGH_WHITE_MIN=190)」だけを埋めていたため、その1px外側に
        ある「背景よりは明るいがしきい値には届かないアンチエイリアス縁」(実測で
        min(r,g,b)が185程度)が背景として温存され、縮小したマークの外側に薄い輪郭が
        そのまま残っていた。これがマークの周りの霞(にじみ)として見えていた。
        MARK_MASK_DILATE で mask を1px膨張させてから埋めることで解消した。
    さらに mark_canvas.paste(mark_small, offset, mark_small) が「透明キャンバスへ自分自身を
    マスクにしてpaste」していたため、出力alphaが a*a と二乗されアンチエイリアス縁が
    実測で1割ほど薄くなっていた(型1で総alphaが72876 -> 65204)。paste先が完全に透明な
    キャンバスなのでマスクは不要であり、マスクなしのpasteに変えて二乗化をなくした。

    🔴 2026-07-30 追加報告: 上記の対応(マーク縮小)だけでは、保存される
    public/type-icons/N.png 自体は依然として正方形(角まで角丸ピルの塗りが
    残る)のままで、表示側のCSS `border-radius: 50%` に円形化を依存していた。
    ユーザーの要求は「画像ファイル自体が円形であること」だったため、
    apply_circular_mask() で出力直前に円形アルファマスクを掛け、ファイルの
    四隅を完全透明にするようにした。円の内側(色・マークの位置)は一切変更
    しない。表示側は従来どおり border-radius: 50% を適用したままだが、
    同じ円を二重に描くだけなので見た目上の副作用はない。
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
    from PIL import Image, ImageChops, ImageDraw
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

# --- 通常タイプ用: マーク(白色系の絵柄)だけを縮小して見切れを防ぐための定数 ---
#
# WHITE_CHANNEL_MIN(245)は「マークかどうか」を厳密に判定するには適切だが、
# アンチエイリアスされた縁のピクセル(例: 240程度)を取りこぼす。取りこぼした
# ピクセルは後述のrow_fill_background()で「背景」として扱われてしまい、
# 縮小されずに元の位置に残ってしまう(実測: どくタイプでこの不具合により
# 縮小が効かないケースを確認し、このしきい値を分離する形で修正した)。
# 19タイプ全ての背景色はmin(r,g,b)が最大でも159(ノーマルタイプ)までしか
# 白に近づかないため、190あれば「背景を誤ってマーク判定する」リスクなしに、
# アンチエイリアス縁まで含めて「マークらしきピクセル」を粗く判定できる。
ROUGH_WHITE_MIN = 190
ROUGH_ALPHA_MIN = 60

# マークの縮小率。実測(WHITE_CHANNEL_MIN=245/ALPHA_MIN=100)で、修正前の19タイプ中
# 最もはみ出し量が大きかったくさタイプの内接円はみ出し量(+0.09px、ほぼゼロ)を
# 基準に、0.84倍に縮小すると全19タイプで内接円から最低でも7.6px(約16%)の
# マージンが残ることを確認した(詳細はround-42.md 42-T1参照)。背景(角丸ピルの
# 塗り)は縮小せず元のまま維持するため、縮小してもハロー(縁の半透明の輪)は
# 生じない。
MARK_SCALE = 0.84

# マーク判定マスクを膨張させる半径(px, 元画像解像度基準)。
# ROUGH_WHITE_MIN(190)でも取りこぼす「背景よりわずかに明るいだけのアンチエイリアス縁」
# (実測でmin(r,g,b)=185程度)が背景側に残ると、マークを縮小したあとも元位置に薄い輪郭
# =残像が残り、これが「模様がかすむ」原因になる(2026-07-30 ユーザー報告)。
# 実測(半径0/1/2の比較)で半径1あれば19タイプ全てで残像が視認できなくなり、かつ
# 埋め距離が伸びることによる背景グラデーション(ステラ)の劣化も起きないことを確認した。
MARK_MASK_DILATE = 1

# 円形マスクのアンチエイリアス品質。マスクをOUTPUT_SIZEのSUPERSAMPLE倍の解像度で
# 描画してからLANCZOSで縮小することで、円周のジャギーを抑える。
CIRCLE_MASK_SUPERSAMPLE = 4


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


def crop_icon_square(im: Image.Image) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """アイコン中心に合わせて「画像高さ×画像高さ」の正方形を切り出す(まだOUTPUT_SIZEには
    リサイズしない。マーク縮小処理を先に済ませてから最後に1回だけリサイズするため)。
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
    return cropped, box


def _is_rough_fg(pixel: tuple[int, int, int, int]) -> bool:
    r, g, b, a = pixel
    return a >= ROUGH_ALPHA_MIN and min(r, g, b) >= ROUGH_WHITE_MIN


def _dilate_mask(mask: list[list[bool]], radius: int) -> list[list[bool]]:
    """mask をおおむね円形の構造要素で radius px 膨張させたコピーを返す。
    マーク周辺のアンチエイリアス縁まで「マーク扱い」にして背景から確実に除くために使う。
    """
    if radius <= 0:
        return mask
    h = len(mask)
    w = len(mask[0])
    offsets = [
        (dx, dy)
        for dy in range(-radius, radius + 1)
        for dx in range(-radius, radius + 1)
        if dx * dx + dy * dy <= radius * radius + radius
    ]
    out = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if not mask[y][x]:
                continue
            for dx, dy in offsets:
                yy, xx = y + dy, x + dx
                if 0 <= yy < h and 0 <= xx < w:
                    out[yy][xx] = True
    return out


def _row_fill_background(im: Image.Image, rough_mask: list[list[bool]]) -> Image.Image:
    """rough_mask[y][x]がTrue(マークらしき画素)の位置を、同じ行で最も近い
    「マークではない」画素の色で塗りつぶした「背景だけ」の画像を作る(行内近傍埋め)。

    背景は縦グラデーションを持つタイプ(ステラ)を除き基本的に単色/横方向グラデーション
    なので、同じ行の近傍から埋めれば十分自然な背景になる。
    """
    w, h = im.size
    px = im.load()
    out = Image.new("RGBA", (w, h))
    out_px = out.load()
    for y in range(h):
        row_is_mark = rough_mask[y]
        for x in range(w):
            if not row_is_mark[x]:
                out_px[x, y] = px[x, y]
                continue
            left = next((xx for xx in range(x - 1, -1, -1) if not row_is_mark[xx]), None)
            right = next((xx for xx in range(x + 1, w) if not row_is_mark[xx]), None)
            if left is not None and (right is None or (x - left) <= (right - x)):
                out_px[x, y] = px[left, y]
            elif right is not None:
                out_px[x, y] = px[right, y]
            else:
                out_px[x, y] = px[x, y]  # 行全体がマーク(通常は起こらない)のフォールバック
    return out


def _compute_mark_alpha(im: Image.Image, bg: Image.Image) -> list[list[float]]:
    """各画素が「背景色からどれだけ白側に混ざっているか」を0〜1で返す
    (アンチエイリアスされた縁も滑らかな値になる)。"""
    w, h = im.size
    px = im.load()
    bg_px = bg.load()
    alpha = [[0.0] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            br, bgc, bb, _ = bg_px[x, y]
            ts = []
            for c, bc in ((r, br), (g, bgc), (b, bb)):
                denom = 255 - bc
                if denom > 0:
                    ts.append((c - bc) / denom)
            t = sum(ts) / len(ts) if ts else 0.0
            alpha[y][x] = max(0.0, min(1.0, t)) * (a / 255.0)
    return alpha


def build_mark_shrunk_icon(cropped: Image.Image, size: int) -> Image.Image:
    """crop_icon_square()が返す h×h の正方形から、白色系の「マーク」だけを検出・分離し、
    中心基準でMARK_SCALEに縮小してから、変更していない背景に再合成した size×size を返す。

    背景(角丸ピルの塗り)は一切縮小・移動しないため、この処理をしても背景の見た目
    (色・角の透明具合)は変わらない。変わるのはマークが内接円からのマージンを
    多く持つようになる点だけ。処理の必要性・不採用にした代替案は本ファイル冒頭の
    docstring参照。

    出力解像度へのリサイズもこの関数の中で行う(呼び出し側で別途resizeしない)。
    マークは「元解像度 -> round(size * MARK_SCALE)」の1回のリサンプルだけで目標サイズに
    なるため、元解像度で縮小してから拡大していた頃のボケが生じない(冒頭docstringの
    「かすんでしまっている」報告への対応)。
    """
    w, h = cropped.size
    px = cropped.load()
    rough_mask = [[_is_rough_fg(px[x, y]) for x in range(w)] for y in range(h)]
    # 膨張させたマスクで埋めることで、マーク周辺のアンチエイリアス縁が背景に残像として
    # 焼き付くのを防ぐ(MARK_MASK_DILATEのコメント参照)。
    bg = _row_fill_background(cropped, _dilate_mask(rough_mask, MARK_MASK_DILATE))
    mark_alpha = _compute_mark_alpha(cropped, bg)

    mark_layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    mark_px = mark_layer.load()
    for y in range(h):
        for x in range(w):
            mark_px[x, y] = (255, 255, 255, round(255 * mark_alpha[y][x]))

    bg_resized = bg.resize((size, size), Image.LANCZOS)
    new_side = round(size * MARK_SCALE)
    mark_resized = mark_layer.resize((new_side, new_side), Image.LANCZOS)
    mark_canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    offset = (size - new_side) // 2
    # paste先が完全に透明なキャンバスなのでマスクは渡さない。マスクに自分自身を渡すと
    # 出力alphaが a*a と二乗され、アンチエイリアス縁が薄くなる(冒頭docstring参照)。
    mark_canvas.paste(mark_resized, (offset, offset))

    result = bg_resized.convert("RGBA")
    result.alpha_composite(mark_canvas)
    return result


def _circular_mask(size: int) -> Image.Image:
    """size x size の"L"モード画像で、中心(size/2, size/2)・半径(size/2)の円の内側を
    255(不透明)、外側を0(透明)にしたマスクを作る。CIRCLE_MASK_SUPERSAMPLE倍の
    解像度で描いてからLANCZOSで縮小し、円周のアンチエイリアスを滑らかにする。
    """
    big = size * CIRCLE_MASK_SUPERSAMPLE
    mask_big = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask_big)
    draw.ellipse((0, 0, big - 1, big - 1), fill=255)
    return mask_big.resize((size, size), Image.LANCZOS)


def apply_circular_mask(im: Image.Image) -> Image.Image:
    """通常タイプ用: 出力直前の正方形画像(角丸ピルの背景+縮小済みマーク)に
    円形アルファマスクを適用し、円の外側(四隅)を完全に透明(alpha=0)にする。

    円の内側の色・マークの位置は一切変更しない(既存のalphaチャンネルと
    円マスクをImageChops.multiplyで掛け合わせるだけなので、背景がもともと
    部分的に透明だった場合もその情報は保持される)。
    """
    w, h = im.size
    if w != h:
        raise ValueError(f"円形マスクは正方形画像のみ対応: got {w}x{h}")
    mask = _circular_mask(w)
    result = im.convert("RGBA")
    r, g, b, a = result.split()
    masked_alpha = ImageChops.multiply(a, mask)
    result.putalpha(masked_alpha)
    return result


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
        cropped, box = crop_icon_square(im)
        result = apply_circular_mask(build_mark_shrunk_icon(cropped, OUTPUT_SIZE))

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
