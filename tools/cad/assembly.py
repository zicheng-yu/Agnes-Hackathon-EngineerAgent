"""Explicit instance placement and sequential, sampled B-rep explosion checks."""
from __future__ import annotations

import math
import re
from pathlib import Path

import cadquery as cq
import numpy as np
import trimesh

from engine import CadError, execute_plan, export_part, export_views, measure, mesh_object, numeric, safe_id, transform_shape, vector, write_json


def expand_instances(instances):
    """Expand instance patterns so repeated fasteners need one entry instead of hand-computed copies.

    An instance may carry exactly one of:
      polar  {count, pcd, start_angle?}  copies on a bolt circle (first copy at start_angle, default +X)
      points [[x, y], ...]               copies at explicit XY positions
    Its translation gives the pattern centre (x, y) and the common z. Copies are named <id>-1, <id>-2, ...
    """
    expanded = []
    for instance in instances:
        has_polar, has_points = "polar" in instance, "points" in instance
        if not has_polar and not has_points:
            expanded.append(instance)
            continue
        if has_polar and has_points:
            raise CadError("INVALID_PATTERN", f"Instance {instance.get('id')} must use either polar or points, not both.")
        base = vector(instance.get("translation", [0, 0, 0]))
        if has_polar:
            pattern = instance["polar"]
            count = pattern.get("count") if isinstance(pattern, dict) else None
            if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 64:
                raise CadError("INVALID_PATTERN", "polar.count must be an integer from 1 to 64.")
            radius = numeric(pattern.get("pcd"), True) / 2
            start = numeric(pattern.get("start_angle", 0))
            offsets = [(radius * math.cos(math.radians(start + 360 * i / count)), radius * math.sin(math.radians(start + 360 * i / count))) for i in range(count)]
        else:
            points = instance["points"]
            if not isinstance(points, list) or not 1 <= len(points) <= 64:
                raise CadError("INVALID_PATTERN", "points must list 1 to 64 [x, y] positions.")
            offsets = [vector(point, 2) for point in points]
        for index, (dx, dy) in enumerate(offsets, start=1):
            copy = {key: value for key, value in instance.items() if key not in {"polar", "points"}}
            copy["id"] = f"{safe_id(instance.get('id'))}-{index}"
            copy["translation"] = [round(base[0] + dx, 6), round(base[1] + dy, 6), base[2]]
            expanded.append(copy)
    return expanded


def bounds_overlap(a, b, tolerance=1e-6):
    aa, bb = a.BoundingBox(), b.BoundingBox()
    return all(min(getattr(aa, k + "max"), getattr(bb, k + "max")) - max(getattr(aa, k + "min"), getattr(bb, k + "min")) > tolerance for k in "xyz")


def intersection_volume(a, b):
    if not bounds_overlap(a, b):
        return 0.0
    return max(0.0, a.intersect(b).Volume())


