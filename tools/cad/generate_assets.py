#!/usr/bin/env python3
"""Generate original demo CAD. These parameter-authored assets are NOT reconstruction evidence."""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path

from assembly import export_assembly
from engine import export_part, write_json


PROVENANCE = {"kind": "original-parametric-demo", "author": "Project-generated demonstration assets", "license": "CC0-1.0", "created": "2026-10-09", "disclaimer": "Self-authored demonstration geometry. Not a manufacturer specification, real enterprise order/history, or evidence of automatic drawing reconstruction."}


def part(part_id, name, features, material="45 steel", checks=None):
    return {"id": part_id, "name": name, "units": "mm", "source_type": "original-parametric-demo", "material": material, "provenance": PROVENANCE,
            "features": features, "checks": checks or [{"kind": "valid", "expected": 1}, {"kind": "solids", "expected": 1}]}


def ring(part_id, name, outer, inner, height, material="45 steel"):
    return part(part_id, name, [{"id": "blank", "op": "cylinder", "radius": outer, "height": height}, {"id": "bore", "op": "hole", "diameter": inner * 2}], material)


def hex_bolt(part_id, diameter, length):
    return part(part_id, f"M{diameter} 六角螺栓（无螺纹简化）", [
        {"id": "head", "op": "extrude", "profile": {"kind": "regular_polygon", "sides": 6, "diameter": diameter * 1.9}, "distance": diameter * 0.7},
        {"id": "shaft", "op": "cylinder", "radius": diameter / 2, "height": length, "translation": [0, 0, diameter * 0.7]},
        {"id": "fused", "op": "union", "base": "head", "tool": "shaft"},
        {"id": "edge-break", "op": "chamfer", "selector": ">Z", "length": 0.6}], "Grade 8.8 steel (demo)")


def instance(instance_id, part_id, translation, explode, sequence, rotation=None, color=None):
    return {"id": instance_id, "part_id": part_id, "translation": translation, "rotation": rotation or [0, 0, 0], "explode": explode,
            "sequence": sequence, "color": color or [143, 166, 181, 255]}


def flange_assembly():
    holes = [[62 * math.cos(i * math.pi / 2 + math.pi / 4), 62 * math.sin(i * math.pi / 2 + math.pi / 4)] for i in range(4)]
    flange = part("flange-hub", "带颈连接法兰", [
        {"id": "plate", "op": "cylinder", "radius": 80, "height": 18},
        {"id": "hub", "op": "cylinder", "radius": 45, "height": 24, "translation": [0, 0, -24]},
        {"id": "blank", "op": "union", "base": "plate", "tool": "hub"},
        {"id": "flow-bore", "op": "hole", "diameter": 60},
        {"id": "bolt-holes", "op": "hole", "diameter": 11.5, "points": holes},
        {"id": "edge-break", "op": "chamfer", "selector": ">Z", "length": 1}], checks=[
            {"kind": "bbox", "axis": "x", "expected": 160}, {"kind": "bbox", "axis": "z", "expected": 42},
            {"kind": "circular_edge_diameter", "expected": 60, "feature_id": "flow-bore"}])
    gasket = ring("gasket", "密封垫片", 55, 30, 4, "NBR (illustrative)")
    washer = ring("washer-m10", "M10 平垫圈", 10.5, 5.5, 3, "Stainless steel")
    bolt = hex_bolt("bolt-m10", 10, 54)
    nut = part("nut-m10", "M10 六角螺母（无螺纹简化）", [
        {"id": "hex", "op": "extrude", "profile": {"kind": "regular_polygon", "sides": 6, "diameter": 19}, "distance": 8},
        {"id": "bore", "op": "hole", "diameter": 10.5},
        {"id": "chamfer", "op": "chamfer", "selector": ">Z", "length": 0.5}])
    instances = [instance("lower-flange", "flange-hub", [0, 0, 0], [0, 0, 0], 100),
                 instance("upper-flange", "flange-hub", [0, 0, 40], [0, 0, 70], 50, [180, 0, 0]),
                 instance("seal", "gasket", [0, 0, 18], [0, 0, 32], 60, color=[213, 140, 42, 255])]
    for i, (x, y) in enumerate(holes, 1):
        instances.extend([
            instance(f"nut-{i}", "nut-m10", [x, y, 43], [0, 0, 160], i, color=[65, 78, 90, 255]),
            instance(f"washer-upper-{i}", "washer-m10", [x, y, 40], [0, 0, 133], 10 + i),
            instance(f"bolt-{i}", "bolt-m10", [x, y, -10], [0, 0, -110], 20 + i, color=[68, 82, 96, 255]),
            instance(f"washer-lower-{i}", "washer-m10", [x, y, -3], [0, 0, -68], 30 + i)])
    return {"id": "flange-coupling-19", "name": "19 件双法兰密封连接组件", "units": "mm", "source_type": "original-parametric-demo", "provenance": PROVENANCE,
            "description": "A bolted pipe connection exposing gasket, mating flanges and complete fastener stack.", "parts": [flange, gasket, washer, bolt, nut], "instances": instances, "path_samples": 6}


