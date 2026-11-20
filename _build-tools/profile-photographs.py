"""Measure catalog lighting from small Shopify proofs; keep product originals untouched."""
import argparse
import concurrent.futures
import hashlib
import io
import json
import sys
import tempfile
import urllib.request
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from PIL import Image, ImageOps

PREFIX = "/s/files/1/0289/5239/5911/"
MARKER = "const reviewed = "
COLOR_REFERENCES = {"painting", "watercolor", "print", "woodcut", "oil painting", "lithograph", "acrylic", "drapery"}
PROFILES = ("original", "shadow", "midtones", "contrast", "highlights")


def photo_key(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "cdn.shopify.com" or not parts.path.startswith(PREFIX):
        return None
    return parts.path[len(PREFIX):] + "?" + dict(parse_qsl(parts.query)).get("v", "")


def proof_bytes(url, cache):
    key = photo_key(url)
    file = cache / (hashlib.sha256(key.encode()).hexdigest() + ".jpg") if cache else None
    if file and file.exists():
        return file.read_bytes()
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query))
    query["width"] = "256"
    req = urllib.request.Request(urlunsplit(parts._replace(query=urlencode(query))),
                                 headers={"User-Agent": "Kiss-It-Good-Buy-photo-review/1.0", "Accept": "image/jpeg,image/png"})
    last_error = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                blob = response.read(2_000_001)
            if len(blob) > 2_000_000:
                raise ValueError("Oversized proof")
            with Image.open(io.BytesIO(blob)) as proof:
                proof.verify()
            if file:
                file.write_bytes(blob)
            return blob
        except (OSError, ValueError) as exc:
            last_error = exc
    raise last_error


def lighting(blob):
    with Image.open(io.BytesIO(blob)) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
    # Ignore the outer mat or floor: the center better represents the sale piece.
    w, h = rgb.size
    region = rgb.crop((w // 8, h // 8, w - w // 8, h - h // 8))
    hist = region.convert("L").histogram()
    total = sum(hist)
    def percentile(frac):
        count = 0
        for level, entries in enumerate(hist):
            count += entries
            if count >= frac * total:
                return level
        return 255
    low, mid, high = [percentile(x) for x in (0.05, 0.5, 0.95)]
    # A studio product on white/black, a fabric swatch or a finish detail often
    # has deliberately extreme or very narrow exposure. Leave those alone.
    full = rgb.convert("L").histogram()
    backdrop = sum(full[248:]) + sum(full[:7])
    if backdrop > .22 * w * h or high - low < 54:
        profile = "original"
    elif mid < 74 and high < 211:
        profile = "shadow"
    elif mid < 106 and high < 224:
        profile = "midtones"
    elif high - low < 142 and 52 < mid < 193:
        profile = "contrast"
    elif mid > 188 and low > 64:
        profile = "highlights"
    else:
        profile = "original"
    return profile, [low, mid, high]


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--template", type=Path, default=Path("photo-tones.js"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--review-all", action="store_true")
    args = parser.parse_args()
    if args.cache:
        args.cache.mkdir(parents=True, exist_ok=True)
    source = args.template.read_text()
    line = next(line for line in source.splitlines() if line.startswith(MARKER))
    prior = json.loads(line[len(MARKER):-1])
    known = {key: profile for profile, keys in prior.items() for key in keys}
    pics = {img["src"]: p for p in json.loads(args.inventory.read_text())["products"] for img in p["images"]}
    groups = {profile: [] for profile in PROFILES}
    rows = []

    def check(item):
        url, product = item
        title = product["title"]
        key = photo_key(url)
        if not key:
            return [url, title, None, "unsupported", None]
        color_reference = (product.get("sourceProductType") or "").lower() in COLOR_REFERENCES
        if key in known and not args.review_all:
            return [url, title, "original" if color_reference else known[key], "cached", None]
        try:
            profile, levels = lighting(proof_bytes(url, args.cache))
            if color_reference:
                profile = "original"
            return [url, title, profile, "measured", levels]
        except (OSError, ValueError) as exc:
            print(f"Photo proof unavailable: {url} ({exc})", file=sys.stderr)
            return [url, title, None, "unavailable", None]

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for row in pool.map(check, pics.items()):
            rows.append(row)
            if row[2]:
                groups[row[2]].append(photo_key(row[0]))
    for keys in groups.values():
        keys.sort()
    replacement = MARKER + json.dumps(groups, separators=(",", ":")) + ";"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False) as tmp:
        tmp.write(source.replace(line, replacement, 1))
    Path(tmp.name).chmod(0o644)
    Path(tmp.name).replace(args.output)
    if args.report:
        args.report.write_text(json.dumps(rows, indent=1))
    print(json.dumps({"uniquePhotos": len(pics), "grades": {k:len(v) for k,v in groups.items()},
                      "reviews": dict(Counter(row[3] for row in rows))}))


if __name__ == "__main__":
    run()
