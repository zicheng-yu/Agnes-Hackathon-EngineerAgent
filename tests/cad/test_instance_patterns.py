from pathlib import Path
import sys
import unittest

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "tools" / "cad"))

from assembly import expand_instances
from engine import CadError


class InstancePatternTests(unittest.TestCase):
    def test_polar_pattern_places_copies_on_the_bolt_circle(self):
        copies = expand_instances([{"id": "stud", "part_id": "stud", "polar": {"count": 4, "pcd": 76, "start_angle": 0},
                                    "translation": [0, 0, -10], "explode": [0, 0, 40], "sequence": 1}])
        self.assertEqual([c["id"] for c in copies], ["stud-1", "stud-2", "stud-3", "stud-4"])
        self.assertEqual([[round(v, 6) for v in c["translation"]] for c in copies],
                         [[38, 0, -10], [0, 38, -10], [-38, 0, -10], [0, -38, -10]])
        self.assertTrue(all("polar" not in c and c["explode"] == [0, 0, 40] for c in copies))

    def test_points_pattern_offsets_from_translation_and_plain_instances_pass_through(self):
        plain = {"id": "base", "part_id": "plate", "translation": [0, 0, 0]}
        copies = expand_instances([plain, {"id": "pin", "part_id": "pin", "points": [[10, 5], [-10, 5]], "translation": [1, 2, 3]}])
        self.assertIs(copies[0], plain)
        self.assertEqual([c["translation"] for c in copies[1:]], [[11, 7, 3], [-9, 7, 3]])

    def test_invalid_patterns_are_rejected(self):
        for instance in ({"id": "a", "polar": {"count": 0, "pcd": 50}},
                         {"id": "a", "polar": {"count": 3, "pcd": 50}, "points": [[0, 0]]},
                         {"id": "a", "points": []}):
            with self.assertRaises(CadError):
                expand_instances([instance])


if __name__ == "__main__":
    unittest.main()


class AssemblyPlacementCheckTests(unittest.TestCase):
    def setUp(self):
        import cadquery as cq
        box = lambda h, z: cq.Workplane("XY").box(10, 10, h, centered=(True, True, False)).val().translate((0, 0, z))
        self.shapes = {"flange-a": box(12, 0), "nut-low-1": box(8, -8), "nut-low-2": box(8, -8), "nut-up-1": box(8, 26)}

    def test_measured_stack_heights_and_overall_extent(self):
        from assembly import assembly_checks
        results = assembly_checks([{"kind": "instance_z", "instance": "flange-a", "expected": 0},
                                   {"kind": "instance_z", "instance": "nut-low", "expected": -8},
                                   {"kind": "bbox", "axis": "z", "expected": 42}], self.shapes)
        self.assertTrue(all(r["passed"] for r in results), results)
        self.assertEqual(results[1]["actual"], {"nut-low-1": -8.0, "nut-low-2": -8.0})

    def test_shifted_stack_fails(self):
        from assembly import assembly_checks
        results = assembly_checks([{"kind": "instance_z", "instance": "nut-low", "expected": 0}], self.shapes)
        self.assertFalse(results[0]["passed"])
        with self.assertRaises(CadError):
            assembly_checks([{"kind": "instance_z", "instance": "missing", "expected": 0}], self.shapes)