def vise_assembly():
    base = part("vise-base", "双导柱精密夹具底座", [
        {"id": "blank", "op": "box", "size": [260, 140, 14]},
        {"id": "mount-slots", "op": "hole", "diameter": 12, "points": [[-112, -56], [-112, 56], [112, -56], [112, 56]]},
        {"id": "support-fastener-holes", "op": "hole", "diameter": 8.5, "points": [[103, -13], [103, 43]]},
        {"id": "edge-break", "op": "chamfer", "selector": "|Z", "length": 3}], "6061-T6 aluminium")
    jaw_features = [
        {"id": "body", "op": "box", "size": [32, 104, 54]},
        {"id": "rod-a", "op": "cylinder", "radius": 7.3, "height": 42, "translation": [-21, -28, 24], "rotation": [0, 90, 0]},
        {"id": "rod-b", "op": "cylinder", "radius": 7.3, "height": 42, "translation": [-21, 28, 24], "rotation": [0, 90, 0]},
        {"id": "guide-bore-a", "op": "cut", "base": "body", "tool": "rod-a"},
        {"id": "guide-bore-b", "op": "cut", "base": "guide-bore-a", "tool": "rod-b"},
        {"id": "spindle-tool", "op": "cylinder", "radius": 9, "height": 42, "translation": [-21, 0, 24], "rotation": [0, 90, 0]},
        {"id": "spindle-bore", "op": "cut", "base": "guide-bore-b", "tool": "spindle-tool"},
        {"id": "mount-holes", "op": "hole", "diameter": 8.5, "points": [[-8, -44], [-8, 44], [8, -44], [8, 44]]}]
    fixed = part("fixed-tower", "固定支架（双导孔与丝杠孔）", jaw_features)
    movable = part("moving-jaw", "活动滑台", jaw_features)
    rod = part("guide-rod", "淬硬导向轴", [{"id": "turned", "op": "cylinder", "radius": 7, "height": 216}, {"id": "end-break", "op": "chamfer", "selector": ">Z", "length": 0.8}], "GCr15 (demo)")
    screw = part("lead-screw", "传动丝杠（螺纹包络简化）", [{"id": "turned", "op": "cylinder", "radius": 8, "height": 262}, {"id": "end-break", "op": "chamfer", "selector": ">Z", "length": 0.6}])
    bearing = part("guide-support", "导柱端部支承座", [
        {"id": "body", "op": "box", "size": [24, 40, 38]},
        {"id": "rod-tool", "op": "cylinder", "radius": 7.3, "height": 34, "rotation": [0, 90, 0], "translation": [-17, 0, 24]},
        {"id": "guide-hole", "op": "cut", "base": "body", "tool": "rod-tool"},
        {"id": "mount-hole", "op": "hole", "diameter": 8.5, "points": [[0, 15]]}])
    insert = part("jaw-insert", "可更换夹持钳口", [{"id": "blank", "op": "box", "size": [6, 84, 20]},
        {"id": "edge-break", "op": "chamfer", "selector": "|Z", "length": 0.8}], "Tool steel")
    wheel = part("handwheel", "四辐调节手轮", [
        {"id": "rim", "op": "cylinder", "radius": 40, "height": 8},
        {"id": "rim-bore", "op": "hole", "diameter": 62},
        {"id": "spoke-a", "op": "box", "size": [66, 10, 8]},
        {"id": "spoke-b", "op": "box", "size": [10, 66, 8]},
        {"id": "spokes", "op": "union", "base": "spoke-a", "tool": "spoke-b"},
        {"id": "wheel", "op": "union", "base": "rim-bore", "tool": "spokes"},
        {"id": "hub", "op": "cylinder", "radius": 14, "height": 14},
        {"id": "combined", "op": "union", "base": "wheel", "tool": "hub"},
        {"id": "center-bore", "op": "hole", "diameter": 16.2},
        {"id": "handle-hole", "op": "hole", "diameter": 6.5, "points": [[0, 35]]}], "Black oxide steel")
    handle = part("wheel-handle", "手轮旋转握柄", [{"id": "stem", "op": "cylinder", "radius": 3, "height": 9},
        {"id": "grip", "op": "cylinder", "radius": 7, "height": 32, "translation": [0, 0, 9]},
        {"id": "combined", "op": "union", "base": "stem", "tool": "grip"}], "Polymer grip / steel stem")
    bolt = hex_bolt("bolt-m8", 8, 50)
    instances = [instance("base", "vise-base", [0, 0, 0], [0, 0, 0], 100, color=[63, 83, 98, 255]),
        instance("fixed-tower", "fixed-tower", [-94, 0, 14], [0, 0, 135], 70),
        instance("moving-carriage", "moving-jaw", [32, 0, 14], [0, 0, 85], 71),
        instance("rod-left", "guide-rod", [-110, -28, 38], [280, 0, 0], 60, [0, 90, 0]),
        instance("rod-right", "guide-rod", [-110, 28, 38], [280, 0, 0], 61, [0, 90, 0]),
        instance("spindle", "lead-screw", [-110, 0, 38], [310, 0, 0], 50, [0, 90, 0], [185, 190, 190, 255]),
        instance("wheel", "handwheel", [138, 0, 38], [450, 0, 0], 10, [0, 90, 0], [214, 145, 43, 255]),
        instance("grip", "wheel-handle", [138, 35, 38], [510, 0, 0], 1, [0, 90, 0], [52, 58, 65, 255]),
        instance("support-left", "guide-support", [103, -28, 14], [0, -95, 65], 65),
        instance("support-right", "guide-support", [103, 28, 14], [0, 95, 65], 66),
        instance("insert-fixed", "jaw-insert", [-75, 0, 48], [0, 0, 200], 40, color=[190, 196, 194, 255]),
        instance("insert-moving", "jaw-insert", [13, 0, 48], [0, 0, 165], 41, color=[190, 196, 194, 255])]
    # Six visible fasteners; bolt heads sit above their respective support and shafts enter the bores.
    for idx, (x, y, top) in enumerate([(-102, -44, 68), (-102, 44, 68), (-86, -44, 68), (-86, 44, 68), (103, -13, 52), (103, 43, 52)], 1):
        instances.append(instance(f"mount-bolt-{idx}", "bolt-m8", [x, y, top + 5.6], [0, 0, 240 + idx * 12], 20 + idx, [180, 0, 0], [55, 67, 79, 255]))
    return {"id": "precision-vise-18", "name": "18 件双导柱精密夹持组件", "units": "mm", "source_type": "original-parametric-demo", "provenance": PROVENANCE,
            "description": "Bench fixture with replaceable jaw inserts, dual guide rods, lead screw envelope and four-spoke handwheel.",
            "parts": [base, fixed, movable, rod, screw, bearing, insert, wheel, handle, bolt], "instances": instances, "path_samples": 6}


