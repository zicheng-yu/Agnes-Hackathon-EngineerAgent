import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";
import { ArrowUpRight, Box, Check, ChevronDown, ChevronRight, Cpu, CircleAlert, CirclePause, Download, FileText, FlaskConical, LoaderCircle, Paperclip, Play, Search, Send, Settings2, Terminal, Wrench, X } from "lucide-react";
import { api, jsonPost } from "./api";
import { readWorkspace, saveWorkspace } from './workspace-state';
import { drawingInputError, drawingPageCount } from './drawing-input';
import type { Asset, DocumentRecord, Health } from "./types";
import Viewer from "./ModelViewer";
import { InspectionReport } from "./InspectionReport";
import ProductionEvidence from "./ProductionEvidence";
import "./task-workspace.css";
import ModelSetupNotice, { needsModelSetup } from './ModelSetupNotice';
import UsagePanel, {TaskUsage, type TaskUsageData} from "./UsagePanel";

type Data = Record<string, unknown>;
type Mode = "reconstruct" | "order_review" | "catalog_search";
type TaskEvent = { time?: string; type?: string; message?: string; toolUseId?: string; toolName?: string; name?: string; phase?: string; input?: unknown; output?: unknown };
export type WorkspaceTask = { parentTaskId?: string; revision?: number; cancelRequested?: boolean; usage?: TaskUsageData; id: string; status: string; title?: string; mode?: string; instruction?: string; createdAt?: string; events?: TaskEvent[]; result?: Data; error?: string };
type DemoCase = { id: string; mode: Mode; kind: "normal" | "boundary" | "failure"; title: string; summary: string; instruction: string; expect: string; document?: { url: string; name: string; preview?: string; pages?: number[] } };
type Snapshot = { instruction: string; mode: Mode; documentId?: string; documentName?: string; pages: number[] };
type ToolCall = { id: string; name: string; time?: string; input?: unknown; output?: unknown; message?: string; phase: "running" | "completed" | "failed" };
const record = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): Data[] => Array.isArray(value) ? value.filter((item): item is Data => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const numeric = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const safeUrl = (value: unknown): string | undefined => typeof value === "string" && (/^\/(?!\/)/.test(value) || /^https?:\/\//.test(value)) ? value : undefined;
const pending = (task: WorkspaceTask | null) => Boolean(task && ["running", "pending", "queued", "preparing"].includes(task.status));
const modes: { id: Mode; label: string; detail: string; icon: typeof Box }[] = [
  { id: "reconstruct", label: "图纸重建", detail: "上传图纸，重建并检查模型", icon: Box },
  { id: "order_review", label: "订单评审", detail: "匹配采购零件与生产条件", icon: FileText },
  { id: "catalog_search", label: "零件检索", detail: "按用途、结构与规格找零件", icon: Search },
];
const statusNames: Record<string, string> = { running: "正在执行", pending: "等待执行", queued: "排队等待", preparing: "准备中", completed: "执行完成", failed: "执行未完成", cancelled: "已停止", canceled: "已停止", interrupted: '执行已中断 · 请核对记录' };
const kindNames: Record<DemoCase["kind"], string> = { normal: "正常", boundary: "边界", failure: "异常" };
const toolNames: Record<string, string> = { industrial_request_clarification: "请求补充资料", browser_order_review: "评审采购与生产条件", browser_catalog_search: "检索工程资产", industrial_read_input: "读取输入资料", industrial_get_document: "读取图纸页面", industrial_geometry: "执行几何工具", industrial_catalog_search: "检索企业零件库", industrial_order_review: "评审采购与生产条件", industrial_search_catalog: "检索企业零件库", industrial_review_order: "评审采购与生产条件" };
const fieldNames: Record<string, string> = { operation: "操作", documentId: "文档", query: "检索条件", text: "采购文本", instruction: "任务要求", path: "输入文件", name: "名称", id: "标识", units: "单位", status: "状态", message: "说明", error: "错误", success: "执行成功", runId: "运行编号", count: "数量", total: "总数", resultCount: "匹配数量", availableStock: "可用库存", toProduce: "待产数量", totalHours: "估算工时", model: "模型", category: "分类", material: "材料", format: "格式", limit: "最多返回", pages: "页码", features: "建模特征", checks: "检查项", items: "采购行", assets: "零件", candidates: "候选零件", results: "结果", parts: "零件定义", instances: "装配实例", warnings: "提醒", errors: "错误项", verification: "验证", measurements: "测量", passed: "检查通过", valid: "几何有效", solids: "实体数量", input: "输入", output: "输出", execution: "执行方式" };
const operationNames: Record<string, string> = { build: "生成模型", patch: "局部修复", validate: "检查几何", project: "生成投影视图", compare_views: "对照图纸与投影", assembly: "构建装配" };

function displayValue(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return (key === "operation" ? operationNames[value] || value : value).slice(0, 700);
  if (Array.isArray(value)) return value.every((item) => ["string", "number"].includes(typeof item)) ? value.slice(0, 8).join("、") : `${value.length} 项`;
  const data = record(value);
  return text(data.message) || text(data.name) || text(data.error) || (typeof data.passed === "boolean" ? (data.passed ? "检查通过" : "检查未通过") : "已返回结构化数据");
}
function ReadableDetails({ value }: { value: unknown }) {
  let parsed = value;
  const envelope = record(parsed);
  if (envelope.structuredContent) parsed = envelope.structuredContent;
  else if (envelope.content && Array.isArray(envelope.content)) {
    const message = list(envelope.content).filter((item) => item.type === "text").map((item) => text(item.text)).join("\n");
    if (message) parsed = message;
  }
  if (typeof parsed === "string" && /^[\[{]/.test(parsed.trim())) { try { parsed = JSON.parse(parsed); } catch { /* Preserve non-JSON tool text. */ } }
  const data = record(parsed);
  const entries = Object.entries(data).filter(([key]) => !/key|token|secret|authorization|base64|image_data/i.test(key)).slice(0, 8);
  if (!entries.length) return <p className="task-tool-text">{displayValue(parsed)}</p>;
  return <dl className="task-tool-values">{entries.map(([key, value]) => <div key={key}><dt>{fieldNames[key] || key}</dt><dd>{displayValue(value, key)}</dd></div>)}</dl>;
}
function eventIsTool(event: TaskEvent) { return Boolean(event.toolName || event.toolUseId || /tool[/:._-](call|result|start|end|error)/.test(event.type || "")); }
function toolCalls(events: TaskEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [index, event] of events.entries()) {
    if (!eventIsTool(event)) continue;
    const id = event.toolUseId || `event-${index}`;
    let call = calls.find((item) => item.id === id);
    if (!call) { call = { id, name: event.toolName || event.name || "工具调用", time: event.time, phase: "running" }; calls.push(call); }
    if (event.toolName) call.name = event.toolName;
    if (event.input !== undefined) call.input = event.input;
    if (event.output !== undefined) call.output = event.output;
    if (event.message) call.message = event.message;
    const phase = `${event.type || ""} ${event.phase || ""}`;
    if (/error|fail/.test(phase) || record(event.output).success === false || record(event.output).isError === true) call.phase = "failed";
    else if (event.output !== undefined || /result|complete|success|\bend\b|\bdone\b/.test(phase)) call.phase = "completed";
  }
  return calls;
}
function eventTime(value?: string) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : ""; }
function ToolTimeline({ events, running, preview }: { events: TaskEvent[]; running: boolean; preview: boolean }) {
  const calls = toolCalls(events);
  // Routine lifecycle events are noise once a run ends: keep warnings and errors, plus the live step while running.
  const lifecycle = events.filter((event) => !eventIsTool(event) && event.type !== "assistant" && event.message);
  const notices = [...lifecycle.filter((event) => event.type === "warning" || event.type === "error"), ...(running && lifecycle.length && !["warning", "error"].includes(lifecycle.at(-1)!.type || "") ? [lifecycle.at(-1)!] : [])].slice(-5);
  return <section className="task-execution" aria-label="工具执行过程"><div className="task-section-heading"><h3><Terminal size={18} />工具执行</h3><span>{preview ? "浏览器工具 · 未连接 AGH" : "AGH 事件记录"}</span></div>
    {!events.length ? <p className="task-empty-log">{running ? "任务已提交，等待执行事件。" : "本次未返回工具执行事件。"}</p> : null}
    <div className="task-tool-list">{calls.map((call) => <details className={`task-tool-card task-tool-card--${call.phase}`} key={call.id} open={call.phase === "failed"}>
      <summary>{call.phase === "running" ? (running ? <LoaderCircle size={18} className="spin" /> : <CircleAlert size={18} />) : call.phase === "failed" ? <CircleAlert size={18} /> : <Check size={18} />}<span><strong>{toolNames[call.name] || call.name}</strong><small>{call.name}</small></span><time>{eventTime(call.time)}</time><em>{call.phase === "running" ? running ? "调用中" : "未收到结果" : call.phase === "failed" ? "失败" : "已返回"}</em><ChevronRight className="task-detail-chevron" size={16} /></summary>
      <div className="task-tool-body">{call.message && <p>{call.message}</p>}{call.input !== undefined && <div><h4>输入</h4><ReadableDetails value={call.input} /></div>}{call.output !== undefined && <div><h4>工具返回</h4><ReadableDetails value={call.output} /></div>}</div>
    </details>)}</div>
    {notices.length ? <ol className="task-event-notices">{notices.map((event, index) => <li key={`${event.time}-${index}`}><time>{eventTime(event.time)}</time><span>{event.message}</span></li>)}</ol> : null}
  </section>;
}
function GeometryResult({ result }: { result: Data }) {
  const artifacts = record(result.artifacts);
  const [manifest, setManifest] = useState<unknown>(result.manifest);
  const [error, setError] = useState("");
  const manifestUrl = safeUrl(artifacts.manifest);
  useEffect(() => {
    setManifest(result.manifest); setError("");
    if (result.manifest || !manifestUrl) return;
    const controller = new AbortController();
    api<unknown>(manifestUrl, { signal: controller.signal }).then(setManifest).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [manifestUrl, result.manifest]);
  const modelUrl = safeUrl(artifacts.glb);
  return <>{modelUrl ? <div className="task-result-viewer"><Viewer url={modelUrl} name="本次任务生成的模型" manifestUrl={manifestUrl} fallbackImageUrl={safeUrl(artifacts.front)} downloadUrl={safeUrl(artifacts.step) || modelUrl} /></div> : null}
    {manifest ? <InspectionReport manifest={manifest} compact /> : null}
    {error ? <p className="task-notice">检查报告暂未载入：{error}</p> : null}
    {safeUrl(artifacts.step) ? <a className="secondary-button" href={safeUrl(artifacts.step)} download>下载 STEP <ArrowUpRight size={16} /></a> : null}</>;
}
function OrderResult({ value, assets, onSelectAsset }: { value: unknown; assets: Asset[]; onSelectAsset: (asset: Asset) => void }) {
  const review = record(value), items = list(review.items);
  const [selected, setSelected] = useState(0);
  const item = items[selected] || items[0];
  const production = record(item?.production);
  const asset = assets.find((asset) => asset.id === item?.matchedAssetId);
  const estimated = items.filter((row) => numeric(record(row.production).totalHours) !== undefined);
  const hours = estimated.reduce((sum, row) => sum + (numeric(record(row.production).totalHours) || 0), 0);
  const complete = items.length > 0 && !list(review.unparsedLines).length && estimated.length === items.length && record(review.summary).completeEstimate !== false;
  const labels: Record<string, string> = { ready: "条件满足", needs_review: "需确认", blocked: "条件冲突", unmatched: "未匹配" };
  return <section className="task-order-result" aria-label="采购评审结果"><div className="task-order-summary"><div><span>采购行</span><strong>{items.length}</strong></div><div><span>需确认 / 冲突</span><strong>{items.filter((row) => row.status !== "ready").length + list(review.unparsedLines).length}</strong></div><div><span>{complete ? "估算工时" : "已知工时小计"}</span><strong>{estimated.length ? `${hours.toFixed(2)} h` : "待补齐"}</strong><small>已识别行覆盖 {estimated.length}/{items.length}</small></div></div>
    <p className="task-result-note">生产建议基于合成演示台账，查看逐行依据后再确认。</p>
    {list(review.unparsedLines).length ? <div className="task-stale" role="alert"><strong>订单尚未完整识别：已识别 {items.length} 行，另有 {list(review.unparsedLines).length} 行待核对。</strong><p>请将以下采购内容补成带字段标签的明细，或确认其为说明后从输入中移除，再重新评审。当前工时只覆盖已识别部分。</p><ul>{list(review.unparsedLines).map((line, index) => <li key={index}>第 {numeric(line.lineNumber) ?? '未知'} 行：{text(line.sourceText)}</li>)}</ul></div> : null}
    {list(review.warnings).filter(warning => warning.code !== 'unparsed_lines').map((warning, index) => <p className="task-notice" role="alert" key={index}>{text(warning.message)}</p>)}
    <div className="task-table-wrap"><table><thead><tr><th>零件</th><th>采购数量</th><th>待产</th><th>评审状态</th></tr></thead><tbody>{items.map((row, index) => <tr key={text(row.lineId) || index} className={index === selected ? "is-selected" : ""}><td><button type="button" aria-pressed={index === selected} onClick={() => setSelected(index)}>{text(row.name) || `采购行 ${index + 1}`}</button></td><td>{numeric(row.quantity) ?? "未提供"}</td><td>{numeric(record(row.production).toProduce) ?? "待确认"}</td><td>{labels[text(row.status)] || "待确认"}</td></tr>)}</tbody></table></div>
    {item ? <div className="task-order-detail"><h3>{text(item.name) || "采购行详情"}</h3>{text(item.sourceText) ? <blockquote>{text(item.sourceText)}</blockquote> : null}{Array.isArray(item.issues) ? item.issues.map((issue, index) => <p className="task-notice" key={index}>{typeof issue === "string" ? issue : text(record(issue).message)}</p>) : null}{asset ? <button className="secondary-button" type="button" onClick={() => onSelectAsset(asset)}>查看匹配零件 <ArrowUpRight size={16} /></button> : null}<details><summary>库存、工序与计算依据</summary><ProductionEvidence production={production} /></details></div> : <p className="task-notice">本次未识别出采购行，请检查输入信息。</p>}
  </section>;
}
function CatalogResult({ value, assets, onSelectAsset }: { value: unknown; assets: Asset[]; onSelectAsset: (asset: Asset) => void }) {
  const wrapper = record(value);
  const candidates = Array.isArray(value) ? list(value) : list(wrapper.assets || wrapper.items || wrapper.results || wrapper.candidates);
  return <section className="task-catalog-result" aria-label="零件检索结果"><h3>匹配到 {candidates.length} 项</h3><div>{candidates.map((candidate, index) => {
    const data = Object.keys(record(candidate.asset)).length ? record(candidate.asset) : candidate;
    const asset = assets.find((asset) => asset.id === data.id || asset.id === data.assetId);
    return <button type="button" className="task-asset-result" aria-label={`查看 ${asset?.displayCode || text(data.displayCode)} ${asset?.name || text(data.name) || "零件"}`} key={text(data.id) || index} disabled={!asset} onClick={() => { if (asset) onSelectAsset(asset); }}><Box size={24} /><span><small>{asset?.displayCode || text(data.displayCode) || text(data.category)}</small><strong>{asset?.name || text(data.name) || "零件信息待补齐"}</strong><p>{text(data.useCase) || text(data.summary) || (Array.isArray(candidate.reasons) ? candidate.reasons.join("；") : "")}</p></span><ArrowUpRight size={18} /></button>;
  })}</div>{!candidates.length ? <p className="task-notice">没有匹配零件，可补充名称、用途或材料后再次检索。</p> : null}</section>;
}


function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={index}>{part.slice(1, -1)}</code> : part);
}
/** Small Markdown subset for model answers; builds React elements only (no HTML injection). */
export function Markdown({ text: source }: { text: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n"), blocks: ReactElement[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++]);
      i++; blocks.push(<pre key={blocks.length}>{body.join("\n")}</pre>); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().slice(1, -1).split("|").map((cell) => cell.trim()); if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells); i++; }
      const [head, ...body] = rows;
      blocks.push(<div className="task-table-wrap" key={blocks.length}><table><thead><tr>{head.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{body.map((row, r) => <tr key={r}>{row.map((cell, index) => <td key={index}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { blocks.push(<h4 key={blocks.length} className={`md-h${heading[1].length}`}>{inline(heading[2])}</h4>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const children = items.map((item, index) => <li key={index}>{inline(item)}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{children}</ol> : <ul key={blocks.length}>{children}</ul>); continue;
    }
    if (!line.trim() || /^-{3,}$/.test(line.trim())) { i++; continue; }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*\||#{1,4}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={blocks.length}>{inline(paragraph.join("\n"))}</p>);
  }
  return <>{blocks}</>;
}
function Clarification({ value }: { value: unknown }) {
  const data = record(value), missing = list(data.missing);
  return <section className="task-clarification" aria-label="需要补充的资料"><h3><CirclePause size={18} />需要补充资料后才能继续</h3>{text(data.question) ? <p>{text(data.question)}</p> : null}
    <ul>{missing.map((item, index) => <li key={index}><strong>{text(item.item)}</strong>{text(item.evidence) ? <span>{text(item.evidence)}</span> : null}</li>)}</ul>
    <p className="task-result-note">AGH 已暂停任务，未使用猜测值生成几何。补充资料后可重新提交。</p></section>;
}
export function taskLabelFor(task: WorkspaceTask) {
  const result = task.result;
  if (result?.outcome === "needs_input") return "等待补充资料";
  if (task.status === "completed" && result?.engineeringStatus === "verified" && result?.runtimeStatus === "blocked" && Boolean(text(record(result?.runtimeWarning).message) || text(result?.runtimeWarning))) return "产物已验证 · AGH 收尾异常";
  return statusNames[task.status] || task.status;
}
export function TaskRecordView({ task, assets, onSelectAsset, preview = false }: { task: WorkspaceTask; assets: Asset[]; onSelectAsset: (asset: Asset) => void; preview?: boolean }) {
  const result = task.result;
  const runtimeWarning = text(record(result?.runtimeWarning).message) || text(result?.runtimeWarning);
  const answer = text(result?.answer);
  const executionPreview = result?.execution === "browser-preview" || preview;
  return <>
    <ToolTimeline events={task.events || []} running={pending(task)} preview={executionPreview} />
    {task.error ? <div className="task-error" role="alert"><CircleAlert size={20} /><p>{task.error}。可修改输入后重新提交。</p></div> : null}
    {runtimeWarning ? <div className="task-notice" role="alert"><p>{runtimeWarning}</p></div> : null}
    {result ? <div className="task-delivery"><div className="task-section-heading"><h3><Wrench size={18} />任务结果</h3>{safeUrl(result.traceUrl) ? <span className="task-record-links">{result.traceUrl === `/api/tasks/${task.id}/trace` ? <a href={`/api/history/${encodeURIComponent(task.id)}/export`} download>导出本次记录（ZIP）<Download size={15} /></a> : null}<a href={safeUrl(result.traceUrl)} download>AGH 原生轨迹 <ArrowUpRight size={15} /></a></span> : null}</div>
      {result.clarification ? <Clarification value={result.clarification} /> : null}
      {answer ? <div className="task-answer"><Markdown text={answer} /></div> : null}
      {result.orderReview ? <OrderResult value={result.orderReview} assets={assets} onSelectAsset={onSelectAsset} /> : null}
      {result.catalogResults ? <CatalogResult value={result.catalogResults} assets={assets} onSelectAsset={onSelectAsset} /> : null}
      {result.artifacts || result.manifest ? <GeometryResult result={result} /> : null}
      {!answer && !result.clarification && !result.orderReview && !result.catalogResults && !result.artifacts && !result.manifest ? <p className="task-notice">本次没有返回可展示的工程产物，请查看执行记录。</p> : null}
    </div> : null}
    {task.usage ? <TaskUsage usage={task.usage} /> : null}
  </>;
}
type Turn = { task: WorkspaceTask; snapshot: Snapshot };
type ModeGuide = { title: string; tagline: string; summary: string; inputs: string[]; tools: string[]; outputs: string[]; placeholder: string };
const MAX_TURNS = 20;
export const modeGuides: Record<Mode, ModeGuide> = {
  reconstruct: {
    title: "图纸重建",
    tagline: "上传零件图或装配图，生成可编辑 CAD 模型、装配爆炸视图和逐项实测检查报告。",
    summary: "上传机械零件图或装配图，AGH 组织视觉模型逐项读取视图、尺寸与明细表，并为每个关键尺寸记录来源；随后调用工业几何工具构建参数化特征，对实体逐项实测并回投影成三视图。装配图会继续求解各零件位置、规划拆卸顺序并逐步检查爆炸路径。缺失或矛盾的尺寸会暂停并请求补充，不使用猜测值建模。",
    inputs: ["PDF / PNG / JPG 图纸，每次最多 4 页", "可附加要求：需重点核对的尺寸、公差或装配关系"],
    tools: ["读取图纸与文字层", "industrial_geometry：build / validate / project / assembly", "请求补充资料（缺尺寸时）"],
    outputs: ["可编辑 STEP 与可旋转 GLB 模型", "装配体的爆炸视图、BOM 与路径检查", "逐项实测检查表与三视图投影"],
    placeholder: "例如：根据附件装配图重建全部零件并生成可拆解的装配模型，核对孔径、分度圆和叠层厚度；缺失的尺寸先向我确认。",
  },
  order_review: {
    title: "订单评审",
    tagline: "粘贴合同或采购明细，逐行匹配零件、分配库存，并估算待产工时与产能缺口。",
    summary: "粘贴合同条款或采购明细，AGH 调用订单评审工具逐行解析内部编号、名称、数量、材料、版本、规格与交期，匹配企业零件库和生产台账，分配可用库存，并按工序估算待产工时与产能缺口。材料或版本冲突、规格缺项、未知编号会逐行标出并检索候选零件，不给出虚假工时。",
    inputs: ["带列名的表格或“字段：值”形式的采购明细", "可附加要求：交期、优先级或需要重点核对的字段"],
    tools: ["industrial_review_order：解析、匹配、库存与工时", "industrial_search_catalog：为冲突或未匹配行检索候选"],
    outputs: ["逐行评审状态（条件满足 / 需确认 / 冲突 / 未匹配）", "库存分配、待产数量与工时估算", "每行的计算依据与匹配零件"],
    placeholder: "粘贴合同或采购明细，说明需要核对的数量、材料、版本和交期…",
  },
  catalog_search: {
    title: "零件检索",
    tagline: "用自然语言在企业零件库中查找可用零件，直接查看三维模型、拆解视图与来源许可。",
    summary: "用自然语言描述用途、结构、材料或文件格式，AGH 会组合关键词与筛选条件多次检索企业零件库，在 45 条带来源与许可的工程资产（公开机械资产、原创装配及配套零件）中给出候选，说明匹配依据并附稳定编号。点击结果可直接打开三维模型、拆解视图和部件清单；库中没有的零件会如实说明，不用无关零件凑数。",
    inputs: ["用途、结构特征、材料、格式等自然语言描述", "可指定数量上限或是否需要装配层级"],
    tools: ["industrial_search_catalog：关键词、分类、格式组合检索"],
    outputs: ["带编号、用途与匹配依据的候选列表", "可打开的三维模型、爆炸视图与 BOM"],
    placeholder: "描述要找的零件，例如：用于定位夹具的带孔支架，优先查看可编辑的 STEP 资产…",
  },
};

function CaseRail({ cases, mode, disabled, active, onRun }: { cases: DemoCase[]; mode: Mode; disabled: boolean; active: string; onRun: (item: DemoCase) => void }) {
  const visible = cases.filter((item) => item.mode === mode);
  if (!visible.length) return null;
  return <section className="chat-cases" aria-label="测试案例"><h3><FlaskConical size={15} />测试案例<span>点击即经 AGH 运行，结果写入历史记录</span></h3>
    <div className="chat-case-list">{visible.map((item) => <button type="button" key={item.id} className={`chat-case${active === item.id ? " is-active" : ""}`} disabled={disabled} aria-label={`运行案例：${item.title}`} title={`预期：${item.expect}`} onClick={() => onRun(item)}>
      {item.document?.preview ? <img src={item.document.preview} alt="" loading="lazy" /> : null}
      <span><span className="chat-case-title"><em className={`task-case-kind task-case-kind--${item.kind}`}>{kindNames[item.kind]}</em><strong>{item.title}</strong></span><small>{item.summary}</small></span>
      <Play size={15} className="chat-case-play" />
    </button>)}</div>
  </section>;
}

function EmptyGuide({ mode, selectable, onMode }: { mode: Mode; selectable: boolean; onMode: (mode: Mode) => void }) {
  const guide = modeGuides[mode];
  return <div className="chat-empty">
    {selectable ? <div className="chat-mode-cards" role="group" aria-label="选择任务类型">{modes.map(({ id, label, detail, icon: Icon }) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => onMode(id)}><Icon size={20} /><strong>{label}</strong><small>{detail}</small></button>)}</div> : null}
    <section className="chat-guide" aria-label={`${guide.title}说明`}>
      <h2>{guide.title}能做什么</h2>
      <p>{guide.summary}</p>
      <div className="chat-guide-grid">
        <div><h3>输入</h3><ul>{guide.inputs.map((item) => <li key={item}>{item}</li>)}</ul></div>
        <div><h3>AGH 调用的工具</h3><ul>{guide.tools.map((item) => <li key={item}>{item}</li>)}</ul></div>
        <div><h3>输出</h3><ul>{guide.outputs.map((item) => <li key={item}>{item}</li>)}</ul></div>
      </div>
      <p className="chat-guide-hint">在下方输入任务，或直接点击一个测试案例运行。每次运行的工具调用都会显示在这里，并保存到“历史记录”。</p>
    </section>
  </div>;
}

function TurnView({ turn, assets, onSelectAsset, preview, canCancel, onCancel }: { turn: Turn; assets: Asset[]; onSelectAsset: (asset: Asset) => void; preview: boolean; canCancel: boolean; onCancel: () => void }) {
  const { task, snapshot } = turn;
  const result = task.result;
  const runtimeWarning = text(record(result?.runtimeWarning).message) || text(result?.runtimeWarning);
  const warningCompletion = task.status === "completed" && result?.engineeringStatus === "verified" && result?.runtimeStatus === "blocked" && Boolean(runtimeWarning);
  const needsInput = result?.outcome === "needs_input";
  const label = taskLabelFor(task);
  const model = text(task.usage?.model) || text(result?.model);
  const executionPreview = result?.execution === "browser-preview" || preview;
  return <article className="chat-turn">
    <div className="chat-user"><div className="chat-bubble"><p>{snapshot.instruction}</p>{snapshot.documentName ? <small><Paperclip size={13} />{snapshot.documentName}{snapshot.pages.length ? ` · 第 ${snapshot.pages.join("、")} 页` : ""}</small> : null}</div></div>
    <section className="chat-agent task-run" aria-label="本次任务记录">
      <header className="task-run-header"><span className={`task-run-status task-run-status--${needsInput ? "needs-input" : warningCompletion ? "failed" : task.status}`}>{pending(task) ? <LoaderCircle size={16} className="spin" /> : needsInput ? <CirclePause size={16} /> : task.status === "completed" && !warningCompletion ? <Check size={16} /> : <CircleAlert size={16} />}<h2>{label}</h2></span>
        <span className="task-run-kicker">{modes.find((item) => item.id === snapshot.mode)?.label} · {executionPreview ? "浏览器工具" : "AGH"}{model ? ` · ${model}` : ""}</span></header>
      {canCancel && pending(task) ? <button type="button" className="secondary-button chat-cancel" disabled={task.cancelRequested} onClick={onCancel}>{task.cancelRequested ? "停止请求已发送，等待执行结束" : task.status === "queued" ? "取消排队" : "停止任务"}</button> : null}
      {task.parentTaskId ? <p className="task-notice">第 {task.revision || 2} 轮补充，已关联上一轮记录 {task.parentTaskId.slice(0, 8)}。</p> : null}
      <TaskRecordView task={task} assets={assets} onSelectAsset={onSelectAsset} preview={executionPreview} />
    </section>
  </article>;
}

function restoreTurns(saved: Record<string, any>): Turn[] {
  if (Array.isArray(saved.turns)) return saved.turns.filter((turn: any) => turn?.task?.id && turn?.snapshot).slice(-MAX_TURNS);
  // Drafts saved before the conversation layout held a single task and snapshot.
  return saved.task?.id && saved.snapshot ? [{ task: saved.task, snapshot: saved.snapshot }] : [];
}

export default function TaskWorkspace({ health, assets, onSelectAsset, onOpenSettings, fixedMode, initialMode = "reconstruct", title, storageKey, active = true }: { active?: boolean; storageKey?: string; fixedMode?: Mode; initialMode?: Mode; title?: string; health: Health | null; assets: Asset[]; onSelectAsset: (asset: Asset) => void; onOpenSettings: () => void }) {
  const inputId = useId();
  const [saved] = useState(() => readWorkspace(storageKey));
  const [mode, setMode] = useState<Mode>(fixedMode || (modes.some(item => item.id === saved.mode) ? saved.mode : initialMode));
  const [instruction, setInstruction] = useState(typeof saved.instruction === 'string' ? saved.instruction : '');
  const [document, setDocument] = useState<DocumentRecord | null>(saved.document?.id ? saved.document : null);
  const [pages, setPages] = useState(typeof saved.pages === 'string' ? saved.pages : '1');
  const [turns, setTurns] = useState<Turn[]>(() => restoreTurns(saved));
  const [newTaskInstead, setNewTaskInstead] = useState(false);
  const [uploading, setUploading] = useState(false), [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(""), [pollError, setPollError] = useState("");
  const [setupNotice, setSetupNotice] = useState("");
  const [pollAttempt, setPollAttempt] = useState(0);
  const [cases, setCases] = useState<DemoCase[]>([]), [activeCase, setActiveCase] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null), textRef = useRef<HTMLTextAreaElement>(null), scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const mounted = useRef(true), requestRef = useRef<AbortController | null>(null);
  const preview = (health as (Health & { preview?: boolean }) | null)?.preview === true;
  const latest = turns.at(-1);
  const running = submitting || turns.some((turn) => pending(turn.task));
  const parsedPages = pages.split(/[,，\s]+/).filter(Boolean).map(Number);
  const pageError = drawingInputError(document, parsedPages);
  const blockedFor = (target: Mode) => !health ? "正在读取运行环境…" : target === "reconstruct" && preview ? "分享版不运行图纸重建，请在本地工作台连接 AGH。" : target === "reconstruct" && health.visionEnabled === false ? "当前模型未启用图片输入，请选择支持图纸的模型。" : !preview && !health.modelConfigured ? health.publicTrial ? "执行器离线或试用尚未开放，请稍后重试。" : "尚未配置模型 API Key：点击输入框下方的模型按钮填写 Key 后，再运行任务或测试案例。" : "";
  const blocked = blockedFor(mode);
  const followUp = Boolean(latest && latest.task.result?.outcome === "needs_input" && health?.taskRevisions && !newTaskInstead && latest.snapshot.mode === mode);
  const needsDocument = mode === "reconstruct" && !followUp;
  const allowSubmit = Boolean(instruction.trim() && !blocked && !running && !uploading && (!needsDocument || (document && !pageError)));
  const pendingKey = turns.filter((turn) => pending(turn.task)).map((turn) => turn.task.id).join(",");

  useEffect(() => {
    saveWorkspace(storageKey, { mode, instruction, document, pages, turns: turns.map(({ task, snapshot }) => ({ task: { id: task.id, status: task.status, title: task.title, mode: task.mode }, snapshot })) });
  }, [storageKey, mode, instruction, document, pages, turns]);
  useEffect(() => {
    const ids = restoreTurns(saved).map((turn) => turn.task.id);
    if (!ids.length) return;
    const controller = new AbortController();
    for (const id of ids) api<WorkspaceTask>(`/api/tasks/${encodeURIComponent(id)}`, { signal: controller.signal }).then(updateTask).catch((cause) => { if (!controller.signal.aborted) setPollError(`无法恢复任务记录：${(cause as Error).message}`); });
    return () => controller.abort();
  }, [saved]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api<{ cases?: DemoCase[] }>("/assets/demo-cases/cases.json", { signal: controller.signal }).then((value) => setCases(Array.isArray(value?.cases) ? value.cases : [])).catch(() => {});
    return () => { mounted.current = false; controller.abort(); requestRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(",");
    let stopped = false, failures = 0, polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        for (const id of ids) {
          const next = await api<WorkspaceTask>(`/api/tasks/${encodeURIComponent(id)}`, { signal: controller.signal });
          if (stopped) return;
          updateTask(next);
        }
        failures = 0; setPollError("");
        timer = setTimeout(poll, 1200);
      } catch (cause) { if (!stopped) { setPollError(`执行记录暂时无法更新：${(cause as Error).message} 正在自动重连`); timer = setTimeout(poll, Math.min(30000, 1000 * 2 ** Math.min(++failures, 5))); } }
      finally { polling = false; }
    };
    const reconnect = () => { if (!window.document.hidden && !stopped) { clearTimeout(timer); timer = setTimeout(poll, 0); } };
    window.addEventListener('online', reconnect);
    window.document.addEventListener('visibilitychange', reconnect);
    timer = setTimeout(poll, 500);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); window.removeEventListener('online', reconnect); window.document.removeEventListener('visibilitychange', reconnect); };
  }, [pendingKey, pollAttempt]);
  // Follow new tool calls and answers while the reader is at the bottom; leave them alone after scrolling up.
  const progress = turns.map((turn) => `${turn.task.id}:${turn.task.status}:${turn.task.events?.length || 0}`).join("|");
  useEffect(() => {
    const element = scrollRef.current;
    if (active && element && progress && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [progress, active]);

  function updateTask(next: WorkspaceTask) {
    if (!mounted.current || !next?.id) return;
    setTurns((current) => current.map((turn) => turn.task.id === next.id ? { ...turn, task: next } : turn));
  }
  async function upload(file?: File): Promise<DocumentRecord | null> {
    if (!file || running) return null;
    if (!/\.(pdf|png|jpe?g|webp)$/i.test(file.name)) { setError("请上传 PDF、PNG、JPEG 或 WebP 图纸。"); return null; }
    setUploading(true); setDocument(null); setError("");
    const controller = new AbortController(); requestRef.current = controller;
    try {
      const form = new FormData(); form.append("file", file);
      const next = await api<DocumentRecord>("/api/documents", { method: "POST", body: form, signal: controller.signal });
      if (mounted.current) { setDocument(next.error ? null : next); setPages("1"); if (next.error) setError('无法读取图纸，请重新上传可正常打开的文件。'); }
      return next.error ? null : next;
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setError(`上传失败：${(cause as Error).message}`); return null; }
    finally { if (mounted.current) setUploading(false); }
  }
  async function start(input: { mode: Mode; instruction: string; document: DocumentRecord | null; pages: number[]; parentTaskId?: string }): Promise<boolean> {
    const snapshot: Snapshot = { instruction: input.instruction, mode: input.mode, ...(input.mode === "reconstruct" ? { documentId: input.document?.id, documentName: input.document?.name } : {}), pages: input.mode === "reconstruct" ? input.pages : [] };
    const controller = new AbortController(); requestRef.current = controller;
    setSubmitting(true); setError(""); setPollError(""); setSetupNotice("");
    try {
      const task = await api<WorkspaceTask>("/api/tasks", { ...jsonPost({ mode: input.mode, instruction: input.instruction, ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), ...(input.mode === "reconstruct" ? { documentId: input.document?.id, pages: input.pages } : {}) }), signal: controller.signal });
      if (!mounted.current) return false;
      stickToBottom.current = true;
      setTurns((current) => [...current, { task, snapshot }].slice(-MAX_TURNS)); setNewTaskInstead(false);
      return true;
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setError(`任务提交失败：${(cause as Error).message}。输入内容已保留。`); return false; }
    finally { if (mounted.current) setSubmitting(false); }
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!allowSubmit) return;
    if (followUp && latest) {
      try {
        const previous = latest.snapshot;
        const attachment = previous.documentId ? document?.id === previous.documentId ? document : await api<DocumentRecord>(`/api/documents/${encodeURIComponent(previous.documentId)}`) : null;
        if (previous.mode === 'reconstruct' && drawingInputError(attachment, previous.pages)) throw new Error(drawingInputError(attachment, previous.pages));
        const next = `${previous.instruction}\n\n补充资料：\n${instruction.trim()}`;
        if (await start({ mode: previous.mode, instruction: next, document: attachment, pages: previous.pages, parentTaskId: latest.task.id })) setInstruction("");
      } catch (cause) { setError((cause as Error).message); }
      return;
    }
    if (await start({ mode, instruction: instruction.trim(), document, pages: parsedPages })) setInstruction("");
  }
  async function runCase(item: DemoCase) {
    if (running || uploading) return;
    if (!fixedMode) setMode(item.mode);
    const reason = blockedFor(item.mode);
    if (reason) { setSetupNotice(reason); return; }
    setError(""); setActiveCase(item.id); setNewTaskInstead(true);
    let attached: DocumentRecord | null = null;
    if (item.document) {
      try {
        const response = await fetch(item.document.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        attached = await upload(new File([blob], item.document.name, { type: blob.type || "application/pdf" }));
      } catch (cause) { if (mounted.current) setError(`案例图纸载入失败：${(cause as Error).message}`); return; }
      if (!attached || !mounted.current) return;
      setPages((item.document.pages || [1]).join(", "));
    }
    await start({ mode: item.mode, instruction: item.instruction, document: attached, pages: item.document?.pages || [1] });
  }
  async function cancel(task: WorkspaceTask) {
    try { updateTask(await api<WorkspaceTask>(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, jsonPost({}))); }
    catch (cause) { setPollError((cause as Error).message); }
  }
  // Page navigation changes visibility, never the submission or polling lifetime.
  // Hidden workspaces keep their own state but release their rendered viewers.
  if (!active) return null;
  const guide = modeGuides[mode];
  const heading = title || (fixedMode ? guide.title : "任务工作台");
  const canCancel = Boolean(health?.publicTrial || health?.metered || health?.taskCancellation);
  const notice = setupNotice || (blocked && !needsModelSetup(health) ? blocked : "");
  return <div className="task-workspace chat-workspace">
    <header className="chat-header"><h1>{heading}</h1><p>{fixedMode ? guide.tagline : "在一个对话中完成图纸重建、订单评审与零件检索；由 AGH 组织模型与工业工具执行，每一步都可核查。"}</p></header>
    <div className="chat-scroll" ref={scrollRef} role="region" aria-label="对话记录" tabIndex={0} onScroll={(event) => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      <ModelSetupNotice health={health} onOpenSettings={onOpenSettings} />
      {health?.publicTrial || health?.metered ? <details className="task-usage-disclosure"><summary>用量与费用</summary><UsagePanel /></details> : null}
      {turns.length ? <div className="chat-thread">{turns.map((turn) => <TurnView key={turn.task.id} turn={turn} assets={assets} onSelectAsset={onSelectAsset} preview={preview} canCancel={canCancel} onCancel={() => void cancel(turn.task)} />)}</div>
        : <EmptyGuide mode={mode} selectable={!fixedMode} onMode={(next) => { setMode(next); setError(""); setSetupNotice(""); }} />}
      {pollError ? <div className="task-error" role="alert"><p>{pollError}。任务可能仍在运行，已收到的记录会保留。</p><button className="secondary-button" type="button" onClick={() => { setPollError(""); setPollAttempt((value) => value + 1); }}>重新连接记录</button></div> : null}
    </div>
    <div className="chat-dock">
      {notice ? <div className="task-connection-note" role="alert"><Settings2 size={20} /><p>{notice}</p>{health && !preview && !health.publicTrial && (!health.modelConfigured || health.visionEnabled === false) ? <button className="secondary-button" type="button" onClick={onOpenSettings}>配置模型 <ArrowUpRight size={16} /></button> : null}</div> : null}
      {error ? <div className="task-error" role="alert"><CircleAlert size={20} /><p>{error}</p></div> : null}
      <form className="chat-composer" onSubmit={(event) => void submit(event)} aria-label="工程任务输入">
        {followUp ? <div className="chat-follow-up" role="status"><CirclePause size={16} /><span>上一轮需要补充资料：发送的内容将作为补充资料，保留原图并创建关联的新一轮任务。</span><button type="button" className="text-button" onClick={() => setNewTaskInstead(true)}>改为新任务</button></div> : null}
        {needsDocument && document ? <div className="task-document"><FileText size={18} /><span><strong>{document.name}</strong><small>{drawingPageCount(document) ? `${drawingPageCount(document)} 页已读取` : "已上传"}</small></span><label>图纸页码<input aria-label="图纸页码" value={pages} onChange={(event) => setPages(event.target.value)} placeholder="1, 2" disabled={running} /></label><button type="button" aria-label="移除附件" disabled={running} onClick={() => setDocument(null)}><X size={18} /></button></div> : null}
        {needsDocument && document && pageError ? <p className="task-error" role="alert">{pageError}</p> : null}
        <label className="task-prompt-label" htmlFor={inputId}>这次需要完成什么？</label>
        <textarea id={inputId} ref={textRef} rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={followUp ? "例如：板厚为 12 mm，依据图纸修订 B。" : guide.placeholder} aria-describedby={`${inputId}-help`} />
        <div className="chat-composer-footer">
          <div className="chat-composer-tools">
            {fixedMode ? <span className="chat-mode-chip">{guide.title}</span> : <label className="task-mode-select"><span className="sr-only">任务类型</span><select aria-label="任务类型" value={mode} disabled={running} onChange={(event) => { setMode(event.target.value as Mode); setError(""); setSetupNotice(""); }}>{modes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
            {needsDocument ? <><input type="file" ref={uploadRef} accept=".pdf,.png,.jpg,.jpeg,.webp" hidden onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} /><button className="task-attach" type="button" disabled={uploading || running || preview} onClick={() => uploadRef.current?.click()}>{uploading ? <LoaderCircle size={16} className="spin" /> : <Paperclip size={16} />}{uploading ? "正在读取…" : document ? "更换图纸" : "添加图纸"}</button></> : null}
            <button type="button" className={`chat-model-chip${health?.modelConfigured ? "" : " is-missing"}`} aria-label={`选择模型：${health?.modelConfigured ? health.model || "已配置" : "未配置"}`} title="切换模型或填写 API Key" onClick={onOpenSettings}><Cpu size={14} />{health?.modelConfigured ? health.model || "已配置模型" : "配置模型"}<ChevronDown size={13} /></button>
            <span id={`${inputId}-help`} className="chat-help">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <button className="primary-button" type="submit" aria-label="开始任务" disabled={!allowSubmit}>{running ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}{running ? "正在执行" : followUp ? "补充并继续" : "发送"}</button>
        </div>
      </form>
      <CaseRail cases={cases} mode={mode} disabled={running || uploading} active={activeCase} onRun={(item) => { void runCase(item); }} />
    </div>
  </div>;
}
