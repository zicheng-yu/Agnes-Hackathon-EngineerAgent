#!/usr/bin/env python3
"""Build reproducible local comparison/repair evidence, explicitly excluding automatic read claims."""
import copy
import json
from pathlib import Path

from compare import compare_views
from engine import export_part, patch_plan, write_json


def compare_payload(source, projection):
    source_meta = json.loads(Path(source["files"]["view_metadata"]).read_text())["views"]["top"]
    projected_meta = json.loads(Path(projection["files"]["view_metadata"]).read_text())["views"]["top"]
    return {"source": {"path": source_meta["path"], "px_per_mm": source_meta["px_per_mm"], "svg_visible_only": True, "scale_evidence": source_meta["scale_evidence"]},
            "projection": {"path": projected_meta["path"], "px_per_mm": projected_meta["px_per_mm"], "svg_visible_only": True, "scale_evidence": projected_meta["scale_evidence"]},
            "registration": {"rotation_degrees": 0, "translation_px": [0, 0], "source_origin_px": source_meta["origin_px"], "projection_origin_px": projected_meta["origin_px"]},
            "pre_cropped_views": True, "tolerance_mm": 0.15, "normalization_length_mm": 80, "minimum_match_fraction": 0.995}


def main():
    project = Path(__file__).resolve().parents[2]
    output = project / "assets/generated/evidence/plate-hole-repair"
    plan = json.loads((project / "tools/cad/examples/mounting-plate.json").read_text())
    reference = export_part(plan, output / "reference")
    wrong_plan = copy.deepcopy(plan)
    next(f for f in wrong_plan["features"] if f["id"] == "mount-holes")["diameter"] = 10
    before = export_part(wrong_plan, output / "before")
    compare_before = compare_payload(reference, before)
    write_json(output / "compare-before-input.json", compare_before)
    initial = compare_views(compare_before, output / "compare-before")
    patch_payload = {"plan": wrong_plan, "patches": [{"feature_id": "mount-holes", "set": {"diameter": 9}}]}
    write_json(output / "patch-input.json", patch_payload)
    after = export_part(patch_plan(patch_payload), output / "after")
    compare_after = compare_payload(reference, after)
    write_json(output / "compare-after-input.json", compare_after)
    final = compare_views(compare_after, output / "compare-after")
    report = {"kind": "deterministic-geometry-tool-evidence", "claim": "Local CAD build, geometric measurement, calibrated view comparison and explicit feature patch are exercised with real files.",
              "not_claimed": ["Automatic drawing understanding", "Autonomous model-selected correction", "Hidden reference parameters available to a reconstruction agent"],
              "reference_origin": "Self-authored parameter fixture. Source contour is a known reference CAD projection, not a model-read drawing.",
              "changed_feature": "mount-holes", "patch": {"diameter_mm_before": 10, "diameter_mm_after": 9},
              "before": {"cad_verification": before["verification"], "view_verification": initial["verification"], "view_metrics": initial["metrics"]},
              "after": {"cad_verification": after["verification"], "view_verification": final["verification"], "view_metrics": final["metrics"]},
              "artifacts": {"before_manifest": str(output / "before/manifest.json"), "after_manifest": str(output / "after/manifest.json"),
                            "before_overlay": initial["files"]["overlay"], "after_overlay": final["files"]["overlay"],
                            "three_view_measurements": after["files"]["view_metadata"], "patch_input": str(output / "patch-input.json")}}
    write_json(output / "report.json", report)
    text = f"""# 本地几何工具验证与修复样例

本样例使用明确参数生成参考板件，将 4 个孔径从 9 mm 改为 10 mm，再根据明确补丁恢复为 9 mm。参考轮廓来自已知 CAD 投影。这是工具级回归证据，不是自动读图或模型自主修复的成绩。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| CAD 明确几何检查通过 | {before['verification']['passed']} | {after['verification']['passed']} |
| 缺失边像素 | {initial['metrics']['missing_pixels']} | {final['metrics']['missing_pixels']} |
| 额外边像素 | {initial['metrics']['extra_pixels']} | {final['metrics']['extra_pixels']} |
| 对称平均边距离 mm | {initial['metrics']['symmetric_mean_distance_mm']:.6f} | {final['metrics']['symmetric_mean_distance_mm']:.6f} |
| 按 80 mm 归一化距离 | {initial['metrics']['normalized_mean_distance']:.6f} | {final['metrics']['normalized_mean_distance']:.6f} |
| 明确阈值下视图检查通过 | {initial['verification']['passed']} | {final['verification']['passed']} |

阈值保持不变：边距离容差 0.15 mm、双向匹配比例至少 0.995。两份 SVG 的比例来自内核导出的统一缩放，配准仅有统一缩放、旋转和平移，没有逐轴拉伸。三视图的宽高、物理轴向和像素原点见 after/views/metadata.json；实测量来自生成 B-rep。

修复前红色表示源图缺失轮廓，蓝色表示额外投影轮廓；修复后应为重合的绿色。对应 overlay.png、输入 JSON、STEP、GLB、三视图与完整 report.json 均在本目录内。
"""
    (output / "report.md").write_text(text, encoding="utf-8")
    print(json.dumps({"status": "completed", "report": str(output / "report.json"), "before_passed": initial["verification"]["passed"], "after_passed": final["verification"]["passed"]}))


if __name__ == "__main__":
    main()
