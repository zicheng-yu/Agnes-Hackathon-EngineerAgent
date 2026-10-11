"""Local, calibrated comparison of corresponding cropped 2-D views.

No automatic page understanding, unconstrained image fitting or anisotropic scaling.
"""
from __future__ import annotations

from io import BytesIO
import math
from pathlib import Path
import re
from xml.etree import ElementTree as ET

import numpy as np
from PIL import Image
import resvg_py
from scipy.ndimage import binary_erosion, distance_transform_edt, find_objects, label

from engine import CadError, numeric, vector, write_json


def rasterize(path, visible_only=False):
    path = Path(path).expanduser().resolve()
    if not path.is_file() or path.stat().st_size > 20_000_000:
        raise CadError("INVALID_IMAGE", "Expected a PNG/SVG file of at most 20 MB.")
    if path.suffix.lower() == ".svg":
        source = path.read_text(encoding="utf-8")
        if "<!DOCTYPE" in source.upper() or "<!ENTITY" in source.upper():
            raise CadError("INVALID_SVG", "SVG document types and entities are not supported.")
        root = ET.fromstring(source)
        for element in root.iter():
            for attribute, value in element.attrib.items():
                if attribute.endswith("href") and not value.startswith("#"):
                    raise CadError("INVALID_SVG", "External SVG resources are not supported.")
            if element.tag.rsplit("}", 1)[-1] in {"script", "foreignObject", "image"}:
                raise CadError("INVALID_SVG", "SVG must contain vector drawing elements only.")
        for parent in root.iter():
            for element in list(parent):
                if visible_only and element.get("stroke-dasharray"):
                    parent.remove(element)
        dimensions = []
        for key in ["width", "height"]:
            match = re.match(r"^([\d.]+)(px)?$", root.get(key, ""))
            if match:
                dimensions.append(float(match[1]))
        if len(dimensions) == 2 and (max(dimensions) > 6000 or math.prod(dimensions) > 12_000_000):
            raise CadError("RESOURCE_LIMIT", "SVG raster size exceeds 12 megapixels.")
        rendered = resvg_py.svg_to_bytes(svg_string=ET.tostring(root, encoding="unicode"), background="#ffffff", skip_system_fonts=True)
        image = Image.open(BytesIO(rendered)).convert("RGBA")
    elif path.suffix.lower() == ".png":
        image = Image.open(path).convert("RGBA")
    else:
        raise CadError("UNSUPPORTED_IMAGE", "View comparison supports PNG or vector SVG.")
    if image.width * image.height > 12_000_000 or max(image.size) > 6000:
        raise CadError("RESOURCE_LIMIT", "Raster size exceeds 12 megapixels.")
    background = Image.new("RGBA", image.size, "white")
    return Image.alpha_composite(background, image).convert("L")


def load_view(spec):
    pixels_per_mm = numeric(spec["px_per_mm"], True)
    image = rasterize(spec["path"], spec.get("svg_visible_only", False))
    if "crop" in spec:
        x, y, width, height = [int(numeric(v)) for v in spec["crop"]]
        if min(x, y) < 0 or min(width, height) <= 0 or x + width > image.width or y + height > image.height:
            raise CadError("INVALID_CROP", "Crop must be fully inside the image with positive width and height.")
        image = image.crop((x, y, x + width, y + height))
    return image, pixels_per_mm


def contour_mask(image, threshold):
    ink = np.asarray(image) < threshold
    return ink & ~binary_erosion(ink, border_value=0)


def component_regions(mask, limit=20):
    regions, count = label(mask, structure=np.ones((3, 3), dtype=int))
    found = []
    slices = find_objects(regions)
    counts = np.bincount(regions.ravel(), minlength=count + 1)
    for component in np.argsort(counts[1:])[::-1][:limit] + 1:
        ys, xs = slices[component - 1]
        found.append({"pixels": int(counts[component]), "bbox_px": [xs.start, ys.start, xs.stop - xs.start, ys.stop - ys.start]})
    return sorted(found, key=lambda item: item["pixels"], reverse=True)[:limit]