def check_paths(instances, original_shapes, samples=6, volume_tolerance=0.01):
    if not 2 <= samples <= 24:
        raise CadError("INVALID_SAMPLES", "Path sampling must be between 2 and 24.")
    ordered = sorted(instances, key=lambda i: i.get("sequence", 0))
    parked = dict(original_shapes)
    initial = []
    for idx, a in enumerate(instances):
        for b in instances[idx + 1:]:
            volume = intersection_volume(parked[a["id"]], parked[b["id"]])
            if volume > volume_tolerance:
                initial.append({"a": a["id"], "b": b["id"], "volume_mm3": round(volume, 6)})
    steps, hints, removed = [], [], set()
    for instance in ordered:
        instance_id = instance["id"]
        delta = vector(instance.get("explode", [0, 0, 0]))
        if sum(abs(x) for x in delta) == 0:
            continue
        collisions = []
        for sample in range(1, samples + 1):
            progress = sample / samples
            moved = original_shapes[instance_id].translate(tuple(x * progress for x in delta))
            for other_id, other in parked.items():
                if other_id == instance_id:
                    continue
                volume = intersection_volume(moved, other)
                if volume > volume_tolerance:
                    collisions.append({"other": other_id, "progress": progress, "volume_mm3": round(volume, 6)})
        parked[instance_id] = original_shapes[instance_id].translate(delta)
        removed.add(instance_id)
        steps.append({"instance_id": instance_id, "sequence": instance.get("sequence", 0), "samples": samples,
                      "checked": True, "passed": not collisions, "collisions": collisions})
        # Actionable repair guidance: say which explode vector or order to change, not just that a collision happened.
        for other_id in sorted({c["other"] for c in collisions}):
            other = next((i for i in instances if i["id"] == other_id), {})
            if other_id in removed:
                hints.append(f"{instance_id} runs into {other_id}, which was already moved to its exploded position. "
                             f"Give {instance_id} a shorter explode distance than {other_id} along the same direction "
                             f"(current {list(delta)} vs {list(vector(other.get('explode', [0, 0, 0])))}), or move it in another direction.")
            else:
                hints.append(f"{instance_id} is blocked by {other_id}, which is still in place. Remove {other_id} earlier "
                             f"(smaller sequence) or move {instance_id} in a direction that clears {other_id}.")
    return {"method": "sequential translation; axis-aligned bounds broad phase and exact B-rep intersection at discrete samples",
            "samples_per_path": samples, "volume_tolerance_mm3": volume_tolerance,
            "initial_interferences": initial, "steps": steps, "repair_hints": hints,
            "passed": not initial and all(step["passed"] for step in steps),
            "limitations": ["Discrete sampling does not prove continuous-path clearance.", "No thread, friction, deformation, tool access or dynamic effects are simulated.", "Viewer simultaneous explosion is illustrative; only the reported sequential trajectories were checked."]}


def assembly_checks(checks, world_shapes):
    """Measure placement against printed assembly dimensions; part checks alone cannot catch a shifted stack.

    bbox        {axis, expected}            overall assembly extent along x/y/z
    instance_z  {instance, expected}        measured bottom-face height of an instance; an id that was
                                            expanded by a pattern (e.g. "nut-up") checks every copy
    """
    results = []
    for index, check in enumerate(checks):
        kind = check.get("kind")
        tolerance = numeric(check.get("tolerance", 0.05))
        expected = numeric(check.get("expected"))
        if kind == "bbox":
            axis = check.get("axis")
            if axis not in ("x", "y", "z"):
                raise CadError("INVALID_CHECK", "Assembly bbox axis must be x, y or z.")
            box = cq.Compound.makeCompound(list(world_shapes.values())).BoundingBox()
            actual = [box.xlen, box.ylen, box.zlen]["xyz".index(axis)]
            results.append({"id": check.get("id", f"assembly-check-{index + 1}"), "kind": kind, "axis": axis, "actual": round(actual, 6),
                            "expected": expected, "tolerance": tolerance, "error": abs(actual - expected), "passed": abs(actual - expected) <= tolerance})
        elif kind == "instance_z":
            target = check.get("instance")
            matched = {key: shape for key, shape in world_shapes.items()
                       if key == target or (isinstance(target, str) and re.fullmatch(re.escape(target) + r"-\d+", key))}
            if not matched:
                raise CadError("INVALID_CHECK", f"instance_z refers to unknown instance: {target}.")
            measured = {key: round(shape.BoundingBox().zmin, 6) for key, shape in matched.items()}
            error = max(abs(value - expected) for value in measured.values())
            results.append({"id": check.get("id", f"assembly-check-{index + 1}"), "kind": kind, "instance": target, "actual": measured,
                            "expected": expected, "tolerance": tolerance, "error": error, "passed": error <= tolerance})
        else:
            raise CadError("INVALID_CHECK", f"Unsupported assembly check kind: {kind}. Supported: bbox, instance_z.")
    return results


