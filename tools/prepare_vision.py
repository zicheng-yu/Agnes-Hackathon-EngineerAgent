"""Prepare explicitly selected local drawing pages. No remote calls."""
import json, sys
from pathlib import Path
from PIL import Image

source = Path(sys.argv[1])
requested = json.loads(sys.argv[2])
results = []
if not isinstance(requested, list) or not 1 <= len(requested) <= 4 or any(type(n) is not int or n < 1 for n in requested) or len(set(requested)) != len(requested):
    raise ValueError('请选择 1–4 页图纸')
if source.suffix.lower() == '.pdf':
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(source)
    for number in requested:
        if not isinstance(number, int) or not 1 <= number <= len(document):
            raise ValueError('页码超出文档范围')
        page = document[number - 1]
        scale = min(2, 2048 / max(page.get_size()))
        image = page.render(scale=scale).to_pil().convert('RGB')
        image.thumbnail((2048, 2048))
        target = source.parent / f'vision-page-{number}.jpg'
        image.save(target, quality=90)
        results.append(str(target))
else:
    if requested != [1]:
        raise ValueError('单张图片只有第 1 页')
    image = Image.open(source).convert('RGB')
    image.thumbnail((2048, 2048))
    target = source.parent / 'vision-image.jpg'
    image.save(target, quality=90)
    results.append(str(target))
print(json.dumps({'images': results}))
