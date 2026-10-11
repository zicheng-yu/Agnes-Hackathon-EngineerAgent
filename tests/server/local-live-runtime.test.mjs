import { hasPrivatePermissions } from '../../server/private-permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBucket, createLocalLiveRuntime } from '../../server/local-live-runtime.mjs';

async function fixture({ root, parsed = true, configured = true } = {}) {
  const directory = root || await mkdtemp(join(tmpdir(), 'engineeragent-local-test-'));
  const settings = { providerId: 'openrouter', apiKey: configured ? 'fixture-not-a-real-key' : '', usageEnabled: true };
  const spawned = [];
  let paidCalls = 0;
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const runtime = await createLocalLiveRuntime({ root: directory, port, getSettings: async () => settings,
    spawnRunner(command, args, options) {
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = (signal) => { child.exitCode = 0; child.signalCode = signal; setImmediate(() => child.emit('exit', 0, signal)); return true; };
      spawned.push({ command, args, options }); return child;
    },
    providerFetch: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer fixture-not-a-real-key');
      paidCalls++;
      return Response.json({ id: `gen-local-${paidCalls}`, choices: [{ message: { role: 'assistant', content: '离线测试结果' }, finish_reason: 'stop' }], usage: { cost: 0.025, prompt_tokens: 50, completion_tokens: 20 } });
    },
  });
  const app = express();
  if (parsed) app.use(express.json({ limit: '24mb' }));
  app.use(runtime.handle);
  if (!parsed) app.use(express.json({ limit: '24mb' }));
  app.use((req, res) => res.json({ original: true, mode: req.body?.mode, path: req.path }));
  server.on('request', app);
  const call = (path, { method = 'GET', cookie, body, headers = {} } = {}) => fetch(`${origin}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const token = (await readFile(join(directory, 'data/live-runtime/runner-token.txt'), 'utf8')).trim();
  const runner = (path, body, lease) => call(path, { method: 'POST', body, headers: { authorization: `Bearer ${token}`, ...(lease ? { 'x-job-lease': lease } : {}) } });
  const session = async () => { const response = await call('/api/health'); return { health: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') }; };
  const stop = async () => { await runtime.stop(); await new Promise((done) => server.close(done)); };
  return { root: directory, runtime, settings, spawned, origin, call, runner, session, stop, paidCalls: () => paidCalls };
}

test('local gateway consumes parsed JSON, multipart and persists actual usage across restarts', async () => {
  const f = await fixture();
  try {
    const { health, cookie, cookieHeader } = await f.session();
    assert.equal(health.publicTrial, false); assert.equal(health.metered, true); assert.equal(health.localMode, true);
    assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Strict/); assert.doesNotMatch(cookieHeader, /; Secure/);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].options.env.OPENROUTER_API_KEY, undefined);
    assert.equal(f.spawned[0].options.env.AGNES_API_KEY, undefined);
    assert.equal(f.spawned[0].options.env.RUNNER_TOKEN, undefined);
    await f.runner('/api/runner/heartbeat', { runnerId: 'fixture', status: 'idle' });
    const form = new FormData(); form.set('file', new File(['%PDF-1.7\nfixture'], 'part.pdf', { type: 'application/pdf' }));
    const upload = await fetch(`${f.origin}/api/documents`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(upload.status, 201); const document = await upload.json();
    const documentFile = await f.call(document.url, { cookie }); assert.match(await documentFile.text(), /^%PDF/);
    const taskResponse = await f.call('/api/tasks', { method: 'POST', cookie, body: { mode: 'catalog_search', instruction: '检索法兰' } });
    assert.equal(taskResponse.status, 201); const task = await taskResponse.json();
    const job = (await (await f.runner('/api/runner/lease', { runnerId: 'fixture' })).json()).job;
    const model = await f.call(`/api/runner/jobs/${job.id}/model/v1/chat/completions`, { method: 'POST', body: { messages: [{ role: 'user', content: '法兰' }] }, headers: { authorization: `Bearer ${job.leaseToken}` } });
    assert.equal(model.status, 200); assert.equal(f.paidCalls(), 1);
    await f.runner(`/api/runner/jobs/${job.id}/complete`, { success: true, result: {} }, job.leaseToken);
    const usage = await (await f.call('/api/usage', { cookie })).json(); assert.equal(usage.usedUsd, 0.025); assert.equal(usage.remainingUsd, 9.975);
    await f.stop();
    const again = await fixture({ root: f.root });
    try {
      const restored = await (await again.call('/api/usage', { cookie })).json();
      assert.equal(restored.usedUsd, 0.025); assert.equal(restored.budgetUsd, 10);
      const oldTask = await (await again.call(`/api/tasks/${task.id}`, { cookie })).json(); assert.equal(oldTask.usage.costUsd, 0.025);
      assert.match(await (await again.call(document.url, { cookie })).text(), /^%PDF/);
      for (const name of ['budget.sqlite', 'secrets.json', 'runner-token.txt']) assert.equal(await hasPrivatePermissions(join(f.root, 'data/live-runtime', name)), true);
    } finally { await again.stop(); }
  } finally { await f.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test('original geometry route and other provider modes remain in the original server', async () => {
  const f = await fixture({ parsed: false });
  try {
    const geometry = await (await f.call('/api/tasks', { method: 'POST', body: { mode: 'geometry', input: { name: 'plate' } } })).json();
    assert.equal(geometry.original, true); assert.equal(geometry.mode, 'geometry');
    assert.equal((await (await f.call('/api/catalog')).json()).original, true);
    f.settings.providerId = 'agnes-ai';
    assert.equal((await (await f.call('/api/health')).json()).original, true);
    assert.equal(f.paidCalls(), 0);
  } finally { await f.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test('runner starts lazily only after an enabled key is configured, and receives no model key', async () => {
  const f = await fixture({ configured: false });
  try {
    assert.equal(await f.runtime.startRunner(), false);
    await f.session(); assert.equal(f.spawned.length, 0);
    f.settings.apiKey = 'fixture-not-a-real-key';
    await f.session(); assert.equal(f.spawned.length, 1);
    const serialized = JSON.stringify(f.spawned[0].options.env);
    assert.doesNotMatch(serialized, /fixture-not-a-real-key|OPENROUTER_API_KEY|AGNES_API_KEY/);
    assert.equal(f.spawned[0].options.env.CLOUD_RUNNER_ALLOW_LOOPBACK, '1');
    f.settings.usageEnabled = false;
    assert.equal(await f.runtime.startRunner(), false);
  } finally { await f.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test('legacy task history remains accessible and local work has no five-task daily quota', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.session();
    await mkdir(join(f.root, 'data/tasks'), { recursive: true });
    await writeFile(join(f.root, 'data/tasks/legacy-cad.json'), JSON.stringify({ id: 'legacy-cad', status: 'completed', title: '原有 CAD 工作流', createdAt: '2026-10-10T00:00:00.000Z' }));
    assert.equal((await (await f.call('/api/tasks/legacy-cad', { cookie })).json()).original, true);
    assert.equal((await (await f.call('/api/tasks/legacy-cad/trace', { cookie })).json()).original, true);
    await f.runner('/api/runner/heartbeat', { runnerId: 'fixture', status: 'idle' });
    for (let i = 0; i < 6; i++) {
      const response = await f.call('/api/tasks', { method: 'POST', cookie, body: { mode: 'catalog_search', instruction: `离线任务 ${i}` } });
      assert.equal(response.status, 201);
      const task = await response.json();
      await f.call(`/api/tasks/${task.id}/cancel`, { method: 'POST', cookie });
    }
    const list = await (await f.call('/api/tasks', { cookie })).json();
    assert.equal(list.length, 7); assert.ok(list.some((task) => task.id === 'legacy-cad'));
    assert.equal((await (await f.call('/api/usage', { cookie })).json()).heldUsd, 0);
    assert.equal(f.paidCalls(), 0);
  } finally { await f.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test('private file bucket rejects traversal, symlink parents and symlink objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engineeragent-bucket-test-'));
  try {
    const bucket = await createFileBucket(join(root, 'objects'));
    await bucket.put('private/good/report.json', '{"valid":true}');
    assert.deepEqual(await (await bucket.get('private/good/report.json')).json(), { valid: true });
    assert.equal(await hasPrivatePermissions(join(root, 'objects/private/good/report.json')), true);
    for (const key of ['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'a//empty']) await assert.rejects(bucket.put(key, 'bad'));
    await mkdir(join(root, 'elsewhere'));
    await writeFile(join(root, 'elsewhere/secret'), 'outside');
    await symlink(join(root, 'elsewhere'), join(root, 'objects/link'));
    await assert.rejects(bucket.get('link/secret'));
    await symlink(join(root, 'elsewhere/secret'), join(root, 'objects/private/good/link'));
    await assert.rejects(bucket.get('private/good/link'));
    await assert.rejects(bucket.put('private/good/link', 'overwritten'));
    assert.equal(await readFile(join(root, 'elsewhere/secret'), 'utf8'), 'outside');
  } finally { await rm(root, { recursive: true, force: true }); }
});
