"""Reuse the app's document preparation and bound cloud input resolution to 1536 px."""
import contextlib
import io
import json
import runpy
import sys
from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = 40_000_000
output = io.StringIO()
with contextlib.redirect_stdout(output):
    runpy.run_path(str(Path(__file__).resolve().parents[2] / 'tools' / 'prepare_vision.py'), run_name='__main__')
result = json.loads(output.getvalue())
for target in result['images']:
    with Image.open(target) as source:
        image = source.convert('RGB')
        image.thumbnail((1536, 1536))
        image.save(target, quality=85)
    if Path(target).stat().st_size > 4 * 1024 * 1024:
        raise ValueError('Prepared image exceeds 4 MiB')
print(json.dumps(result))
