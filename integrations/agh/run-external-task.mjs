#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { integration, projectRoot, runtime } from './common.mjs';
import { allowedInputPath } from './industrial-tools/index.mjs';
import { externalSettings } from './external-provider.mjs';
import { publicValue } from './cloud-runner-protocol.mjs';
import { portablePath } from '../../server/paths.mjs';
import { runtimeEnvironment } from '../../server/runtime-environment.mjs';

let child, stage = '检查任务配置', safeSecret = '', cancelled = false;
let diagnostic = '';
const stop = () => { cancelled = true; if (child?.connected) child.send({type:'cancel'},()=>{}); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
process.on('message', message => { if (message?.type === 'cancel') stop(); });
process.once('disconnect', stop);
if (process.send) process.send({type:'ready'});
try {
  if (process.env.AGH_ALLOW_MODEL_RUN !== '1' || process.argv[2] !== '--input' || process.argv.length !== 4) throw new Error('External task use requires application enablement and one local task file.');
  const config = externalSettings({ providerId: process.env.AGNES_PROVIDER_ID, model: process.env.AGNES_MODEL, baseUrl: process.env.AGNES_BASE_URL, apiKey: process.env.AGNES_API_KEY, visionEnabled: process.env.AGH_VISION_ENABLED === '1', thinkingDisabled: process.env.AGH_THINKING_DISABLED === '1' });
  safeSecret = config.apiKey;
  stage = '读取任务文件';
  const source = await allowedInputPath(projectRoot, process.argv[3]);
  const task = JSON.parse(await readFile(source.actual, 'utf8'));
  if (!Array.isArray(task.images || []) || (task.images || []).length > 4 || ((task.images || []).length && !config.visionEnabled)) throw new Error('The selected model does not support these drawing images.');
  const id = randomUUID(), directory = resolve(integration, '.local/cloud-jobs', `${id}-${randomUUID()}`), upload = resolve(projectRoot, 'data/uploads', `cloud-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(upload, { recursive: true, mode: 0o700 });
  const preparedInputs = [];
  for (const [index, name] of (task.images || []).entries()) {
    const file = await allowedInputPath(projectRoot, name), folder = resolve(upload, `input-${index}`);
    await mkdir(folder, { mode: 0o700 });
    const copied = resolve(folder, 'source' + extname(file.actual)); await copyFile(file.actual, copied);
    const { stdout } = await promisify(execFile)(resolve(projectRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'), [resolve(integration, 'cloud-prepare-vision.py'), copied, '[1]'], { timeout: 60000, maxBuffer: 1024 * 1024 });
    for (const image of JSON.parse(stdout).images) preparedInputs.push({ name: `drawing-${index+1}.jpg`, localName: portablePath(relative(upload, image)), mime: 'image/jpeg' });
  }
  const job = { id, mode: task.mode || 'reconstruct', prompt: task.prompt, inputs: [], pages: (task.mode || 'reconstruct') === 'reconstruct' ? [1] : [], preparedInputs,
    model: { id: config.model, input: config.visionEnabled ? ['text', 'image'] : ['text'], contextWindow: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, limits: { timeoutMs: 600000, maxSteps: (task.mode || 'reconstruct') === 'reconstruct' ? 16 : 10, maxOutputTokens: 8192 } };
  await writeFile(resolve(directory, 'job.json'), JSON.stringify(job), { mode: 0o600 });
  const { apiKey, ...publicConfig } = config;
  stage = '启动 AGH 工作进程';
  if (cancelled) throw new Error('任务已停止');
  child = spawn(process.execPath, ['--import', pathToFileURL(resolve(runtime, 'node_modules/tsx/dist/loader.mjs')).href, resolve(integration, 'cloud-job-worker.mjs')], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: { ...runtimeEnvironment(), SITE_ORIGIN: process.env.AGH_INDUSTRIAL_API || 'http://127.0.0.1:4310', CLOUD_RUNNER_ALLOW_LOOPBACK: '1', AGH_INDUSTRIAL_API: process.env.AGH_INDUSTRIAL_API || 'http://127.0.0.1:4310', AGH_CLOUD_JOB_DIR: directory, AGH_CLOUD_LEASE_TOKEN: randomUUID() + randomUUID(), AGH_EXTERNAL_CONFIG: JSON.stringify(publicConfig), AGH_EXTERNAL_API_KEY: apiKey },
  });
  const lines = createInterface({ input: child.stdout });
  child.on('message', message => { if (message?.type === 'ready' && cancelled) stop(); });
  lines.on('line', line => { try { const value = JSON.parse(line); if (value.type !== 'result') console.log(JSON.stringify(publicValue(value, { projectRoot, secrets: [apiKey] }))); } catch {} });
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + publicValue(String(bytes), { projectRoot, secrets: [apiKey] })).slice(-3000); });
  const exited = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({code, signal})); });
  let result;
  try { result = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8')); }
  catch { const detail = diagnostic.split(/\r?\n/).find(line => /(?:Error|Exception)(?: \[[A-Z_]+\])?:/.test(line)) || diagnostic.trim().slice(-600) || '工作进程未返回任务结果'; throw new Error(`退出 ${exited.code ?? exited.signal}：${detail}`); }
  console.log(JSON.stringify({ ...publicValue(result, { projectRoot, secrets: [apiKey] }), trace: resolve(directory, 'trace.agnes.jsonl') }));
  if (!result.success) process.exitCode = 1;
} catch (failure) { const detail = publicValue(String(failure.message), { projectRoot, secrets: [safeSecret] }).slice(0, 400); console.log(JSON.stringify({ type: 'result', success: false, error: { code: 'EXTERNAL_TASK_START_FAILED', stage, message: `${stage}失败：${detail}` } })); process.exitCode = 1; }
finally { if (process.connected) process.disconnect(); }
