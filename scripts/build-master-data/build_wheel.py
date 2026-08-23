#!/usr/bin/env python3
"""Build the vendored pure-Python jpoke package as a wheel using only stdlib.

Cloudflare's build image provides Python but not the third-party ``build`` module.
The package has no dependencies or compiled extensions, so its wheel is simply a
ZIP archive containing ``src/jpoke`` and the standard dist-info metadata.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import sys
import zipfile
from pathlib import Path


NAME = "jpoke"
VERSION = "0.2.0"
DIST_INFO = f"{NAME}-{VERSION}.dist-info"


def record_hash(contents: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(contents).digest()).decode().rstrip("=")
    return f"sha256={digest}"


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_wheel.py JPOKE_DIR OUTPUT_DIR")

    package_root = Path(sys.argv[1]) / "src"
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)
    wheel_path = output_dir / f"{NAME}-{VERSION}-py3-none-any.whl"

    metadata = (
        "Metadata-Version: 2.1\n"
        f"Name: {NAME}\n"
        f"Version: {VERSION}\n"
        "Summary: Event-driven Pokemon Champions single-battle simulation and damage calculation library (unofficial)\n"
        "License: MIT\n"
        "Requires-Python: >=3.11\n"
    ).encode()
    wheel = (
        "Wheel-Version: 1.0\n"
        "Generator: poke-guide build_wheel.py\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    ).encode()

    records: list[tuple[str, str, str]] = []
    with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in sorted((package_root / NAME).rglob("*")):
            if not source.is_file() or "__pycache__" in source.parts:
                continue
            destination = source.relative_to(package_root).as_posix()
            contents = source.read_bytes()
            archive.writestr(destination, contents)
            records.append((destination, record_hash(contents), str(len(contents))))

        for filename, contents in (("METADATA", metadata), ("WHEEL", wheel)):
            destination = f"{DIST_INFO}/{filename}"
            archive.writestr(destination, contents)
            records.append((destination, record_hash(contents), str(len(contents))))

        record_path = f"{DIST_INFO}/RECORD"
        record_contents = "".join(
            ",".join(record) + "\n" for record in [*records, (record_path, "", "")]
        ).encode()
        archive.writestr(record_path, record_contents)

    print(f"Successfully built {wheel_path}")


if __name__ == "__main__":
    main()
