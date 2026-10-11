#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runtimeEnvironment } from '../../server/runtime-environment.mjs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { integration, runtime } from './common.mjs';

if (process.argv.includes('--help')) {
  console.log('External Codex decision transport, not autonomous Agnes inference.\nUsage: node integrations/agh/run-controller.mjs --stdio\n  Send one JSON line: {"type":"tool","name":"industrial_geometry","args":{...},"decision":"source evidence and decision summary"}\n  Read controller_step before deciding the next tool. Finish with {"type":"finish"}.\nBatch replay: --input data/uploads/ID/controller.json\n  File: {"execution":"external-codex-assisted","decisions":[...]}\nThe runner creates a fresh project-local AGH home, uses only a loopback transport token, and exports the real AGH ledger. No external model Key or account is read.');
  process.exit(0);
}
const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(runtime, 'node_modules/tsx/dist/loader.mjs')).href, resolve(integration, 'controller-worker.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...runtimeEnvironment(), AGH_INDUSTRIAL_API: process.env.AGH_INDUSTRIAL_API } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
child.on('error', () => { process.exitCode = 1; });
