#!/usr/bin/env python3
"""Rebuild exact-frame catalog masters from preserved manufacturer files."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
ORIGINALS = ROOT / "originals"

SOURCES = {
    "oros-room": (
        ORIGINALS / "oros-room-official-original.jpg",
        "cbf198a9b320bed784cdea0d4235a0c87a5e4c4e2327f082b7d880a5d760c2c0",
    ),
    "oros-detail": (
        ORIGINALS / "oros-detail-official-original.jpg",
        "501ec9d4879051c1dfc8be80af92aab29582dd47e929fa1051cadc5fee6b3843",
    ),
    "madrid-lamp": (
        ORIGINALS / "madrid-lamp-official-original.jpg",
        "db2250d9551931a6b798bb49dfa76a8ac7370bbf0e2cb0b16553a48b411442bf",
    ),
}

# Similarity transform from the 3199 x 4140 manufacturer photograph directly
# to a 2048 x 2048 canvas. It is the merchant photograph's fitted portrait
# presentation scaled from 274 to 2048: uniform scale, 0.047-degree rotation,
# and white side matte. It does not stretch or generatively extend the scene.
OROS_ROOM_TO_2048 = np.array(
    [
        [0.4852833402588243, -0.00039529579711555416, 246.257839649635],
        [0.00039529579711555416, 0.4852833402588243, 17.1147199719708],
    ],
    dtype=np.float64,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_sources() -> None:
    for label, (path, expected) in SOURCES.items():
        actual = sha256(path)
        if actual != expected:
            raise RuntimeError(f"{label}: source hash {actual} does not match {expected}")


def write_oros_room() -> None:
    source = cv2.imread(str(SOURCES["oros-room"][0]), cv2.IMREAD_COLOR)
    if source is None or source.shape[:2] != (4140, 3199):
        raise RuntimeError(f"Unexpected Oros room source shape: {None if source is None else source.shape}")
    master = cv2.warpAffine(
        source,
        OROS_ROOM_TO_2048,
        (2048, 2048),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    parameters = [
        cv2.IMWRITE_JPEG_QUALITY, 97,
        cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444,
        cv2.IMWRITE_JPEG_PROGRESSIVE, 1,
        cv2.IMWRITE_JPEG_OPTIMIZE, 1,
    ]
    if not cv2.imwrite(str(ROOT / "oros-room.jpg"), master, parameters):
        raise RuntimeError("Could not write Oros room master")


def copy_exact_sources() -> None:
    # These originals already match the merchant geometry to subpixel error.
    # Retain their genuine native pixels instead of introducing another resample.
    shutil.copyfile(SOURCES["oros-detail"][0], ROOT / "oros-detail.jpg")
    shutil.copyfile(SOURCES["madrid-lamp"][0], ROOT / "madrid-lamp.jpg")


def main() -> None:
    cv2.setNumThreads(1)
    verify_sources()
    write_oros_room()
    copy_exact_sources()
    for name in ("oros-room.jpg", "oros-detail.jpg", "madrid-lamp.jpg"):
        path = ROOT / name
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"Could not verify {name}")
        print(f"{name}\t{image.shape[1]}x{image.shape[0]}\t{sha256(path)}")


if __name__ == "__main__":
    main()