def compare_views(payload, output):
    if payload.get("pre_cropped_views") is not True:
        raise CadError("VIEW_CONFIRMATION_REQUIRED", "Set pre_cropped_views=true only for corresponding isolated views. Whole-page automatic registration is not implemented.")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source, source_scale = load_view(payload["source"])
    projection, projection_scale = load_view(payload["projection"])
    registration = payload.get("registration")
    if not isinstance(registration, dict):
        raise CadError("REGISTRATION_REQUIRED", "Supply an explicit rigid registration, including rotation_degrees and translation_px.")
    allowed = {"rotation_degrees", "translation_px", "source_origin_px", "projection_origin_px"}
    if set(registration) - allowed:
        raise CadError("NONRIGID_REGISTRATION", "Only rotation and translation are accepted; uniform scale is derived from the two px_per_mm calibrations.")
    angle = math.radians(numeric(registration["rotation_degrees"]))
    translation = np.array(vector(registration["translation_px"], 2))
    source_origin = np.array(vector(registration.get("source_origin_px", [0, 0]), 2))
    projection_origin = np.array(vector(registration.get("projection_origin_px", [0, 0]), 2))
    uniform_scale = source_scale / projection_scale
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    forward = rotation * uniform_scale
    offset = source_origin + translation - forward @ projection_origin
    inverse = np.linalg.inv(forward)
    inverse_offset = -inverse @ offset
    affine = (inverse[0, 0], inverse[0, 1], inverse_offset[0], inverse[1, 0], inverse[1, 1], inverse_offset[1])
    threshold = int(numeric(payload.get("ink_threshold", 190)))
    if not 1 <= threshold <= 254:
        raise CadError("INVALID_THRESHOLD", "ink_threshold must be between 1 and 254.")
    original_edges = contour_mask(projection, threshold)
    py, px = np.nonzero(original_edges)
    transformed_points = np.column_stack([px, py]) @ forward.T + offset
    if len(transformed_points) and (np.any(transformed_points[:, 0] < -0.5) or np.any(transformed_points[:, 1] < -0.5) or np.any(transformed_points[:, 0] > source.width - 0.5) or np.any(transformed_points[:, 1] > source.height - 0.5)):
        raise CadError("REGISTRATION_CLIPS_GEOMETRY", "The registered projection leaves the source canvas. Expand the crop/canvas; discarded geometry must not disappear from the score.")
    registered = projection.transform(source.size, Image.Transform.AFFINE, affine, resample=Image.Resampling.BICUBIC, fillcolor=255)
    source_edges, projected_edges = contour_mask(source, threshold), contour_mask(registered, threshold)
    exclusion = np.zeros(source_edges.shape, dtype=bool)
    for region in payload.get("exclude_regions", []):
        x, y, width, height = [int(numeric(v)) for v in region]
        if min(x, y) < 0 or min(width, height) <= 0 or x + width > source.width or y + height > source.height:
            raise CadError("INVALID_EXCLUSION", "Exclude regions must be inside the registered source canvas.")
        exclusion[y:y + height, x:x + width] = True
    source_edges[exclusion] = False
    projected_edges[exclusion] = False
    if not source_edges.any() or not projected_edges.any():
        raise CadError("EMPTY_VIEW", "Both corresponding views must contain nonempty geometry contours after exclusion.")
    tolerance_mm = numeric(payload.get("tolerance_mm", 0.15))
    if tolerance_mm < 0:
        raise CadError("INVALID_TOLERANCE", "Tolerance must be nonnegative.")
    normalization = numeric(payload["normalization_length_mm"], True)
    source_to_projection = distance_transform_edt(~projected_edges)[source_edges] / source_scale
    projection_to_source = distance_transform_edt(~source_edges)[projected_edges] / source_scale
    missing = np.zeros_like(source_edges)
    extra = np.zeros_like(projected_edges)
    missing[source_edges] = source_to_projection > tolerance_mm
    extra[projected_edges] = projection_to_source > tolerance_mm
    missing_count, extra_count = int(missing.sum()), int(extra.sum())
    n_source, n_projected = int(source_edges.sum()), int(projected_edges.sum())
    symmetric_mean = float((source_to_projection.mean() + projection_to_source.mean()) / 2)
    distances = np.concatenate([source_to_projection, projection_to_source])
    precision, recall = 1 - extra_count / n_projected, 1 - missing_count / n_source
    minimum_match = numeric(payload.get("minimum_match_fraction", 0.98))
    if not 0 <= minimum_match <= 1:
        raise CadError("INVALID_THRESHOLD", "minimum_match_fraction must be between zero and one.")
    metrics = {"source_edge_pixels": n_source, "projection_edge_pixels": n_projected,
               "missing_pixels": missing_count, "extra_pixels": extra_count,
               "missing_fraction": missing_count / n_source, "extra_fraction": extra_count / n_projected,
               "precision": precision, "recall": recall, "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0,
               "symmetric_mean_distance_mm": symmetric_mean, "p95_distance_mm": float(np.percentile(distances, 95)),
               "max_distance_mm": float(distances.max()), "normalized_mean_distance": symmetric_mean / normalization,
               "normalization_length_mm": normalization, "tolerance_mm": tolerance_mm,
               "missing_regions": component_regions(missing), "extra_regions": component_regions(extra)}
    overlay = np.full((*source_edges.shape, 3), 248, dtype=np.uint8)
    overlay[source_edges | projected_edges] = [55, 146, 109]
    overlay[missing] = [222, 65, 54]
    overlay[extra] = [27, 112, 206]
    overlay[exclusion] = [220, 222, 224]
    Image.fromarray(overlay).save(output / "overlay.png")
    Image.fromarray((missing * 255).astype(np.uint8)).save(output / "missing.png")
    Image.fromarray((extra * 255).astype(np.uint8)).save(output / "extra.png")
    source.save(output / "source-raster.png")
    registered.save(output / "projection-registered.png")
    write_json(output / "metrics.json", metrics)
    manifest = {"schema_version": "1.0", "status": "completed", "operation": "compare_views", "metrics": metrics,
                "verification": {"passed": precision >= minimum_match and recall >= minimum_match, "minimum_match_fraction": minimum_match,
                                 "scope": "Corresponding calibrated 2-D contour agreement only; not proof of a unique or manufacturing-correct 3-D reconstruction."},
                "registration": {"source_px_per_mm": source_scale, "projection_px_per_mm": projection_scale, "derived_uniform_scale": uniform_scale,
                                 "rotation_degrees": math.degrees(angle), "translation_px": translation.tolist(), "source_origin_px": source_origin.tolist(),
                                 "projection_origin_px": projection_origin.tolist(), "forward_matrix_2x2": forward.tolist(), "offset_px": offset.tolist(),
                                 "scale_evidence": {"source": payload["source"].get("scale_evidence", "Caller supplied; not independently verified."), "projection": payload["projection"].get("scale_evidence", "Caller supplied; not independently verified.")}},
                "files": {key: str(output / value) for key, value in {"overlay": "overlay.png", "missing": "missing.png", "extra": "extra.png", "metrics": "metrics.json", "source_raster": "source-raster.png", "registered_projection": "projection-registered.png"}.items()},
                "legend": {"green": "matched contour", "red": "source contour missing from projection", "blue": "extra projected contour", "gray": "caller-excluded annotation region"},
                "limitations": ["Caller must isolate the same view and supply calibrated scale and rigid registration.", "Scale metadata is not inferred or independently verified from drawing dimensions.", "Annotation removal is explicit; no page segmentation, OCR or automatic hole semantics.", "Occluded and hidden lines must use consistent inclusion rules on both images."], "errors": []}
    write_json(output / "manifest.json", manifest)
    return manifest
