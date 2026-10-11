import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import "dotenv/config";
import { loadCatalog } from "./catalog.mjs";
import { createCatalogCache } from './catalog-cache.mjs';
import { serviceIdentity } from './local-service.mjs';
import { isWithinDirectory } from './paths.mjs';
import { drawingInputError } from './document-validation.mjs';
import { TaskScheduler } from './task-scheduler.mjs';
import { createTaskHistory } from './task-history.mjs';
import { runAGHTask, publishTrace } from "./agh-bridge.mjs";
import {readableAGHEvent} from "./task-events.mjs";
import {historyArchive, historyTasks, taskEntries, zip} from "./record-export.mjs";
import {createLocalLiveRuntime} from "./local-live-runtime.mjs";
import {createProviderSettings} from "./provider-settings.mjs";
import {createOpenRouterCatalog} from "./openrouter-models.mjs";
import {hostedDemoConfig, hostedDemoGuard} from "./hosted-demo.mjs";

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const instanceId = serviceIdentity(root);
const port = Number(process.env.PORT || 4310);
const app = express();
const python = path.join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const dataRoot = path.join(root, "data");
const readCatalog = createCatalogCache(root);
const hosted = hostedDemoConfig();
await Promise.all(
  ["uploads", "runs", "tasks"].map((x) =>
    fs.mkdir(path.join(dataRoot, x), { recursive: true }),
  ),
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    ![`http://localhost:${port}`, `http://127.0.0.1:${port}`, ...hosted.origins].includes(origin)
  )
    return res.status(403).json({ error: "仅接受本地工作台请求" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "24mb" }));
if (hosted.enabled) app.use(hostedDemoGuard(hosted));
app.use(
  "/assets",
  express.static(path.join(root, "assets"), { dotfiles: "deny" }),
);
app.use(
  "/runs",
  express.static(path.join(dataRoot, "runs"), { dotfiles: "deny" }),
);

const safeId = /^[a-zA-Z0-9_-]+$/;
const tasks = new Map();
const taskHistory = await createTaskHistory(path.join(dataRoot, 'tasks'));
const taskScheduler = new TaskScheduler({concurrency: Number(process.env.ENGINEERAGENT_CONCURRENCY || 1)});
const settingsPath = path.join(dataRoot, "settings.json");
const modelCatalog = createOpenRouterCatalog({path:path.join(dataRoot,"openrouter-models.json")});
const providerSettings = createProviderSettings({path:settingsPath,resolveOpenRouterModel:modelCatalog.resolve});
const settings = providerSettings.current;
let changingSettings = false;
let pendingTaskSubmissions = 0;
app.use((req,res,next)=>{
  if(changingSettings && req.method === "POST" && req.path === "/api/tasks" && req.body?.mode !== "geometry") return res.status(409).json({error:"正在保存模型连接，请稍后提交任务。"});
  if(req.method === "POST" && req.path === "/api/tasks" && req.body?.mode !== "geometry") {
    pendingTaskSubmissions++; let released=false;
    const release=()=>{if(!released){released=true;pendingTaskSubmissions--;}};
    res.once("finish",release);res.once("close",release);
  }
  next();
});
const localLive = await createLocalLiveRuntime({root, getSettings: settings, port, resolveModel:modelCatalog.resolve});
app.use(localLive.handle);

