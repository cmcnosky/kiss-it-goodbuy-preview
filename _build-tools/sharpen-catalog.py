"""Build conservative, luma-only sharpened JPEG renditions of Shopify catalog photographs."""

import argparse
import concurrent.futures
import hashlib
import io
import json
import re
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from PIL import Image, ImageChops, ImageCms, ImageFilter, ImageOps, ImageStat, __version__ as PILLOW_VERSION


SHOPIFY_PREFIX = "/s/files/1/0289/5239/5911/"
ALGORITHM = "catalog-sharpen-v1"
PIPELINE_DIGEST = hashlib.sha256(Path(__file__).read_bytes() + b"\0Pillow-" + PILLOW_VERSION.encode()).hexdigest()[:16]
TARGET_WIDTHS = (192, 480, 960, 1600)
MAX_SOURCE_BYTES = 30_000_000
MAX_PIXELS = 30_000_000


def photo_key(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "cdn.shopify.com" or not parts.path.startswith(SHOPIFY_PREFIX):
        return None
    return parts.path[len(SHOPIFY_PREFIX):] + "?" + dict(parse_qsl(parts.query)).get("v", "")


def target_widths(native_width):
    native_width = min(int(native_width), TARGET_WIDTHS[-1])
    widths = [width for width in TARGET_WIDTHS if width < native_width]
    # An almost-identical intermediate only adds bytes and cannot improve selection.
    if widths and widths[-1] / native_width > 0.82:
        widths.pop()
    return [*widths, native_width]


def source_bytes(url, cache):
    key = photo_key(url)
    cached = cache / "sources" / (hashlib.sha256(key.encode()).hexdigest() + ".source") if cache else None
    if cached and cached.exists():
        return cached.read_bytes(), True
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Kiss-It-Good-Buy-catalog-clarity/1.0",
            "Accept": "image/jpeg,image/png,image/webp",
        },
    )
    last_error = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                blob = response.read(MAX_SOURCE_BYTES + 1)
            if len(blob) > MAX_SOURCE_BYTES:
                raise ValueError("source photograph exceeds the 30 MB safety limit")
            with Image.open(io.BytesIO(blob)) as image:
                image.verify()
            if cached:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(blob)
            return blob, False
        except (OSError, ValueError) as error:
            last_error = error
    raise last_error


def open_rgb(blob):
    with Image.open(io.BytesIO(blob)) as source:
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("source photograph exceeds the 30-megapixel safety limit")
        image = ImageOps.exif_transpose(source)
        icc = image.info.get("icc_profile")
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            background.alpha_composite(rgba)
            image = background.convert("RGB")
            return image, "alpha-composited-srgb"
        elif icc:
            try:
                image = ImageCms.profileToProfile(
                    image,
                    ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                )
                return image, "converted-to-srgb"
            except (ImageCms.PyCMSError, OSError, ValueError):
                return image.convert("RGB"), "invalid-profile-assumed-srgb"
        return image.convert("RGB"), "untagged-assumed-srgb"


def sharpened(image, width):
    height = max(1, round(image.height * width / image.width))
    resized = image if image.size == (width, height) else image.resize((width, height), Image.Resampling.LANCZOS)
    red, green, blue = resized.split()
    y = resized.convert("L")
    radius = 0.85 if width <= 480 else 1.05
    detail = ImageChops.difference(y, y.filter(ImageFilter.GaussianBlur(radius)))
    detail_rms = ImageStat.Stat(detail).rms[0]
    if detail_rms <= 2.2:
        percent, threshold = 135, 1
    elif detail_rms <= 6:
        percent, threshold = 125, 2
    elif detail_rms <= 12:
        percent, threshold = 110, 3
    else:
        percent, threshold = 85, 5
    crisp_y = y.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))
    mean_change = ImageStat.Stat(ImageChops.difference(y, crisp_y)).mean[0]
    # Apply a bounded luminance delta to the original RGB channels. This avoids
    # chroma shifts from a YCbCr round trip and limits halos on glass or linework.
    delta = ImageChops.subtract(crisp_y, y, offset=128).point(lambda value: max(110, min(146, value)))
    output = Image.merge("RGB", tuple(ImageChops.add(channel, delta, offset=-128) for channel in (red, green, blue)))
    return output, {
        "detailRms": round(detail_rms, 3),
        "meanLumaChange": round(mean_change, 3),
        "radius": radius,
        "percent": percent,
        "threshold": threshold,
    }


def jpeg_bytes(image):
    output = io.BytesIO()
    image.save(output, "JPEG", quality=88, subsampling=0, optimize=True, progressive=True)
    return output.getvalue()


def cache_path(cache, key, width):
    if not cache:
        return None
    identity = hashlib.sha256(f"{ALGORITHM}\0{PIPELINE_DIGEST}\0{key}\0{width}".encode()).hexdigest()
    return cache / "renditions" / f"{identity}.jpg"


