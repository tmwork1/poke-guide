"""PokeAPI の公式絵(official-artwork)を縮小+WebP変換して public/pokemon-artwork/ に
事前配置するスクリプト(scripts/pokemon-sprites/generate_pokemon_sprites.py の公式絵版)。

## ドット絵版との違い: 原画をそのまま置かない
ドット絵は1KB前後なので無加工でコミットしたが、公式絵は **475x475 / 平均145.8KB**(実測10枚)で、
1284件そのまま置くと **178.6MB** になりgitにもデプロイにも載らない。
一方、アプリが実際に表示しているサイズは原画よりはるかに小さい(2026-08-06 実測)。

    ページ              枚数  転送量   CSS表示サイズ
    /box                 8    943KB    115x115
    /team                5    640KB     72x72
    /pokemon/[name]      1    149KB    160x160

最大表示が160pxなので、Retina(2倍)を見込んで **320px** に縮小し、WebP(q82)で保存する。
実測で 18.0KB/枚 → 1284件で約22.6MB(原画比 約1/8)。/box の公式絵転送は943KB→約144KBになる。

## ローカル化する理由(ドット絵版と共通)
raw.githubusercontent.com の Cache-Control は max-age=300(5分)しかなく、再訪のたびに
取り直しになる。またドット絵をローカル化した結果、/box と /team が外部オリジンに接続する
理由は公式絵だけになり、5〜8枚のためにDNS+TCP+TLS(初回266ms)を張る割の合わない状態だった。
詳細は docs/plan/pokemon-sprites-localization.md。

## リサンプルは1回だけ
scripts/type-icons/generate_type_icons.py の教訓(2回リサンプルするとボケる)に従い、
475px から 320px への縮小を LANCZOS で1回だけ行う。

## 使い方
    npm run generate:pokemon-artwork            # 未取得のぶんだけ処理する
    npm run generate:pokemon-artwork -- --force # 全部やり直す

Pillowが必要(scripts/item-icons・scripts/type-icons と同じ)。
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
MASTER_JSON = REPO_ROOT / "public" / "master-data" / "autocomplete" / "pokemon.json"
OUT_DIR = REPO_ROOT / "public" / "pokemon-artwork"

ARTWORK_URL = (
    "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/"
    "other/official-artwork/{image_id}.png"
)

# アプリ内の最大表示サイズは /pokemon/[name] と /share/[slug] の160px。Retina(2倍)を見込んで320px。
OUTPUT_SIZE = 320
# q82 は実測で 320px 18.0KB/枚。q75 まで落とすと16.0KB/枚になるが、公式絵は写実的な
# イラストで圧縮劣化が出やすいため、容量差(約2.5MB)よりも画質を優先する。
WEBP_QUALITY = 82

MAX_WORKERS = 8
RETRIES = 3
TIMEOUT_SEC = 60


def load_image_ids() -> list[int]:
    if not MASTER_JSON.exists():
        sys.exit(
            f"マスタデータが見つかりません: {MASTER_JSON}\n"
            "先に `npm run build:master-data` を実行してください"
        )
    entries = json.loads(MASTER_JSON.read_text(encoding="utf-8"))
    return sorted({int(e["imageId"]) for e in entries if e.get("imageId") is not None})


def fetch(image_id: int) -> bytes | None:
    """公式絵を取得する。404(その imageId の公式絵が上流に無い)なら None。"""
    url = ARTWORK_URL.format(image_id=image_id)
    last_err: Exception | None = None
    for _ in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "poke-commons-artwork-fetch"})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
                return res.read()
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            last_err = err
        except Exception as err:  # noqa: BLE001 - ネットワーク由来は全部リトライ対象
            last_err = err
    raise RuntimeError(f"imageId={image_id} の取得に失敗しました: {last_err}")


def main() -> None:
    parser = argparse.ArgumentParser(description="公式絵を縮小+WebP変換して public/pokemon-artwork/ に配置する")
    parser.add_argument("--force", action="store_true", help="既に存在する画像も処理し直す")
    args = parser.parse_args()

    image_ids = load_image_ids()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    targets = [i for i in image_ids if args.force or not (OUT_DIR / f"{i}.webp").exists()]
    print(f"対象imageId: {len(image_ids)}件(うち今回処理: {len(targets)}件)")
    print(f"出力: {OUTPUT_SIZE}px WebP (quality={WEBP_QUALITY})")

    missing: list[int] = []

    def work(image_id: int) -> None:
        raw = fetch(image_id)
        if raw is None:
            missing.append(image_id)
            return
        # 公式絵は透過PNGなのでRGBAのまま扱う(WebPはアルファチャンネルを保持できる)。
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        resized = im.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)
        resized.save(OUT_DIR / f"{image_id}.webp", "WEBP", quality=WEBP_QUALITY, method=6)

    if targets:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            for done, _ in enumerate(pool.map(work, targets), start=1):
                if done % 100 == 0:
                    print(f"  {done}/{len(targets)}")

    saved = sorted(OUT_DIR.glob("*.webp"))
    total_bytes = sum(p.stat().st_size for p in saved)
    covered = sum(1 for i in image_ids if (OUT_DIR / f"{i}.webp").exists())

    print()
    print(f"保存済み: {len(saved)}ファイル / {total_bytes / 1024 / 1024:.2f} MB")
    print(f"1枚あたり平均: {total_bytes / max(len(saved), 1) / 1024:.1f} KB")
    print(f"カバー率: {covered}/{len(image_ids)} ({covered / len(image_ids) * 100:.1f}%)")
    if missing:
        # 上流に公式絵が無いimageId。applySprite はonerrorで頭文字バッジに退避するため
        # 画面は壊れないが、件数は必ず確認すること。
        print(f"⚠️ 上流に公式絵が無かったimageId({len(missing)}件): {sorted(missing)}")
    else:
        print("欠損なし")


if __name__ == "__main__":
    main()
