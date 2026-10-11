"""Render small catalog previews from existing GLB geometry, without a GPU or network.

Run with the project's Python environment on Windows, macOS or Linux.
The original CAD/model files are never changed. Backgrounds stay transparent so
the catalog's CSS provides the same light/dark surface for every preview.
"""
import json
from pathlib import Path
import numpy as np
import trimesh
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]


def render(model, target):
    scene = trimesh.load(model, force='scene', process=False)
    meshes = scene.dump()
    camera = np.array([1.1, -1.55, 1.0]); camera /= np.linalg.norm(camera)
    right = np.cross(camera, [0, 0, 1]); right /= np.linalg.norm(right)
    up = np.cross(right, camera)
    basis = np.array([right, up, camera]).T
    palette = np.array([[132, 151, 161], [203, 150, 108], [157, 171, 178], [113, 137, 144]])
    points, colors = [], []
    light = np.array([-0.4, -0.6, 1]); light /= np.linalg.norm(light)
    for i, mesh in enumerate(meshes):
        triangles = np.asarray(mesh.triangles)
        if not len(triangles):
            continue
        normals = np.asarray(mesh.face_normals)
        visible = normals @ camera > -0.05
        projected = (triangles[visible] @ basis)
        shade = (0.55 + 0.45 * np.clip(normals[visible] @ light, 0, 1))[:, None]
        points.extend(projected)
        colors.extend(np.clip(palette[i % len(palette)] * shade, 0, 255).astype('uint8'))
    points = np.asarray(points)
    if not len(points):
        raise ValueError(f'No renderable triangles: {model.name}')
    low, high = points[:, :, :2].min(axis=(0, 1)), points[:, :, :2].max(axis=(0, 1))
    width, height, margin = 960, 640, 55
    scale = min((width - 2 * margin) / max(high[0] - low[0], 1e-6), (height - 2 * margin) / max(high[1] - low[1], 1e-6))
    xy = (points[:, :, :2] - (low + high) / 2) * scale
    xy[:, :, 0] += width / 2
    xy[:, :, 1] = height / 2 - xy[:, :, 1]
    # Keep the background and holes transparent. Baking a light matte into RGB
    # makes these previews look like white rectangles in the dark theme.
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    drawing = ImageDraw.Draw(image)
    for index in np.argsort(points[:, :, 2].mean(axis=1)):
        drawing.polygon([tuple(p) for p in xy[index]], fill=(*map(int, colors[index]), 255))
    image.resize((480, 320), Image.Resampling.LANCZOS).save(target, optimize=True)


def main():
    catalog_path = ROOT / 'assets/generated/catalog.json'
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    output = ROOT / 'assets/generated/thumbnails'
    output.mkdir(exist_ok=True)
    count = 0
    for item in [*catalog.get('assemblies', []), *catalog.get('parts', [])]:
        manifest = json.loads((ROOT / item['manifest']).read_text(encoding='utf-8'))
        source = ROOT / manifest['files']['glb']
        target = output / (item['id'] + '.png')
        if target.parent.resolve() != output.resolve():
            raise ValueError('Invalid catalog ID')
        render(source, target)
        item['thumbnailUrl'] = target.relative_to(ROOT).as_posix()
        count += 1
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'thumbnails': count, 'bytes': sum(p.stat().st_size for p in output.glob('*.png'))}))


if __name__ == '__main__':
    main()
