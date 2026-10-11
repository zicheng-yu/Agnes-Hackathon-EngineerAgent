// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProductionEvidence from "../../src/ProductionEvidence";

const complete = () => ({
  availableStock: 12, allocatedStock: 12, toProduce: 18,
  setupHours: 1.4, unitHours: 0.26, totalHours: 6.08,
  canEstimate: true, canCommit: false, commitment: "synthetic_scenario_only",
  capacityWindow: { start: "2026-10-10", end: "2026-10-20" },
  inventoryEvidence: [{ lotId: "internal-lot", onHand: 18, reserved: 6, allocated: 12, qualityStatus: "qualified", material: "45钢", revision: "B", sourceType: "synthetic_demo" }],
  route: [{ operation: "车削与钻孔", machineId: "internal-machine", machineName: "车削中心", setupHours: 1.4, unitHours: 0.26, requiredHours: 6.08, availableHoursBeforeThisLine: 20, sourceType: "synthetic_demo" }],
  evidence: [{ type: "part_master", id: "private-master", internalCode: "FH-101", material: "45钢", revision: "B", specification: "FH-101-B", sourceType: "synthetic_demo" },
    { type: "formula", expression: "totalHours = setupHours + unitHours * toProduce" },
    { type: "assumptions", text: "工时为演示假设，尚未核对真实设备安排。", sourceType: "synthetic_demo" }],
});

function metric(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  return term.parentElement!.querySelector("dd")!;
}

describe("human-readable production evidence", () => {
  it("renders actual inventory, route, formula and ledger facts without raw JSON or internal identifiers", () => {
    const { container } = render(<ProductionEvidence production={complete()} />);
    expect(screen.getByText("合成演示数据")).toBeVisible();
    expect(metric("台账库存")).toHaveTextContent("18 件");
    expect(metric("已预留")).toHaveTextContent("6 件");
    expect(metric("本行分配")).toHaveTextContent("12 件");
    expect(metric("待生产")).toHaveTextContent("18 件");
    expect(metric("估算总工时")).toHaveTextContent("6.08 小时");
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("cell", { name: "车削中心" })).toBeVisible();
    expect(screen.getByText("1.4 + 0.26 × 18 = 6.08 小时")).toBeVisible();
    expect(screen.getByText("18 − 6 − 0 = 12 件")).toBeVisible();
    expect(screen.getByText("零件规格记录")).toBeVisible();
    expect(container.querySelector("pre")).toBeNull();
    for (const hidden of ["totalHours", "sourceType", "internal-lot", "internal-machine", "FH-101", "private-master"]) expect(container.textContent).not.toContain(hidden);
  });

  it("keeps incomplete estimates and unknown fields explicit, including an entirely unknown value", () => {
    const partial: any = complete();
    partial.availableStock = null;
    partial.totalHours = null;
    partial.canEstimate = false;
    partial.blockedReason = "材料要求尚未提供。";
    partial.inventoryEvidence[0].reserved = null;
    partial.route[0].unitHours = undefined;
    partial.route[0].requiredHours = null;
    partial.route[0].machineName = undefined;
    const { rerender } = render(<ProductionEvidence production={partial} />);
    expect(screen.getByText("估算依据待补齐")).toBeVisible();
    expect(metric("已预留")).toHaveTextContent("待补齐");
    expect(metric("本行可用")).toHaveTextContent("待补齐");
    expect(metric("已提供的工时小计")).toHaveTextContent("待补齐");
    expect(screen.getByRole("cell", { name: "设备待确认" })).toBeVisible();
    expect(screen.getByText(/工时不完整，不能据此确认整条路线总工时/)).toBeVisible();
    rerender(<ProductionEvidence production={null} />);
    expect(screen.getByText("数据来源待确认")).toBeVisible();
    expect(screen.getByText(/尚无生产依据/)).toBeVisible();
    expect(screen.queryByText("0 件")).not.toBeInTheDocument();
    expect(screen.queryByText("0 小时")).not.toBeInTheDocument();
  });

  it("distinguishes a recorded zero from missing information and explains stock-only fulfilment", () => {
    const zero = complete();
    zero.toProduce = 0;
    zero.setupHours = 0;
    zero.totalHours = 0;
    zero.route[0].requiredHours = 0;
    render(<ProductionEvidence production={zero} />);
    expect(metric("待生产")).toHaveTextContent("0 件");
    expect(metric("估算总工时")).toHaveTextContent("0 小时");
    expect(screen.getByText(/本行没有待产量.*本次不应计入准备或加工工时/)).toBeVisible();
    expect(screen.getByText("0 + 0.26 × 0 = 0 小时")).toBeVisible();
  });

  it("surfaces insufficient capacity and inconsistent totals without calling the evidence safe or complete", () => {
    const conflicting = complete();
    conflicting.route[0].availableHoursBeforeThisLine = -2;
    conflicting.totalHours = 4;
    render(<ProductionEvidence production={conflicting} />);
    const checks = screen.getByRole("region", { name: "需要确认的事项" });
    expect(within(checks).getByText(/需要 6.08 小时，窗口内剩余 -2 小时/)).toBeVisible();
    expect(within(checks).getByText(/汇总工时.*不一致/)).toBeVisible();
    expect(screen.getByText(/所提供的汇总为 4 小时/)).toBeVisible();
    expect(screen.getByText("估算依据待补齐")).toBeVisible();
    expect(screen.queryByText("产能充足")).not.toBeInTheDocument();
  });
});
