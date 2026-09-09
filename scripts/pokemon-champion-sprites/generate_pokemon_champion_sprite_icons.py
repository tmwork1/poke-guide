"""320px の Champions スプライトから、小さい表示に使う WebP を生成する。

元の 320x320 PNG は1枚平均74KB(最大132KB)あり、40px枠や100px枠に流し込むには過大。
表示サイズ帯ごとに2種類の派生を作り、呼び出し側は
src/lib/pokemon-master-data.ts の championSpriteIconUrl / championSpriteMediumUrl で参照する。

  icon/   96px  … 一覧のジャンプレール・見出し・同時採用など、概ね48px以下の表示
  medium/ 192px … カード・プレビュー・相性グリッドなど、概ね64〜128pxの表示

取得・アップスケール(generate_pokemon_champion_sprites.py)は重いので再実行しない。
このスクリプトは既に配置済みのPNGだけを入力にする。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "public" / "pokemon-champion-sprites"
# (出力ディレクトリ名, 一辺のピクセル数)
VARIANTS = (("icon", 96), ("medium", 192))
WEBP_QUALITY = 90


def main() -> None:
    """既存PNGだけを入力にするため、取得・アップスケール処理は再実行しない。"""
    sources = sorted(SOURCE_DIR.glob("*.png"))
    for name, size in VARIANTS:
        output_dir = SOURCE_DIR / name
        output_dir.mkdir(parents=True, exist_ok=True)
        for source in sources:
            with Image.open(source) as image:
                # WebPでも透明な余白を保ち、縮小後も輪郭が崩れないよう高品質に縮小する。
                image.convert("RGBA").resize((size, size), Image.LANCZOS).save(
                    output_dir / f"{source.stem}.webp",
                    "WEBP",
                    quality=WEBP_QUALITY,
                    method=6,
                )

        generated = sorted(output_dir.glob("*.webp"))
        total_bytes = sum(path.stat().st_size for path in generated)
        print(f"{name}/ ({size}px): {len(generated)}枚 / {total_bytes / 1024 / 1024:.2f} MiB")


if __name__ == "__main__":
    main()
