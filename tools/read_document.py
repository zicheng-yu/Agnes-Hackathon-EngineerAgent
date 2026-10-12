import json, sys
from pathlib import Path
from pypdf import PdfReader
from PIL import Image

file = Path(sys.argv[1])
result = {"pages": []}
try:
    if file.suffix.lower() == '.pdf':
        if file.stat().st_size == 0:
            raise ValueError('empty file')
        reader = PdfReader(file)
        if reader.is_encrypted and not reader.decrypt(''):
            # Permission-only PDFs (common from office and scanning apps) open with an empty password.
            raise ValueError('encrypted PDF requires a password')
        result['pageCount'] = len(reader.pages)
        if len(reader.pages) > 100:
            raise ValueError('文档超过 100 页，请拆分为较小文件。')

        def page_text(page):
            # A damaged text layer on one page should not reject an otherwise readable drawing.
            try:
                return page.extract_text() or ''
            except Exception:
                return ''
        result['pages'] = [{"page": i + 1, "text": page_text(page)} for i, page in enumerate(reader.pages)]
        result['textLayer'] = any(x['text'].strip() for x in result['pages'])
    elif file.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
        with Image.open(file) as im:
            result['width'], result['height'] = im.size
            im.verify()
        result['pageCount'] = 1
        result['textLayer'] = False
    elif file.suffix.lower() == '.json':
        result['spec'] = json.loads(file.read_text(encoding='utf-8'))
    else:
        result['textLayer'] = False
except Exception as exc:
    result['error'] = str(exc)
print(json.dumps(result, ensure_ascii=False))
