"""320px の Champions スプライトから、アイコン表示専用の WebP を生成する。"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "public" / "pokemon-champion-sprites"
OUTPUT_DIR = SOURCE_DIR / "icon"
OUTPUT_SIZE = 96
WEBP_QUALITY = 90


def main() -> None:
    """既存PNGだけを入力にするため、取得・アップスケール処理は再実行しない。"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sources = sorted(SOURCE_DIR.glob("*.png"))
    for source in sources:
        with Image.open(source) as image:
            # WebPでも透明な余白を保ち、40px前後の表示で輪郭が崩れないよう高品質に縮小する。
            image.convert("RGBA").resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS).save(
                OUTPUT_DIR / f"{source.stem}.webp",
                "WEBP",
                quality=WEBP_QUALITY,
                method=6,
            )

    icons = sorted(OUTPUT_DIR.glob("*.webp"))
    total_bytes = sum(path.stat().st_size for path in icons)
    print(f"生成済み: {len(icons)}枚 / {total_bytes / 1024 / 1024:.2f} MiB")


if __name__ == "__main__":
    main()
