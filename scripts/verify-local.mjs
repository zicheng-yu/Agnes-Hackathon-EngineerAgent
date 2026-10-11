#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmCommand, projectRoot, pythonPath, run, setupLocal } from './setup-local.mjs';
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
let server;
try {
  await setupLocal({ install: false });
  const npm = await npmCommand();
  for (const script of ['build', 'test:ui', 'test:package']) await run(npm.command, [...npm.prefix, 'run', script], { env });
  await run(pythonPath(), ['-m', 'unittest', 'discover', '-s', 'tests/cad', '-v'], { env });
  const port = '4319';
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: projectRoot, env: { ...env, PORT: port, NODE_ENV: 'production' }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  let failure;
  server.on('error', error => { failure = error; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure || server.exitCode !== null) throw failure || new Error('Verification server exited before readiness.');
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) })).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 300));
  }
  if (!ready) throw new Error('Verification server did not become ready.');
  await run(process.execPath, ['--test', '--test-timeout=90000', 'tests/server/*.test.mjs', 'tests/orders/*.test.mjs', 'server/live-runtime/*.test.mjs'], { env: { ...env, TEST_BASE_URL: `http://127.0.0.1:${port}` } });
  await run(process.execPath, ['--import', pathToFileURL(resolve(projectRoot, 'integrations/agh/vendor-runtime/node_modules/tsx/dist/loader.mjs')).href, '--test', '--test-timeout=45000', 'integrations/agh/*.test.mjs'], { env });
  console.log('All local verification suites passed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(done => { const timer = setTimeout(() => { server.kill('SIGKILL'); done(); }, 5000); server.once('exit', () => { clearTimeout(timer); done(); }); });
  }
}
