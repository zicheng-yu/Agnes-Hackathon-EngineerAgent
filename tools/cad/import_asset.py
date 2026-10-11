"""Import local STEP solids or STL connected components, preserving geometry without fusion."""
from __future__ import annotations

import shutil
from pathlib import Path

import cadquery as cq
import numpy as np
import trimesh

from engine import CadError, export_views, measure, mesh_data, mesh_object, write_json


def import_asset(payload, output):
    project_root = Path(__file__).resolve().parents[2]
    source = Path(payload["path"]).expanduser().resolve()
    if not source.is_relative_to(project_root):
        raise CadError("INVALID_PATH", "Import source must be inside this project directory.")
    if not source.is_file() or source.stat().st_size > 250_000_000:
        raise CadError("INVALID_FILE", "Expected a local CAD file smaller than 250 MB.")
    suffix = source.suffix.lower()
    if suffix not in {".step", ".stp", ".stl"}:
        raise CadError("UNSUPPORTED_FORMAT", "Import supports STEP/STP and STL.")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()
    instances, parts = [], []
    solids = []
    views = {}
    if suffix in {".step", ".stp"}:
        imported = cq.importers.importStep(str(source))
        shape = imported.val()
        solids = shape.Solids()
        if not solids:
            raise CadError("NO_SOLID", "STEP did not contain closed solids.")
        meshes = [mesh_object(solid) for solid in solids]
        measurements = measure(shape)
        measurements["sum_of_solid_volumes_mm3"] = sum(s.Volume() for s in solids)
        # Dense imported assemblies can make hidden-line projection disproportionately costly.
        if len(solids) <= 40 and payload.get("project", False):
            views = export_views(shape, output / "views")
        shutil.copyfile(source, output / "model.step")
        hierarchy = "STEP B-rep solids preserved as separate objects. Source product hierarchy, instance labels and constraints were not recovered."
    else:
        loaded = trimesh.load(str(source), force="mesh", process=False)
        if not isinstance(loaded, trimesh.Trimesh) or not len(loaded.faces):
            raise CadError("EMPTY_MESH", "STL contains no mesh faces.")
        # STL repeats vertices per triangle; merge before connectivity detection.
        loaded.merge_vertices()
        meshes = list(loaded.split(only_watertight=False)) or [loaded]
        measurements = {"valid": None, "watertight": bool(loaded.is_watertight), "solids": None, "mesh_components": len(meshes),
                        "volume_mm3": float(abs(loaded.volume)) if loaded.is_watertight else None,
                        "bbox": {"min": loaded.bounds[0].tolist(), "max": loaded.bounds[1].tolist(), "size": loaded.extents.tolist()},
                        "faces": len(loaded.faces), "surface_area_mm2": float(loaded.area)}
        hierarchy = "STL connected mesh components retained separately. Components are not verified mechanical parts and no assembly semantics are inferred."
    total = len(meshes)
    assembly_center = (np.array(measurements["bbox"]["min"]) + np.array(measurements["bbox"]["max"])) / 2
    diagonal = np.linalg.norm(measurements["bbox"]["size"])
    for index, mesh in enumerate(meshes):
        part_id = f"imported-{index + 1:03d}"
        directory = output / "parts" / part_id
        directory.mkdir(parents=True, exist_ok=True)
        data = {"units": "mm", "up_axis": "Z", "positions": np.round(mesh.vertices, 6).tolist(), "indices": mesh.faces.tolist()}
        write_json(directory / "mesh.json", data)
        mesh.export(str(directory / "model.glb"))
        scene.add_geometry(mesh, geom_name=part_id, node_name=part_id)
        direction = np.array(mesh.centroid) - assembly_center
        if np.linalg.norm(direction) < 1e-6:
            direction = np.array([0, 0, 1 if index % 2 == 0 else -1])
        explode = (direction / np.linalg.norm(direction) * max(diagonal * 0.45, 20)).tolist() if total > 1 else [0, 0, 0]
        measurements_part = measure(solids[index]) if solids else {"bbox": {"min": mesh.bounds[0].tolist(), "max": mesh.bounds[1].tolist(), "size": mesh.extents.tolist()}, "watertight": bool(mesh.is_watertight)}
        parts.append({"id": part_id, "name": part_id, "files": {"mesh": str(directory / "mesh.json"), "glb": str(directory / "model.glb")}, "measurements": measurements_part})
        instances.append({"id": part_id, "part_id": part_id, "mesh": str(directory / "mesh.json"), "translation": [0, 0, 0], "rotation": [0, 0, 0],
                          "original_transform": {"translation": [0, 0, 0], "rotation_euler_xyz_degrees": [0, 0, 0]}, "explode": explode, "sequence": index,
                          "explode_provenance": "Illustrative centroid separation; not a solved disassembly path."})
    scene.export(str(output / "model.glb"))
    merged = trimesh.util.concatenate(meshes)
    write_json(output / "mesh.json", {"units": "mm", "up_axis": "Z", "positions": np.round(merged.vertices, 6).tolist(), "indices": merged.faces.tolist()})
    files = {"glb": str(output / "model.glb"), "mesh": str(output / "mesh.json"), "views": views}
    if solids:
        files["step"] = str(output / "model.step")
    manifest = {"schema_version": "1.0", "status": "completed", "operation": "import", "id": payload.get("id", source.stem), "name": payload.get("name", source.stem),
                "source_type": "imported-existing-cad", "source": str(source), "units": "mm", "up_axis": "Z", "units_note": "STEP kernel values use millimetres; STL has no unit metadata and is assumed millimetres.",
                "files": files, "parts": parts, "instances": instances, "instance_count": total, "measurements": measurements,
                "verification": {"passed": measurements.get("valid") if solids else None, "geometry_valid": measurements.get("valid"),
                                 "scope": "Imported B-rep validity only; no source drawing, semantic assembly or disassembly verification." if solids else "Mesh inspection only; no B-rep validation or disassembly verification."},
                "hierarchy_note": hierarchy, "path_check": {"checked": False, "passed": None, "reason": "No assembly constraints or disassembly path supplied for imported components."}, "errors": []}
    write_json(output / "manifest.json", manifest)
    return manifest
