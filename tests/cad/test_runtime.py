import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "tools" / "cad"))

import cadquery as cq

from assembly import check_paths, export_assembly
from engine import CadError, evaluate_checks, execute_plan, export_part, measure, mesh_data, patch_plan
from import_asset import import_asset


class CadRuntimeTests(unittest.TestCase):
    def test_each_requested_hole_must_remove_material(self):
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": [{"id": "stock", "op": "box", "size": [72, 48, 8]},
                {"id": "holes", "op": "hole", "diameter": 8, "points": [[12, 10], [60, 10], [12, 38], [60, 38]]}]})
        error = caught.exception.as_dict()
        self.assertEqual(error["code"], "HOLE_NO_MATERIAL_REMOVAL")
        self.assertEqual(error["feature_id"], "holes")
        self.assertEqual([p["index"] for p in error["details"]["invalid_points"]], [1, 2, 3])
        self.assertEqual(error["details"]["workplane"]["origin_world_mm"], [0, 0, 8])
        self.assertIn("centered=[true,true,false]", error["message"])

        shape, log = execute_plan({"features": [{"id": "stock", "op": "box", "size": [72, 48, 8]},
            {"id": "holes", "op": "hole", "diameter": 8, "points": [[-24, -14], [24, -14], [-24, 14], [24, 14]]}]})
        self.assertAlmostEqual(shape.Volume(), 72 * 48 * 8 - 4 * math.pi * 4 ** 2 * 8, places=5)
        self.assertEqual(len(log[-1]["hole_cuts"]), 4)
        for cut in log[-1]["hole_cuts"]:
            self.assertAlmostEqual(cut["removed_volume_mm3"], math.pi * 4 ** 2 * 8, places=5)

        named, _ = execute_plan({"features": [{"id": "stock", "op": "box", "size": [72, 48, 8]},
            {"id": "holes", "op": "hole", "diameter": 8, "points": [{"x": -24, "y": -14}, {"x": 24, "y": -14}, {"x": -24, "y": 14}, {"x": 24, "y": 14}]}]})
        self.assertAlmostEqual(named.Volume(), shape.Volume(), places=5)
        self.assertTrue(evaluate_checks(named, [{"kind": "valid", "expected": True}])["checks"][0]["passed"])
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": [{"id": "stock", "op": "box", "size": [72, 48, 8]},
                {"id": "holes", "op": "hole", "diameter": 8, "points": [{"x": -24}]}]})
        self.assertEqual(caught.exception.as_dict()["code"], "INVALID_VECTOR")

    def test_drawing_style_hole_placement_and_hole_checks(self):
        checks = [{"kind": "hole_count", "diameter": 8, "expected": 4},
                  {"kind": "hole_pitch", "diameter": 8, "axis": "x", "expected": 48},
                  {"kind": "hole_pitch", "diameter": 8, "axis": "y", "expected": 28},
                  {"kind": "hole_positions", "diameter": 8, "expected": [[-24, -14], [24, -14], [-24, 14], [24, 14]]}]
        for placement in ({"grid": {"pitch": [48, 28], "count": [2, 2]}},
                          {"edge_offsets": [[12, 10], [60, 10], [12, 38], [60, 38]]}):
            shape, log = execute_plan({"features": [{"id": "plate", "op": "box", "size": [72, 48, 8]},
                                                    {"id": "holes", "op": "hole", "diameter": 8, **placement}]})
            self.assertEqual(sorted(map(tuple, log[-1]["hole_centres_mm"])), [(-24, -14), (-24, 14), (24, -14), (24, 14)])
            self.assertTrue(evaluate_checks(shape, checks)["passed"])
        # Edge distances mistaken for centred coordinates keep the count but fail the drawing pitch.
        wrong, _ = execute_plan({"features": [{"id": "plate", "op": "box", "size": [72, 48, 8]},
                                              {"id": "holes", "op": "hole", "diameter": 8, "points": [[-12, -14], [12, -14], [-12, 14], [12, 14]]}]})
        verdict = {c["kind"] + str(c.get("axis") or ""): c["passed"] for c in evaluate_checks(wrong, checks)["checks"]}
        self.assertEqual(verdict, {"hole_count": True, "hole_pitchx": False, "hole_pitchy": True, "hole_positions": False})

        flange, log = execute_plan({"features": [{"id": "disk", "op": "cylinder", "diameter": 140, "height": 16},
                                                 {"id": "bore", "op": "hole", "diameter": 60, "points": [[0, 0]]},
                                                 {"id": "bolts", "op": "hole", "diameter": 14, "polar": {"count": 6, "pcd": 110}}]})
        self.assertEqual(log[-1]["hole_placement"], "polar")
        result = evaluate_checks(flange, [{"kind": "hole_count", "diameter": 14, "expected": 6},
                                          {"kind": "hole_pcd", "diameter": 14, "expected": 110},
                                          {"kind": "hole_count", "diameter": 140, "expected": 0}])
        self.assertTrue(result["passed"], result["checks"])
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": [{"id": "plate", "op": "box", "size": [72, 48, 8]},
                                       {"id": "holes", "op": "hole", "diameter": 8, "points": [[0, 0]], "grid": {"pitch": [10, 10]}}]})
        self.assertEqual(caught.exception.as_dict()["code"], "INVALID_HOLE_POINTS")

    def test_hole_frame_and_counterbore_on_transformed_face(self):
        blank = {"id": "stock", "op": "box", "size": [36, 28, 12], "rotation": [0, 90, 0], "translation": [18, -6, 40]}
        hole = {"id": "counterbore", "op": "hole", "face": ">X", "diameter": 6,
                "counterbore_diameter": 10, "counterbore_depth": 3, "points": [[-6, 40]]}
        shape, log = execute_plan({"features": [blank, hole]})
        self.assertAlmostEqual(shape.Volume(), 36 * 28 * 12 - math.pi * 3 ** 2 * 12 - math.pi * (5 ** 2 - 3 ** 2) * 3, places=5)
        world = log[-1]["hole_cuts"][0]["point_world_mm"]
        for actual, expected in zip(world, [30, -6, 40]):
            self.assertAlmostEqual(actual, expected, places=6)
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": [blank, {**hole, "points": [[0, 0]]}]})
        self.assertEqual(caught.exception.code, "HOLE_NO_MATERIAL_REMOVAL")

    def test_cross_step_drilling_is_preserved_and_respects_depth(self):
        features = [{"id": "plate", "op": "box", "size": [40, 40, 4]},
                    {"id": "hub", "op": "cylinder", "radius": 6, "height": 8, "translation": [0, 0, 4]},
                    {"id": "blank", "op": "union", "base": "plate", "tool": "hub"}]
        hole = {"id": "remote-hole", "op": "hole", "diameter": 4, "points": [[12, 0]]}
        blank, _ = execute_plan({"features": features})
        result, _ = execute_plan({"features": features + [hole]})
        self.assertAlmostEqual(blank.Volume() - result.Volume(), math.pi * 2 ** 2 * 4, places=5)
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": features + [{**hole, "depth": 5}]})
        self.assertEqual(caught.exception.code, "HOLE_NO_MATERIAL_REMOVAL")
        self.assertEqual(caught.exception.details["drill_depth_mm"], 5)
        result, _ = execute_plan({"features": features + [{**hole, "counterbore_diameter": 8, "counterbore_depth": 10}]})
        self.assertAlmostEqual(blank.Volume() - result.Volume(), math.pi * (2 ** 2 * 4 + (4 ** 2 - 2 ** 2) * 2), places=5)

    def test_duplicate_existing_and_empty_holes_are_rejected(self):
        stock = {"id": "stock", "op": "box", "size": [40, 30, 8]}
        hole = {"id": "hole", "op": "hole", "diameter": 6}
        cases = [[stock, {**hole, "points": [[0, 0], [0, 0]]}],
                 [stock, hole, {**hole, "id": "duplicate"}]]
        for features in cases:
            with self.subTest(features=features), self.assertRaises(CadError) as caught:
                execute_plan({"features": features})
            self.assertEqual(caught.exception.code, "HOLE_NO_MATERIAL_REMOVAL")
        # Enlarging an existing bore is real material removal and remains legal.
        result, _ = execute_plan({"features": [stock, hole, {**hole, "id": "enlarged", "diameter": 8}]})
        self.assertAlmostEqual(result.Volume(), 40 * 30 * 8 - math.pi * 4 ** 2 * 8, places=5)
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": [stock, {**hole, "points": []}]})
        self.assertEqual(caught.exception.code, "INVALID_HOLE_POINTS")

    def test_bbox_membership_does_not_make_empty_space_drillable(self):
        with self.assertRaises(CadError) as caught:
            execute_plan({"features": [{"id": "disc", "op": "cylinder", "radius": 10, "height": 6},
                {"id": "outside-disc", "op": "hole", "diameter": 1, "points": [[9, 9]]}]})
        self.assertEqual(caught.exception.code, "HOLE_NO_MATERIAL_REMOVAL")

    def test_measured_hole_volume_and_dimensions(self):
        plan = {"features": [{"id": "stock", "op": "box", "size": [50, 40, 10]},
                             {"id": "bore", "op": "hole", "diameter": 8}],
                "checks": [{"kind": "bbox", "axis": "z", "expected": 10}, {"kind": "circular_edge_diameter", "expected": 8}]}
        shape, log = execute_plan(plan)
        self.assertAlmostEqual(shape.Volume(), 50 * 40 * 10 - math.pi * 4 ** 2 * 10, places=5)
        self.assertTrue(evaluate_checks(shape, plan["checks"])["passed"])
        self.assertEqual([x["id"] for x in log], ["stock", "bore"])

    def test_failed_constraint_is_repaired_with_stable_feature_id(self):
        plan = {"features": [{"id": "stock", "op": "box", "size": [50, 40, 9]}],
                "checks": [{"id": "height", "kind": "bbox", "axis": "z", "expected": 10, "tolerance": 0.001}]}
        before, _ = execute_plan(plan)
        self.assertFalse(evaluate_checks(before, plan["checks"])["passed"])
        patched = patch_plan({"plan": plan, "patches": [{"feature_id": "stock", "set": {"size": [50, 40, 10]}}]})
        after, _ = execute_plan(patched)
        self.assertTrue(evaluate_checks(after, patched["checks"])["passed"])
        self.assertEqual(patched["features"][0]["id"], "stock")
        self.assertEqual(plan["features"][0]["size"][2], 9)

    def test_patch_rejects_top_level_checks_without_overriding_original_checks(self):
        plan = {"features": [{"id": "stock", "op": "box", "size": [50, 40, 9]}],
                "checks": [{"kind": "bbox", "axis": "z", "expected": 10, "tolerance": 0.001}]}
        payload = {"plan": plan, "patches": [{"feature_id": "stock", "set": {"size": [50, 40, 10]}}]}
        original = copy.deepcopy(plan)
        for checks in ([{"kind": "volume", "expected": 20000}], [], None):
            with self.subTest(checks=checks), self.assertRaises(CadError) as caught:
                patch_plan({**payload, "checks": checks})
            self.assertEqual(caught.exception.code, "INVALID_PATCH")
            self.assertIn("plan.checks", str(caught.exception))
            self.assertEqual(plan, original)
        self.assertEqual(patch_plan(payload)["checks"], original["checks"])

    def test_sketch_extrude_revolve_and_pattern(self):
        shape, _ = execute_plan({"features": [
            {"id": "section", "op": "sketch", "plane": "XZ", "profile": {"kind": "polygon", "points": [[10, 0], [20, 0], [20, 30], [10, 30]]}},
            {"id": "lathe", "op": "revolve", "sketch": "section"}]})
        self.assertAlmostEqual(shape.Volume(), math.pi * (20 ** 2 - 10 ** 2) * 30, places=4)
        shape, _ = execute_plan({"features": [
            {"id": "sketch", "op": "sketch", "profile": {"kind": "rectangle", "width": 8, "height": 6}},
            {"id": "prism", "op": "extrude", "sketch": "sketch", "distance": 12},
            {"id": "repeat", "op": "pattern", "count": 3, "step": [15, 0, 0]}]})
        self.assertEqual(len(shape.Solids()), 3)
        self.assertAlmostEqual(shape.Volume(), 3 * 8 * 6 * 12)

    def test_reject_code_and_duplicate_ids(self):
        for plan in [{"features": [{"id": "x", "op": "exec", "code": "print(1)"}]},
                     {"features": [{"id": "x", "op": "box", "size": [1, 2, 3]}, {"id": "x", "op": "box", "size": [2, 3, 4]}]},
                     {"features": [{"id": "x", "op": "box", "size": ["__import__('os')", 2, 3]}]}]:
            with self.assertRaises(CadError):
                execute_plan(plan)

    def test_collision_paths_are_measured_and_not_silently_passed(self):
        a = cq.Workplane("XY").box(10, 10, 10).val()
        b = a.translate((20, 0, 0))
        bad = check_paths([{"id": "a", "explode": [40, 0, 0]}, {"id": "b", "explode": [0, 0, 0]}], {"a": a, "b": b}, samples=8)
        self.assertFalse(bad["passed"])
        self.assertTrue(bad["steps"][0]["collisions"])
        good = check_paths([{"id": "a", "explode": [-40, 0, 0]}, {"id": "b", "explode": [0, 0, 0]}], {"a": a, "b": b}, samples=8)
        self.assertTrue(good["passed"])

    def test_bounding_box_remains_exact_after_tessellation(self):
        shape, _ = execute_plan({"features": [{"id": "disc", "op": "cylinder", "radius": 80, "height": 18},
                                               {"id": "bore", "op": "hole", "diameter": 60},
                                               {"id": "edge-break", "op": "chamfer", "selector": ">Z", "length": 1}]})
        mesh_data(shape, tolerance=0.8)
        self.assertAlmostEqual(measure(shape)["bbox"]["size"][0], 160, places=6)
        self.assertAlmostEqual(measure(shape)["bbox"]["size"][1], 160, places=6)

    def test_assembly_aggregates_part_check_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = export_assembly({"id": "bad-dimension", "parts": [{"id": "p", "features": [{"id": "stock", "op": "box", "size": [10, 10, 11]}],
                "checks": [{"kind": "bbox", "axis": "z", "expected": 10}]}],
                "instances": [{"id": "p1", "part_id": "p", "translation": [0, 0, 0]}]}, tmp)
            self.assertEqual(result["status"], "completed")
            self.assertFalse(result["verification"]["passed"])
            self.assertFalse(result["verification"]["part_checks_passed"])

    def test_exports_are_real_and_step_import_preserves_separate_solids(self):
        with tempfile.TemporaryDirectory(dir=PROJECT / "tests" / "cad") as tmp:
            output = Path(tmp)
            plan = {"id": "export-test", "features": [{"id": "blank", "op": "box", "size": [20, 30, 10]}]}
            result = export_part(plan, output / "part")
            self.assertTrue(Path(result["files"]["step"]).read_text().startswith("ISO-10303-21"))
            self.assertEqual(Path(result["files"]["glb"]).read_bytes()[:4], b"glTF")
            mesh = json.loads(Path(result["files"]["mesh"]).read_text())
            self.assertGreaterEqual(len(mesh["indices"]), 12)
            a = cq.Workplane("XY").box(10, 10, 10).val()
            source = output / "two.step"
            cq.exporters.export(cq.Compound.makeCompound([a, a.translate((30, 0, 0))]), str(source))
            imported = import_asset({"path": str(source)}, output / "imported")
            self.assertEqual(imported["instance_count"], 2)
            self.assertFalse(imported["path_check"]["checked"])
            self.assertIn("not recovered", imported["hierarchy_note"])

    def test_cli_structured_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / "input.json").write_text(json.dumps({"features": [{"id": "bad", "op": "sphere"}]}))
            run = subprocess.run([sys.executable, str(PROJECT / "tools/cad/runner.py"), "build", "--input", str(path / "input.json"), "--output", str(path / "out")], capture_output=True, text=True)
            self.assertEqual(run.returncode, 2)
            result = json.loads(run.stdout)
            self.assertEqual(result["errors"][0]["feature_id"], "bad")


if __name__ == "__main__":
    unittest.main()
