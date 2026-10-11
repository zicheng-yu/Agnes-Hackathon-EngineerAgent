// Bundles AGH execution records from the local task history into ZIP downloads.
// Each task folder holds the official AGH trace export, the task record, the input drawing,
// the final verified CAD artifacts and a readable README; secrets and local paths are removed.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";

/** Minimal ZIP (deflate, UTF-8 names) writer; entries are [{ name, data }]. */
export function zip(entries, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10); header.writeUInt16LE(day, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26);
    locals.push(header, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10);
    record.writeUInt16LE(time, 12); record.writeUInt16LE(day, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const modeNames = { reconstruct: "图纸重建", order_review: "订单评审", catalog_search: "零件检索" };
const sha256 = value => createHash("sha256").update(value).digest("hex");
function cleaner(root, secrets = []) {
  const clean = value => {
    if (typeof value === "string") {
      let text = value.replaceAll(`${root}/`, "");
      for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
      return text.replace(/sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED]").replace(/(?:\/Users\/|\/home\/|\/private\/|[A-Z]:\\Users\\)[^\s"'<>]+/g, "[LOCAL_PATH]");
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(apiKey|authorization|accessToken|secret|token|api_key)$/i.test(key)).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return clean;
}

/** All non-debug tasks in the local history, newest first. */
export async function historyTasks(dataRoot) {
  const tasks = [];
  for (const name of await fs.readdir(path.join(dataRoot, "tasks")).catch(() => [])) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    try { const task = JSON.parse(await fs.readFile(path.join(dataRoot, "tasks", name), "utf8")); if (task?.id && task.mode !== "geometry") tasks.push(task); } catch { /* skip unreadable records */ }
  }
  return tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function readme(task, info) {
  const result = task.result || {}, usage = task.usage || result.usage || {};
  const calls = new Map(), lines = [];
  for (const event of task.events || []) {
    if (event.type === "tool/call") calls.set(event.toolUseId, event);
    if (event.type === "tool/result") lines.push(`- ${calls.get(event.toolUseId)?.toolName || event.toolName}：${calls.get(event.toolUseId)?.input ? `${String(calls.get(event.toolUseId).input).slice(0, 160)} → ` : ""}${String(event.output ?? "").slice(0, 600)}`);
  }
  const checks = result.geometryRuns?.at(-1)?.verification?.checks || [];
  return [
    `# ${task.title}`,
    "",
    `- 任务编号：${task.id}`,
    `- 任务类型：${modeNames[task.mode] || task.mode}`,
    `- 开始时间：${task.createdAt}`,
    `- 状态：${task.status}${result.outcome ? `（${result.outcome}）` : ""}`,
    `- 模型：${usage.model || result.model || "未记录"}（${usage.providerId || result.providerId || "未记录"}），模型请求 ${usage.requestCount ?? "未记录"} 次`,
    `- AGH 会话：${result.sessionId || task.sessionId || "未记录"}；AGH 版本：${info.aghCommit}`,
    `- 原生执行记录：trace.agnes.jsonl（AGH 官方导出器 agnes 格式，${info.traceEvents} 条事件，SHA-256 ${info.traceSha256 || "无"}）`,
    "",
    "## 任务输入",
    "",
    "```text",
    String(task.instruction || "").trim(),
    "```",
    "",
    "## 工具调用与返回（按时间顺序，来自 AGH 事件）",
    "",
    ...(lines.length ? lines : ["- 本次没有工具调用。"]),
    ...(checks.length ? ["", "## 几何检查（实测 CAD 实体）", "", "| 检查 | 图纸值 | 实测值 | 结果 |", "|---|---|---|---|",
      ...checks.map(c => `| ${[c.kind, c.axis, c.diameter ? `Ø${c.diameter}` : ""].filter(Boolean).join(" ")} | ${JSON.stringify(c.expected)} | ${JSON.stringify(c.actual)} | ${c.passed ? "通过" : "未通过"} |`)] : []),
    ...(result.clarification ? ["", "## 请求补充的资料", "", ...((result.clarification.missing || []).map(item => `- ${item.item}${item.evidence ? `：${item.evidence}` : ""}`))] : []),
    "",
    "## 模型最终回答",
    "",
    String(result.answer || "（无）").trim(),
    "",
    "## 文件",
    "",
    ...info.files.map(file => `- ${file}`),
    "",
  ].join("\n");
}

/** ZIP entries for one task under the given folder prefix. */
export async function taskEntries(task, { root, dataRoot, prefix = "", aghCommit = "", secrets = [] }) {
  const clean = cleaner(root, secrets), entries = [], files = [];
  const add = (name, data) => { entries.push({ name: prefix + name, data }); files.push(name); };
  let traceEvents = 0, traceSha256 = "";
  try {
    const lines = (await fs.readFile(path.join(dataRoot, "tasks", task.id, "trace.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.stringify(clean(JSON.parse(line))));
    const text = lines.join("\n") + "\n";
    traceEvents = lines.length; traceSha256 = sha256(text);
    add("trace.agnes.jsonl", text);
  } catch { /* exported below as missing in README */ }
  add("task.json", JSON.stringify(clean(task), null, 2));
  if (task.documentId && /^[A-Za-z0-9_-]+$/.test(task.documentId)) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dataRoot, "uploads", task.documentId, "record.json"), "utf8"));
      const source = path.join(dataRoot, "uploads", task.documentId, path.basename(record.file));
      add(`input/${path.basename(record.name || source).replace(/[^\w.\-一-鿿]/g, "_")}`, await fs.readFile(source));
    } catch { /* input no longer available */ }
  }
  const runId = task.result?.geometryRuns?.at(-1)?.runId;
  if (runId && /^[A-Za-z0-9_-]+$/.test(runId)) {
    const run = path.join(dataRoot, "runs", runId);
    for (const file of ["model.step", "model.glb", "feature-plan.json", "views/front.svg", "views/top.svg", "views/side.svg"]) {
      try { add(`artifacts/${path.basename(file)}`, await fs.readFile(path.join(run, file))); } catch { /* optional view */ }
    }
    try { const manifest = JSON.parse(await fs.readFile(path.join(run, "manifest.json"), "utf8")); delete manifest.files; add("artifacts/manifest.json", JSON.stringify(clean(manifest), null, 2)); } catch { /* no manifest */ }
  }
  entries.unshift({ name: `${prefix}README.md`, data: clean(readme(task, { aghCommit, traceEvents, traceSha256, files: ["README.md", ...files] })) });
  return { entries, summary: { id: task.id, title: task.title, mode: task.mode, status: task.status, outcome: task.result?.outcome, model: task.usage?.model || task.result?.model, createdAt: task.createdAt, sessionId: task.result?.sessionId || task.sessionId, traceEvents, traceSha256, folder: prefix } };
}