def render_photo(item, output_dir, cache):
    url, declared_width, declared_height = item
    key = photo_key(url)
    if not key:
        return {"url": url, "status": "unsupported"}
    blob, source_cached = source_bytes(url, cache)
    image, color_handling = open_rgb(blob)
    declared = [declared_width, declared_height]
    dimension_mismatch = any(
        value and value != actual
        for value, actual in zip(declared, [image.width, image.height])
    )
    width_cap = image.width
    if declared_width:
        width_cap = min(width_cap, declared_width)
    if declared_height:
        width_cap = min(width_cap, max(1, int(declared_height * image.width / image.height)))
    sources = []
    measures = []
    derivative_cached = 0
    for width in target_widths(width_cap):
        cached = cache_path(cache, key, width)
        if cached and cached.exists():
            encoded = cached.read_bytes()
            derivative_cached += 1
            # Measurements are advisory and omitted on cached daily rebuilds.
            metrics = None
        else:
            rendition, metrics = sharpened(image, width)
            encoded = jpeg_bytes(rendition)
            if cached:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(encoded)
        digest = hashlib.sha256(encoded).hexdigest()
        name = digest[:24] + ".jpg"
        destination = output_dir / name
        if not destination.exists():
            destination.write_bytes(encoded)
        elif hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
            raise ValueError(f"content-addressed derivative collision at {destination}")
        height = max(1, round(image.height * width / image.width))
        sources.append([width, height, "assets/catalog-clarity/" + name])
        if metrics:
            measures.append({"width": width, **metrics})
    return {
        "key": key,
        "url": url,
        "status": "sharpened",
        "native": [image.width, image.height],
        "declared": declared,
        "dimensionMismatch": dimension_mismatch,
        "colorHandling": color_handling,
        "sources": sources,
        "measurements": measures,
        "sourceCached": source_cached,
        "derivativesCached": derivative_cached,
    }


def write_manifest(path, photos):
    payload = {key: sources for key, sources in sorted(photos.items())}
    script = (
        "(function(root){'use strict';root.KIGBPhotoSharpness=Object.freeze({"
        + "algorithm:"
        + json.dumps(ALGORITHM)
        + ",pipelineDigest:"
        + json.dumps(PIPELINE_DIGEST)
        + ",photos:Object.freeze("
        + json.dumps(payload, separators=(",", ":"))
        + ")});})(typeof globalThis!=='undefined'?globalThis:window);\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as temporary:
        temporary.write(script)
    Path(temporary.name).chmod(0o644)
    Path(temporary.name).replace(path)


def prune_files(directory, active_names, owned_pattern):
    if not directory.exists():
        return 0
    removed = 0
    for entry in directory.iterdir():
        if entry.is_file() and re.fullmatch(owned_pattern, entry.name) and entry.name not in active_names:
            entry.unlink()
            removed += 1
    return removed


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text())
    items = {}
    for product in inventory["products"]:
        for image in product.get("images", []):
            width = int(image["width"]) if int(image.get("width") or 0) > 0 else None
            height = int(image["height"]) if int(image.get("height") or 0) > 0 else None
            items[image["src"]] = (image["src"], width, height)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.cache:
        args.cache.mkdir(parents=True, exist_ok=True)
    rows = []
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 12))) as pool:
        future_rows = {pool.submit(render_photo, item, args.output_dir, args.cache): item[0] for item in items.values()}
        for completed, future in enumerate(concurrent.futures.as_completed(future_rows), 1):
            try:
                rows.append(future.result())
            except Exception as error:
                errors.append({"url": future_rows[future], "error": str(error)})
            if completed % 100 == 0:
                print(f"Processed {completed}/{len(future_rows)} photographs", file=sys.stderr)
    photos = {row["key"]: row["sources"] for row in rows if row["status"] == "sharpened"}
    active_outputs = {Path(source[2]).name for sources in photos.values() for source in sources}
    report = {
        "algorithm": ALGORITHM,
        "pipelineDigest": PIPELINE_DIGEST,
        "inventoryPhotos": len(items),
        "sharpenedPhotos": len(photos),
        "failedPhotos": len(errors),
        "renditions": sum(len(row.get("sources", [])) for row in rows),
        "outputBytes": sum((args.output_dir / name).stat().st_size for name in active_outputs),
        "rows": sorted(rows, key=lambda row: row["url"]),
        "errors": errors,
    }
    print(json.dumps({key: report[key] for key in ("inventoryPhotos", "sharpenedPhotos", "failedPhotos", "renditions", "outputBytes")}))
    if errors:
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=1))
        raise SystemExit(f"Refusing an incomplete catalog: {len(errors)} sharpening failures")
    write_manifest(args.manifest, photos)
    prune_files(args.output_dir, active_outputs, r"[0-9a-f]{24}\.jpg")
    if args.cache:
        active_sources = {hashlib.sha256(key.encode()).hexdigest() + ".source" for key in photos}
        active_renditions = {
            cache_path(args.cache, key, source[0]).name
            for key, sources in photos.items()
            for source in sources
        }
        report["prunedCacheFiles"] = (
            prune_files(args.cache / "sources", active_sources, r"[0-9a-f]{64}\.source")
            + prune_files(args.cache / "renditions", active_renditions, r"[0-9a-f]{64}\.jpg")
        )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    run()
