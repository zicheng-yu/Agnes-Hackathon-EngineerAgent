"""Millimetre/Z-up CAD feature executor with independent geometric measurements."""
from __future__ import annotations

import copy
import json
import math
import re
import time
from pathlib import Path
from typing import Any

import cadquery as cq
import numpy as np
import trimesh
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt


class CadError(Exception):
    def __init__(self, code: str, message: str, feature_id: str | None = None, details: dict | None = None):
        super().__init__(message)
        self.code, self.feature_id = code, feature_id
        self.details = details

    def as_dict(self):
        result = {"code": self.code, "message": str(self), "feature_id": self.feature_id}
        if self.details is not None:
            result["details"] = self.details
        return result


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise CadError("INVALID_ID", "IDs must contain 1–80 letters, digits, '_' or '-'.")
    return value


def numeric(value, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CadError("INVALID_NUMBER", f"Expected a finite number, got {value!r}.")
    if abs(value) > 100_000 or (positive and value <= 0):
        raise CadError("NUMBER_OUT_OF_RANGE", f"Dimension out of range: {value!r}.")
    return float(value)


def vector(value, size=3):
    # Named coordinates are accepted because some tool-calling formats cannot nest arrays reliably.
    if isinstance(value, dict) and set(value) == set("xyz"[:size]):
        value = [value[axis] for axis in "xyz"[:size]]
    if not isinstance(value, (list, tuple)) or len(value) != size:
        raise CadError("INVALID_VECTOR", f"Expected {size} coordinates as [{', '.join('xyz'[:size])}] or {{{', '.join('xyz'[:size])}}}.")
    return tuple(numeric(v) for v in value)


def resolve(value, parameters):
    """Exact parameter references only; there is deliberately no eval/exec."""
    if isinstance(value, dict):
        if set(value) == {"param"}:
            key = value["param"]
            if key not in parameters:
                raise CadError("UNKNOWN_PARAMETER", f"Unknown parameter: {key}.")
            return numeric(parameters[key])
        return {k: resolve(v, parameters) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, parameters) for v in value]
    return value


def shape_of(obj):
    if isinstance(obj, cq.Shape):
        return obj
    if isinstance(obj, cq.Workplane):
        shapes = [x for x in obj.vals() if isinstance(x, cq.Shape)]
        if not shapes:
            raise CadError("EMPTY_SHAPE", "Feature produced no geometric shape.")
        return shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
    raise CadError("NOT_A_SHAPE", "Expected a CAD shape.")


def workplane(shape):
    return cq.Workplane("XY").newObject([shape_of(shape)])


def cut_checked_holes(base, selector, points, diameter, depth, counterbore, feature_id):
    """Match CQ's hole cutters, but require each request to remove real material."""
    wp = workplane(base).faces(selector).workplane()
    drill_depth = depth if depth is not None else wp.largestDimension()
    frame = {"origin_world_mm": list(wp.plane.origin.toTuple()),
             "x_axis_world": list(wp.plane.xDir.toTuple()), "y_axis_world": list(wp.plane.yDir.toTuple()),
             "normal_world": list(wp.plane.zDir.toTuple())}
    direction = wp.plane.zDir.multiply(-1)
    current = shape_of(base)
    invalid, cuts = [], []
    for index, point in enumerate(points):
        world = wp.plane.toWorldCoords(point)
        cutter = cq.Solid.makeCylinder(diameter / 2, drill_depth, world, direction)
        if counterbore is not None:
            bore_diameter, bore_depth = counterbore
            cutter = cutter.fuse(cq.Solid.makeCylinder(bore_diameter / 2, bore_depth, world, direction))
        before_volume = current.Volume()
        candidate = current.cut(cutter).clean()
        removed_volume = before_volume - candidate.Volume()
        # Reject differences indistinguishable from floating-point round-off;
        # this is an execution-effect check, not a machining fit tolerance.
        volume_resolution = max(1.0e-9, 8 * math.ulp(before_volume))
        record = {"index": index, "point_local_mm": list(point), "point_world_mm": list(world.toTuple()),
                  "removed_volume_mm3": removed_volume, "volume_resolution_mm3": volume_resolution}
        if removed_volume <= volume_resolution:
            invalid.append(record)
        else:
            current = candidate
            cuts.append(record)
    if invalid:
        locations = "; ".join(f"index {item['index']} point {item['point_local_mm']}" for item in invalid)
        raise CadError("HOLE_NO_MATERIAL_REMOVAL",
                       f"Requested holes removed no measurable material: {locations}. "
                       "Check out-of-body coordinates, drilling depth, existing bores and duplicate points. "
                       "Points are local XY coordinates of the selected face workplane. box defaults to centered=[true,true,false] "
                       "(XY centered at 0; Z starts at 0). The face workplane uses the global origin projected onto its plane, "
                       f"not the face center; actual origin is {frame['origin_world_mm']}. "
                       f"Drilling follows the negative workplane normal for {drill_depth:g} mm. No partial feature is returned.",
                       feature_id, {"invalid_points": invalid, "workplane": frame, "face_selector": selector,
                                    "drill_depth_mm": drill_depth, "counterbore": counterbore})
    return current, cuts