def drawing_sheet(plan, manifest, output):
    """A visible dimensioned input sheet; source parameters stay in the reference directory."""
    from xml.etree import ElementTree as ET
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    root = ET.Element("{http://www.w3.org/2000/svg}svg", {"viewBox": "0 0 1400 980", "width": "1400", "height": "980"})
    def elem(tag, attrs, text=None):
        node = ET.SubElement(root, "{http://www.w3.org/2000/svg}" + tag, attrs)
        node.text = text
        return node
    elem("rect", {"width": "1400", "height": "980", "fill": "#f8fafc"})
    elem("rect", {"x": "24", "y": "24", "width": "1352", "height": "932", "fill": "none", "stroke": "#183446", "stroke-width": "2"})
    elem("text", {"x": "54", "y": "74", "font-size": "27", "font-family": "sans-serif", "fill": "#173044"}, f"ENGINEERING DEMO INPUT / {plan['id']}")
    for name, x, y in [("front", 45, 115), ("top", 705, 115), ("side", 45, 565)]:
        view = ET.parse(manifest["files"]["views"][name]).getroot()
        view.attrib.update({"x": str(x), "y": str(y), "width": "620", "height": "350"})
        root.append(view)
        elem("text", {"x": str(x + 8), "y": str(y + 365), "font-size": "20", "font-family": "monospace", "fill": "#183446"}, name.upper())
    x, y, z = manifest["measurements"]["bbox"]["size"]
    for index, text in enumerate([f"Overall X: {x:.2f} mm", f"Overall Y: {y:.2f} mm", f"Overall Z: {z:.2f} mm", "Units: mm | Named orthographic views", "INCOMPLETE INTERNAL DIMENSIONS: request clarification.", "ORIGINAL SYNTHETIC DEMO / NOT A MANUFACTURING DRAWING", "Reference CAD is held separately from drawing-only input."]):
        elem("text", {"x": "710", "y": str(625 + index * 38), "font-size": "16", "font-family": "monospace", "fill": "#183446"}, text)
    # Explicit outer-dimension lines, aligned to the frontal view bounding rectangle.
    elem("line", {"x1": "105", "x2": "570", "y1": "498", "y2": "498", "stroke": "#b35c00", "stroke-width": "2"})
    for dx in (105, 570):
        elem("line", {"x1": str(dx), "x2": str(dx), "y1": "488", "y2": "508", "stroke": "#b35c00"})
    elem("text", {"x": "290", "y": "530", "font-size": "20", "font-family": "monospace", "fill": "#b35c00"}, f"{x:.2f} mm")
    Path(output).write_text(ET.tostring(root, encoding="unicode"), encoding="utf-8")