function run(command, args, timeout = 120000, onLine, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('任务已停止'));
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, {once:true});
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("工具运行超时"));
    }, timeout);
    child.stdout.on("data", (x) => {
      stdout += x;
      if (stdout.length > 12000000) child.kill();
      if (onLine) onLine(String(x));
    });
    child.stderr.on("data", (x) => {
      stderr = (stderr + x).slice(-20000);
    });
    child.on("error", (e) => {
      signal?.removeEventListener('abort',cancel);
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      signal?.removeEventListener('abort',cancel);
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || stdout || `工具退出 ${code}`));
      else resolve({ stdout, stderr });
    });
  });
}
async function persistTask(task) {
  tasks.set(task.id, task);
  // Direct CAD debug runs bypass AGH, so they stay in memory and never enter the task history.
  if (task.mode === "geometry") return;
  await taskHistory.save(task);
  // Keep active tasks and a small recent working set; full records remain on disk.
  if (tasks.size > 60) for (const [id, item] of tasks) {
    if (!['running','queued','preparing'].includes(item.status)) tasks.delete(id);
    if (tasks.size <= 50) break;
  }
}
async function event(task, type, message, detail = {}) {
  task.events.push({ time: new Date().toISOString(), type, message, ...detail });
  await persistTask(task);
}
function readJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {}
  for (const line of stdout.trim().split("\n").reverse())
    try {
      return JSON.parse(line);
    } catch {}
  throw new Error("工具未返回有效 JSON 结果");
}
app.get("/api/health", async (req, res) => {
  const s = await settings();
  res.json({
    application: "EngineerAgent",
    instanceId,
    version: "0.1.0",
    cad: existsSync(path.join(root, "tools/cad/runner.py")),
    agh: existsSync(
      path.join(
        root,
        "integrations/agh/vendor-runtime/packages/cli/dist/local/agnes.mjs",
      ),
    ),
    modelConfigured: Boolean(s.apiKey && s.model && s.usageEnabled),
    hasApiKey: Boolean(s.apiKey),
    model: s.model,
    providerId: s.providerId,
    billingMode: s.billingMode,
    visionEnabled: s.visionEnabled,
    usageEnabled: s.usageEnabled,
    taskCancellation: true,
    taskRevisions: true,
    hostedDemo: hosted.enabled,
  });
});
app.get("/api/catalog", async (req, res) => {res.set('Cache-Control','private, max-age=30');res.json(await readCatalog());});
app.get("/api/evaluation", async (req,res)=>{try{res.json(JSON.parse(await fs.readFile(path.join(root,"assets/evaluation/report.json"),"utf8")));}catch{res.status(404).json({error:"实测报告尚未生成"});}});
app.get("/api/order-examples", async (req, res) => {
  try {
    const data = JSON.parse(
      await fs.readFile(
        path.join(root, "assets/demo-enterprise/orders.json"),
        "utf8",
      ),
    );
    res.json(Array.isArray(data) ? data : data.orders || data.examples || []);
  } catch {
    res.status(503).json({ error: "订单演示资料正在准备" });
  }
});
app.post("/api/orders/review", async (req, res) => {
  if (
    typeof req.body.text !== "string" ||
    !req.body.text.trim() ||
    req.body.text.length > 100000
  )
    return res
      .status(400)
      .json({ error: "请输入有效采购文本（不超过 100000 字符）" });
  try {
    const { reviewOrder } = await import("./order-tools.mjs");
    const enterprise = JSON.parse(
      await fs.readFile(
        path.join(root, "assets/demo-enterprise/enterprise.json"),
        "utf8",
      ),
    );
    const report = await reviewOrder({
      text: req.body.text,
      catalog: await readCatalog(),
      enterprise,
    });
    res.json(report);
  } catch (error) {
    res.status(422).json({ error: error.message });
  }
});
app.get("/api/settings", async (req, res) => {
  try {res.json(await providerSettings.publicSettings());} catch {res.status(500).json({error:"无法读取模型设置。"});}
});
app.get("/api/models",async(req,res)=>{
  if(req.query.providerId !== "openrouter")return res.json({models:req.query.providerId === "agnes-ai"?[{id:"agnes-3.0-flash",name:"Agnes 3.0 Flash",input:["text","image"],selectable:true}]:[]});
  try {res.json(await modelCatalog.list({refresh:req.query.refresh === "1"}));}catch(error){res.status(503).json({error:error.message});}
});
app.post("/api/settings", async (req, res) => {
  if(changingSettings)return res.status(409).json({error:"正在保存另一个连接配置。"});
  changingSettings=true;
  try {
    if(pendingTaskSubmissions>0 || [...tasks.values()].some(task=>task.status==="running"||task.status==="queued") || await localLive.hasActiveJobs()) return res.status(409).json({error:"任务或费用核账尚未结束，暂不能更换模型连接。"});
    res.json(await providerSettings.save(req.body||{}));
  }catch(error){res.status(400).json({error:error.message});}
  finally{changingSettings=false;}
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
});
app.post("/api/documents", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择文件" });
  const extension = path.extname(req.file.originalname).toLowerCase();
  if (
    ![
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".dxf",
      ".step",
      ".stp",
      ".json",
    ].includes(extension)
  )
    return res
      .status(400)
      .json({ error: "支持 PDF、图片、DXF、STEP 和建模 JSON" });
  const id = randomUUID();
  const dir = path.join(dataRoot, "uploads", id);
  await fs.mkdir(dir);
  const file = path.join(dir, "input" + extension);
  await fs.writeFile(file, req.file.buffer);
  let parsed = {};
  try {
    parsed = readJsonOutput(
      (
        await run(
          python,
          [path.join(root, "tools/read_document.py"), file],
          60000,
        )
      ).stdout,
    );
  } catch (e) {
    parsed = { error: e.message };
  }
  if (parsed.error) {
    await fs.rm(dir, { recursive: true, force: true });
    return res.status(422).json({ error: '无法读取此文件，请确认文件未损坏、未加密且能够正常打开，再重新上传。' });
  }
  const mime =
    {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    }[extension] || "application/octet-stream";
  const record = {
    id,
    name: req.file.originalname,
    mime,
    url: `/api/documents/${id}/file`,
    file,
    createdAt: new Date().toISOString(),
    ...parsed,
  };
  await fs.writeFile(
    path.join(dir, "record.json"),
    JSON.stringify(record, null, 2),
  );
  const { file: privateFile, ...publicRecord } = record;
  res.json(publicRecord);
});
app.get("/api/documents/:id", async (req, res) => {
  if (!safeId.test(req.params.id))
    return res.status(400).json({ error: "文档 ID 无效" });
  try {
    const { file, ...record } = JSON.parse(
      await fs.readFile(
        path.join(dataRoot, "uploads", req.params.id, "record.json"),
        "utf8",
      ),
    );
    res.json(record);
  } catch {
    res.status(404).json({ error: "文档不存在" });
  }
});
app.get("/api/documents/:id/file", async (req, res) => {
  if (!safeId.test(req.params.id)) return res.sendStatus(400);
  try {
    const record = JSON.parse(
      await fs.readFile(
        path.join(dataRoot, "uploads", req.params.id, "record.json"),
        "utf8",
      ),
    );
    res.setHeader("Content-Type", record.mime);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.sendFile(record.file);
  } catch {
    res.sendStatus(404);
  }
});
async function geometry(operation, input) {
  if (
    ![
      "build",
      "validate",
      "project",
      "patch",
      "assembly",
      "import",
      "compare_views",
    ].includes(operation)
  )
    throw new Error("不支持的几何操作");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("请输入结构化建模参数");
  if (operation === "import") {
    const absolute = await fs.realpath(path.resolve(root, input.path || ""));
    if (
      !["assets", "data/uploads"].some((prefix) =>
        isWithinDirectory(path.resolve(root, prefix), absolute),
      )
    )
      throw new Error("仅允许导入项目资产或已上传文件");
    input = { ...input, path: absolute };
  }
  if (operation === "compare_views") {
    input = structuredClone(input);
    for (const key of ["source", "projection"]) {
      if (!input[key]?.path) throw new Error("源图与投影视图都需要路径");
      const actual = await fs.realpath(path.resolve(root, input[key].path));
      if (
        !["assets", "data/uploads", "data/runs"].some((prefix) =>
          isWithinDirectory(path.resolve(root, prefix), actual),
        )
      )
        throw new Error("仅允许比较项目图纸和生成视图");
      input[key].path = actual;
    }
  }
  const id = randomUUID();
  const dir = path.join(dataRoot, "runs", id);
  await fs.mkdir(dir);
  const inputFile = path.join(dir, "input.json");
  await fs.writeFile(inputFile, JSON.stringify(input, null, 2));
  let output;
  try {
    output = await run(
      python,
      [
        path.join(root, "tools/cad/runner.py"),
        operation,
        "--input",
        inputFile,
        "--output",
        dir,
      ],
      180000,
    );
  } catch (error) {
    if (!existsSync(path.join(dir, "manifest.json"))) throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    );
  } catch {
    manifest = readJsonOutput(output.stdout);
  }
  const artifacts = {base: `/runs/${id}/`};
  for (const [key, file] of Object.entries({manifest:"manifest.json",step:"model.step",glb:"model.glb",mesh:"mesh.json",front:"views/front.svg",top:"views/top.svg",side:"views/side.svg",overlay:"overlay.png",metrics:"metrics.json"})) {
    try {const info=await fs.stat(path.join(dir,file));if(info.isFile() && info.size>0)artifacts[key]=`/runs/${id}/${file}`;} catch {}
  }
  return {
    success: manifest.status === "completed" && !manifest.errors?.length,
    verified:
      manifest.verification?.passed ??
      (manifest.operation === "import" && manifest.measurements?.valid === false
        ? false
        : null),
    runId: id,
    manifest,
    artifacts,
  };
}
app.post("/api/geometry", async (req, res) => {
  try {
    res.json(await geometry(req.body.operation, req.body.input));
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});
app.get("/api/examples", async (req, res) => {
  const examples = [];
  const dir = path.join(root, "tools/cad/examples");
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.endsWith(".json"))
        examples.push({
          name,
          spec: JSON.parse(await fs.readFile(path.join(dir, name), "utf8")),
        });
    }
  } catch {}
  res.json(examples);
});
app.get("/api/tasks", async (req, res) => {
  if (req.query.summary === '1') return res.json(taskHistory.list(req.query));
  const files = await fs.readdir(path.join(dataRoot, "tasks"));
  const items = [];
  for (const file of files.filter((x) => x.endsWith(".json")))
    try {
      items.push(
        JSON.parse(
          await fs.readFile(path.join(dataRoot, "tasks", file), "utf8"),
        ),
      );
    } catch {}
  res.json(items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});
app.post("/api/tasks", async (req, res) => {
  const { mode, input, operation, documentId, instruction, parentTaskId } = req.body;
  if (mode !== "geometry") {
    const taskMode = mode || "reconstruct";
    if (!["reconstruct", "order_review", "catalog_search"].includes(taskMode))
      return res.status(400).json({error:"请选择有效任务类型"});
    const s = await settings();
    if (!s.usageEnabled || !s.apiKey || !s.model)
      return res.status(409).json({error:"请在设置中连接模型并启用 AGH 任务"});
    if(typeof instruction !== "string" || !instruction.trim() || instruction.length > 100000)
      return res.status(400).json({error:"请输入任务要求（不超过 100000 字符）"});
    let document;
    const pages = req.body.pages || [1];
    if(taskMode === "reconstruct") {
      if(!s.visionEnabled)return res.status(422).json({error:"当前模型未启用图片输入，请在设置中选择支持图纸的模型。"});
      if(!safeId.test(documentId || "")) return res.status(400).json({error:"请先上传图纸"});
      try {document=JSON.parse(await fs.readFile(path.join(dataRoot,"uploads",documentId,"record.json"),"utf8"));}
      catch {return res.status(404).json({error:"图纸不存在"});}
      const validationError = drawingInputError(document, pages);
      if (validationError) return res.status(422).json({error:validationError});
    }
    const title = {reconstruct:"图纸重建",order_review:"订单评审",catalog_search:"零件检索"}[taskMode];
    let parent;
    if (parentTaskId) {
      if (!safeId.test(parentTaskId)) return res.status(400).json({error:'原任务编号无效。'});
      try { parent=await taskHistory.get(parentTaskId); } catch { return res.status(404).json({error:'原任务记录不存在。'}); }
      if (parent.mode!==taskMode || ['running','queued','preparing'].includes(parent.status)) return res.status(409).json({error:'原任务尚未结束，或任务类型不同。'});
    }
    if (!taskScheduler.available) return res.status(429).json({error:'任务队列已满，请稍后重试。'});
    const task = {id:randomUUID(),status:"queued",createdAt:new Date().toISOString(),title:document?`${title} · ${document.name}`:title,mode:taskMode,events:[],instruction,documentId:document?.id,pages:document?pages:undefined,...(parent?{parentTaskId:parent.id,rootTaskId:parent.rootTaskId||parent.id,revision:(parent.revision||1)+1}:{revision:1})};
    const initialSave = persistTask(task);
    taskScheduler.submit(task.id, async(signal)=>{
      let queue=Promise.resolve(); const calls=new Map(); let answer="";
      try {
        await initialSave;
        signal.throwIfAborted(); task.status='running'; task.startedAt=new Date().toISOString();
        await event(task,'start','开始执行任务');
        let prompt=instruction, images=[];
        if(document) {
          await event(task,"prepare","准备所选图纸页与原文证据");
          const prepared=readJsonOutput((await run(python,[path.join(root,"tools/prepare_vision.py"),document.file,JSON.stringify(pages)],60000,undefined,signal)).stdout);
          images=prepared.images;
          prompt += `\n文档ID: ${documentId}\n选中页码: ${pages.join(", ")}\n只使用选中图纸；未提供的尺寸保持未知。\n${(document.pages||[]).filter(p=>pages.includes(p.page)).map(p=>`第${p.page}页：${p.text}`).join("\n").slice(0,45000)}`;
        }
        const inputDir=path.join(dataRoot,"uploads",`task-${task.id}`);
        await fs.mkdir(inputDir,{recursive:true});
        const taskFile=path.join(inputDir,"task.json");
        await fs.writeFile(taskFile,JSON.stringify({mode:taskMode,prompt,images},null,2));
        signal.throwIfAborted();
        const result=await runAGHTask({root,taskFile,settings:s,signal,onEvent:record=>{
          queue=queue.then(async()=>{
            if(record.type==="session") {task.sessionId=record.sessionId;await event(task,"session","AGH 会话已创建");}
            else if(record.type==="agh_event") {
              const view=readableAGHEvent(record.event,calls);
              if(view) {if(view.type==="assistant") answer=view.message;const {type,message,...detail}=view;await event(task,type,message,detail);}
            }
          });
        }});
        await queue;
        const traceUrl=await publishTrace(root,task.id,result.trace,s.apiKey).catch(error=>{if(signal.aborted)return null;throw error;});
        task.result={...result,answer,trace:undefined,html:undefined,traceUrl};
        if(result.usage)task.usage=result.usage;
        task.status=signal.aborted?(signal.reason==='shutdown'?'interrupted':'cancelled'):result.success?"completed":"failed"; task.error=result.error?.message;
        task.completedAt=new Date().toISOString();
        if(signal.aborted) {task.error=signal.reason==='shutdown'?'服务关闭，执行已中断；现有记录已保存。':'任务已停止；停止前已经发送的模型请求仍可能计费。';await event(task,'warning',task.error);return;}
        if(result.outcome==="needs_input") await event(task,"warning","AGH 已暂停：输入资料不完整，等待补充后再继续");
        else await event(task,result.success?"success":"error",result.success?"AGH 已完成任务与结果检查":task.error||"任务未通过验证");
      } catch(error) {
        await queue.catch(()=>{}); task.status=signal.aborted?(signal.reason==='shutdown'?'interrupted':'cancelled'):"failed";
        task.completedAt=new Date().toISOString();
        task.error=signal.aborted?'执行已停止或中断，已保留收到的记录。':s.apiKey?String(error.message).split(s.apiKey).join("[REDACTED]"):String(error.message);
        await event(task,"error",task.error);
      }
    },async reason=>{await initialSave;task.status=reason==='shutdown'?'interrupted':'cancelled';task.completedAt=new Date().toISOString();await event(task,'warning',reason==='shutdown'?'服务关闭，排队任务未启动。':'排队任务已取消，未调用模型。');});
    await initialSave; res.status(202).json(task);
    return;
  }
  const task = {
    id: randomUUID(),
    status: "running",
    createdAt: new Date().toISOString(),
    title: input?.name || "CAD 工具任务",
    mode: "geometry",
    execution: "direct-tool",
    events: [],
    input,
  };
  await persistTask(task);
  res.status(202).json(task);
  (async () => {
    try {
      await event(task, "tool", "开始执行本地 CAD 工具");
      const result = await geometry(operation || "build", input);
      task.result = result;
      task.status = result.success ? "completed" : "failed";
      await event(
        task,
        !result.success
          ? "error"
          : result.verified === false
            ? "warning"
            : "success",
        !result.success
          ? "几何工具报告构建错误"
          : result.verified === true
            ? "几何构建与检查通过"
            : result.verified === false
              ? "构建完成，部分检查未通过，请查看验证报告"
              : "几何构建完成，未验证的项目见报告",
      );
    } catch (e) {
      task.status = "failed";
      task.error = e.message;
      await event(task, "error", e.message);
    }
  })();
});
app.post('/api/tasks/:id/cancel', async(req,res)=>{
  if(!safeId.test(req.params.id))return res.status(400).json({error:'任务编号无效。'});
  const task=tasks.get(req.params.id)||await taskHistory.get(req.params.id).catch(()=>null);
  if(!task)return res.status(404).json({error:'任务不存在。'});
  if(['running','queued','preparing'].includes(task.status)) {
    task.cancelRequested=true;await persistTask(task);
    if(!await taskScheduler.cancel(task.id))return res.status(409).json({error:'当前任务不由此执行器管理，请核对任务记录。'});
  }
  res.json(task);
});
app.get("/api/tasks/:id", async (req, res) => {
  if (!safeId.test(req.params.id))
    return res.status(400).json({ error: "任务 ID 无效" });
  try {
    res.json(
      tasks.get(req.params.id) ||
        JSON.parse(
          await fs.readFile(
            path.join(dataRoot, "tasks", req.params.id + ".json"),
            "utf8",
          ),
        ),
    );
  } catch {
    res.status(404).json({ error: "任务不存在" });
  }
});
app.get("/api/tasks/:id/trace", async (req, res) => {
  if (!safeId.test(req.params.id)) return res.sendStatus(400);
  const file = path.join(dataRoot, "tasks", req.params.id, "trace.jsonl");
  if (!existsSync(file)) return res.sendStatus(404);
  res.download(file, `${req.params.id}-agh-trace.jsonl`);
});
// Convenient AGH execution-record export: every history task, or one task, as a ZIP.
async function exportContext() {
  const lock = JSON.parse(await fs.readFile(path.join(root, "integrations/agh/runtime-lock.json"), "utf8"));
  const saved = await providerSettings.load();
  return { root, dataRoot, aghCommit: lock.commit, secrets: Object.values(saved.providers || {}).map((item) => item.apiKey) };
}
const exportStamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
app.get("/api/history/export", async (req, res) => {
  try {
    const { buffer, count } = await historyArchive(await exportContext());
    if (!count) return res.status(404).json({ error: "历史记录为空，没有可导出的执行记录" });
    res.attachment(`EngineerAgent-AGH执行记录-${exportStamp()}.zip`).type("application/zip").send(buffer);
  } catch (error) { res.status(500).json({ error: `导出失败：${error.message}` }); }
});
app.get("/api/history/:id/export", async (req, res) => {
  if (!safeId.test(req.params.id)) return res.status(400).json({ error: "任务 ID 无效" });
  try {
    const task = (await historyTasks(dataRoot)).find((item) => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: "该任务不在本机 AGH 历史记录中" });
    const { entries } = await taskEntries(task, await exportContext());
    res.attachment(`AGH执行记录-${task.mode}-${task.id.slice(0, 8)}.zip`).type("application/zip").send(zip(entries));
  } catch (error) { res.status(500).json({ error: `导出失败：${error.message}` }); }
});
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
app.use((req, res, next) => {
  if (/^\/(data|integrations|\.venv|references)(\/|$)/.test(req.path))
    return res.status(403).send("Private workspace path");
  next();
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*splat}", (req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use((error, req, res, next) => {
  console.error(error.message);
  res.status(400).json({
    error:
      error.code === "LIMIT_FILE_SIZE" ? "文件不能超过 40MB" : error.message,
  });
});
const listener = app.listen(port, "127.0.0.1", () => {
  console.log(`EngineerAgent workbench http://127.0.0.1:${port}`);
  void localLive.startRunner();
});
let shuttingDown=false;
const shutdown=async()=>{
 if(shuttingDown)return;shuttingDown=true;
 listener.close();await Promise.all([taskScheduler.stop(),localLive.stop()]);process.exit(0);
};
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal,shutdown);
process.on('message',message=>{if(message?.type==='shutdown')void shutdown();});
process.once('disconnect',shutdown);
