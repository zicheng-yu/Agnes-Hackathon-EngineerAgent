import { render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import UsagePanel, { TaskUsage } from "../../src/UsagePanel";
import { api } from "../../src/api";

vi.mock("../../src/api", () => ({ api: vi.fn() }));

describe("usage reporting", () => {
  it("labels external-provider tokens without presenting missing USD as free or pending reconciliation", () => {
    render(<TaskUsage usage={{ billingMode: "external", status: "unavailable", costUsd: null, promptTokens: 900, completionTokens: 100, requestCount: 2 }} />);
    expect(screen.getByText("服务商计费")).toBeVisible();
    expect(screen.getByText("服务商未提供")).toBeVisible();
    expect(screen.getByText("900")).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("待对账")).not.toBeInTheDocument();
    expect(screen.queryByText("预占额度")).not.toBeInTheDocument();
  });
  it("keeps unknown charges pending instead of presenting them as zero", () => {
    render(<TaskUsage usage={{ status: "unknown", costUsd: 0, heldUsd: 0.5, requestCount: 1 }} />);
    const fee = screen.getByText("已确认费用").parentElement!;
    expect(within(fee).getByText("待对账")).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText("$0.50")).toBeVisible();
    expect(screen.queryByText("已结算")).not.toBeInTheDocument();
  });

  it("shows settled costs with cache and reasoning as subsets of input and output", () => {
    render(<TaskUsage usage={{ status: "settled", costUsd: 0.0124, promptTokens: 1200, cachedTokens: 900, completionTokens: 400, reasoningTokens: 300, requestCount: 2 }} />);
    expect(screen.getByText("已结算")).toBeVisible();
    expect(screen.getByText("$0.0124")).toBeVisible();
    expect(screen.getByText("1,200")).toBeVisible();
    expect(screen.getByText("400")).toBeVisible();
    expect(screen.getByText("其中缓存读取 900")).toBeVisible();
    expect(screen.getByText("其中推理 300")).toBeVisible();
    expect(screen.queryByText("2,100")).not.toBeInTheDocument();
    expect(screen.queryByText("700")).not.toBeInTheDocument();
  });

  it("shows offline execution clearly and hides itself when usage is unavailable locally", async () => {
    vi.mocked(api).mockResolvedValueOnce({ currency: "USD", budgetUsd: 10, usedUsd: 0.12, heldUsd: 0.5, remainingUsd: 9.38, taskLimitUsd: 0.5, model: "MiniMax M3", modelId: "minimax/minimax-m3", runnerOnline: false, requests: 3, uncertain: 1 });
    const view = render(<UsagePanel />);
    expect(await screen.findByText("执行器离线")).toBeVisible();
    expect(screen.getByText("执行器暂时离线，当前无法启动新任务。")).toBeVisible();
    expect(screen.getByText("1 次调用待对账，待结算金额仍计入预占。")).toBeVisible();
    expect(screen.getByText("$9.38")).toBeVisible();
    view.unmount();
    vi.mocked(api).mockRejectedValueOnce(new Error("请求失败 (404)"));
    render(<UsagePanel />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: "试用额度" })).not.toBeInTheDocument();
  });
});
