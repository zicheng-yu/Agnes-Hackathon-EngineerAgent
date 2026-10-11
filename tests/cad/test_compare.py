import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "tools" / "cad"))
from compare import compare_views
from engine import CadError, export_part


class CompareViewTests(unittest.TestCase):
    def create_image(self, path, hole=True, shift=(0, 0)):
        image = Image.new("L", (400, 300), 255)
        draw = ImageDraw.Draw(image)
        x, y = shift
        draw.rectangle((50 + x, 50 + y, 350 + x, 250 + y), outline=0, width=2)
        if hole:
            draw.ellipse((170 + x, 120 + y, 230 + x, 180 + y), outline=0, width=2)
        image.save(path)

    def payload(self, source, projection):
        return {"source": {"path": str(source), "px_per_mm": 10}, "projection": {"path": str(projection), "px_per_mm": 10},
                "registration": {"rotation_degrees": 0, "translation_px": [0, 0]}, "pre_cropped_views": True,
                "tolerance_mm": 0.15, "normalization_length_mm": 30}

    def test_png_self_comparison_is_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.create_image(path / "input.png")
            result = compare_views(self.payload(path / "input.png", path / "input.png"), path / "out")
            self.assertEqual(result["metrics"]["symmetric_mean_distance_mm"], 0)
            self.assertEqual(result["metrics"]["missing_pixels"], 0)
            self.assertEqual(result["metrics"]["extra_pixels"], 0)
            self.assertTrue(result["verification"]["passed"])
            self.assertTrue(Path(result["files"]["overlay"]).is_file())

    def test_missing_hole_is_localized_and_uses_physical_units(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.create_image(path / "source.png")
            self.create_image(path / "projection.png", hole=False)
            payload = self.payload(path / "source.png", path / "projection.png")
            result = compare_views(payload, path / "one")
            metrics = result["metrics"]
            self.assertGreater(metrics["missing_pixels"], 100)
            self.assertEqual(metrics["extra_pixels"], 0)
            self.assertFalse(result["verification"]["passed"])
            x, y, width, height = metrics["missing_regions"][0]["bbox_px"]
            self.assertTrue(168 <= x <= 172 and 118 <= y <= 122)
            payload["source"]["px_per_mm"] = payload["projection"]["px_per_mm"] = 20
            payload["normalization_length_mm"] = 15
            other = compare_views(payload, path / "two")["metrics"]
            self.assertAlmostEqual(other["symmetric_mean_distance_mm"], metrics["symmetric_mean_distance_mm"] / 2)
            self.assertAlmostEqual(other["normalized_mean_distance"], metrics["normalized_mean_distance"])

    def test_explicit_translation_preserves_shape_and_rejects_clipping(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.create_image(path / "source.png")
            self.create_image(path / "projection.png", shift=(-10, -20))
            payload = self.payload(path / "source.png", path / "projection.png")
            payload["registration"]["translation_px"] = [10, 20]
            result = compare_views(payload, path / "aligned")
            self.assertEqual(result["metrics"]["symmetric_mean_distance_mm"], 0)
            payload["registration"]["translation_px"] = [150, 0]
            with self.assertRaisesRegex(CadError, "leaves the source canvas"):
                compare_views(payload, path / "clipped")

    def test_requires_cropped_views_and_rejects_anisotropic_scale(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.create_image(path / "input.png")
            payload = self.payload(path / "input.png", path / "input.png")
            payload["pre_cropped_views"] = False
            with self.assertRaises(CadError):
                compare_views(payload, path / "bad")
            payload["pre_cropped_views"] = True
            payload["registration"]["scale_x"] = 1.1
            with self.assertRaisesRegex(CadError, "Only rotation and translation"):
                compare_views(payload, path / "stretched")

    def test_calibrated_uniform_scale_and_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.create_image(path / "small.png")
            square = Image.new("L", (400, 400), 255)
            square.paste(Image.open(path / "small.png"), (0, 50))
            square.resize((800, 800), Image.Resampling.NEAREST).save(path / "source.png")
            square.transpose(Image.Transpose.ROTATE_90).save(path / "projection.png")
            payload = self.payload(path / "source.png", path / "projection.png")
            payload["source"]["px_per_mm"] = 20
            payload["registration"].update({"rotation_degrees": 90, "source_origin_px": [400, 400], "projection_origin_px": [200, 200]})
            result = compare_views(payload, path / "scaled")
            self.assertEqual(result["registration"]["derived_uniform_scale"], 2)
            self.assertTrue(result["verification"]["passed"])

    def test_real_cad_svg_self_comparison_and_measured_view_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            manifest = export_part({"id": "projection", "features": [{"id": "plate", "op": "box", "size": [80, 60, 12]}, {"id": "bore", "op": "hole", "diameter": 9}]}, path / "model")
            metadata = json.loads(Path(manifest["files"]["view_metadata"]).read_text())
            top = metadata["views"]["top"]
            self.assertEqual(top["measured_width_mm"], 80)
            self.assertEqual(top["measured_height_mm"], 60)
            payload = self.payload(top["path"], top["path"])
            payload["source"]["px_per_mm"] = payload["projection"]["px_per_mm"] = top["px_per_mm"]
            result = compare_views(payload, path / "compare")
            self.assertTrue(result["verification"]["passed"])
            self.assertEqual(result["metrics"]["max_distance_mm"], 0)


if __name__ == "__main__":
    unittest.main()
