"""public/pokemon-champion-sprites/ の128px素材を超解像でアップスケールするための
Real-ESRGAN(ncnn-vulkan版)実行ファイルを取得・実行するヘルパー
(generate_pokemon_champion_sprites.py 専用、scripts/ranker/common.py と同様の同ディレクトリ内共通モジュール)。

## 背景
bulbagardenのChampions menu sprite(128x128)をそのままCSSで拡大表示すると、表示サイズが
128pxを超える箇所(share/[slug]・pokemon/[name]の160px等)でぼやけて見える問題があった
(2026-09-02、Real-ESRGAN x4plus-animeでアップスケールしたところボケが大幅に軽減することを
ローカルDBのボックス登録種族20体で確認済み)。

## Pythonライブラリ版ではなく実行ファイル版を使う理由
pipパッケージ版(realesrgan)が依存するbasicsrは、Python 3.13 + 新しいsetuptools環境だと
setup.pyのバージョン取得処理が壊れてビルドできない(2026-09時点の既知の非互換)。
公式配布のスタンドアロン実行ファイル(ncnn-vulkan版、Pythonにもtorchにも依存しない)を
使うことでこの問題を避ける。初回実行時にGitHub Releasesから取得しキャッシュする
(このファイルと同じディレクトリの .cache/ 配下、.gitignore対象)。
https://github.com/xinntao/Real-ESRGAN/releases

## 実行環境の前提
Vulkan対応GPU(統合GPUで可、実測はIntel iGPU)が必要。CI環境では動かない想定で、
このモジュールは他のgenerate_*.py(bulbagarden/PokeAPIへの都度アクセスが必要で
ローカル実行専用)と同じく、ローカルでの事前生成専用。
"""

from __future__ import annotations

import platform
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent / ".cache"

RELEASE_TAG = "v0.2.5.0"
RELEASE_DATE = "20220424"

# xinntao/Real-ESRGAN のGitHub Releasesが配布するOSごとのアセット名・実行ファイル名。
# 動作確認はWindows(Intel iGPU)のみ。macOS/Linuxはアセット名のみ揃えてあるが未検証。
_PLATFORM_ASSETS = {
    "Windows": f"realesrgan-ncnn-vulkan-{RELEASE_DATE}-windows.zip",
    "Darwin": f"realesrgan-ncnn-vulkan-{RELEASE_DATE}-macos.zip",
    "Linux": f"realesrgan-ncnn-vulkan-{RELEASE_DATE}-ubuntu.zip",
}
_PLATFORM_EXE = {
    "Windows": "realesrgan-ncnn-vulkan.exe",
    "Darwin": "realesrgan-ncnn-vulkan",
    "Linux": "realesrgan-ncnn-vulkan",
}

# アニメ塗り絵(セルシェード)向けの学習済みモデル。ポケモンの立ち絵に近いテイストで
# 実測(2026-09-02、20体)でジャギー・ハレーションが少なかったためこれを採用する。
MODEL = "realesrgan-x4plus-anime"
SCALE = 4


def _current_platform() -> str:
    system = platform.system()
    if system not in _PLATFORM_ASSETS:
        sys.exit(f"未対応OSです: {system}(Windows/macOS/Linuxのみ対応)")
    return system


def ensure_tool() -> Path:
    """realesrgan-ncnn-vulkan 実行ファイルのパスを返す。未取得ならダウンロードして展開する。"""
    system = _current_platform()
    tool_dir = CACHE_DIR / system
    exe_path = tool_dir / _PLATFORM_EXE[system]
    if exe_path.exists():
        return exe_path

    asset = _PLATFORM_ASSETS[system]
    print(f"Real-ESRGAN実行ファイルを取得中: {asset}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE_DIR / asset
    url = f"https://github.com/xinntao/Real-ESRGAN/releases/download/{RELEASE_TAG}/{asset}"
    req = urllib.request.Request(url, headers={"User-Agent": "poke-guide-realesrgan-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=120) as res:
        zip_path.write_bytes(res.read())

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(tool_dir)
    zip_path.unlink()

    if system != "Windows":
        exe_path.chmod(0o755)
    if not exe_path.exists():
        sys.exit(f"展開後も実行ファイルが見つかりません: {exe_path}")
    return exe_path


def upscale_dir(in_dir: Path, out_dir: Path) -> None:
    """in_dir 直下の画像すべてを MODEL/SCALE でアップスケールし、out_dir に同名で書き出す。"""
    exe_path = ensure_tool()
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [str(exe_path), "-i", str(in_dir), "-o", str(out_dir), "-n", MODEL, "-s", str(SCALE)],
        cwd=exe_path.parent,
        check=True,
    )
