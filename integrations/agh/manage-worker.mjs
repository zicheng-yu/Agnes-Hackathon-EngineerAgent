import { spawn } from 'node:child_process';
import { createClient, memoryJournal } from './vendor-runtime/packages/sdk/src/index.node.ts';
import { entry, projectRoot, environment, prepareHome, daemonClientOptions, installPlugin, cli } from './common.mjs';
const action = process.argv[2];
const env = environment();
if (action === 'install') {
  const client = createClient({ ...await daemonClientOptions(env), auth: { kind: 'local' }, journal: memoryJournal() });
  try { await client.initialize(); console.log(JSON.stringify({ success: true, plugin: await installPlugin(client), modelCalled: false }, null, 2)); }
  finally { await client.close(); }
} else if (action === 'serve') {
  await prepareHome(env);
  const port = '4311';
  const child = spawn(process.execPath, [entry, 'serve', '--port', port, '--cwd', projectRoot], { cwd: projectRoot, env: { ...env, AGNES_WEB_ORIGIN: `http://127.0.0.1:${port}` }, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const result = await cli(action === 'stop' ? ['daemon', 'stop'] : ['package', 'status'], env);
  console.log(result.stdout.trim());
}
