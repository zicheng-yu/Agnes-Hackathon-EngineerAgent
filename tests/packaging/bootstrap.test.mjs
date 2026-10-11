import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildNeeded, pythonPath, versionAtLeast, pythonReport, probePythonImports } from '../../scripts/setup-local.mjs';
import { localPort } from '../../scripts/start-local.mjs';

test('requires the AGH Node minimum and rejects malformed versions', () => {
  for (const version of ['24.10.0', 'v24.10', '24.11.1', '26.7.0']) assert.equal(versionAtLeast(version), true, version);
  for (const version of ['24.9.9', '22.99.0', '24', 'latest', '24.10.0-rc.1']) assert.equal(versionAtLeast(version), false, version);
});

test('CAD interpreter follows the host platform', () => {
  assert.equal(pythonPath('/sample', 'darwin'), path.join('/sample', '.venv/bin/python'));
  assert.equal(pythonPath('/sample', 'linux'), path.join('/sample', '.venv/bin/python'));
  assert.equal(pythonPath('/sample', 'win32'), path.join('/sample', '.venv/Scripts/python.exe'));
});

test('only valid loopback ports reach the browser launcher', () => {
  assert.equal(localPort('4310'), 4310);
  assert.equal(localPort('65535'), 65535);
  for (const port of ['0', '65536', '4310&calc', '1.5', '-1', 'localhost', '']) assert.throws(() => localPort(port));
});

test('native import timeout preserves a runnable interpreter version and the stalled module', async () => {
  const progress = [];
  const result = await probePythonImports(process.execPath, ['-e', 'console.log(JSON.stringify({event:"checking",module:"cadquery"}));setInterval(()=>{},1000);'], {
    timeoutMs: 500, heartbeatMs: 50, onProgress: event => progress.push(event),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.module, 'cadquery');
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(progress.length > 1);
  const report = pythonReport({ version: '3.12.14', seriesOk: true, missing: [] }, result);
  assert.equal(report.ready, false);
  assert.equal(report.version, '3.12.14');
  assert.equal(report.interpreterReady, true);
  assert.equal(report.importTimedOut, true);
  assert.match(report.details, /cadquery/);
  assert.doesNotMatch(report.details, /无法运行/);
});

test('specific import errors and native crashes are not reduced to missing Python', async () => {
  const metadata = { version: '3.12.14', seriesOk: true, missing: [] };
  const failed = await probePythonImports(process.execPath, ['-e', 'console.log(JSON.stringify({event:"checking",module:"cadquery"}));console.log(JSON.stringify({event:"result",imports:["cadquery: ImportError: library not loaded"]}));'], { timeoutMs: 2000 });
  const report = pythonReport(metadata, failed);
  assert.equal(report.version, metadata.version);
  assert.equal(report.interpreterReady, true);
  assert.match(report.details, /ImportError: library not loaded/);
  assert.match(pythonReport(metadata, { code: null, signal: 'SIGABRT', module: 'cadquery' }).details, /SIGABRT/);
  assert.equal(pythonReport(metadata, { ok: true }).ready, true);
});

test('missing or newer frontend sources rebuild; equal archive timestamps reuse dist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineeragent-build-check-'));
  try {
    assert.equal(await buildNeeded(root), true);
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist/index.html'), '<main></main>');
    await fs.writeFile(path.join(root, 'src/nested/entry.ts'), 'export {};');
    const same = new Date('2026-10-09T00:00:00Z');
    await fs.utimes(path.join(root, 'dist/index.html'), same, same);
    await fs.utimes(path.join(root, 'src/nested/entry.ts'), same, same);
    assert.equal(await buildNeeded(root), false);
    const later = new Date('2026-10-10T00:00:00Z');
    await fs.utimes(path.join(root, 'src/nested/entry.ts'), later, later);
    assert.equal(await buildNeeded(root), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