HOLE_PLACEMENTS = ("points", "grid", "polar", "edge_offsets")


def hole_points(f, base, feature_id):
    """Resolve hole centres from the way drawings dimension them, so callers copy printed values."""
    modes = [key for key in HOLE_PLACEMENTS if key in f]
    if len(modes) > 1:
        raise CadError("INVALID_HOLE_POINTS", f"Use only one of {', '.join(HOLE_PLACEMENTS)}; got {', '.join(modes)}.", feature_id)
    mode = modes[0] if modes else "points"
    if mode == "grid":
        grid = f["grid"]
        if not isinstance(grid, dict):
            raise CadError("INVALID_HOLE_POINTS", "grid must be {pitch:[Px,Py], count:[nx,ny], center:[x,y]}.", feature_id)
        counts = grid.get("count", [2, 2])
        if not isinstance(counts, (list, tuple)) or len(counts) != 2 or any(isinstance(c, bool) or not isinstance(c, int) or not 1 <= c <= 32 for c in counts):
            raise CadError("INVALID_HOLE_POINTS", "grid.count must be two integers from 1 to 32, e.g. [2, 2].", feature_id)
        pitch = vector(grid.get("pitch", [0, 0]), 2)
        if any(p < 0 for p in pitch) or any(n > 1 and p == 0 for n, p in zip(counts, pitch)):
            raise CadError("INVALID_HOLE_POINTS", "grid.pitch is the positive centre distance between neighbouring holes on each axis.", feature_id)
        cx, cy = vector(grid.get("center", [0, 0]), 2)
        xs = [cx + (i - (counts[0] - 1) / 2) * pitch[0] for i in range(counts[0])]
        ys = [cy + (j - (counts[1] - 1) / 2) * pitch[1] for j in range(counts[1])]
        points = [(x, y) for y in ys for x in xs]
    elif mode == "polar":
        polar = f["polar"]
        if not isinstance(polar, dict):
            raise CadError("INVALID_HOLE_POINTS", "polar must be {count:n, pcd:D, start_angle:deg, center:[x,y]}.", feature_id)
        count = polar.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 128:
            raise CadError("INVALID_HOLE_POINTS", "polar.count must be an integer from 1 to 128.", feature_id)
        radius = numeric(polar.get("pcd"), True) / 2
        start = numeric(polar.get("start_angle", 0))
        cx, cy = vector(polar.get("center", [0, 0]), 2)
        angles = [math.radians(start + 360 * i / count) for i in range(count)]
        points = [(cx + radius * math.cos(a), cy + radius * math.sin(a)) for a in angles]
    elif mode == "edge_offsets":
        if f.get("face", ">Z") != ">Z":
            raise CadError("INVALID_HOLE_POINTS", "edge_offsets supports the default >Z face; use points for other faces.", feature_id)
        box = shape_of(base).BoundingBox()
        points = [(box.xmin + a, box.ymin + b) for a, b in (vector(p, 2) for p in f["edge_offsets"])]
    else:
        points = [vector(p, 2) for p in f.get("points", [[0, 0]])]
    points = [tuple(round(v, 9) + 0.0 for v in point) for point in points]
    if not points:
        raise CadError("INVALID_HOLE_POINTS", "hole requires at least one center point.", feature_id)
    if len(points) > 128:
        raise CadError("RESOURCE_LIMIT", "Maximum 128 hole points per feature.")
    return mode, points


