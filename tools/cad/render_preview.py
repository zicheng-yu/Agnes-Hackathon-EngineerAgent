#!/usr/bin/env python3
"""Deterministic orthographic raster preview of the real CAD triangles (no AI image generation)."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def rotate(vertices, angles):
    result = np.asarray(vertices, dtype=float)
    for index, angle in enumerate(angles):
        a = math.radians(angle)
        c, s = math.cos(a), math.sin(a)
        matrix = [np.array([[1, 0, 0], [0, c, -s], [0, s, c]]),
                  np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
                  np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])][index]
        result = result @ matrix.T
    return result


def render(manifest_path, output, explosion=0, size=(1200, 850)):
    manifest = json.loads(Path(manifest_path).read_text())
    meshes = []
    if "instances" in manifest:
        for instance in manifest["instances"]:
            data = json.loads(Path(instance["mesh"]).read_text())
            vertices = rotate(data["positions"], instance.get("rotation", [0, 0, 0]))
            vertices += np.array(instance.get("translation", [0, 0, 0])) + explosion * np.array(instance.get("explode", [0, 0, 0]))
            meshes.append((vertices, np.array(data["indices"]), instance.get("color", [154, 181, 200, 255])[:3]))
    else:
        data = json.loads(Path(manifest["files"]["mesh"]).read_text())
        meshes.append((np.array(data["positions"]), np.array(data["indices"]), [154, 181, 200]))
    eye = np.array([1.0, -1.35, 1.05]); eye /= np.linalg.norm(eye)
    right = np.cross([0, 0, 1], eye); right /= np.linalg.norm(right)
    up = np.cross(eye, right)
    basis = np.stack([right, up, eye], axis=1)
    all_vertices = np.concatenate([m[0] for m in meshes])
    view = all_vertices @ basis
    low, high = view.min(axis=0), view.max(axis=0)
    scale = min((size[0] - 120) / (high[0] - low[0]), (size[1] - 120) / (high[1] - low[1]))
    center = (low + high) / 2
    light = np.array([-0.45, -0.65, 0.8]); light /= np.linalg.norm(light)
    image = Image.new("RGB", size, "#111820")
    draw = ImageDraw.Draw(image)
    for x in range(0, size[0], 40):
        draw.line((x, 0, x, size[1]), fill="#18232e", width=1)
    for y in range(0, size[1], 40):
        draw.line((0, y, size[0], y), fill="#18232e", width=1)
    # Per-pixel depth resolves long triangles crossing different parts; a painter's
    # average-depth sort produces misleading see-through stripes on cylinders.
    pixels = np.asarray(image).copy()
    depth_buffer = np.full((size[1], size[0]), -np.inf)
    for vertices, faces, base_color in meshes:
        world_triangles = vertices[faces]
        normal = np.cross(world_triangles[:, 1] - world_triangles[:, 0], world_triangles[:, 2] - world_triangles[:, 0])
        normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-12)[:, None]
        colors = np.clip(np.array(base_color)[None, :] * (0.40 + 0.60 * np.maximum(0, normal @ light))[:, None], 0, 255).astype(np.uint8)
        projected = vertices @ basis - center
        projected[:, 0] = projected[:, 0] * scale + size[0] / 2
        projected[:, 1] = -projected[:, 1] * scale + size[1] / 2
        for index, face in enumerate(faces):
            tri = projected[face]
            xa, ya, za = tri[0]; xb, yb, zb = tri[1]; xc, yc, zc = tri[2]
            denominator = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc)
            if abs(denominator) < 1e-10:
                continue
            x0, x1 = max(0, int(np.floor(tri[:, 0].min()))), min(size[0] - 1, int(np.ceil(tri[:, 0].max())))
            y0, y1 = max(0, int(np.floor(tri[:, 1].min()))), min(size[1] - 1, int(np.ceil(tri[:, 1].max())))
            xx, yy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            wa = ((yb - yc) * (xx - xc) + (xc - xb) * (yy - yc)) / denominator
            wb = ((yc - ya) * (xx - xc) + (xa - xc) * (yy - yc)) / denominator
            wc = 1 - wa - wb
            depths = wa * za + wb * zb + wc * zc
            region = depth_buffer[y0:y1 + 1, x0:x1 + 1]
            visible = (wa >= -1e-7) & (wb >= -1e-7) & (wc >= -1e-7) & (depths > region)
            region[visible] = depths[visible]
            pixels[y0:y1 + 1, x0:x1 + 1][visible] = colors[index]
    image = Image.fromarray(pixels)
    image.save(output)
    return str(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--explode", type=float, default=0)
    args = parser.parse_args()
    print(render(args.manifest, args.output, args.explode))
