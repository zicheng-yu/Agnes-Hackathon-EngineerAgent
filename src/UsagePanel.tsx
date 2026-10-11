import { useEffect, useState } from "react";
import { api } from "./api";
import "./usage-panel.css";

export type UsageSummary = {
  currency: "USD";
  budgetUsd: number | null;
  usedUsd: number | null;
  heldUsd: number | null;
  remainingUsd: number | null;
  taskLimitUsd: number | null;
  model: string;
  modelId: string;
  runnerOnline: boolean;
  requests: number;
  uncertain: number | boolean;
};

export type TaskUsageData = {
  tokenScope?: "agh_main_turn";
  billingMode?: "external" | "managed";
  costUsd?: number | null;
  heldUsd?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  requestCount?: number | null;
  status: "settled" | "pending" | "unknown" | "unavailable";
  model?: string;
};

const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const money = (value: unknown) => !amount(value) ? "待对账" : value > 0 && value < 0.0001 ? "< $0.0001" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const count = (value: unknown) => amount(value) ? value.toLocaleString("zh-CN") : "未返回";

export default function UsagePanel() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await api<UsageSummary>("/api/usage", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (next?.currency !== "USD") throw new Error("Usage is unavailable");
        setUsage(next);
        setStale(false);
      } catch {
        if (controller.signal.aborted) return;
        // Local installations without this endpoint keep the workspace uncluttered.
        setStale(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 10_000);
      }
    }
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, []);

  if (!usage) return null;
  const model = usage.model || usage.modelId || "模型待确认";
  const online = usage.runnerOnline === true && !stale;
  const uncertain = usage.uncertain === true || (amount(usage.uncertain) && usage.uncertain > 0);

  return <section className="usage-panel" aria-label="试用额度">
    <div className="usage-panel__heading">
      <h2>试用额度 <span>USD</span></h2>
      <span className={`usage-panel__connection ${online ? "is-online" : "is-offline"}`} role="status"><i aria-hidden="true" />{stale ? "连接状态待确认" : online ? "执行器在线" : "执行器离线"}</span>
    </div>
    <dl className="usage-panel__metrics">
      <div><dt>总预算</dt><dd>{money(usage.budgetUsd)}</dd></div>
      <div><dt>累计实际费用</dt><dd>{money(usage.usedUsd)}</dd></div>
      <div><dt>预占 / 待结算</dt><dd>{money(usage.heldUsd)}</dd></div>
      <div className="usage-panel__remaining"><dt>可用额度</dt><dd>{money(usage.remainingUsd)}</dd></div>
    </dl>
    <div className="usage-panel__details">
      <span>本轮模型：<strong>{model}</strong></span>
      <span>单任务上限 <strong>{money(usage.taskLimitUsd)}</strong></span>
      <span>累计调用 <strong>{count(usage.requests)} 次</strong></span>
    </div>
    {uncertain ? <p className="usage-panel__note">{typeof usage.uncertain === "number" ? `${count(usage.uncertain)} 次调用待对账` : "有模型调用待对账"}，待结算金额仍计入预占。</p> : null}
    {stale ? <p className="usage-panel__notice">用量暂未更新，以上为最近一次记录。</p> : !online ? <p className="usage-panel__notice">执行器暂时离线，当前无法启动新任务。</p> : null}
  </section>;
}

export function TaskUsage({ usage }: { usage: TaskUsageData | null | undefined }) {
  if (!usage) return null;
  const external = usage.billingMode === "external";
  const settled = usage.status === "settled" && amount(usage.costUsd);
  const costKnown = usage.status !== "unknown" && amount(usage.costUsd) && (settled || usage.costUsd > 0);
  const note = external
    ? "费用由当前模型服务商结算。此处统计任务主回合的 Token，可能不含标题生成等后台请求；完整用量和实际费用以服务商账单为准。"
    : !settled ? "费用尚未结算完成，预占额度会在对账后更新。" : undefined;
  // One compact line per turn: the model name is already shown in the turn header.
  return <section className="task-usage" aria-label="本次用量" title={note}>
    <span className={`task-usage__badge ${external ? "" : settled ? "is-settled" : "is-pending"}`}>{external ? "服务商计费" : settled ? "已结算" : "待对账"}</span>
    <dl className="task-usage__totals">
      <div><dt>{external || settled ? "本次费用" : "已确认费用"}</dt><dd>{external ? amount(usage.costUsd) ? money(usage.costUsd) : "服务商未提供" : costKnown ? money(usage.costUsd) : "待对账"}</dd></div>
      {!external && !settled && <div><dt>预占额度</dt><dd>{money(usage.heldUsd)}</dd></div>}
      <div><dt>模型调用</dt><dd>{count(usage.requestCount)} 次</dd></div>
      <div><dt>输入 token</dt><dd>{count(usage.promptTokens)}</dd><small>其中缓存读取 {count(usage.cachedTokens)}</small></div>
      <div><dt>输出 token</dt><dd>{count(usage.completionTokens)}</dd><small>其中推理 {count(usage.reasoningTokens)}</small></div>
    </dl>
  </section>;
}