/** ZIP of every task in the local history with an index. */
export async function historyArchive({ root, dataRoot, aghCommit, secrets }) {
  const tasks = await historyTasks(dataRoot), entries = [], index = [];
  for (const [i, task] of tasks.entries()) {
    const folder = `${String(i + 1).padStart(2, "0")}-${task.mode}-${task.id.slice(0, 8)}/`;
    const bundle = await taskEntries(task, { root, dataRoot, prefix: folder, aghCommit, secrets });
    entries.push(...bundle.entries); index.push(bundle.summary);
  }
  const overview = ["# EngineerAgent · AGH 执行记录导出", "", `- 导出时间：${new Date().toISOString()}`, `- AGH 版本：${aghCommit}`, `- 任务数：${index.length}`, "- 每个目录包含：trace.agnes.jsonl（AGH 官方导出的原生执行记录）、task.json（工作台任务记录）、README.md（可读摘要）、input/（输入图纸）、artifacts/（最终 STEP/GLB/视图与检查清单）。", "",
    "| # | 任务 | 类型 | 模型 | 状态 | AGH 事件数 | 目录 |", "|---|---|---|---|---|---|---|",
    ...index.map((item, i) => `| ${i + 1} | ${item.title} | ${modeNames[item.mode] || item.mode} | ${item.model || "—"} | ${item.outcome || item.status} | ${item.traceEvents} | ${item.folder} |`), ""].join("\n");
  entries.unshift({ name: "README.md", data: overview }, { name: "index.json", data: JSON.stringify({ exportedAt: new Date().toISOString(), aghCommit, tasks: index }, null, 2) });
  return { buffer: zip(entries), count: index.length };
}