def hole_axes(shape, diameter, tolerance=0.05):
    """Distinct axes of concave cylindrical faces (drilled holes) with the requested diameter."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    axes = []
    for face in shape_of(shape).Faces():
        surface = BRepAdaptor_Surface(face.wrapped)
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        cylinder = surface.Cylinder()
        if abs(2 * cylinder.Radius() - diameter) > tolerance:
            continue
        axis = cylinder.Axis()
        direction = np.array([axis.Direction().X(), axis.Direction().Y(), axis.Direction().Z()])
        if direction[np.flatnonzero(np.abs(direction) > 1e-9)[0]] < 0:
            direction = -direction
        location = np.array([axis.Location().X(), axis.Location().Y(), axis.Location().Z()])
        foot = location - location.dot(direction) * direction
        u = (surface.FirstUParameter() + surface.LastUParameter()) / 2
        v = (surface.FirstVParameter() + surface.LastVParameter()) / 2
        sample = surface.Value(u, v)
        point = np.array([sample.X(), sample.Y(), sample.Z()])
        normal = face.normalAt(cq.Vector(*point)).toTuple()
        to_axis = (location + (point - location).dot(direction) * direction) - point
        if np.dot(normal, to_axis) <= 0:
            continue  # Convex cylinder: an outside diameter or boss, not a hole.
        if not any(np.allclose(direction, d, atol=1e-6) and np.allclose(foot, p, atol=1e-3) for d, p in axes):
            axes.append((direction, foot))
    return axes


def profile(spec, plane="XY", origin=(0, 0, 0)):
    if plane not in {"XY", "XZ", "YZ", "YX", "ZX", "ZY"}:
        raise CadError("INVALID_PLANE", f"Unsupported named plane: {plane}.")
    wp = cq.Workplane(plane, origin=vector(origin))
    kind = spec.get("kind", "polygon")
    if kind == "circle":
        return wp.circle(numeric(spec["radius"], True))
    if kind == "rectangle":
        return wp.rect(numeric(spec["width"], True), numeric(spec["height"], True))
    if kind == "polygon":
        points = [vector(p, 2) for p in spec["points"]]
        if not 3 <= len(points) <= 256:
            raise CadError("INVALID_PROFILE", "Polygon must contain 3–256 vertices.")
        return wp.polyline(points).close()
    if kind == "regular_polygon":
        sides = int(spec["sides"])
        if not 3 <= sides <= 64:
            raise CadError("INVALID_PROFILE", "Regular polygon sides must be between 3 and 64.")
        return wp.polygon(sides, numeric(spec["diameter"], True))
    if kind == "slot":
        return wp.slot2D(numeric(spec["length"], True), numeric(spec["width"], True), numeric(spec.get("angle", 0)))
    raise CadError("INVALID_PROFILE", f"Unsupported profile kind: {kind}.")


def transform_shape(shape, translation=(0, 0, 0), rotation=(0, 0, 0)):
    result = shape_of(shape)
    for axis, angle in zip([(1, 0, 0), (0, 1, 0), (0, 0, 1)], vector(rotation)):
        if angle:
            result = result.rotate((0, 0, 0), axis, angle)
    return result.translate(vector(translation))


def measure(shape):
    shape = shape_of(shape)
    exact_box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, exact_box, False, False)
    xmin, ymin, zmin, xmax, ymax, zmax = exact_box.Get()
    return {"valid": bool(shape.isValid()), "solids": len(shape.Solids()),
            "volume_mm3": round(shape.Volume(), 6), "area_mm2": round(shape.Area(), 6),
            "bbox": {"min": [xmin, ymin, zmin], "max": [xmax, ymax, zmax],
                     "size": [xmax - xmin, ymax - ymin, zmax - zmin],
                     "method": "OpenCascade BRepBndLib.AddOptimal, useTriangulation=False, useShapeTolerance=False"},
            "center_of_mass": list(shape.Center().toTuple()),
            "faces": len(shape.Faces()), "edges": len(shape.Edges())}


def evaluate_checks(shape, checks):
    m = measure(shape)
    result = []
    for i, check in enumerate(checks):
        kind = check.get("kind")
        if kind == "bbox":
            axis = check.get("axis", "x")
            if axis not in "xyz" or len(axis) != 1:
                raise CadError("INVALID_CHECK", "bbox axis must be x, y or z.")
            actual = m["bbox"]["size"]["xyz".index(axis)]
        elif kind == "volume":
            actual = m["volume_mm3"]
        elif kind == "solids":
            actual = m["solids"]
        elif kind == "valid":
            actual = int(m["valid"])
        elif kind == "circular_edge_diameter":
            diameter = numeric(check["expected"], True)
            radii = []
            for edge in shape_of(shape).Edges():
                if edge.geomType() == "CIRCLE":
                    radii.append(2 * edge.radius())
            actual = min(radii, key=lambda x: abs(x - diameter)) if radii else None
        elif kind in {"hole_count", "hole_pitch", "hole_pcd", "hole_positions"}:
            diameter = numeric(check.get("diameter"), True)
            axes = hole_axes(shape, diameter)
            if kind == "hole_count":
                actual = len(axes)
            elif kind == "hole_pitch":
                axis = check.get("axis", "x")
                if axis not in ("x", "y", "z"):
                    raise CadError("INVALID_CHECK", "hole_pitch axis must be x, y or z.")
                values = sorted({round(float(foot["xyz".index(axis)]), 6) for _, foot in axes})
                actual = values[-1] - values[0] if len(values) > 1 else None
            elif kind == "hole_pcd":
                center = np.array(vector(check.get("center", [0, 0]), 2))
                diameters = [2 * float(np.linalg.norm(foot[:2] - center)) for _, foot in axes]
                expected_pcd = numeric(check.get("expected"), True)
                actual = round(sum(diameters) / len(diameters), 6) if diameters else None
                worst = max((abs(d - expected_pcd) for d in diameters), default=None)
            else:
                expected_points = [vector(p, 2) for p in check.get("expected", [])]
                if not expected_points:
                    raise CadError("INVALID_CHECK", "hole_positions expected must list [x,y] hole centres.")
                feet = [foot[:2] for _, foot in axes]
                distances = [min((float(np.linalg.norm(np.array(p) - f)) for f in feet), default=math.inf) for p in expected_points]
                tolerance = numeric(check.get("tolerance", 0.05))
                error = max(distances) if len(feet) == len(expected_points) else math.inf
                result.append({"id": check.get("id", f"check-{i + 1}"), "kind": kind, "diameter": diameter,
                               "actual": [[round(float(v), 4) for v in f] for f in feet], "expected": [list(p) for p in expected_points],
                               "tolerance": tolerance, "error": None if math.isinf(error) else error,
                               "passed": error <= tolerance})
                continue
            expected = numeric(check.get("expected"))
            tolerance = numeric(check.get("tolerance", 0 if kind == "hole_count" else 0.05))
            error = (worst if kind == "hole_pcd" else abs(actual - expected)) if actual is not None else None
            result.append({"id": check.get("id", f"check-{i + 1}"), "kind": kind, "diameter": diameter,
                           "axis": check.get("axis") if kind == "hole_pitch" else None,
                           "actual": actual, "expected": expected, "tolerance": tolerance, "error": error,
                           "passed": error is not None and error <= tolerance,
                           "measured_hole_centres": [[round(float(v), 4) for v in foot[:2]] for _, foot in axes]})
            continue
        else:
            raise CadError("INVALID_CHECK", f"Unsupported check kind: {kind}. Supported: bbox, volume, solids, valid, circular_edge_diameter, hole_count, hole_pitch, hole_pcd, hole_positions.")
        expected = check.get("expected", 1)
        if kind == "valid" and isinstance(expected, bool):
            expected = int(expected)
        expected = numeric(expected)
        tolerance = numeric(check.get("tolerance", 0.05))
        error = abs(actual - expected) if actual is not None else None
        result.append({"id": check.get("id", f"check-{i + 1}"), "kind": kind,
                       "axis": check.get("axis", "x") if kind == "bbox" else None,
                       "feature_id": check.get("feature_id"), "actual": actual,
                       "expected": expected, "tolerance": tolerance, "error": error,
                       "passed": error is not None and error <= tolerance})
    return {"passed": m["valid"] and m["solids"] > 0 and m["volume_mm3"] > 0 and all(c["passed"] for c in result),
            "checks": result, "measurements": m,
            "scope": "B-rep validity and explicitly listed geometric checks; not a manufacturing certification."}


def execute_plan(plan):
    if plan.get("units", "mm") != "mm":
        raise CadError("UNSUPPORTED_UNITS", "Only explicit millimetre inputs are supported.")
    features = plan.get("features")
    if not isinstance(features, list) or not 1 <= len(features) <= 250:
        raise CadError("INVALID_PLAN", "A plan requires 1–250 ordered features.")
    parameters = plan.get("parameters", {})
    registry, sketch_specs, log = {}, {}, []
    previous = None
    for raw in features:
        start = time.perf_counter()
        feature_id = safe_id(raw.get("id"))
        if feature_id in registry:
            raise CadError("DUPLICATE_FEATURE", f"Duplicate feature ID: {feature_id}.", feature_id)
        f = resolve(raw, parameters)
        op = f.get("op")
        hole_cuts = None
        try:
            def ref(key="base"):
                name = f.get(key, previous if key == "base" else None)
                if name not in registry:
                    raise CadError("UNKNOWN_FEATURE", f"Unknown {key} feature: {name}.", feature_id)
                return registry[name]

            if op == "box":
                dims = [numeric(v, True) for v in vector(f["size"])]
                result = cq.Workplane("XY").box(*dims, centered=tuple(f.get("centered", [True, True, False])))
            elif op == "cylinder":
                if ("radius" in f) == ("diameter" in f):
                    raise CadError("INVALID_CYLINDER", "cylinder needs exactly one of radius or diameter, plus height.", feature_id)
                radius = numeric(f["radius"], True) if "radius" in f else numeric(f["diameter"], True) / 2
                result = cq.Workplane("XY").circle(radius).extrude(numeric(f["height"], True))
            elif op == "sketch":
                result = profile(f["profile"], f.get("plane", "XY"), f.get("origin", [0, 0, 0]))
                sketch_specs[feature_id] = f
            elif op in {"extrude", "revolve"}:
                if "sketch" in f:
                    if f["sketch"] not in sketch_specs:
                        raise CadError("UNKNOWN_SKETCH", f"Unknown sketch feature: {f['sketch']}.", feature_id)
                    source_spec = sketch_specs[f["sketch"]]
                    source = profile(source_spec["profile"], source_spec.get("plane", "XY"), source_spec.get("origin", [0, 0, 0]))
                else:
                    source = profile(f["profile"], f.get("plane", "XY"), f.get("origin", [0, 0, 0]))
                if op == "extrude":
                    result = source.extrude(numeric(f["distance"]), combine=False)
                else:
                    result = source.revolve(numeric(f.get("angle", 360)), vector(f.get("axis_start", [0, 0]), 2), vector(f.get("axis_end", [0, 1]), 2), combine=False)
            elif op in {"union", "cut", "intersect"}:
                result = getattr(workplane(ref()), op)(shape_of(ref("tool")))
            elif op == "hole":
                placement, points = hole_points(f, ref(), feature_id)
                depth = f.get("depth")
                if depth is not None:
                    depth = numeric(depth, True)
                counterbore = None
                if "counterbore_diameter" in f:
                    counterbore = (numeric(f["counterbore_diameter"], True), numeric(f["counterbore_depth"], True))
                result, hole_cuts = cut_checked_holes(ref(), f.get("face", ">Z"), points, numeric(f["diameter"], True), depth, counterbore, feature_id)
            elif op in {"fillet", "chamfer"}:
                wp = workplane(ref()).edges(f.get("selector", "|Z"))
                result = getattr(wp, op)(numeric(f["radius" if op == "fillet" else "length"], True))
            elif op == "transform":
                result = transform_shape(ref(), f.get("translation", [0, 0, 0]), f.get("rotation", [0, 0, 0]))
            elif op == "pattern":
                source = shape_of(ref())
                copies = []
                count = int(f.get("count", 1))
                if not 1 <= count <= 128:
                    raise CadError("RESOURCE_LIMIT", "Pattern count must be 1–128.")
                if f.get("kind", "linear") == "linear":
                    step = vector(f.get("step", [10, 0, 0]))
                    copies = [source.translate(tuple(x * i for x in step)) for i in range(count)]
                elif f["kind"] == "circular":
                    start, end = vector(f.get("axis_start", [0, 0, 0])), vector(f.get("axis_end", [0, 0, 1]))
                    sweep = numeric(f.get("angle", 360))
                    copies = [source.rotate(start, end, i * sweep / count) for i in range(count)]
                else:
                    raise CadError("INVALID_PATTERN", "Pattern kind must be linear or circular.")
                result = cq.Compound.makeCompound(copies)
            elif op == "mirror":
                result = shape_of(ref()).mirror(f.get("plane", "YZ"), vector(f.get("origin", [0, 0, 0])))
            else:
                raise CadError("UNSUPPORTED_OPERATION", f"Unsupported operation: {op}.", feature_id)
            if op != "sketch":
                result = shape_of(result)
                if op != "transform" and ("translation" in f or "rotation" in f):
                    result = transform_shape(result, f.get("translation", [0, 0, 0]), f.get("rotation", [0, 0, 0]))
                if not result.isValid():
                    raise CadError("INVALID_TOPOLOGY", "The CAD kernel produced invalid topology.", feature_id)
            registry[feature_id] = result
            previous = feature_id
            entry = {"id": feature_id, "op": op, "status": "completed", "duration_ms": round(1000 * (time.perf_counter() - start), 2)}
            if hole_cuts is not None:
                entry["hole_placement"] = placement
                entry["hole_centres_mm"] = [list(p) for p in points]
                entry["hole_cuts"] = hole_cuts
            log.append(entry)
        except CadError:
            raise
        except Exception as exc:
            raise CadError("KERNEL_ERROR", f"{type(exc).__name__}: {exc}", feature_id) from exc
    selected = plan.get("result", previous)
    if selected not in registry:
        raise CadError("UNKNOWN_RESULT", f"Result feature does not exist: {selected}.")
    shape = shape_of(registry[selected])
    if not shape.Solids() or shape.Volume() <= 0:
        raise CadError("NO_SOLID", "Final result must contain positive-volume solids.", selected)
    return shape, log


def mesh_data(shape, tolerance=0.25):
    vertices, triangles = shape_of(shape).tessellate(tolerance, 0.1)
    positions = [[round(x, 6) for x in vertex.toTuple()] for vertex in vertices]
    indices = [list(triangle) for triangle in triangles]
    return {"units": "mm", "up_axis": "Z", "positions": positions, "indices": indices}


def mesh_object(shape, color=None):
    data = mesh_data(shape)
    mesh = trimesh.Trimesh(vertices=data["positions"], faces=data["indices"], process=False)
    if color:
        mesh.visual.vertex_colors = np.tile(np.asarray(color, dtype=np.uint8), (len(mesh.vertices), 1))
    return mesh


def export_views(shape, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    views = {}
    dimensions = measure(shape)
    metadata = {"units": "mm", "source": "Measured analytic B-rep; not declared feature dimensions", "measurements": dimensions, "views": {}}
    for name, direction in {"front": (0, -1, 0), "top": (0, 0, 1), "side": (1, 0, 0)}.items():
        target = output / f"{name}.svg"
        cq.exporters.export(shape, str(target), exportType="SVG", opt={"projectionDir": direction, "width": 640, "height": 480, "marginLeft": 40, "marginTop": 40, "showAxes": False, "showHidden": True, "strokeWidth": 0.6, "strokeColor": (37, 58, 73), "hiddenColor": (130, 148, 160)})
        views[name] = str(target.resolve())
        markup = target.read_text(encoding="utf-8")
        scales = re.search(r"scale\(([-0-9.eE+]+),\s*([-0-9.eE+]+)\)", markup)
        offsets = re.search(r"translate\(([-0-9.eE+]+),\s*([-0-9.eE+]+)\)", markup)
        frame = gp_Ax2(gp_Pnt(), gp_Dir(*direction))
        x_axis, y_axis = list(frame.XDirection().Coord()), list(frame.YDirection().Coord())
        metadata["views"][name] = {"path": str(target.resolve()), "projection_direction": list(direction),
            "x_axis_world": x_axis, "y_axis_world": y_axis,
            "measured_width_mm": sum(abs(a) * b for a, b in zip(x_axis, dimensions["bbox"]["size"])),
            "measured_height_mm": sum(abs(a) * b for a, b in zip(y_axis, dimensions["bbox"]["size"])),
            "px_per_mm": abs(float(scales[1])) if scales else None,
            "origin_px": [float(scales[1]) * float(offsets[1]), float(scales[2]) * float(offsets[2])] if scales and offsets else None,
            "scale_evidence": "Read from the CAD SVG exporter uniform transform, with millimetre B-rep geometry.",
            "hidden_lines_included": True}
    write_json(output / "metadata.json", metadata)
    return views


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def export_part(plan, output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    shape, log = execute_plan(plan)
    cq.exporters.export(shape, str(output / "model.step"))
    mesh = mesh_data(shape)
    write_json(output / "mesh.json", mesh)
    mesh_object(shape).export(str(output / "model.glb"))
    views = export_views(shape, output / "views")
    verification = evaluate_checks(shape, resolve(plan.get("checks", []), plan.get("parameters", {})))
    write_json(output / "feature-plan.json", plan)
    manifest = {"schema_version": "1.0", "status": "completed", "operation": "build", "id": plan.get("id"), "name": plan.get("name"),
                "units": "mm", "up_axis": "Z", "source_type": plan.get("source_type", "user-feature-plan"),
                "files": {"step": str(output / "model.step"), "glb": str(output / "model.glb"), "mesh": str(output / "mesh.json"), "feature_plan": str(output / "feature-plan.json"), "views": views, "view_metadata": str(output / "views" / "metadata.json")},
                "verification": verification, "measurements": verification["measurements"], "feature_log": log, "errors": []}
    write_json(output / "manifest.json", manifest)
    return manifest


def patch_plan(payload):
    if "checks" in payload:
        raise CadError("INVALID_PATCH", "Checks must be placed in plan.checks. Original checks are not overridden by a top-level checks field.")
    plan = copy.deepcopy(payload["plan"])
    by_id = {f["id"]: f for f in plan["features"]}
    for patch in payload.get("patches", []):
        feature_id = patch.get("feature_id")
        if feature_id not in by_id:
            raise CadError("UNKNOWN_FEATURE", f"Cannot patch unknown feature: {feature_id}.")
        updates = patch.get("set", {})
        if any(key in {"id", "op"} for key in updates):
            raise CadError("INVALID_PATCH", "Stable feature id and operation cannot be patched.", feature_id)
        by_id[feature_id].update(updates)
    for key, value in payload.get("parameters", {}).items():
        if key not in plan.get("parameters", {}):
            raise CadError("UNKNOWN_PARAMETER", f"Cannot patch unknown parameter: {key}.")
        plan["parameters"][key] = numeric(value)
    return plan
