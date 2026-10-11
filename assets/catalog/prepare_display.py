"""Convert catalog models with the project CAD runner and render real mesh thumbnails.

This script does not reconstruct a shape, replace source geometry, or execute any
upstream model-generation code.  CAD and mesh verification are kept distinct.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / 'assets/catalog'


def relative(path):
    return str(Path(path).resolve().relative_to(ROOT))


def save(rows):
    for row in rows:
        target = CATALOG / row['id'] / 'metadata.json'
        target.write_text(json.dumps(row, ensure_ascii=False, indent=2))
    temp = CATALOG / 'catalog.json.tmp'
    temp.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    temp.replace(CATALOG / 'catalog.json')


def crop_thumbnail(path):
    """Use transparent margins to frame the actual mesh without altering it."""
    from PIL import Image
    image = Image.open(path).convert('RGBA')
    box = image.getchannel('A').getbbox()
    if not box:
        raise ValueError('Rendered thumbnail is blank')
    crop = image.crop(box)
    scale = min(696 / crop.width, 528 / crop.height)
    crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (792, 624), (0, 0, 0, 0))
    canvas.alpha_composite(crop, ((792 - crop.width) // 2, (624 - crop.height) // 2))
    canvas.save(path)


def thumbnail(mesh_path, destination):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    import numpy as np

    if Path(mesh_path).suffix.lower() == '.stl':
        import struct
        raw = Path(mesh_path).read_bytes()
        count = struct.unpack_from('<I', raw, 80)[0]
        if len(raw) != 84 + count * 50:
            raise ValueError('Direct STL rendering currently requires binary STL')
        dtype = np.dtype([('normal', '<f4', (3,)), ('vertices', '<f4', (3, 3)), ('attribute', '<u2')])
        records = np.frombuffer(raw, dtype=dtype, count=count, offset=84)
        vertices = records['vertices'].reshape(-1, 3).astype(float)
        faces = np.arange(count * 3).reshape(-1, 3)
    else:
        mesh = json.loads(Path(mesh_path).read_text())
        vertices = np.asarray(mesh['positions'], dtype=float)
        faces = np.asarray(mesh['indices'], dtype=int)
    if not len(vertices) or not len(faces) or not np.isfinite(vertices).all():
        raise ValueError('Cannot render empty or nonfinite mesh')
    triangles = vertices[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    light = np.array([-0.4, -0.5, 0.76])
    light /= np.linalg.norm(light)
    fill = np.array([0.4, 0.8, 0.45])
    fill /= np.linalg.norm(fill)
    intensity = 0.38 + 0.48 * np.maximum(normals @ light, 0) + 0.13 * np.maximum(normals @ fill, 0)
    colors = np.clip(intensity[:, None] * np.array([0.76, 0.81, 0.84]), 0, 1)
    rgba = np.column_stack([colors, np.ones(len(colors))])
    fig = plt.figure(figsize=(6.6, 5.2), dpi=120)
    fig.patch.set_alpha(0)
    ax = fig.add_axes([0, 0, 1, 1], projection='3d', proj_type='ortho')
    ax.patch.set_alpha(0)
    ax.add_collection3d(Poly3DCollection(triangles, facecolors=rgba, edgecolors='none',
                                      linewidths=0, antialiased=False, zsort='average'))
    low, high = vertices.min(axis=0), vertices.max(axis=0)
    center = (low + high) / 2
    radius = max(float(np.max(high - low)) * 0.53, 1e-4)
    ax.set_xlim(center[0] - radius, center[0] + radius)
    ax.set_ylim(center[1] - radius, center[1] + radius)
    ax.set_zlim(center[2] - radius, center[2] + radius)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=29, azim=-53)
    ax.set_axis_off()
    fig.savefig(destination, transparent=True, dpi=180, pad_inches=0)
    plt.close(fig)
    crop_thumbnail(destination)
    return dict(renderer='matplotlib Poly3DCollection', sourceMeshPath=relative(mesh_path),
                sourceMeshSha256=hashlib.sha256(Path(mesh_path).read_bytes()).hexdigest(),
                trianglesRendered=len(faces), geometryDecimated=False,
                view=dict(projection='orthographic', elevation=29, azimuth=-53),
                framing='alpha bounds centered on a transparent canvas',
                background='transparent', appearance='metallic grey visualization; not actual material')


def prepare(row, force=False, in_process=False):
    folder = CATALOG / row['id']
    output = folder / 'preview-cad'
    payload = folder / 'import-request.json'
    payload.write_text(json.dumps(dict(path=str(ROOT / row['localPath']), id=row['id'],
                                      name=row['name'], project=False), ensure_ascii=False))
    manifest_path = output / 'manifest.json'
    start = time.monotonic()
    if force or not manifest_path.exists():
        try:
            if in_process:
                sys.path.insert(0, str(ROOT / 'tools/cad'))
                import runner
                result = runner.run('import', json.loads(payload.read_text()), output)
                (folder / 'import.stdout.json').write_text(json.dumps(result, ensure_ascii=False))
                row['importExitCode'] = 0
            else:
                proc = subprocess.run([str(ROOT / '.venv/bin/python'), str(ROOT / 'tools/cad/runner.py'),
                                       'import', '--input', str(payload), '--output', str(output)],
                                      cwd=ROOT, text=True, capture_output=True, timeout=360)
                (folder / 'import.stdout.json').write_text(proc.stdout)
                (folder / 'import.stderr.log').write_text(proc.stderr)
                row['importExitCode'] = proc.returncode
        except subprocess.TimeoutExpired as error:
            row['kernelValidation'] = dict(status='failed', reason='CAD import exceeded 360 seconds',
                                           topologyValidated=False)
            print('IMPORT_TIMEOUT', row['id'], flush=True)
            return
        except Exception as error:
            row['kernelValidation'] = dict(status='failed', reason=str(error), topologyValidated=False)
            (folder / 'import.stderr.log').write_text(str(error))
            print('IMPORT_FAILED', row['id'], str(error), flush=True)
            return
    if not manifest_path.exists():
        row['kernelValidation'] = dict(status='failed', reason='Import did not produce a manifest',
                                       topologyValidated=False)
        print('IMPORT_FAILED', row['id'], flush=True)
        return
    manifest = json.loads(manifest_path.read_text())
    measurements = manifest.get('measurements', {})
    cad_valid = measurements.get('valid')
    status = 'passed' if cad_valid is True else ('failed' if cad_valid is False else 'mesh-only')
    if manifest.get('status') != 'completed':
        status = 'failed'
    row['kernelValidation'] = dict(status=status, topologyValidated=cad_valid is True,
                                  importStatus=manifest.get('status'), measurements=measurements,
                                  sourceFormat=row['format'],
                                  manifestPath=relative(manifest_path),
                                  unitsNote=manifest.get('units_note'),
                                  solidOrComponentCount=manifest.get('instance_count'),
                                  hierarchyNote=manifest.get('hierarchy_note'),
                                  tool='tools/cad/runner.py import',
                                  errors=manifest.get('errors', []),
                                  checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    if manifest.get('status') != 'completed':
        print('IMPORT_FAILED', row['id'], manifest.get('errors'), flush=True)
        return
    files = manifest.get('files', {})
    glb = files.get('glb')
    if not glb or not Path(glb).is_file():
        row['kernelValidation']['status'] = 'failed'
        row['kernelValidation']['errors'].append(dict(code='MISSING_GLB'))
        return
    row['browserModelPath'] = relative(glb)
    row['browserModelUrl'] = '/' + row['browserModelPath']
    row['browserModelFormat'] = 'GLB'
    row['browserModelSha256'] = hashlib.sha256(Path(glb).read_bytes()).hexdigest()
    row['browserModelSizeBytes'] = Path(glb).stat().st_size
    row['browserMeshPath'] = relative(files['mesh'])
    row['browserManifestPath'] = relative(manifest_path)
    row['previewIsReconstruction'] = False
    row['previewDerivation'] = 'Tessellated or converted from attributed upstream CAD; no reconstructed geometry.'
    png = folder / 'thumbnail.png'
    try:
        details = thumbnail(files['mesh'], png)
        row['thumbnailPath'] = relative(png)
        row['thumbnailUrl'] = '/' + row['thumbnailPath']
        row['thumbnailSha256'] = hashlib.sha256(png.read_bytes()).hexdigest()
        row['thumbnailProvenance'] = details
    except Exception as error:
        row['thumbnailError'] = str(error)
        print('THUMBNAIL_FAILED', row['id'], str(error), flush=True)
    print('DISPLAY_READY', row['id'], status, manifest.get('instance_count'),
          round(time.monotonic() - start, 2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ids', nargs='*')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--in-process', action='store_true')
    parser.add_argument('--thumbnail-only', action='store_true')
    args = parser.parse_args()
    rows = json.loads((CATALOG / 'catalog.json').read_text())
    chosen = [row for row in rows if not args.ids or row['id'] in args.ids]
    chosen.sort(key=lambda row: (not row.get('hero', False), row['format'] != 'STEP'))
    for row in chosen:
        if args.thumbnail_only:
            source = row['localPath'] if row['format'] == 'STL' else row.get('previewPath')
            if not source:
                continue
            png = CATALOG / row['id'] / 'thumbnail.png'
            row['thumbnailProvenance'] = thumbnail(ROOT / source, png)
            row['thumbnailPath'] = relative(png)
            row['thumbnailUrl'] = '/' + row['thumbnailPath']
            row['thumbnailSha256'] = hashlib.sha256(png.read_bytes()).hexdigest()
            row.setdefault('browserModelPath', source)
            row.setdefault('browserModelUrl', '/' + source)
            row.setdefault('browserModelFormat', 'STL')
            print('SOURCE_THUMBNAIL_READY', row['id'], flush=True)
        else:
            prepare(row, force=args.force, in_process=args.in_process)
        save(rows)
    print('FINISHED', len(chosen), flush=True)