def complete_plate_input(output):
    """Complete nominal drawing authored independently of the reference model renderer."""
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    # SVG is an input document, not a hidden feature plan. Every value appears visibly.
    svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1200" viewBox="0 0 1400 1200">
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" fill="#263e50"/></marker></defs>
<rect width="1400" height="1200" fill="#fff"/><rect x="25" y="25" width="1350" height="1150" fill="none" stroke="#183446" stroke-width="2"/>
<g font-family="monospace" fill="#183446"><text x="65" y="78" font-size="30">MP-080 / MACHINED MOUNTING PLATE</text><text x="65" y="112" font-size="19">ALL DIMENSIONS IN mm | NOMINAL GEOMETRY | ORIGINAL DEMO DRAWING</text></g>
<g fill="none" stroke="#183446" stroke-width="3">
<rect x="240" y="220" width="640" height="480" rx="24"/>
<circle cx="360" cy="340" r="36"/><circle cx="760" cy="340" r="36"/><circle cx="360" cy="580" r="36"/><circle cx="760" cy="580" r="36"/>
<rect x="240" y="835" width="640" height="96"/>
<path stroke-dasharray="10 6" stroke-width="1.5" d="M324 835V931 M396 835V931 M724 835V931 M796 835V931"/>
<rect x="1080" y="220" width="96" height="480"/>
<path stroke-dasharray="10 6" stroke-width="1.5" d="M1080 304H1176 M1080 376H1176 M1080 544H1176 M1080 616H1176"/>
</g>
<g stroke="#718696" stroke-width="1.2" stroke-dasharray="18 6 3 6"><path d="M560 200V720 M220 460H900 M345 340H375 M360 325V355 M745 340H775 M760 325V355 M345 580H375 M360 565V595 M745 580H775 M760 565V595"/></g>
<g stroke="#263e50" stroke-width="1.4" fill="none">
<path d="M240 155V211 M880 155V211 M160 220H231 M160 700H231 M360 610V774 M760 610V774 M796 340H965 M796 580H965 M886 835H965 M886 931H965"/>
<path marker-start="url(#arrow)" marker-end="url(#arrow)" d="M240 170H880 M175 220V700 M360 757H760 M945 340V580 M945 835V931"/>
<path d="M800 312L940 230H1050 M254 232L185 195H70"/>
</g>
<g font-family="monospace" fill="#183446" font-size="23">
<text x="544" y="160">80</text><text x="145" y="472" transform="rotate(-90 145 472)">60</text>
<text x="544" y="746">50</text><text x="936" y="472" transform="rotate(-90 936 472)">30</text><text x="937" y="898" transform="rotate(-90 937 898)">12</text>
<text x="947" y="218">4 x Ø9 THRU</text><text x="72" y="184">4 x R3</text>
<text x="242" y="798">TOP</text><text x="242" y="971">FRONT</text><text x="1080" y="742">RIGHT</text>
</g>
<g font-family="monospace" fill="#183446" font-size="20"><text x="70" y="1030">Hole pattern centered on plate: 50 x 30. All four holes are through.</text>
<text x="70" y="1066">Corner fillets R3 extend through the full 12 mm thickness.</text><text x="70" y="1102">No unspecified chamfers. Material: 6061-T6 (illustrative). No tolerances.</text>
<text x="70" y="1138">Self-authored input. Reference CAD is excluded from agent input folders.</text></g></svg>'''
    (output / "mounting-plate-complete.svg").write_text(svg, encoding="utf-8")
    return part("mounting-plate-complete", "四孔圆角安装板（独立读图输入）", [
        {"id": "blank", "op": "box", "size": [80, 60, 12]},
        {"id": "mount-holes", "op": "hole", "diameter": 9, "points": [[-25, -15], [25, -15], [-25, 15], [25, 15]]},
        {"id": "corners", "op": "fillet", "selector": "|Z", "radius": 3}], "6061-T6 aluminium", [
            {"kind": "bbox", "axis": "x", "expected": 80}, {"kind": "bbox", "axis": "y", "expected": 60},
            {"kind": "bbox", "axis": "z", "expected": 12}, {"kind": "circular_edge_diameter", "expected": 9}])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "assets" / "generated")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    index = {"source_type": "original-parametric-demo", "provenance": PROVENANCE, "assemblies": [], "parts": []}
    plate = complete_plate_input(args.output / "drawing-inputs")
    write_json(args.output / "reference-plans" / "mounting-plate-complete.json", plate)
    export_part(plate, args.output / "reference-models" / "mounting-plate-complete")
    for plan in [flange_assembly(), vise_assembly()]:
        print(f"Building {plan['id']}", flush=True)
        target = args.output / plan["id"]
        manifest = export_assembly(plan, target)
        write_json(args.output / "reference-plans" / f"{plan['id']}.json", plan)
        index["assemblies"].append({"id": plan["id"], "name": plan["name"], "manifest": str(target / "manifest.json"), "instance_count": manifest["instance_count"], "path_check_passed": manifest["path_check"]["passed"], "provenance": PROVENANCE})
        for p, m in zip(plan["parts"], manifest["parts"]):
            if p["id"] in {"flange-hub", "fixed-tower", "handwheel"}:
                sheet_path = args.output / "drawing-inputs" / f"{p['id']}.svg"
                sheet_path.parent.mkdir(parents=True, exist_ok=True)
                drawing_sheet(p, m, sheet_path)
            index["parts"].append({"id": p["id"], "name": p["name"], "manifest": str(Path(m["files"]["step"]).parent / "manifest.json"), "assembly_id": plan["id"]})
        print(f"  {manifest['instance_count']} instances, path check passed={manifest['path_check']['passed']}", flush=True)
    write_json(args.output / "catalog.json", index)
    print(json.dumps({"status": "completed", "catalog": str(args.output / "catalog.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
