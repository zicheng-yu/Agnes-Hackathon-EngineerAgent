import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import ModelSettings from "../../src/ModelSettings";
import { api } from "../../src/api";

vi.mock("../../src/api", () => ({ api: vi.fn(), jsonPost: (value: unknown) => ({ method: "POST", body: JSON.stringify(value) }) }));
const mocked = vi.mocked(api);
let settings: Record<string, unknown>;
let models: Record<string, unknown>[];
let posted: Record<string, unknown>[];
let receipt: { endpointKeyCleared?: boolean };
const refresh = vi.fn(), onClose = vi.fn();
beforeEach(() => {
  settings = {}; models = []; posted = []; receipt = {};
  mocked.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === "/api/models?providerId=openrouter") return { models } as never;
    if (url === "/api/settings" && options?.method === "POST") { const body = JSON.parse(String(options.body)); posted.push(body); settings = { ...body, hasKey: !receipt.endpointKeyCleared, usageEnabled: receipt.endpointKeyCleared ? false : body.usageEnabled }; return receipt as never; }
    if (url === "/api/settings") return settings as never;
    throw new Error(`unexpected ${url}`);
  });
});
it("defaults to official Agnes and keeps all four interfaces available", async () => {
  render(<ModelSettings refresh={refresh} onClose={onClose} />);
  const select = await screen.findByRole("combobox", { name: "模型接口" });
  expect(select).toHaveValue("agnes-ai");
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["官方 Agnes（默认）", "OpenAI 兼容接口", "Anthropic 兼容接口", "OpenRouter"]);
  expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue("agnes-3.0-flash");
  expect(screen.getByLabelText("API Key")).toHaveValue("");
});
it("preserves saved provider fields and clears only the unsaved key when switching", async () => {
  settings = { providerId: "openai-compatible", baseUrl: "https://models.example/v1", model: "saved-openai-model", hasKey: true, usageEnabled: true,
    providers: { "agnes-ai": { baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-3.0-flash", hasKey: true, usageEnabled: false }, "anthropic-compatible": { baseUrl: "https://compatible.example", model: "saved-anthropic-model", hasKey: false } } };
  render(<ModelSettings refresh={refresh} onClose={onClose} />); const user = userEvent.setup();
  const select = await screen.findByRole("combobox", { name: "模型接口" });
  expect(select).toHaveValue("openai-compatible");
  await user.type(screen.getByLabelText("API Key"), "unsaved-fixture-key");
  await user.selectOptions(select, "anthropic-compatible");
  expect(screen.getByLabelText("API Key")).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "API 地址" })).toHaveValue("https://compatible.example");
  expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue("saved-anthropic-model");
  expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "填写此接口的 API Key");
  await user.selectOptions(select, "agnes-ai");
  expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "已保存密钥 · 留空保持");
  await user.selectOptions(select, "openai-compatible");
  expect(screen.getByRole("textbox", { name: "API 地址" })).toHaveValue("https://models.example/v1");
  expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue("saved-openai-model");
});
it("submits only the selected provider and omits a blank key to preserve its saved value", async () => {
  settings = { providerId: "openai-compatible", baseUrl: "https://models.example/v1", model: "engineering-model", hasKey: true, usageEnabled: true, providers: { "agnes-ai": { hasKey: true } } };
  render(<ModelSettings refresh={refresh} onClose={onClose} />); const user = userEvent.setup();
  await screen.findByRole("combobox", { name: "模型接口" });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByText(/费用由当前模型服务商结算/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存并使用" }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toEqual({ providerId: "openai-compatible", baseUrl: "https://models.example/v1", model: "engineering-model" });
  expect(posted[0]).not.toHaveProperty("apiKey"); expect(posted[0]).not.toHaveProperty("providers");
  expect(await screen.findByRole("status", { name: '配置保存结果' })).toHaveTextContent("已切换到");
});
it("does not copy an unrecognized connection's credentials and endpoint into Agnes", async () => {
  settings = { providerId: "legacy-provider", baseUrl: "https://legacy.example/v1", model: "legacy-model", hasKey: true, usageEnabled: true,
    providers: { "agnes-ai": { baseUrl: "https://saved-agnes.example/v1", model: "saved-agnes-model", hasKey: false, usageEnabled: false } } };
  render(<ModelSettings refresh={refresh} onClose={onClose} />);
  expect(await screen.findByRole("combobox", { name: "模型接口" })).toHaveValue("agnes-ai");
  expect(screen.getByRole("textbox", { name: "API 地址" })).toHaveValue("https://saved-agnes.example/v1");
  expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue("saved-agnes-model");
  expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "填写此接口的 API Key");
  expect(screen.getByLabelText("API Key")).toHaveValue("");
  expect(posted).toHaveLength(0);
  expect(mocked.mock.calls.every(([url]) => url === "/api/settings")).toBe(true);
  await userEvent.setup().click(screen.getByRole("button", { name: "保存并使用" }));
  expect(await screen.findByRole("status", { name: '配置保存结果' })).toHaveTextContent("已切换到");
  expect(posted[0]).not.toHaveProperty("apiKey");
  expect(posted[0].providerId).toBe("agnes-ai");
});

it("preserves the managed model catalogue and blocks models outside its limits", async () => {
  settings = { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "example/expensive", hasKey: false };
  models = [{ id: "example/expensive", name: "Expensive", selectable: false, disabledReason: "保守预占超过单任务 $0.50" }, { id: "minimax/minimax-m3", name: "MiniMax M3", selectable: true }];
  render(<ModelSettings refresh={refresh} onClose={onClose} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("保守预占超过单任务 $0.50");
  expect(screen.getByRole("combobox", { name: "模型接口" })).toHaveValue("openrouter");
  expect(screen.getByRole("button", { name: "保存并使用" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "API 地址" })).toHaveAttribute("readonly");
  await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "模型接口" }), "agnes-ai");
  expect(screen.queryByText(/保守预占/)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "API 地址" })).not.toHaveAttribute("readonly");
});

it("explains a key cleared after an endpoint change and reloads the disabled connection state", async () => {
  settings = { providerId: "openai-compatible", baseUrl: "https://previous.example/v1", model: "engineering-model", hasKey: true, usageEnabled: true };
  receipt = { endpointKeyCleared: true };
  render(<ModelSettings refresh={refresh} onClose={onClose} />); const user = userEvent.setup();
  const endpoint = await screen.findByRole("textbox", { name: "API 地址" });
  await user.clear(endpoint); await user.type(endpoint, "https://new-service.example/v1");
  await user.click(screen.getByRole("button", { name: "保存并使用" }));
  expect(await screen.findByRole("status", { name: '配置保存结果' })).toHaveTextContent("原密钥已清除，请填写新服务的 API Key");
  expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "填写此接口的 API Key");
  expect(screen.getByLabelText("API Key")).toHaveValue("");
  expect(posted[0]).not.toHaveProperty("apiKey");
});

it("closes from the dialog button and with Escape", async () => {
  render(<ModelSettings refresh={refresh} onClose={onClose} />); const user = userEvent.setup();
  expect(await screen.findByRole("dialog", { name: "模型设置" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "关闭模型设置" }));
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});
