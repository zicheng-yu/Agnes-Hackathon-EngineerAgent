import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { runtimeEnvironment } from './runtime-environment.mjs';
import { stopProcessTree } from './process-cancellation.mjs';

export function runAGHTask({ root, taskFile, settings, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('任务已停止'));
    const child = spawn(
      process.execPath,
      [path.join(root, "integrations/agh/run-external-task.mjs"), "--input", taskFile],
      {
        cwd: root,
        env: {
          ...runtimeEnvironment(),
          AGH_ALLOW_MODEL_RUN: "1",
          AGNES_BASE_URL: settings.baseUrl,
          AGNES_MODEL: settings.model,
          AGNES_API_KEY: settings.apiKey,
          AGNES_PROVIDER_ID: settings.providerId || "agnes-ai",
          AGH_VISION_ENABLED: settings.visionEnabled ? "1" : "0",
          AGH_THINKING_DISABLED: settings.thinkingDisabled ? "1" : "0",
          AGH_INDUSTRIAL_API: process.env.AGH_INDUSTRIAL_API || `http://127.0.0.1:${process.env.PORT || 4310}`,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    );
    const redact = (text) =>
      settings.apiKey ? text.split(settings.apiKey).join("[REDACTED]") : text;
    let buffer = "",
      stderr = "",
      result;
    let hard;
    const cancel = () => {
      if (hard) return;
      if (child.connected) child.send({type:'cancel'},()=>{});
      hard = setTimeout(() => stopProcessTree(child), 25000); hard.unref();
    };
    const timer = setTimeout(cancel, 660000);
    signal?.addEventListener('abort',cancel,{once:true});
    child.on('message',message=>{if(message?.type==='ready' && hard && child.connected)child.send({type:'cancel'},()=>{});});
    if (signal?.aborted) cancel();
    const cleanup = () => { clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener('abort',cancel); };
    child.stdout.on("data", (data) => {
      buffer += redact(String(data));
      let position;
      while ((position = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, position);
        buffer = buffer.slice(position + 1);
        try {
          const record = JSON.parse(line);
          if (record.type === "result") result = record;
          onEvent?.(record);
        } catch {}
      }
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + redact(String(data))).slice(-12000);
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (result) resolve(result);
      else reject(new Error(stderr || `AGH 未返回结果（退出 ${code}）`));
    });
  });
}

export async function publishTrace(root, taskId, trace, secret = "") {
  if (!trace) return null;
  const actual = await fs.realpath(trace),
    allowed = await fs.realpath(path.join(root, "integrations/agh/.local"));
  if (!actual.startsWith(allowed + path.sep))
    throw new Error("执行记录路径不在项目运行目录");
  let content = await fs.readFile(actual, "utf8");
  if (secret) content = content.split(secret).join("[REDACTED]");
  const dir = path.join(root, "data/tasks", taskId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "trace.jsonl"), content, { mode: 0o600 });
  return `/api/tasks/${taskId}/trace`;
}
