import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InspectionReport from "../../src/InspectionReport";
import before from "../../assets/generated/evidence/plate-hole-repair/before/manifest.json";
import after from "../../assets/generated/evidence/plate-hole-repair/after/manifest.json";
import compareBefore from "../../assets/generated/evidence/plate-hole-repair/compare-before/manifest.json";
import compareAfter from "../../assets/generated/evidence/plate-hole-repair/compare-after/manifest.json";
import flange from "../../assets/generated/flange-coupling-19/manifest.json";
import importedStl from "../../assets/catalog/moveo-wrist/preview-cad/manifest.json";

function metric(label: string) {
  return screen.getByText(label).closest(".inspection-report__metric") as HTMLElement;
}

describe("human-readable geometry reports", () => {
  it("renders real passed CAD measurements and checks without raw JSON or redundant success prose", () => {
    const { container } = render(<InspectionReport manifest={after} />);
    expect(screen.getByText("检查已通过")).toBeInTheDocument();
    expect(metric("几何有效性")).toHaveTextContent("有效");
    expect(metric("实体数量")).toHaveTextContent("1 个");
    expect(metric("外形尺寸（X × Y × Z）")).toHaveTextContent("80 × 60 × 12 mm");
    expect(metric("体积").textContent).toMatch(/cm³/);
    expect(screen.getByRole("columnheader", { name: "目标值" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "实测值" })).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("/Users/admin");
    expect(container.textContent).not.toContain("报告中的检查项已通过");
    expect(container.textContent).not.toContain("范围：几何与已列检查条件");
  });

  it("explains the actual failed diameter instead of treating completed as passed", () => {
    render(<InspectionReport manifest={before} />);
    expect(screen.getByText("有待处理项")).toBeInTheDocument();
    expect(screen.getByText(/圆边直径：目标 9 mm，实测 10 mm，偏差 1 mm/)).toBeInTheDocument();
    const failedRow = screen.getByRole("rowheader", { name: "圆边直径" }).closest("tr")!;
    expect(within(failedRow).getByText(/允许 0.05 mm/)).toBeInTheDocument();
    expect(screen.queryByText("检查已通过")).not.toBeInTheDocument();
    expect(metric("几何有效性")).toHaveTextContent("有效");
  });

  it.each([null, undefined, "not a report", []])(
    "handles missing or malformed report %j",
    (manifest) => {
      render(<InspectionReport manifest={manifest} />);
      expect(screen.getByText("总判定未提供")).toBeInTheDocument();
      expect(screen.getByText("检查报告未提供。")).toBeInTheDocument();
      expect(screen.queryByText("检查已通过")).not.toBeInTheDocument();
    },
  );

  it("keeps null STL validity, solids and volume unknown rather than using zero or mesh count", () => {
    render(<InspectionReport manifest={importedStl} />);
    expect(metric("几何有效性")).toHaveTextContent("未提供");
    expect(metric("实体数量")).toHaveTextContent("未提供");
    expect(metric("体积")).toHaveTextContent("未提供");
    expect(metric("体积")).not.toHaveTextContent("0 cm³");
    expect(screen.getByText(/未提供装配约束和拆解路径/)).toBeInTheDocument();
    expect(screen.queryByText("检查已通过")).not.toBeInTheDocument();
    expect(screen.queryByText("采样路径已通过")).not.toBeInTheDocument();
  });

  it("does not coerce string/unknown flags or missing deviations into a pass/zero", () => {
    render(
      <InspectionReport
        manifest={{
          operation: "validate",
          status: "completed",
          measurements: { valid: "true", solids: null, volume_mm3: null },
          verification: {
            passed: "true",
            checks: [
              {
                kind: "bbox",
                expected: 12,
                actual: 12,
                tolerance: 0.05,
                error: null,
                passed: null,
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("总判定未提供")).toBeInTheDocument();
    expect(metric("几何有效性")).toHaveTextContent("未提供");
    const row = screen.getByRole("rowheader", { name: /外形尺寸/ }).closest("tr")!;
    expect(row).toHaveTextContent("未提供");
    expect(within(row).queryByText("已通过")).not.toBeInTheDocument();
    expect(within(row).queryByText("0 mm")).not.toBeInTheDocument();
  });

  it("converts volume values consistently and preserves small nonzero deviations", () => {
    render(
      <InspectionReport
        manifest={{
          operation: "validate",
          verification: {
            passed: true,
            measurements: {
              valid: true,
              solids: 1,
              volume_mm3: 12345.6789,
              bbox: { size: [10, 20, 30] },
            },
            checks: [
              {
                kind: "bbox",
                axis: "z",
                expected: 30,
                actual: 30.0000002,
                error: 0.0000002,
                tolerance: 0.05,
                passed: true,
              },
            ],
          },
        }}
      />,
    );
    expect(metric("体积")).toHaveTextContent("12.346 cm³");
    expect(screen.getByText("0.0000002 mm")).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Z 向尺寸" })).toBeInTheDocument();
  });

  it("accepts the API envelope and shows a concrete tool error without exposing file paths", () => {
    render(
      <InspectionReport
        manifest={{
          success: false,
          manifest: {
            operation: "build",
            status: "failed",
            errors: [
              {
                code: "UNKNOWN_FEATURE",
                feature_id: "mount-holes",
                message: "a raw implementation message",
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText(/特征 mount-holes：建模特征引用缺失/)).toBeInTheDocument();
    expect(screen.getByText("有待处理项")).toBeInTheDocument();
  });
});

describe("assembly paths and bill of materials", () => {
  it("shows the real BOM and distinguishes moving steps from fixed instances", () => {
    render(<InspectionReport manifest={flange} />);
    expect(screen.getByText("采样路径已通过")).toBeInTheDocument();
    expect(
      screen.getByText(/已检查 18 条 · 未检查 0 条 · 1 个实例保持固定/),
    ).toBeInTheDocument();
    const section = screen.getByText("装配零件清单").closest("details")!;
    expect(within(section).getAllByRole("row")).toHaveLength(6);
    expect(within(section).getByText("带颈连接法兰")).toBeInTheDocument();
    expect(within(section).getByText("2 件")).toBeInTheDocument();
    expect(within(section).getByText("丁腈橡胶（演示）")).toBeInTheDocument();
  });

  it("surfaces collision evidence even when the aggregate flag claims success", () => {
    render(
      <InspectionReport
        manifest={{
          operation: "assembly",
          measurements: { valid: true },
          verification: { passed: true, path_check_passed: true },
          instances: [{ id: "bolt", part_id: "bolt-part", explode: [0, 0, 10] }],
          bom: [{ part_id: "bolt-part", name: "螺栓", quantity: 1 }],
          path_check: {
            passed: true,
            samples_per_path: 6,
            volume_tolerance_mm3: 0.01,
            initial_interferences: [],
            steps: [
              {
                instance_id: "bolt",
                sequence: 1,
                checked: true,
                passed: false,
                samples: 6,
                collisions: [{ other: "cover", progress: 0.5, volume_mm3: 2.5 }],
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("有待处理项")).toBeInTheDocument();
    expect(screen.getByText(/螺栓（bolt）\s*的移动路径未通过/)).toBeInTheDocument();
    expect(screen.getByText(/移动至 50% 时与 cover 交叠 2.5 mm³/)).toBeInTheDocument();
    expect(screen.queryByText("采样路径已通过")).not.toBeInTheDocument();
  });

  it("does not double-count an explicitly unchecked moving instance", () => {
    render(
      <InspectionReport
        manifest={{
          operation: "assembly",
          measurements: { valid: true },
          verification: { passed: true },
          instances: [{ id: "moving", explode: [0, 0, 5] }],
          path_check: {
            checked: false,
            passed: null,
            steps: [{ instance_id: "moving", checked: false, passed: null }],
          },
        }}
      />,
    );
    expect(screen.getByText(/已检查 0 条 · 未检查 1 条/)).toBeInTheDocument();
    expect(screen.getByText("总判定未提供")).toBeInTheDocument();
    expect(screen.queryByText("检查已通过")).not.toBeInTheDocument();
  });

  it("does not describe an empty movement plan as validated trajectories", () => {
    render(
      <InspectionReport
        manifest={{
          operation: "assembly",
          measurements: { valid: true },
          verification: { passed: true },
          instances: [{ id: "base", explode: [0, 0, 0] }],
          path_check: { passed: true, steps: [] },
        }}
      />,
    );
    expect(screen.getByText("无移动路径需检查")).toBeInTheDocument();
    expect(screen.queryByText("采样路径已通过")).not.toBeInTheDocument();
  });
});

describe("calibrated view comparison", () => {
  it("translates the real failed metrics, units and acceptance threshold", () => {
    render(<InspectionReport manifest={compareBefore} />);
    expect(metric("投影边缘吻合程度")).toHaveTextContent("83.78%");
    expect(metric("原图边缘覆盖程度")).toHaveTextContent("86.46%");
    expect(metric("缺失边缘")).toHaveTextContent("608 像素");
    expect(metric("额外边缘")).toHaveTextContent("752 像素");
    expect(metric("平均轮廓偏差")).toHaveTextContent("0.07 mm");
    expect(metric("两项边缘指标最低要求")).toHaveTextContent("99.5%");
    expect(metric("轮廓匹配容差")).toHaveTextContent("0.15 mm");
    expect(screen.getByText(/不包含整页自动配准/)).toBeInTheDocument();
    expect(screen.getByText("有待处理项")).toBeInTheDocument();
  });

  it("preserves zero-valued passed differences and collapses only detail sections in compact mode", () => {
    render(<InspectionReport manifest={compareAfter} compact />);
    expect(screen.getByText("检查已通过")).toBeInTheDocument();
    expect(metric("平均轮廓偏差")).toHaveTextContent("0 mm");
    expect(metric("缺失边缘")).toHaveTextContent("0 像素");
    expect(metric("投影边缘吻合程度")).toHaveTextContent("100%");
    expect(screen.getByText("比较阈值与输入条件").closest("details")).not.toHaveAttribute(
      "open",
    );
  });

  it("keeps null comparison metrics unknown even if a malformed summary says passed", () => {
    render(
      <InspectionReport
        manifest={{
          operation: "compare_views",
          status: "completed",
          verification: { passed: true, minimum_match_fraction: null },
          metrics: {
            precision: null,
            recall: null,
            missing_pixels: null,
            symmetric_mean_distance_mm: null,
          },
        }}
      />,
    );
    expect(screen.getByText("总判定未提供")).toBeInTheDocument();
    expect(metric("投影边缘吻合程度")).toHaveTextContent("未提供");
    expect(metric("平均轮廓偏差")).toHaveTextContent("未提供");
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("检查已通过")).not.toBeInTheDocument();
  });
  it("lists failed assembly placement checks with the worst measured copy", () => {
    const manifest = { ...flange, verification: { ...(flange as any).verification, passed: false, assembly_checks_passed: false,
      assembly_checks: [{ kind: "instance_z", instance: "nut-low", expected: -8, tolerance: 0.05, error: 8, passed: false, actual: { "nut-low-1": 0, "nut-low-2": 0 } }] } };
    render(<InspectionReport manifest={manifest} />);
    expect(screen.getAllByText(/装配位置 · nut-low 底面高度：目标 -8 mm，实测 0 mm/).length).toBeGreaterThan(0);
  });
});
