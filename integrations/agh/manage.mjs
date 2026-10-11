#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { integration, runtime } from './common.mjs';
const action = process.argv[2] || 'status';
if (!['install', 'status', 'serve', 'stop'].includes(action)) throw new Error('Use manage.mjs install|status|serve|stop');
const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(runtime, 'node_modules/tsx/dist/loader.mjs')).href, resolve(integration, 'manage-worker.mjs'), action], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
child.on('error', () => { process.exitCode = 1; });
