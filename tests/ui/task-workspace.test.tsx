// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TaskWorkspace from "../../src/TaskWorkspace";
import { api } from "../../src/api";
import type { Health } from "../../src/types";
vi.mock("../../src/api", () => ({ api: vi.fn(), jsonPost: (value: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }) }));
vi.mock("../../src/Viewer", () => ({ default: () => <div>模型视图</div> }));
const mockApi = vi.mocked(api);
const health: Health = { cad: true, modelConfigured: true, agh: true, model: "test-model", version: "test" };
const assets = [{ id: "bracket", displayCode: "FG-012", name: "定位支架", category: "支架" }];
const onSettings = vi.fn(), onAsset = vi.fn();
let post: (body: Record<string, unknown>) => Promise<unknown>;
let poll: () => Promise<unknown>;
const demoCases = [
  { id: "catalog-case", mode: "catalog_search", kind: "normal", title: "支架检索", summary: "检索带孔支架", instruction: "查找带孔支架", expect: "返回候选零件" },
  { id: "drawing-case", mode: "reconstruct", kind: "boundary", title: "缺厚度图纸", summary: "厚度为 ?", instruction: "重建附件图纸", expect: "请求补充厚度", document: { url: "/assets/demo-cases/d.pdf", name: "d.pdf", preview: "/assets/demo-cases/d.png", pages: [1] } },
];
const completed = { id: "task-1", status: "completed", events: [], result: { execution: "real-model", answer: "本次结果已检查。" } };
function mount(value: Health | null = health) { return render(<TaskWorkspace health={value} assets={assets} onSelectAsset={onAsset} onOpenSettings={onSettings} />); }
async function searchInput(instruction = "查找定位支架") {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox", { name: "任务类型" }), "catalog_search");
  await user.type(screen.getByRole("textbox", { name: "这次需要完成什么？" }), instruction);
  return user;
}
beforeEach(() => {
  post = async () => completed;
  poll = async () => completed;
  mockApi.mockImplementation(((url: string, options?: RequestInit) => {
    if (url === "/assets/demo-cases/cases.json") return Promise.resolve({ cases: demoCases });
    if (url === "/api/tasks") return post(JSON.parse(String(options?.body)));
    if (url.startsWith("/api/tasks/")) return poll();
    if (url === "/api/documents") return Promise.resolve({ id: "drawing-1", name: "drawing.pdf", mime: "application/pdf", url: "/api/documents/drawing-1/file", pages: [{ page: 1, text: "" }] });
    throw new Error(`Unexpected API: ${url}`);
  }) as typeof api);
});
describe("TaskWorkspace input and execution evidence", () => {
  it("shows each submission as a conversation turn above a fixed composer and clears the draft", async () => {
    post = async () => ({ ...completed, events: [{ type: "tool/result", toolName: "industrial_search_catalog", toolUseId: "actual-1", phase: "result", output: { count: 1 } }], result: { answer: "真实结果保留在对话记录中" } });
    mount();
    const user = await searchInput();
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(await screen.findByText("真实结果保留在对话记录中")).toBeVisible();
    const thread = screen.getByRole("region", { name: "对话记录" });
    expect(thread).toContainElement(screen.getByRole("region", { name: "本次任务记录" }));
    expect(thread).toHaveTextContent("查找定位支架");
    expect(thread).not.toContainElement(screen.getByRole("textbox", { name: "这次需要完成什么？" }));
    expect(screen.getByText("industrial_search_catalog")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "这次需要完成什么？" })).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: "这次需要完成什么？" }), "第二轮检索");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(screen.getAllByRole("region", { name: "本次任务记录" })).toHaveLength(2));
  });
  it("explains each case in full on a task page and shows the compact rail only after a conversation starts", async () => {
    const detailed = [{ ...demoCases[1], purpose: "验证缺尺寸时会询问", checks: ["只调用请求补充资料", "列出缺失的板厚"] }];
    mockApi.mockImplementation(((url: string) => url === "/assets/demo-cases/cases.json" ? Promise.resolve({ cases: detailed }) : Promise.reject(new Error(url))) as typeof api);
    render(<TaskWorkspace fixedMode="reconstruct" health={health} assets={assets} onSelectAsset={onAsset} onOpenSettings={onSettings} />);
    const details = await screen.findByRole("region", { name: "测试案例详解" });
    expect(details).toHaveTextContent("验证缺尺寸时会询问");
    expect(details).toHaveTextContent("列出缺失的板厚");
    expect(details).toHaveTextContent("边界测试");
    expect(screen.queryByRole("region", { name: "测试案例" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "运行案例：缺厚度图纸" })).toHaveLength(1);
  });
  it("keeps a fixed task page on its own task type without a type switch", async () => {
    render(<TaskWorkspace fixedMode="order_review" health={health} assets={assets} onSelectAsset={onAsset} onOpenSettings={onSettings} />);
    expect(screen.getByRole("heading", { name: "订单评审", level: 1 })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "任务类型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "本地规则评审" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "订单评审流程" })).toHaveTextContent("库存与工时");
  });
  it("distinguishes verified artifacts from a blocked AGH turn without displaying execution completed", async () => {
    post = async () => ({ ...completed, result: { engineeringStatus: "verified", runtimeStatus: "blocked", runtimeWarning: { message: "工程产物通过检查，AGH 回合未正常结束。原始记录保留。" }, artifacts: { glb: "/runs/example/model.glb", step: "/runs/example/model.step" } } });
    mount(); const user = await searchInput();
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(await screen.findByRole("heading", { name: "产物已验证 · AGH 收尾异常" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("AGH 回合未正常结束");
    expect(await screen.findByText("模型视图")).toBeVisible();
    expect(screen.queryByText("执行完成")).not.toBeInTheDocument();
  });
  it("starts with an empty prompt and reminds about the missing model when a case is clicked", async () => {
    mount({ ...health, modelConfigured: false });
    expect(screen.getByRole("textbox", { name: "这次需要完成什么？" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "运行案例：缺厚度图纸" }));
    expect(screen.getByRole("alert")).toHaveTextContent("尚未配置模型 API Key");
    await user.click(screen.getByRole("button", { name: /配置模型/ }));
    expect(onSettings).toHaveBeenCalledOnce();
    await searchInput();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    expect(mockApi.mock.calls.filter(([url]) => url === "/api/tasks")).toHaveLength(0);
  });
  it("blocks drawing reconstruction on text-only models while retaining catalog search", async () => {
    mount({ ...health, visionEnabled: false });
    expect(screen.getByText("当前模型未启用图片输入，请选择支持图纸的模型。")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    await searchInput();
    expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled();
  });
  it("shows a paired real tool call and result once, without invented steps", async () => {
    post = async () => ({ ...completed, events: [
      { type: "tool/call", time: "2026-10-09T12:00:00Z", toolUseId: "call-1", toolName: "industrial_catalog_search", phase: "call", input: { query: "定位支架" } },
      { type: "tool/result", time: "2026-10-09T12:00:01Z", toolUseId: "call-1", toolName: "industrial_catalog_search", phase: "result", output: { count: 1, success: true } },
    ], result: { execution: "real-model", answer: "找到定位支架。", catalogResults: assets } });
    mount(); const user = await searchInput();
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await screen.findByText("找到定位支架。");
    expect(screen.getAllByText("industrial_catalog_search")).toHaveLength(1);
    const card = screen.getByText("industrial_catalog_search").closest("details")!;
    await user.click(card.querySelector("summary")!);
    expect(screen.getByText("检索条件")).toBeVisible();
    expect(screen.getByText("执行成功")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /FG-012 定位支架/ }));
    expect(onAsset).toHaveBeenCalledWith(assets[0]);
    expect(screen.queryByText(/思考中|规划完成/)).not.toBeInTheDocument();
  });
  it("retains failed input and reports failure without a fabricated success", async () => {
    post = async () => { throw new Error("AGH 连接失败"); };
    mount(); const user = await searchInput("保留这条检索要求");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AGH 连接失败");
    expect(screen.getByRole("textbox", { name: "这次需要完成什么？" })).toHaveValue("保留这条检索要求");
    expect(screen.getByRole("button", { name: "开始任务" })).toBeEnabled();
    expect(screen.queryByText("执行完成")).not.toBeInTheDocument();
  });
  it("polls real events for a running turn", async () => {
    post = async () => ({ id: "task-poll", status: "running", events: [] });
    poll = async () => ({ ...completed, id: "task-poll", events: [{ type: "error", message: "没有匹配结果" }] });
    mount(); const user = await searchInput("初始检索要求");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await screen.findByText("任务已提交，等待执行事件。");
    await waitFor(() => expect(screen.getByText("没有匹配结果")).toBeVisible());
    expect(mockApi).toHaveBeenCalledWith("/api/tasks/task-poll", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("requires an attachment and valid page selection for reconstruction", async () => {
    const received: Record<string, unknown>[] = [];
    post = async (body) => { received.push(body); return completed; };
    const { container } = mount(); const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "这次需要完成什么？" }), "重建这张图纸");
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    const file = new File(["%PDF-1.4"], "drawing.pdf", { type: "application/pdf" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByText("drawing.pdf");
    fireEvent.change(screen.getByRole("textbox", { name: "图纸页码" }), { target: { value: "1,1" } });
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "图纸页码" }), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ mode: "reconstruct", instruction: "重建这张图纸", documentId: "drawing-1", pages: [1] });
  });
  it("labels browser tools explicitly and blocks preview reconstruction", async () => {
    post = async () => ({ ...completed, result: { execution: "browser-preview", answer: "浏览器内计算结果" } });
    mount({ ...health, preview: true, modelConfigured: false } as Health);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "这次需要完成什么？" }), "请重建" );
    expect(screen.getByRole("button", { name: "开始任务" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "任务类型" }), "catalog_search");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await screen.findByText("浏览器内计算结果");
    expect(screen.getAllByText("浏览器工具 · 未连接 AGH").length).toBeGreaterThan(0);
    expect(screen.queryByText("AGH 事件记录")).not.toBeInTheDocument();
  });
  it("runs a demo case in one click and sends the next message as a linked supplement", async () => {
    const received: Record<string, unknown>[] = [];
    post = async (body) => { received.push(body); return { ...completed, id: `task-${received.length}`, result: { outcome: "needs_input", clarification: { question: "请补充板厚", missing: [{ item: "厚度", evidence: "主视图标注为 ?" }] } } }; };
    const fetched = vi.fn(async () => new Response(new Blob([])));
    vi.stubGlobal("fetch", fetched);
    const demoRequests: unknown[] = [];
    mockApi.mockImplementation(((url: string, options?: RequestInit) => {
      if (url === "/assets/demo-cases/cases.json") return Promise.resolve({ cases: demoCases });
      if (url === "/api/tasks") return post(JSON.parse(String(options?.body)));
      if (url === "/api/demo-documents") { demoRequests.push(JSON.parse(String(options?.body))); return Promise.resolve({ id: "drawing-1", name: "d.pdf", mime: "application/pdf", pages: [{ page: 1, text: "" }] }); }
      throw new Error(`Unexpected API: ${url}`);
    }) as typeof api);
    mount({ ...health, taskRevisions: true }); const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: /填入案例/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "运行案例：缺厚度图纸" }));
    await waitFor(() => expect(received).toHaveLength(1));
    // The drawing is attached on the server; the page never downloads and re-uploads the PDF.
    expect(demoRequests).toEqual([{ caseId: "drawing-case" }]);
    expect(fetched).not.toHaveBeenCalled();
    expect(received[0]).toEqual({ mode: "reconstruct", instruction: "重建附件图纸", documentId: "drawing-1", pages: [1] });
    expect(await screen.findByRole("heading", { name: "等待补充资料" })).toBeVisible();
    expect(screen.getByText("主视图标注为 ?")).toBeVisible();
    expect(screen.getByText(/发送的内容将作为补充资料/)).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "这次需要完成什么？" }), "板厚 12 mm");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    await waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toEqual({ mode: "reconstruct", instruction: "重建附件图纸\n\n补充资料：\n板厚 12 mm", parentTaskId: "task-1", documentId: "drawing-1", pages: [1] });
    vi.unstubAllGlobals();
  });
  it("renders Markdown answers as tables and offers the per-task AGH record export", async () => {
    post = async () => ({ ...completed, id: "task-md", result: { traceUrl: "/api/tasks/task-md/trace", answer: "## 检查结果\n\n| 检查 | 实测 |\n|---|---|\n| 孔数 | **4** |\n\n- 已生成 `model.step`" } });
    mount(); const user = await searchInput();
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(await screen.findByRole("table")).toHaveTextContent("孔数");
    expect(screen.getByRole("heading", { name: "检查结果" })).toBeVisible();
    expect(screen.getByText("model.step").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: /导出本次记录/ })).toHaveAttribute("href", "/api/history/task-md/export");
    expect(screen.getByRole("link", { name: /AGH 原生轨迹/ })).toHaveAttribute("href", "/api/tasks/task-md/trace");
  });
});

