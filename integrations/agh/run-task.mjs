#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { integration, runtime } from './common.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node integrations/agh/run-task.mjs --input data/uploads/ID/task.json\nTask JSON: {"mode":"reconstruct|order_review|catalog_search","prompt":"...","images":["data/uploads/ID/page-1.png"]}\nMode defaults to reconstruct; order_review/catalog_search need no images. Real model use requires AGH_ALLOW_MODEL_RUN=1 plus AGNES_BASE_URL, AGNES_MODEL and AGNES_API_KEY from the server environment. Optional AGNES_PROVIDER_ID defaults to agnes-ai. AGH_INDUSTRIAL_HOME may select an isolated directory under integrations/agh/.local. No key argument is accepted.');
  process.exit(0);
}
if (process.env.AGH_ALLOW_MODEL_RUN !== '1') {
  console.log(JSON.stringify({ type: 'result', success: false, modelRequestSubmitted: false, code: 'MODEL_RUN_DISABLED', message: '真实模型调用尚未启用。可使用 offline-smoke.mjs 验证 AGH 与工具链。', error: { code: 'MODEL_RUN_DISABLED', message: 'Real model use is disabled.' } }));
  process.exit(2);
}
const loader = resolve(runtime, 'node_modules/tsx/dist/loader.mjs');
await access(loader);
const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, resolve(integration, 'task-entry.mjs'), ...args], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
child.on('error', () => { process.exitCode = 1; });