def export_assembly(plan, output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if plan.get("units", "mm") != "mm":
        raise CadError("UNSUPPORTED_UNITS", "Assembly units must be mm.")
    parts = plan.get("parts", [])
    instances = expand_instances(plan.get("instances", []))
    if not 1 <= len(parts) <= 40 or not 1 <= len(instances) <= 128:
        raise CadError("RESOURCE_LIMIT", "Assembly requires 1–40 part definitions and 1–128 instances.")
    shapes, part_manifests = {}, []
    for part in parts:
        part_id = safe_id(part["id"])
        if part_id in shapes:
            raise CadError("DUPLICATE_PART", f"Repeated part ID: {part_id}.")
        shapes[part_id], _ = execute_plan(part)
        part_manifests.append(export_part(part, output / "parts" / part_id))
    world_shapes, scene, resolved = {}, trimesh.Scene(), []
    cq_assembly = cq.Assembly(name=plan.get("id", "assembly"))
    for instance in instances:
        instance_id = safe_id(instance["id"])
        if instance_id in world_shapes:
            raise CadError("DUPLICATE_INSTANCE", f"Repeated instance ID: {instance_id}.")
        part_id = instance.get("part_id")
        if part_id not in shapes:
            raise CadError("UNKNOWN_PART", f"Unknown part definition: {part_id}.")
        translation, rotation = vector(instance.get("translation", [0, 0, 0])), vector(instance.get("rotation", [0, 0, 0]))
        explode = vector(instance.get("explode", [0, 0, 0]))
        world = transform_shape(shapes[part_id], translation, rotation)
        world_shapes[instance_id] = world
        color = instance.get("color", [135, 151, 160, 255])
        mesh = mesh_object(world, color)
        scene.add_geometry(mesh, geom_name=instance_id, node_name=instance_id, metadata={"part_id": part_id})
        cq_assembly.add(world, name=instance_id, color=cq.Color(*(c / 255 for c in color[:3])))
        resolved.append({**instance, "translation": list(translation), "rotation": list(rotation), "explode": list(explode),
                         "original_transform": {"translation": list(translation), "rotation_euler_xyz_degrees": list(rotation)},
                         "mesh": str(output / "parts" / part_id / "mesh.json"),
                         "measurements": measure(world)})
    cq_assembly.export(str(output / "model.step"))
    scene.export(str(output / "model.glb"))
    compound = cq.Compound.makeCompound(list(world_shapes.values()))
    views = export_views(compound, output / "views")
    path_check = check_paths(resolved, world_shapes, int(plan.get("path_samples", 6)))
    bom = []
    for part in parts:
        ids = [instance["id"] for instance in resolved if instance["part_id"] == part["id"]]
        bom.append({"part_id": part["id"], "name": part.get("name", part["id"]), "quantity": len(ids), "instance_ids": ids,
                    "material": part.get("material", "unspecified")})
    write_json(output / "assembly-plan.json", plan)
    measurements = measure(compound)
    part_checks_passed = all(p["verification"]["passed"] for p in part_manifests)
    placement = assembly_checks(plan.get("checks", []), world_shapes)
    placement_passed = all(check["passed"] for check in placement)
    verification = {"passed": measurements["valid"] and part_checks_passed and placement_passed and path_check["passed"],
                    "geometry_valid": measurements["valid"], "part_checks_passed": part_checks_passed,
                    "assembly_checks_passed": placement_passed, "assembly_checks": placement,
                    "path_check_passed": path_check["passed"],
                    "scope": "All part B-rep checks, listed assembly placement checks, initial interference and sampled sequential explosion paths. Not a continuous-clearance proof."}
    if not placement:
        verification["warnings"] = ["No assembly-level checks were listed, so instance placement against the drawing was not measured."]
    manifest = {"schema_version": "1.0", "status": "completed", "operation": "assembly", "id": plan.get("id"), "name": plan.get("name"),
                "units": "mm", "up_axis": "Z", "source_type": plan.get("source_type", "user-assembly-plan"),
                "provenance": plan.get("provenance"), "files": {"step": str(output / "model.step"), "glb": str(output / "model.glb"),
                    "feature_plan": str(output / "assembly-plan.json"), "views": views, "view_metadata": str(output / "views" / "metadata.json")},
                "parts": part_manifests, "instances": resolved, "bom": bom, "instance_count": len(instances),
                "measurements": measurements, "verification": verification, "path_check": path_check, "errors": []}
    write_json(output / "manifest.json", manifest)
    return manifest
