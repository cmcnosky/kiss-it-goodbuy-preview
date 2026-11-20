#!/usr/bin/env python3
"""Create a source-faithful Murano overview from genuine merchant frames.

The base composition is merchant photograph 1. Merchant photographs 2 and 4
are used only where SIFT/RANSAC registration, a bounded piecewise optical-flow
refinement, and local structural correlations all agree with that base. The
fusion replaces only the high-frequency luminance band; color and large-scale
geometry always come from photograph 1.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_bgr(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not decode {path}")
    return image


def project_points(points: np.ndarray, homography: np.ndarray) -> np.ndarray:
    return cv2.perspectiveTransform(points.reshape(-1, 1, 2).astype(np.float32), homography).reshape(-1, 2)


def local_homography_scale(homography: np.ndarray, points: np.ndarray) -> np.ndarray:
    scales = []
    for x, y in points:
        origin = project_points(np.array([[x, y]], np.float32), homography)[0]
        along_x = project_points(np.array([[x + 1.0, y]], np.float32), homography)[0] - origin
        along_y = project_points(np.array([[x, y + 1.0]], np.float32), homography)[0] - origin
        jacobian = np.stack([along_x, along_y], axis=1)
        scales.append(float(np.sqrt(abs(np.linalg.det(jacobian)))))
    return np.asarray(scales, np.float32)


def estimate_homography(detail: np.ndarray, base: np.ndarray, ratio: float, threshold: float) -> dict:
    sift = cv2.SIFT_create(nfeatures=16000, contrastThreshold=0.01, edgeThreshold=15)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    base_gray = clahe.apply(cv2.cvtColor(base, cv2.COLOR_BGR2GRAY))
    detail_gray = clahe.apply(cv2.cvtColor(detail, cv2.COLOR_BGR2GRAY))
    base_keypoints, base_descriptors = sift.detectAndCompute(base_gray, None)
    detail_keypoints, detail_descriptors = sift.detectAndCompute(detail_gray, None)
    if base_descriptors is None or detail_descriptors is None:
        raise RuntimeError("SIFT could not find descriptors")
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    forward = matcher.knnMatch(detail_descriptors, base_descriptors, k=2)
    reverse = matcher.knnMatch(base_descriptors, detail_descriptors, k=2)
    forward = [first for first, second in forward if first.distance < ratio * second.distance]
    reverse_pairs = {(match.trainIdx, match.queryIdx) for match, second in reverse if match.distance < ratio * second.distance}
    matches = [match for match in forward if (match.queryIdx, match.trainIdx) in reverse_pairs]
    if len(matches) < 12:
        raise RuntimeError(f"Only {len(matches)} ratio-tested matches")
    source = np.float32([detail_keypoints[match.queryIdx].pt for match in matches])
    target = np.float32([base_keypoints[match.trainIdx].pt for match in matches])
    homography, inlier_mask = cv2.findHomography(source, target, cv2.USAC_MAGSAC, threshold, maxIters=100000, confidence=0.999)
    if homography is None or inlier_mask is None:
        raise RuntimeError("RANSAC could not find a homography")
    inliers = inlier_mask.ravel().astype(bool)
    source_inliers = source[inliers]
    target_inliers = target[inliers]
    projected = project_points(source_inliers, homography)
    errors = np.linalg.norm(projected - target_inliers, axis=1)
    scales = local_homography_scale(homography, source_inliers)
    return {
        "homography": homography,
        "source_inliers": source_inliers,
        "target_inliers": target_inliers,
        "ratio_matches": len(matches),
        "inliers": int(inliers.sum()),
        "inlier_fraction": float(inliers.mean()),
        "median_reprojection_error": float(np.median(errors)),
        "p95_reprojection_error": float(np.percentile(errors, 95)),
        "median_source_to_base_scale": float(np.median(scales)),
        "median_sampling_gain": float(np.median(1.0 / np.maximum(scales, 1e-6))),
        "ratio_threshold": ratio,
        "magsac_reprojection_threshold": threshold,
    }


def local_correlation(first: np.ndarray, second: np.ndarray, window: int) -> np.ndarray:
    first = first.astype(np.float32)
    second = second.astype(np.float32)
    kernel = (window, window)
    mean_first = cv2.boxFilter(first, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    mean_second = cv2.boxFilter(second, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    mean_product = cv2.boxFilter(first * second, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    mean_first_squared = cv2.boxFilter(first * first, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    mean_second_squared = cv2.boxFilter(second * second, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    covariance = mean_product - mean_first * mean_second
    variance_first = np.maximum(mean_first_squared - mean_first * mean_first, 0.0)
    variance_second = np.maximum(mean_second_squared - mean_second * mean_second, 0.0)
    return covariance / np.sqrt(np.maximum(variance_first * variance_second, 1e-6))


def remove_small_components(mask: np.ndarray, minimum_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    output = np.zeros(mask.shape, np.uint8)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= minimum_area:
            output[labels == label] = 1
    return output


def correlation(first: np.ndarray, second: np.ndarray) -> float:
    first = first.astype(np.float64).ravel()
    second = second.astype(np.float64).ravel()
    first -= first.mean()
    second -= second.mean()
    denominator = np.linalg.norm(first) * np.linalg.norm(second)
    return float(first.dot(second) / denominator) if denominator > 1e-9 else -1.0


def validated_tile_mask(base_high: np.ndarray, warped_high: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    mask = np.zeros(base_high.shape, np.uint8)
    accepted = []
    tile = 32
    # Independent validation found no defensible high-detail correspondence
    # below this upper-tier band. Do not let global background registration
    # become evidence for lower transparent glass.
    for y in range(0, 129, tile):
        for x in range(0, base_high.shape[1] - tile + 1, tile):
            template = base_high[y:y + tile, x:x + tile]
            texture = float(template.std())
            if texture < 5.0 or (valid[y:y + tile, x:x + tile] > 0).mean() < 0.85:
                continue
            best = (-2.0, 0, 0)
            for dy in range(-3, 4):
                for dx in range(-3, 4):
                    yy, xx = y + dy, x + dx
                    if yy < 0 or xx < 0 or yy + tile > base_high.shape[0] or xx + tile > base_high.shape[1]:
                        continue
                    if (valid[yy:yy + tile, xx:xx + tile] > 0).mean() < 0.85:
                        continue
                    value = correlation(template, warped_high[yy:yy + tile, xx:xx + tile])
                    if value > best[0]:
                        best = (value, dx, dy)
            value, dx, dy = best
            if value >= 0.65 and abs(dx) <= 2 and abs(dy) <= 2:
                mask[y:y + tile, x:x + tile] = 1
                accepted.append({"x": x, "y": y, "width": tile, "height": tile, "correlation": value, "dx": dx, "dy": dy, "base_highpass_std": texture})
    return mask, accepted


def piecewise_registration(detail: np.ndarray, base: np.ndarray, registration: dict) -> dict:
    height, width = base.shape[:2]
    homography = registration["homography"]
    warped = cv2.warpPerspective(detail, homography, (width, height), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT)
    valid = cv2.warpPerspective(np.full(detail.shape[:2], 255, np.uint8), homography, (width, height), flags=cv2.INTER_NEAREST) > 0

    base_gray = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
    warped_gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    flow_target = warped_gray.copy()
    flow_target[~valid] = base_gray[~valid]
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setUseSpatialPropagation(True)
    flow = dis.calc(base_gray, flow_target, None)
    flow = cv2.GaussianBlur(flow, (0, 0), 1.15)
    magnitude = np.linalg.norm(flow, axis=2)
    scale = np.minimum(1.0, 4.0 / np.maximum(magnitude, 1e-6))
    flow *= scale[..., None]
    flow[~valid] = 0.0

    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    map_x = grid_x + flow[..., 0]
    map_y = grid_y + flow[..., 1]
    aligned = cv2.remap(warped, map_x, map_y, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT)
    aligned_valid = cv2.remap(valid.astype(np.uint8), map_x, map_y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT) > 0

    base_float = base_gray.astype(np.float32)
    aligned_gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).astype(np.float32)
    base_high = base_float - cv2.GaussianBlur(base_float, (0, 0), 1.65)
    aligned_high = aligned_gray - cv2.GaussianBlur(aligned_gray, (0, 0), 1.65)
    warped_float = warped_gray.astype(np.float32)
    warped_high = warped_float - cv2.GaussianBlur(warped_float, (0, 0), 1.2)
    validation_mask, accepted_tiles = validated_tile_mask(base_float - cv2.GaussianBlur(base_float, (0, 0), 1.2), warped_high, valid)
    high_correlation = local_correlation(base_high, aligned_high, 27)
    intensity_correlation = local_correlation(base_float, aligned_gray, 35)

    base_x = cv2.Sobel(base_float, cv2.CV_32F, 1, 0, ksize=3)
    base_y = cv2.Sobel(base_float, cv2.CV_32F, 0, 1, ksize=3)
    aligned_x = cv2.Sobel(aligned_gray, cv2.CV_32F, 1, 0, ksize=3)
    aligned_y = cv2.Sobel(aligned_gray, cv2.CV_32F, 0, 1, ksize=3)
    kernel = (23, 23)
    gradient_dot = cv2.boxFilter(base_x * aligned_x + base_y * aligned_y, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    base_energy = cv2.boxFilter(base_x * base_x + base_y * base_y, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    aligned_energy = cv2.boxFilter(aligned_x * aligned_x + aligned_y * aligned_y, -1, kernel, normalize=True, borderType=cv2.BORDER_REFLECT)
    gradient_correlation = gradient_dot / np.sqrt(np.maximum(base_energy * aligned_energy, 1e-6))
    texture = np.sqrt(np.maximum(cv2.boxFilter(aligned_high * aligned_high, -1, (13, 13), normalize=True, borderType=cv2.BORDER_REFLECT), 0.0))
    base_texture = np.sqrt(np.maximum(cv2.boxFilter(base_high * base_high, -1, (13, 13), normalize=True, borderType=cv2.BORDER_REFLECT), 0.0))

    hull_mask = np.zeros((height, width), np.uint8)
    hull = cv2.convexHull(registration["target_inliers"].reshape(-1, 1, 2).astype(np.float32)).astype(np.int32)
    cv2.fillConvexPoly(hull_mask, hull, 1)
    hull_mask = cv2.dilate(hull_mask, np.ones((31, 31), np.uint8)) > 0
    safe_valid = cv2.erode(aligned_valid.astype(np.uint8), np.ones((17, 17), np.uint8)) > 0

    high_score = np.clip((high_correlation - 0.50) / 0.34, 0.0, 1.0)
    gradient_score = np.clip((gradient_correlation - 0.54) / 0.34, 0.0, 1.0)
    intensity_score = np.clip((intensity_correlation - 0.68) / 0.27, 0.0, 1.0)
    texture_score = np.clip((np.minimum(texture, base_texture * 1.7 + 1.0) - 1.25) / 4.0, 0.0, 1.0)
    flow_score = np.clip((4.0 - np.linalg.norm(flow, axis=2)) / 3.0, 0.0, 1.0)
    confidence = np.power(np.maximum(high_score * gradient_score * intensity_score * texture_score * flow_score, 0.0), 0.20)
    confidence = np.nan_to_num(confidence, nan=0.0, posinf=0.0, neginf=0.0)
    confidence *= safe_valid & hull_mask & (validation_mask > 0)
    reliable = (confidence >= 0.47).astype(np.uint8)
    reliable = cv2.morphologyEx(reliable, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    reliable = cv2.morphologyEx(reliable, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    reliable = remove_small_components(reliable, 48)
    confidence *= cv2.GaussianBlur(reliable.astype(np.float32), (0, 0), 2.2)

    registration.update({
        "global_warp": warped,
        "aligned": aligned,
        "valid": aligned_valid,
        "flow": flow,
        "confidence": confidence,
        "reliable": reliable,
        "validation_mask": validation_mask,
        "accepted_tiles": accepted_tiles,
        "high_correlation": high_correlation,
        "gradient_correlation": gradient_correlation,
        "intensity_correlation": intensity_correlation,
        "texture": texture,
        "median_piecewise_flow": float(np.median(np.linalg.norm(flow[reliable > 0], axis=1))) if reliable.any() else None,
        "p95_piecewise_flow": float(np.percentile(np.linalg.norm(flow[reliable > 0], axis=1), 95)) if reliable.any() else None,
        "reliable_pixels": int(reliable.sum()),
        "reliable_fraction_of_frame": float(reliable.mean()),
        "median_high_correlation": float(np.median(high_correlation[reliable > 0])) if reliable.any() else None,
        "median_gradient_correlation": float(np.median(gradient_correlation[reliable > 0])) if reliable.any() else None,
        "median_intensity_correlation": float(np.median(intensity_correlation[reliable > 0])) if reliable.any() else None,
    })
    return registration


def align_to_master(detail: np.ndarray, registration: dict, size: int, base_size: int) -> np.ndarray:
    ratio = size / base_size
    scale_matrix = np.array([[ratio, 0.0, 0.0], [0.0, ratio, 0.0], [0.0, 0.0, 1.0]], np.float64)
    global_warp = cv2.warpPerspective(detail, scale_matrix @ registration["homography"], (size, size), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT)
    flow = cv2.resize(registration["flow"], (size, size), interpolation=cv2.INTER_CUBIC) * ratio
    grid_x, grid_y = np.meshgrid(np.arange(size, dtype=np.float32), np.arange(size, dtype=np.float32))
    return cv2.remap(global_warp, grid_x + flow[..., 0], grid_y + flow[..., 1], cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT)


def fuse_high_frequency(
    base: np.ndarray,
    details: list[tuple[np.ndarray, dict]],
    size: int,
) -> tuple[np.ndarray, list[dict], np.ndarray]:
    base_size = base.shape[0]
    base_master = cv2.resize(base, (size, size), interpolation=cv2.INTER_LANCZOS4)
    lab = cv2.cvtColor(base_master, cv2.COLOR_BGR2LAB).astype(np.float32)
    base_luminance = lab[..., 0]
    sigma = 1.05
    base_low = cv2.GaussianBlur(base_luminance, (0, 0), sigma)
    current_high = base_luminance - base_low
    layer_reports = []
    combined_alpha = np.zeros((size, size), np.float32)
    for detail, registration in details:
        aligned = align_to_master(detail, registration, size, base_size)
        source_luminance = cv2.cvtColor(aligned, cv2.COLOR_BGR2LAB).astype(np.float32)[..., 0]
        source_high = source_luminance - cv2.GaussianBlur(source_luminance, (0, 0), sigma)
        confidence = cv2.resize(registration["confidence"], (size, size), interpolation=cv2.INTER_CUBIC)
        confidence = np.clip(confidence, 0.0, 1.0)
        alpha = 0.86 * confidence
        current_high = current_high * (1.0 - alpha) + source_high * alpha
        combined_alpha = np.maximum(combined_alpha, alpha)
        layer_reports.append({"aligned": aligned, "confidence": confidence, "source_high": source_high, "alpha": alpha})
    lab[..., 0] = np.clip(base_low + current_high, 0.0, 255.0)
    fused = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2BGR)
    # A LAB round trip can otherwise move an untouched channel by one code
    # value. Copy the overview back verbatim wherever no validated contributor
    # had any alpha, so unchanged pixels are mathematically unchanged.
    fused[combined_alpha <= 1e-6] = base_master[combined_alpha <= 1e-6]
    return fused, layer_reports, combined_alpha


def laplacian_variance(image: np.ndarray, mask: np.ndarray | None = None) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    laplacian = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    values = laplacian[mask > 0] if mask is not None else laplacian.ravel()
    return float(np.var(values))


def normalized_gradient_correlation(first: np.ndarray, second: np.ndarray, mask: np.ndarray) -> float:
    first_gray = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY).astype(np.float32)
    second_gray = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY).astype(np.float32)
    first_high = first_gray - cv2.GaussianBlur(first_gray, (0, 0), 1.05)
    second_high = second_gray - cv2.GaussianBlur(second_gray, (0, 0), 1.05)
    a = first_high[mask > 0]
    b = second_high[mask > 0]
    if len(a) < 2:
        return float("nan")
    a -= a.mean()
    b -= b.mean()
    return float(np.dot(a, b) / np.sqrt(max(float(np.dot(a, a) * np.dot(b, b)), 1e-12)))


def save_heatmap(path: Path, values: np.ndarray, mask: np.ndarray, low: float = 0.0, high: float = 1.0) -> None:
    normalized = np.nan_to_num(np.clip((values - low) / max(high - low, 1e-6), 0.0, 1.0), nan=0.0)
    heat = cv2.applyColorMap(np.round(normalized * 255).astype(np.uint8), cv2.COLORMAP_TURBO)
    heat[mask == 0] = 0
    cv2.imwrite(str(path), heat)


def save_upper_crown_proof(base_master: np.ndarray, fused: np.ndarray, evidence_dir: Path) -> dict:
    # Exact same-pixel crop at the 1280 master scale. It contains the accepted
    # upper-crown patches without implying that the unchanged lower chandelier
    # was reconstructed from another view.
    x1, y1, x2, y2 = 320, 0, 896, 384
    before = base_master[y1:y2, x1:x2].copy()
    after = fused[y1:y2, x1:x2].copy()
    before_path = evidence_dir / "murano-upper-crown-499f46c-same-scale.png"
    after_path = evidence_dir / "murano-upper-crown-multiframe-same-scale.png"
    cv2.imwrite(str(before_path), before, [cv2.IMWRITE_PNG_COMPRESSION, 5])
    cv2.imwrite(str(after_path), after, [cv2.IMWRITE_PNG_COMPRESSION, 5])

    margin = 22
    heading_height = 100
    gap = 20
    panel_width = before.shape[1]
    sheet = np.full(
        (heading_height + before.shape[0] + margin, panel_width * 2 + gap + margin * 2, 3),
        (245, 241, 232),
        np.uint8,
    )
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(sheet, "MURANO UPPER CROWN - SAME PIXELS, SAME SCALE", (margin, 30), font, 0.68, (42, 37, 33), 1, cv2.LINE_AA)
    cv2.putText(sheet, "BEFORE: merchant overview (499f46c)", (margin, 64), font, 0.48, (72, 63, 57), 1, cv2.LINE_AA)
    cv2.putText(sheet, "AFTER: validated detail from merchant frames 2 + 4", (margin + panel_width + gap, 64), font, 0.43, (72, 63, 57), 1, cv2.LINE_AA)
    cv2.putText(sheet, "No generative pixels; unchanged areas remain the overview photograph.", (margin, 88), font, 0.43, (91, 78, 68), 1, cv2.LINE_AA)
    sheet[heading_height:heading_height + before.shape[0], margin:margin + panel_width] = before
    sheet[heading_height:heading_height + after.shape[0], margin + panel_width + gap:margin + panel_width * 2 + gap] = after
    comparison_path = evidence_dir / "murano-upper-crown-same-scale-comparison.png"
    cv2.imwrite(str(comparison_path), sheet, [cv2.IMWRITE_PNG_COMPRESSION, 5])
    return {
        "crop_at_1280_master": [x1, y1, x2, y2],
        "before": str(before_path),
        "after": str(after_path),
        "comparison": str(comparison_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--master-size", type=int, default=1280)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir = args.output_dir / "evidence"
    output_dir = args.output_dir / "output"
    evidence_dir.mkdir(exist_ok=True)
    output_dir.mkdir(exist_ok=True)

    cv2.setRNGSeed(20261120)
    cv2.setNumThreads(1)
    base_path = args.source_dir / "merchant-overview-1.jpg"
    detail_specs = [
        (args.source_dir / "merchant-detail-2.jpg", 0.84, 3.0),
        (args.source_dir / "merchant-detail-4.jpg", 0.80, 4.0),
    ]
    detail_paths = [spec[0] for spec in detail_specs]
    base = read_bgr(base_path)
    if base.shape[:2] != (640, 640):
        raise RuntimeError(f"Base must be 640x640; got {base.shape[:2]}")

    registrations = []
    details = []
    for path, ratio, threshold in detail_specs:
        detail = read_bgr(path)
        registration = estimate_homography(detail, base, ratio, threshold)
        registration = piecewise_registration(detail, base, registration)
        registrations.append(registration)
        details.append(detail)
        stem = path.stem
        cv2.imwrite(str(evidence_dir / f"{stem}-global-warp.png"), registration["global_warp"])
        cv2.imwrite(str(evidence_dir / f"{stem}-piecewise-aligned.png"), registration["aligned"])
        cv2.imwrite(str(evidence_dir / f"{stem}-reliable-mask.png"), registration["reliable"] * 255)
        cv2.imwrite(str(evidence_dir / f"{stem}-validated-tile-mask.png"), registration["validation_mask"] * 255)
        save_heatmap(evidence_dir / f"{stem}-confidence.png", registration["confidence"], registration["valid"])
        overlay = cv2.addWeighted(base, 0.5, registration["aligned"], 0.5, 0.0)
        overlay[registration["reliable"] == 0] = (overlay[registration["reliable"] == 0] * 0.45).astype(np.uint8)
        cv2.imwrite(str(evidence_dir / f"{stem}-accepted-overlay.png"), overlay)

    fused, layers, combined_alpha = fuse_high_frequency(base, list(zip(details, registrations)), args.master_size)
    master_path = output_dir / "murano-overview-genuine-multiframe-master-1280.png"
    cv2.imwrite(str(master_path), fused, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    base_master = cv2.resize(base, (args.master_size, args.master_size), interpolation=cv2.INTER_LANCZOS4)
    cv2.imwrite(str(output_dir / "murano-overview-499f46c-source-upscaled-1280.png"), base_master, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    downsampled = cv2.resize(fused, (640, 640), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(output_dir / "murano-overview-genuine-multiframe-640.png"), downsampled, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    crop_proof = save_upper_crown_proof(base_master, fused, evidence_dir)

    combined_mask = np.zeros((args.master_size, args.master_size), np.uint8)
    for layer in layers:
        combined_mask[layer["confidence"] >= 0.47] = 1
    layer_metrics = []
    for path, registration, layer in zip(detail_paths, registrations, layers):
        evaluation_mask = (layer["confidence"] >= 0.47).astype(np.uint8)
        layer_metrics.append({
            "source": str(path),
            "source_sha256": sha256(path),
            "ratio_matches": registration["ratio_matches"],
            "inliers": registration["inliers"],
            "inlier_fraction": registration["inlier_fraction"],
            "median_reprojection_error_base_pixels": registration["median_reprojection_error"],
            "p95_reprojection_error_base_pixels": registration["p95_reprojection_error"],
            "median_source_to_base_scale": registration["median_source_to_base_scale"],
            "median_sampling_gain": registration["median_sampling_gain"],
            "ratio_threshold": registration["ratio_threshold"],
            "magsac_reprojection_threshold": registration["magsac_reprojection_threshold"],
            "median_piecewise_flow_base_pixels": registration["median_piecewise_flow"],
            "p95_piecewise_flow_base_pixels": registration["p95_piecewise_flow"],
            "reliable_pixels_at_640": registration["reliable_pixels"],
            "reliable_fraction_of_frame": registration["reliable_fraction_of_frame"],
            "accepted_highpass_tiles": registration["accepted_tiles"],
            "median_high_frequency_correlation": registration["median_high_correlation"],
            "median_gradient_orientation_correlation": registration["median_gradient_correlation"],
            "median_intensity_correlation": registration["median_intensity_correlation"],
            "baseline_to_source_high_frequency_correlation": normalized_gradient_correlation(base_master, layer["aligned"], evaluation_mask),
            "fused_to_source_high_frequency_correlation": normalized_gradient_correlation(fused, layer["aligned"], evaluation_mask),
        })

    baseline_down = cv2.resize(base_master, (640, 640), interpolation=cv2.INTER_AREA)
    difference = cv2.absdiff(baseline_down, downsampled)
    master_difference = cv2.absdiff(base_master, fused)
    outside_active = combined_alpha <= 1e-6
    changed_outside_active = np.any(master_difference > 0, axis=2) & outside_active
    metrics = {
        "method": "SIFT/RANSAC global homography, bounded DIS piecewise alignment, local structural-correlation masks, luminance high-frequency fusion",
        "base": {"path": str(base_path), "sha256": sha256(base_path), "dimensions": [640, 640]},
        "details": layer_metrics,
        "master": {"path": str(master_path), "sha256": sha256(master_path), "dimensions": [args.master_size, args.master_size]},
        "combined_reliable_pixels_at_master": int(combined_mask.sum()),
        "combined_reliable_fraction_of_frame": float(combined_mask.mean()),
        "active_feathered_contribution_pixels_at_master": int((combined_alpha > 1e-6).sum()),
        "active_feathered_contribution_fraction_of_frame": float((combined_alpha > 1e-6).mean()),
        "outside_contribution_exact_preservation": {
            "changed_pixels": int(changed_outside_active.sum()),
            "maximum_absolute_channel_difference": int(master_difference[outside_active].max()) if outside_active.any() else 0,
        },
        "same_scale_upper_crown_proof": crop_proof,
        "laplacian_variance_in_fused_regions": {
            "499f46c_source_upscaled": laplacian_variance(base_master, combined_mask),
            "multiframe_fused": laplacian_variance(fused, combined_mask),
        },
        "downsampled_640_difference": {
            "mean_absolute_channel_difference": float(difference.mean()),
            "p95_absolute_channel_difference": float(np.percentile(difference, 95)),
            "maximum_absolute_channel_difference": int(difference.max()),
        },
        "limitations": [
            "Only the upper chandelier regions overlap at meaningfully higher sampling in the genuine close merchant frames.",
            "The lower tier and surrounding room remain photograph 1 enlarged; no absent detail is synthesized.",
            "Transparent glass and camera parallax prevent reliable whole-frame replacement, so low-correlation pixels are excluded.",
        ],
    }
    metrics_path = evidence_dir / "fusion-metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
