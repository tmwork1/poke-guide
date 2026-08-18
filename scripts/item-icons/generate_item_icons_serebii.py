"""serebii.net のアイテム画像から高解像度(160x160)のアイテム画像を収集し、
generate_item_icons.py と同じ正規化パイプラインで public/item-icons/ に上書き
生成するスクリプト(旧 generate_item_icons_gamewith.py の後継)。

## 背景
generate_item_icons.py が参照する PokeAPI 原画は、素朴なアイテム(きのみ・プレート等)
が30x30と小さく、96pxへの拡大時にぼやける(同スクリプトdocstring「実測」参照。
2026-08-12ユーザー報告「アイテム画像の一部が低画質」の原因)。以前はgamewith.jpの
持ち物一覧記事から差し替え画像を収集していたが、記事1本に掲載されている147件しか
カバーできず、記事の存在に依存する不安定さもあった。serebii.net は itemdex 配下に
アイテムごとの単独画像を持ち、Scarlet/Violet仕様の160x160画像(`itemdex/sprites/sv/`)と
Legends Z-A仕様の160x160画像(`itemdex/sprites/za/`、メガストーン等sv側に存在しない
アイテムを補完)の2ディレクトリを優先的に使うことで、items.json 全263件(2026-08-18時点、
spritePathを持つユニーク名)を100%カバーできることを実測確認済み。za/svいずれにも
存在しないアイテム(キングのおうじゃのしるし等、旧世代のみの意匠でsv/za向けに描き直され
なかったもの)は、非バージョン管理の `itemdex/sprites/`(40x40、PokeAPI30x30よりは高精細)
にフォールバックする。

## ファイル名の対応付け
items.json の spritePath(例 "gen9/ability-shield" / "charizardite-x")は PokeAPI 由来の
スラッグで、ハイフンが単語区切りとして一律に使われる。一方 serebii のファイル名は英語の
原表記に忠実で、"Heavy-Duty Boots" のようにハイフンが単語の一部として残る場合と、
"King's Rock" → "kingsrock" のように空白・アポストロフィごと消える場合が混在し、
spritePathから機械的に導出できない。そのため以下の優先順で候補を試す:
  1. spritePathの末尾セグメントからハイフンを全て除いた文字列(例 "abilityshield"。
     大半のアイテム・メガストーンはこれで一致する)
  2. serebii の itemdex/list/*.shtml 各カテゴリ一覧ページを都度スクレイピングして
     構築した「ハイフン除去キー→実ファイル名」索引からの逆引き(heavy-dutyboots等、
     ハイフンの一部が残る例外を吸収する)
  3. spritePathの末尾セグメントをそのまま(ハイフン付き)使う
候補ごとに za → sv → (バージョンなし) の順でHTTP到達性を確認し、最初に成功したものを
採用する。2026-08-18時点でこの方式により263/263件が解決することを実測確認済み。

## spritePathがnullのアイテム
items.json で spritePath が null のアイテム(PokeAPIに存在しないChampions固有アイテム等)は
上記の自動解決の対象外。ただし一部は英語名が判明しているため、下記 MANUAL_ENGLISH_SLUG に
手動で対応表を持たせている(2026-08-18時点で確認できた4件のみ。「もりのプレート」
「アブソルナイトZ」「ガブリアスナイトZ」はPokeAPIに対応する実在アイテムがなく解決不能
のため対象外のまま)。

## 出力ファイル名
public/item-icons/{アイテム和名}.png (generate_item_icons.pyと同じ命名規則。
詳細は同スクリプトのdocstring「出力ファイル名」参照)。

## 使い方
    python scripts/item-icons/generate_item_icons_serebii.py

    ネットワークアクセスが必要(serebii.netのカテゴリ一覧ページと画像を都度取得、ローカル
    キャッシュは持たない)。再実行可能(既存ファイルは上書き)。

## 依存
    Pillow (pip install Pillow)。generate_item_icons.py と同様。
"""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_item_icons import (  # noqa: E402
    ITEMS_JSON,
    OUT_DIR,
    REPO_ROOT,
    build_normalized_icon,
)

SPRITES_BASE = "https://www.serebii.net/itemdex/sprites"

# serebii.net の itemdex カテゴリ一覧ページ。メガストーンはどのカテゴリページにも
# 一覧されないが(2026-08-18確認)、画像自体は itemdex/sprites/za/ 等に単独で存在するため、
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

# 160x160の高解像度画像を持つバージョン別ディレクトリ。za(Legends Z-A)を先に試すのは、
# メガストーン等sv側に存在しないアイテムをzaが補完しているため(実測、docstring参照)。
# ""(空文字)はバージョンなしの itemdex/sprites/ 直下(40x40、フォールバック用)を表す。
IMAGE_DIRS = ["za", "sv", ""]

# spritePathがnullのアイテムのうち、英語識別子が判明しているものの手動対応表
# (docstring「spritePathがnullのアイテム」参照)。
MANUAL_ENGLISH_SLUG: dict[str, str] = {
    "ウォーターメモリ": "water-memory",
    "ファイアーメモリ": "fire-memory",
    "こうてつのプレート": "iron-plate",
    "たまむしのプレート": "insect-plate",
}

STEM_IMG_RE = re.compile(r"/itemdex/sprites/([a-zA-Z0-9\-]+)\.png")


def fetch_url(url: str) -> bytes | None:
    req = urllib.request.Request(url, headers={"User-Agent": "poke-commons-item-icon-collector"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read()
    except urllib.error.URLError:
        return None


def build_stem_index() -> dict[str, str]:
    """serebii の各カテゴリ一覧ページから、バージョンなし itemdex/sprites/ 直下の画像
    ファイル名(スラッグ)を集め、「ハイフン除去キー→実ファイル名」の索引を作る。
    """
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
    """spritePath末尾セグメント(またはMANUAL_ENGLISH_SLUGのスラッグ)から実画像を解決する。
    見つかった場合は (画像バイト列, 採用したURL) を返す。見つからなければNone。
    """
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
    """(アイテム和名, spritePath末尾セグメント/手動スラッグ) の一覧を返す。
    items.json の重複名は除外し、spritePathがnullでもMANUAL_ENGLISH_SLUGにあれば含める。
    """
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
