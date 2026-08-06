"""PokeAPI のポケモンのドット絵を public/pokemon-sprites/ にダウンロードして事前配置する
スクリプト(scripts/item-icons/generate_item_icons.py・scripts/type-icons/generate_type_icons.py と
同じ「生成済み画像を事前生成してリポジトリにコミットする」方式)。

## 背景
src/lib/pokemon-master-data.ts の spriteUrl() は、もともと
https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{imageId}.png
を実行時に直接参照していた。2026-08-06 にユーザーから「外部参照のほうがパフォーマンス
メリットがある?」と問われて実測したところ、次が判明した(詳細は
docs/plan/pokemon-sprites-localization.md)。

  - raw.githubusercontent.com の Cache-Control は **max-age=300(5分)** しかない。
    /ranked-teams は初期表示で300枚のドット絵を並べるため、5分後の再訪で300本の
    条件付きリクエスト(304)が発生する。自前配信なら0本にできる。
  - 画像は543〜1291バイト(実測5枚、平均891B)しかなく、コストは転送量ではなく
    「別オリジンへのDNS+TCP+TLS確立と往復」。初回はTLS確立だけで266msかかっていた。
  - ブラウザのHTTPキャッシュはトップレベルサイト単位で分割(cache partitioning)されている
    ため、「他サイトが取得済みのCDN画像を使い回せる」という利点は現在成立しない。

一方、**公式絵(officialArtworkUrl)はローカル化しない**。実測118〜203KB/枚 × 1284件 ≒ 180MB で、
ドット絵(約1.2MB)とは3桁違い、gitにもCloudflare Workers assetsにも現実的に載らない。

## 対象のimageId
public/master-data/autocomplete/pokemon.json の imageId(dexNoではない)。
メガシンカ・キョダイマックス等の特殊フォルムは10000番台のフォルム専用IDを持つため、
フォルム固有のドット絵が落ちてくる(pokemon-master-data.ts 冒頭のコメント参照)。
detail/pokemon.json は imageId を持たないので、autocomplete が唯一の供給元。

⚠️ public/master-data/ は .gitignore 対象で `npm run build:master-data` が生成する。
   **マスタデータを再生成してフォルムが増えたら、このスクリプトも再実行すること。**
   (このスクリプトは master-data が生成済みであることを前提にする)

## 使い方
    npm run generate:pokemon-sprites            # 未取得のぶんだけ落とす
    npm run generate:pokemon-sprites -- --force # 全部落とし直す

標準ライブラリのみで動く(Pillow不要)。ドット絵は加工せずそのまま保存するため、
item-icons/type-icons のような正規化処理は無い。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MASTER_JSON = REPO_ROOT / "public" / "master-data" / "autocomplete" / "pokemon.json"
OUT_DIR = REPO_ROOT / "public" / "pokemon-sprites"

SPRITE_URL = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{image_id}.png"

# GitHubのrawはレート制限があるため、並列数は控えめにする(実測でこの程度なら詰まらない)。
MAX_WORKERS = 8
RETRIES = 3
TIMEOUT_SEC = 30


def load_image_ids() -> list[int]:
    if not MASTER_JSON.exists():
        sys.exit(
            f"マスタデータが見つかりません: {MASTER_JSON}\n"
            "先に `npm run build:master-data` を実行してください"
        )
    entries = json.loads(MASTER_JSON.read_text(encoding="utf-8"))
    return sorted({int(e["imageId"]) for e in entries if e.get("imageId") is not None})


def fetch(image_id: int) -> bytes | None:
    """ドット絵を取得する。404(その imageId の画像が上流に存在しない)なら None。"""
    url = SPRITE_URL.format(image_id=image_id)
    last_err: Exception | None = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "poke-commons-sprite-fetch"})
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
    parser = argparse.ArgumentParser(description="ポケモンのドット絵を public/pokemon-sprites/ に事前配置する")
    parser.add_argument("--force", action="store_true", help="既に存在する画像も取得し直す")
    args = parser.parse_args()

    image_ids = load_image_ids()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    targets = [i for i in image_ids if args.force or not (OUT_DIR / f"{i}.png").exists()]
    print(f"対象imageId: {len(image_ids)}件(うち今回取得: {len(targets)}件)")

    missing: list[int] = []

    def work(image_id: int) -> None:
        data = fetch(image_id)
        if data is None:
            missing.append(image_id)
            return
        (OUT_DIR / f"{image_id}.png").write_bytes(data)

    if targets:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            for done, _ in enumerate(pool.map(work, targets), start=1):
                if done % 100 == 0:
                    print(f"  {done}/{len(targets)}")

    saved = sorted(OUT_DIR.glob("*.png"))
    total_bytes = sum(p.stat().st_size for p in saved)
    covered = sum(1 for i in image_ids if (OUT_DIR / f"{i}.png").exists())

    print()
    print(f"保存済み: {len(saved)}ファイル / {total_bytes / 1024 / 1024:.2f} MB")
    print(f"カバー率: {covered}/{len(image_ids)} ({covered / len(image_ids) * 100:.1f}%)")
    if missing:
        # 上流に画像が無いimageId。呼び出し側(applySprite)はonerrorで頭文字バッジに
        # フォールバックするが、ranked-teams/card.ts など onerror を持たない箇所もあるため、
        # ここに出たIDは必ず確認すること。
        print(f"⚠️ 上流に画像が無かったimageId({len(missing)}件): {sorted(missing)}")
    else:
        print("欠損なし")


if __name__ == "__main__":
    main()
