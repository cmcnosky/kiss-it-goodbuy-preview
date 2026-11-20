"""Build restrained, detail-preserving JPEG renditions of Shopify catalog photographs."""

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

import numpy as np
from PIL import Image, ImageCms, ImageFilter, ImageOps, __version__ as PILLOW_VERSION


SHOPIFY_PREFIX = "/s/files/1/0289/5239/5911/"
ALGORITHM = "catalog-sharpen-v2"
PIPELINE_DIGEST = hashlib.sha256(
    Path(__file__).read_bytes()
    + b"\0Pillow-"
    + PILLOW_VERSION.encode()
    + b"\0NumPy-"
    + np.__version__.encode()
).hexdigest()[:16]
# A versioned merchant key and the original file hash both bind each approved replacement.
PHOTO_SOURCES = Path(__file__).parent / "photo-sources"
REGISTERED_MASTERS = json.loads((PHOTO_SOURCES / "catalog-masters.json").read_text())
TARGET_WIDTHS = (192, 480, 960, 1600)
MAX_SOURCE_BYTES = 30_000_000
MAX_PIXELS = 30_000_000
JPEG_QUALITY = 92


def photo_key(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "cdn.shopify.com" or not parts.path.startswith(SHOPIFY_PREFIX):
        return None
    return parts.path[len(SHOPIFY_PREFIX):] + "?" + dict(parse_qsl(parts.query)).get("v", "")


def target_widths(native_width):
    native_width = int(native_width)
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
        source_format = source.format
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("source photograph exceeds the 30-megapixel safety limit")
        image = ImageOps.exif_transpose(source)
        icc = image.info.get("icc_profile")
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            background.alpha_composite(rgba)
            image = background.convert("RGB")
            return image, "alpha-composited-srgb", source_format
        elif icc:
            try:
                image = ImageCms.profileToProfile(
                    image,
                    ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                )
                return image, "converted-to-srgb", source_format
            except (ImageCms.PyCMSError, OSError, ValueError):
                return image.convert("RGB"), "invalid-profile-assumed-srgb", source_format
        return image.convert("RGB"), "untagged-assumed-srgb", source_format


def luma(rgb):
    return rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722


def blurred(values, radius):
    plane = Image.fromarray(np.clip(np.rint(values), 0, 255).astype(np.uint8), "L")
    return np.asarray(plane.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)


def noise_estimate(values, fine_detail):
    if min(values.shape) < 2:
        return 0.0
    vertical, horizontal = np.gradient(values)
    flat = (np.abs(vertical) + np.abs(horizontal)) < 5.0
    sample = fine_detail[flat] if np.count_nonzero(flat) >= 256 else fine_detail.ravel()
    center = np.median(sample)
    return float(np.median(np.abs(sample - center)) * 1.4826)


def soft_threshold(values, threshold):
    return np.sign(values) * np.maximum(np.abs(values) - threshold, 0.0)


def protect_extremes(delta, values):
    # Preserve clean whites, deep blacks and already-clipped source pixels.
    headroom = np.minimum(values, 255.0 - values)
    return delta * np.clip((headroom - 1.5) / 12.0, 0.0, 1.0)


def with_luma_delta(image, values, delta):
    rgb = np.asarray(image, dtype=np.float32)
    protected = protect_extremes(delta, values)
    # Adding the same delta to all three channels preserves chroma until a
    # channel clips. Constrain the delta to the available RGB headroom so even
    # saturated upholstery, glass and artwork retain their recorded color.
    lower = -np.min(rgb, axis=2)
    upper = np.min(255.0 - rgb, axis=2)
    applied = np.clip(protected, lower, upper)
    adjusted = rgb + applied[:, :, None]
    encoded = np.clip(np.rint(adjusted), 0, 255).astype(np.uint8)
    newly_clipped = np.count_nonzero(
        ((encoded == 0) | (encoded == 255)) & ((rgb > 0) & (rgb < 255))
    ) / encoded.size
    output = Image.fromarray(encoded, "RGB")
    return output, float(newly_clipped), applied


def block_ratio(values):
    ratios = []
    for differences, direction in (
        (np.abs(np.diff(values, axis=1)), "vertical"),
        (np.abs(np.diff(values, axis=0)), "horizontal"),
    ):
        boundary = differences[:, 7::8] if direction == "vertical" else differences[7::8, :]
        if not boundary.size:
            continue
        mask = np.ones(differences.shape, dtype=bool)
        if direction == "vertical":
            mask[:, 7::8] = False
        else:
            mask[7::8, :] = False
        interior = differences[mask]
        if interior.size:
            ratios.append(float(boundary.mean() / max(float(interior.mean()), 1e-6)))
    return float(sum(ratios) / len(ratios)) if ratios else 1.0


def deblock(values):
    """Soften only small, isolated jumps on the JPEG eight-pixel grid."""
    before = block_ratio(values)
    # A ratio near one is normal image structure. Intervene only when the
    # eight-pixel grid is materially stronger than ordinary neighboring detail.
    if before < 1.15:
        return values, {"blockRatioBefore": round(before, 4), "blockRatioAfter": round(before, 4), "deblockedFraction": 0.0}

    output = values.copy()
    changed = 0
    possible = values.size
    for axis in (1, 0):
        work = values if axis == 1 else values.T
        result = output if axis == 1 else output.T
        boundaries = np.arange(8, work.shape[1], 8)
        boundaries = boundaries[(boundaries >= 2) & (boundaries + 1 < work.shape[1])]
        if not boundaries.size:
            continue
        previous = work[:, boundaries - 1]
        following = work[:, boundaries]
        left_slope = previous - work[:, boundaries - 2]
        right_slope = work[:, boundaries + 1] - following
        jump = following - previous
        neighboring = np.maximum(np.abs(left_slope), np.abs(right_slope))
        mask = (
            (np.abs(jump) <= 12.0)
            & (neighboring <= 6.0)
            & (np.abs(jump) > neighboring * 1.25 + 0.5)
        )
        correction = np.where(mask, np.clip(jump * 0.24, -2.25, 2.25), 0.0)
        result[:, boundaries - 1] += correction
        result[:, boundaries] -= correction
        result[:, boundaries - 2] += correction * 0.10
        result[:, boundaries + 1] -= correction * 0.10
        changed += int(np.count_nonzero(mask))
    after = block_ratio(output)
    return output, {
        "blockRatioBefore": round(before, 4),
        "blockRatioAfter": round(after, 4),
        "deblockedFraction": round(changed / possible, 6),
    }


def prepared_source(image, source_format):
    rgb = np.asarray(image, dtype=np.float32)
    original_y = luma(rgb)
    working_y = original_y
    deblock_metrics = {"blockRatioBefore": None, "blockRatioAfter": None, "deblockedFraction": 0.0}
    if source_format == "JPEG":
        working_y, deblock_metrics = deblock(working_y)

    fine = working_y - blurred(working_y, 0.72)
    detail_rms = float(np.sqrt(np.mean(np.square(fine))))
    noise = noise_estimate(working_y, fine)
    if detail_rms <= 2.2:
        amount = 0.34
    elif detail_rms <= 6.0:
        amount = 0.25
    elif detail_rms <= 12.0:
        amount = 0.16
    else:
        amount = 0.08
    if min(image.size) < 480:
        # Tiny merchant files are already the limiting record. Do not make
        # compression edges masquerade as recoverable object detail.
        amount *= 0.55
    fine_delta = soft_threshold(fine, max(0.35, min(2.4, noise * 0.45))) * amount
    local_radius = max(3.0, min(8.0, min(image.size) / 150.0))
    local_amount = 0.03 if min(image.size) < 480 else (0.04 if noise > 4.0 or detail_rms > 12.0 else 0.06)
    local_delta = np.clip(working_y - blurred(working_y, local_radius), -18.0, 18.0) * local_amount
    delta = np.clip((working_y - original_y) + fine_delta + local_delta, -5.0, 5.0)
    output, newly_clipped, applied = with_luma_delta(image, original_y, delta)
    return output, {
        **deblock_metrics,
        "detailRms": round(detail_rms, 3),
        "noiseEstimate": round(noise, 3),
        "deconvolutionAmount": amount,
        "localContrastAmount": local_amount,
        "meanLumaChange": round(float(np.mean(np.abs(applied))), 3),
        "newlyClippedFraction": round(newly_clipped, 8),
    }


def sharpened(image, width):
    height = max(1, round(image.height * width / image.width))
    resized = image if image.size == (width, height) else image.resize((width, height), Image.Resampling.LANCZOS)
    values = luma(np.asarray(resized, dtype=np.float32))
    radius = 0.72 if width <= 480 else 0.90
    detail = values - blurred(values, radius)
    detail_rms = float(np.sqrt(np.mean(np.square(detail))))
    noise = noise_estimate(values, detail)
    if detail_rms <= 2.2:
        amount = 1.20
    elif detail_rms <= 6.0:
        amount = 1.05
    elif detail_rms <= 12.0:
        amount = 0.85
    else:
        amount = 0.55
    threshold = max(0.75, min(4.0, noise * 0.70))
    fine_delta = soft_threshold(detail, threshold) * amount
    local_radius = 3.5 if width <= 480 else 5.0
    local_amount = 0.05 if noise > 4.0 or detail_rms < 2.2 else 0.07
    local_delta = np.clip(values - blurred(values, local_radius), -20.0, 20.0) * local_amount
    delta = np.clip(fine_delta + local_delta, -14.0, 14.0)
    output, newly_clipped, applied = with_luma_delta(resized, values, delta)
    mean_change = float(np.mean(np.abs(applied)))
    return output, {
        "detailRms": round(detail_rms, 3),
        "meanLumaChange": round(mean_change, 3),
        "radius": radius,
        "amount": amount,
        "threshold": round(threshold, 3),
        "noiseEstimate": round(noise, 3),
        "localContrastAmount": local_amount,
        "newlyClippedFraction": round(newly_clipped, 8),
    }


def jpeg_bytes(image):
    output = io.BytesIO()
    image.save(output, "JPEG", quality=JPEG_QUALITY, subsampling=0, optimize=True, progressive=True)
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
    image, color_handling, source_format = open_rgb(blob)
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
    registered_width = None
    rendition_key = key
    registration = REGISTERED_MASTERS.get(key)
    if registration:
        original_hash = hashlib.sha256(blob).hexdigest()
        rendition_key += ":" + original_hash
        # Shopify can negotiate different encodings of the same exact frame.
        approved_hashes = [registration["originalSha256"], *registration.get("alternateOriginalSha256", [])]
        if original_hash in approved_hashes:
            master = (PHOTO_SOURCES / registration["file"]).read_bytes()
            master_hash = hashlib.sha256(master).hexdigest()
            if master_hash != registration["masterSha256"]:
                raise ValueError(f"Catalog photograph master failed its integrity check: {key}")
            image, color_handling, source_format = open_rgb(master)
            registered_width = width_cap = image.width
            rendition_key += ":" + master_hash
    image, source_processing = prepared_source(image, source_format)
    sources = []
    measures = []
    derivative_cached = 0
    for width in target_widths(width_cap):
        cached = cache_path(cache, rendition_key, width)
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
        "sourceFormat": source_format,
        "sourceProcessing": source_processing,
        "registeredWidth": registered_width,
        "renditionKey": rendition_key,
        "jpegQuality": JPEG_QUALITY,
        "sources": sources,
        "measurements": measures,
        "sourceCached": source_cached,
        "derivativesCached": derivative_cached,
    }


def write_manifest(path, photos, registered_widths):
    payload = {key: sources for key, sources in sorted(photos.items())}
    script = (
        "(function(root){'use strict';root.KIGBPhotoSharpness=Object.freeze({"
        + "algorithm:"
        + json.dumps(ALGORITHM)
        + ",pipelineDigest:"
        + json.dumps(PIPELINE_DIGEST)
        + ",registeredWidths:Object.freeze("
        + json.dumps(registered_widths, separators=(",", ":"))
        + "),photos:Object.freeze("
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
    registered_widths = {row["key"]: row["registeredWidth"] for row in rows if row.get("registeredWidth")}
    write_manifest(args.manifest, photos, registered_widths)
    prune_files(args.output_dir, active_outputs, r"[0-9a-f]{24}\.jpg")
    if args.cache:
        active_sources = {hashlib.sha256(key.encode()).hexdigest() + ".source" for key in photos}
        active_renditions = {
            cache_path(args.cache, row["renditionKey"], source[0]).name
            for row in rows if row["status"] == "sharpened"
            for source in row["sources"]
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
