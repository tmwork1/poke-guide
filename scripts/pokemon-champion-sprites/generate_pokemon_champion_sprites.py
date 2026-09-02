"""bulbagardenの Champions menu sprite を public/pokemon-champion-sprites/ にダウンロードして
事前配置するスクリプト(scripts/pokemon-artwork と同じ「生成済み画像を事前生成して
リポジトリにコミットする」方式)。

## 背景
公式絵(officialArtworkUrl)・ドット絵(廃止済みのspriteUrl)を、Pokémon Champions公式の
メニュー用アイコン(bulbagarden archives の Category:Champions_menu_sprites)に置き換える。
https://archives.bulbagarden.net/wiki/Category:Champions_menu_sprites

## 対象
public/master-data/autocomplete/pokemon.json の imageId(dexNoではない)。メガシンカ・
キョダイマックス等の特殊フォルムは10000番台のフォルム専用IDを持つため、フォルム固有の
画像を解決できる。

このカテゴリはPokémon Championsに現在実装されているポケモン/フォルムのみを含むため、
pokemon.json 全件(1290件、歴代フォルム含む)のうち一部(2026-08時点で235件、
regulationsが空でないレコードとほぼ一致)しかヒットしない。ヒットしないimageIdは
「まだゲームに実装されていないフォルム」であり欠損ではないので、このスクリプトは
それらを警告なしでスキップする(呼び出し側は既存のonerrorフォールバックに委ねる)。

## ファイル名からimageIdへの解決
bulbagarden側のファイル名は `Menu_CP_{dexNo:04d}[-{フォルム名}].png` 形式で、
project側の imageId ではなく dexNo + フォルム名(英語表記)で管理されている。
この2つの命名は完全には一致しないため、比較前に正規化(小文字化・スペース/
アンダースコア/ハイフンをハイフンに統一)した上で、必要最小限のエイリアス表
(FORME_ALIASES)で表記ゆれを吸収する。今のところ以下の2件のみ:
  - "F"(project、性別差のあるポケモンの♀個体) <-> "Female"(bulbagarden)
  - "Super"(project、パンプジンの特大サイズ) <-> "Jumbo"(bulbagarden)
新しいフォルムが実装されて解決できないケースが出た場合は、このFORME_ALIASESに
追加するか、それでも解決できなければ scripts/build-master-data/extract_autocomplete.py
の _IMAGE_ID_OVERRIDES と同様の個別上書き表を追加すること。

## 取得元API
Bulbagarden ArchivesはMediaWikiベースなので、カテゴリの全件列挙と画像実URLの解決
(アップロード先はハッシュディレクトリでファイル名から予測できない)を
generator=categorymembers + prop=imageinfo で1回のAPIリクエストにまとめている。

⚠️ public/master-data/ は .gitignore 対象で `npm run build:master-data` が生成する。
   このスクリプトの実行前に master-data が生成済みであることが必要。

## 使い方
    npm run generate:pokemon-champion-sprites            # 未取得のぶんだけ落とす
    npm run generate:pokemon-champion-sprites -- --force  # 全部落とし直す

bulbagardenの原画は128x128だが、そのままCSSで拡大表示すると160px前後の表示箇所
(share/[slug]・pokemon/[name])でぼやける。realesrgan_tool.py(同ディレクトリ)経由で
Real-ESRGAN(x4plus-anime, 4倍)にかけた後、実測最大表示160pxのRetina(2倍)を見込んだ
320pxへLANCZOSで1回だけ縮小し直してから保存する
(縮小1回のみの方針はscripts/pokemon-artwork/generate_pokemon_artwork.pyと同じ)。
Pillowと、初回実行時にRealESRGAN実行ファイルを取得するためのネットワーク接続が必要。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

from realesrgan_tool import upscale_dir

REPO_ROOT = Path(__file__).resolve().parents[2]
MASTER_JSON = REPO_ROOT / "public" / "master-data" / "autocomplete" / "pokemon.json"
OUT_DIR = REPO_ROOT / "public" / "pokemon-champion-sprites"

# 実測最大表示は/share/[slug]・/pokemon/[name]の160px。Retina(2倍)を見込んで320pxで保存する
# (generate_pokemon_artwork.pyのOUTPUT_SIZEと同じ方針・同じ値)。
OUTPUT_SIZE = 320

API_URL = "https://archives.bulbagarden.net/w/api.php"
CATEGORY_TITLE = "Category:Champions_menu_sprites"
USER_AGENT = "poke-guide-champion-sprite-fetch/1.0 (https://github.com/; local dev tool)"

FORME_ALIASES = {
    "f": "female",
    "super": "jumbo",
}

FILENAME_RE = re.compile(r"^Menu[ _]CP[ _](\d{4})(?:[-_](.+))?\.png$", re.IGNORECASE)

MAX_WORKERS = 8
RETRIES = 3
TIMEOUT_SEC = 30


def norm(value: str | None) -> str:
    """比較用に正規化する: 小文字化し、空白/アンダースコア/ハイフンをハイフンに統一する。"""
    if not value:
        return ""
    collapsed = " ".join(value.strip().lower().replace("_", " ").replace("-", " ").split())
    return collapsed.replace(" ", "-")


def aliased(value: str | None) -> str:
    key = norm(value)
    return FORME_ALIASES.get(key, key)


def load_pokemon_entries() -> list[dict]:
    if not MASTER_JSON.exists():
        sys.exit(
            f"マスタデータが見つかりません: {MASTER_JSON}\n"
            "先に `npm run build:master-data` を実行してください"
        )
    return json.loads(MASTER_JSON.read_text(encoding="utf-8"))


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
        return json.loads(res.read())


def fetch_bulba_manifest() -> list[dict]:
    """Category:Champions_menu_sprites の全ファイルの (dexNo, suffix, url, title) 一覧を取得する。"""
    entries: list[dict] = []
    params = {
        "action": "query",
        "generator": "categorymembers",
        "gcmtitle": CATEGORY_TITLE,
        "gcmlimit": "500",
        "gcmtype": "file",
        "prop": "imageinfo",
        "iiprop": "url",
        "format": "json",
    }
    while True:
        data = fetch_json(API_URL + "?" + urllib.parse.urlencode(params))
        pages = data.get("query", {}).get("pages", {})
        for page in pages.values():
            title = page["title"]
            body = title[len("File:"):] if title.startswith("File:") else title
            m = FILENAME_RE.match(body)
            if not m:
                print(f"⚠️ 命名規則(Menu_CP_dddd[-suffix].png)に一致しないファイルをスキップ: {title}")
                continue
            imageinfo = page.get("imageinfo")
            if not imageinfo:
                continue
            entries.append(
                {
                    "dexNo": int(m.group(1)),
                    "suffix": m.group(2),
                    "url": imageinfo[0]["url"],
                    "title": title,
                }
            )
        cont = data.get("continue")
        if not cont:
            break
        params.update(cont)
    return entries


def build_index(bulba_entries: list[dict]) -> dict[tuple[int, str], dict]:
    return {(e["dexNo"], aliased(e["suffix"])): e for e in bulba_entries}


def fetch_image(url: str) -> bytes:
    last_err: Exception | None = None
    for _ in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
                return res.read()
        except Exception as err:  # noqa: BLE001 - ネットワーク由来は全部リトライ対象
            last_err = err
    raise RuntimeError(f"{url} の取得に失敗しました: {last_err}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="bulbagardenのChampions menu spriteを public/pokemon-champion-sprites/ に事前配置する"
    )
    parser.add_argument("--force", action="store_true", help="既に存在する画像も取得し直す")
    args = parser.parse_args()

    print("bulbagardenのカテゴリ一覧を取得中...")
    bulba_entries = fetch_bulba_manifest()
    print(f"bulbagarden側ファイル数: {len(bulba_entries)}")
    index = build_index(bulba_entries)

    pokemon_entries = load_pokemon_entries()
    by_image_id: dict[int, dict] = {}
    for e in pokemon_entries:
        image_id = e.get("imageId")
        if image_id is None:
            continue
        by_image_id.setdefault(image_id, e)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    matched: dict[int, dict] = {}
    unmatched: list[dict] = []
    for image_id, e in by_image_id.items():
        hit = index.get((e["dexNo"], aliased(e.get("forme"))))
        if hit:
            matched[image_id] = hit
        else:
            unmatched.append(e)

    targets = {
        image_id: hit
        for image_id, hit in matched.items()
        if args.force or not (OUT_DIR / f"{image_id}.png").exists()
    }
    print(
        f"対象imageId: {len(by_image_id)}件中 {len(matched)}件がbulbagardenに存在"
        f"(うち今回取得: {len(targets)}件)"
    )

    failed: list[int] = []

    with tempfile.TemporaryDirectory(prefix="champion-sprites-raw-") as raw_dir_s, \
         tempfile.TemporaryDirectory(prefix="champion-sprites-upscaled-") as upscaled_dir_s:
        raw_dir = Path(raw_dir_s)
        upscaled_dir = Path(upscaled_dir_s)

        def work(item: tuple[int, dict]) -> None:
            image_id, hit = item
            try:
                data = fetch_image(hit["url"])
            except Exception as err:  # noqa: BLE001
                print(f"⚠️ imageId={image_id} ({hit['title']}) の取得に失敗: {err}")
                failed.append(image_id)
                return
            (raw_dir / f"{image_id}.png").write_bytes(data)

        if targets:
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                for done, _ in enumerate(pool.map(work, targets.items()), start=1):
                    if done % 50 == 0:
                        print(f"  取得 {done}/{len(targets)}")

        fetched_ids = [image_id for image_id in targets if image_id not in failed]
        if fetched_ids:
            print(f"Real-ESRGANでアップスケール中: {len(fetched_ids)}件(初回はツールのダウンロードが入る)")
            upscale_dir(raw_dir, upscaled_dir)
            for done, image_id in enumerate(fetched_ids, start=1):
                upscaled_path = upscaled_dir / f"{image_id}.png"
                src_path = upscaled_path if upscaled_path.exists() else raw_dir / f"{image_id}.png"
                if not upscaled_path.exists():
                    print(f"⚠️ imageId={image_id} のアップスケールに失敗(原寸のまま縮小して保存)")
                im = Image.open(src_path).convert("RGBA")
                resized = im.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
                resized.save(OUT_DIR / f"{image_id}.png", "PNG", optimize=True)
                if done % 50 == 0:
                    print(f"  保存 {done}/{len(fetched_ids)}")

    saved = sorted(OUT_DIR.glob("*.png"))
    total_bytes = sum(p.stat().st_size for p in saved)

    print()
    print(f"保存済み: {len(saved)}ファイル / {total_bytes / 1024 / 1024:.2f} MB")
    print(f"マッチ率: {len(matched)}/{len(by_image_id)} ({len(matched) / len(by_image_id) * 100:.1f}%)")
    if failed:
        print(f"⚠️ ダウンロードに失敗したimageId({len(failed)}件): {sorted(failed)}")
    if unmatched:
        # bulbagardenにまだ絵が無い(=Championsに未実装の)imageId。呼び出し側のonerror
        # フォールバックに任せるため実行は継続するが、件数の急増は仕様変更の兆候として確認すること。
        print(f"ℹ️ bulbagardenにChampions menu spriteが無かったimageId: {len(unmatched)}件")


if __name__ == "__main__":
    main()
