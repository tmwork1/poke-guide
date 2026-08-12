"""gamewith.jp の持ち物一覧記事から高解像度(160x160)のアイテム画像を収集し、
generate_item_icons.py と同じ正規化パイプラインで public/item-icons/ に上書き
生成するスクリプト。

## 背景
generate_item_icons.py が参照する PokeAPI 原画は、素朴なアイテム(きのみ・プレート等)
が30x30と小さく、96pxへの拡大時にぼやける(同スクリプトdocstring「実測」参照。
2026-08-12ユーザー報告「アイテム画像の一部が低画質」の原因)。gamewith.jp の持ち物
一覧記事(https://gamewith.jp/pokemon-champions/546487)には同じアイテムの160x160
原画が掲載されており、これを差し替えソースとして使うとぼやけを解消できることを
実測確認済み(item204/item211で alpha>=8 のバウンディングボックスが gen8/gen9系
PokeAPI画像と同様の特性を示した)。

## 対象
記事内の `alt` 属性(日本語アイテム名)を public/master-data/autocomplete/items.json
の `name` と突き合わせ、完全一致したものだけを対象とする(2026-08-12時点で記事中
73件がヒットし、items.json と73/73マッチ。うち72件が従来30x30原画由来だった)。
spritePathがnull(PokeAPI原画が存在しない)のアイテムでも、items.jsonにname自体が
存在すればマッチ対象になる(出力ファイル名は和名のみで決まるため、spritePathの有無に
依存しない)。記事に掲載のないアイテムは対象外とし、generate_item_icons.py が生成した
既存ファイルをそのまま残す。

## 出力ファイル名
public/item-icons/{アイテム和名}.png (generate_item_icons.pyと同じ命名規則。
詳細は同スクリプトのdocstring「出力ファイル名」参照)。

## 使い方
    python scripts/item-icons/generate_item_icons_gamewith.py

    ネットワークアクセスが必要(gamewith.jpの記事HTMLと画像を都度取得、ローカル
    キャッシュは持たない)。再実行可能(既存ファイルは上書き)。

## 依存
    Pillow (pip install Pillow)。generate_item_icons.py と同様。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_item_icons import (  # noqa: E402
    ITEMS_JSON,
    OUT_DIR,
    REPO_ROOT,
    build_normalized_icon,
    fetch_image,
)

ARTICLE_URL = "https://gamewith.jp/pokemon-champions/546487"

# 記事HTML中の `<img data-original='.../i_item123.png' ... alt='アイテム名'>` を拾う。
# gamewithはlazyload用placeholder imgと実urlを持つ非表示imgの2つを毎回セットで
# 出力するため、同じURLが2回ヒットするが呼び出し側でdictに詰めて重複除去する。
ITEM_IMG_RE = re.compile(
    r"data-original='(https://img\.gamewith\.jp/article_tools/pokemon-champions/gacha/i_item\d+\.png)'"
    r"[^>]*alt='([^']*)'"
)


def fetch_article_html() -> str:
    req = urllib.request.Request(
        ARTICLE_URL,
        headers={"User-Agent": "poke-commons-item-icon-collector"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"記事の取得に失敗しました: {ARTICLE_URL}\n{exc}") from exc


def extract_name_to_url() -> dict[str, str]:
    html = fetch_article_html()
    result: dict[str, str] = {}
    for url, name in ITEM_IMG_RE.findall(html):
        result.setdefault(name, url)
    return result


def load_item_names() -> set[str]:
    data = json.loads(ITEMS_JSON.read_text(encoding="utf-8"))
    return {entry["name"] for entry in data if entry.get("name")}


def main() -> None:
    name_to_url = extract_name_to_url()
    item_names = load_item_names()

    targets = [(name, url) for name, url in name_to_url.items() if name in item_names]
    skipped = sorted(name for name in name_to_url if name not in item_names)

    print(f"記事から抽出: {len(name_to_url)} 件 / items.json とマッチ: {len(targets)} 件")
    if skipped:
        print(f"マッチせず対象外: {len(skipped)} 件 - {skipped}")

    total_bytes = 0
    failures: list[tuple[str, str]] = []
    for i, (name, url) in enumerate(targets, 1):
        try:
            im = fetch_image(url)
            result = build_normalized_icon(im)
            out_path = OUT_DIR / f"{name}.png"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            result.save(out_path)
        except Exception as exc:  # noqa: BLE001 - 1件失敗しても残りを続ける
            failures.append((name, str(exc)))
            print(f"[{i}/{len(targets)}] {name}: FAILED - {exc}")
            continue
        size = out_path.stat().st_size
        total_bytes += size
        rel = out_path.relative_to(REPO_ROOT)
        print(f"[{i}/{len(targets)}] {name} -> {rel} ({size}B)")

    ok = len(targets) - len(failures)
    print(
        f"\n完了: {ok}/{len(targets)} 枚差し替え。合計サイズ: {total_bytes:,} バイト "
        f"({total_bytes / 1024:.1f} KiB)"
    )
    if failures:
        print(f"\n失敗 {len(failures)} 件:")
        for name, reason in failures:
            print(f"  - {name}: {reason}")


if __name__ == "__main__":
    main()
