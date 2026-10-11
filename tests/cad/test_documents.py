import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image
from pypdf import PdfWriter

ROOT = Path(__file__).resolve().parents[2]

class DocumentTests(unittest.TestCase):
    def invoke(self, script, *args):
        return subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'tools' / script), *map(str, args)], capture_output=True, text=True, encoding='utf-8')

    def test_image_bounds_and_pdf_bounds_before_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / '图纸.png'
            Image.new('RGB', (20, 20), 'white').save(image)
            parsed = json.loads(self.invoke('read_document.py', image).stdout)
            self.assertEqual(parsed['pageCount'], 1)
            self.assertEqual(self.invoke('prepare_vision.py', image, '[1]').returncode, 0)
            for pages in ('[999]', '[1,1]', '[true]'):
                self.assertNotEqual(self.invoke('prepare_vision.py', image, pages).returncode, 0)
            pdf = Path(tmp) / 'pages.pdf'
            writer = PdfWriter()
            writer.add_blank_page(width=100, height=100)
            writer.add_blank_page(width=100, height=100)
            with pdf.open('wb') as stream:
                writer.write(stream)
            self.assertEqual(json.loads(self.invoke('read_document.py', pdf).stdout)['pageCount'], 2)
            self.assertNotEqual(self.invoke('prepare_vision.py', pdf, '[3]').returncode, 0)

    def test_damaged_file_is_not_reported_as_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'corrupt.pdf'
            file.write_bytes(b'not a PDF')
            self.assertTrue(json.loads(self.invoke('read_document.py', file).stdout)['error'])

if __name__ == '__main__':
    unittest.main()
