import { setPrivatePermissions } from '../../server/private-permissions.mjs';
import { runtimeEnvironment } from '../../server/runtime-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { checkCloudTool, sessionInlineImageResult } from './cloud-guard/index.mjs';
import { cloudProfile, publicEvent, publicValue, readRunnerToken, siteOrigin, validateJob, safeArtifact } from './cloud-runner-protocol.mjs';
import { runnerClient, runLeasedJob } from './cloud-runner.mjs';
import { startCloudLocalApi } from './cloud-local-api.mjs';

const job = () => ({ id: 'job-12345678', mode: 'catalog_search', prompt: '查找轴承', leaseToken: 'test-only-lease-token-123456789', model: { id: 'test/provider', input: ['text', 'image'] }, limits: { timeoutMs: 60000, maxSteps: 8, maxOutputTokens: 4096 }, inputs: [] });

test('cloud profile has only the job-scoped manual provider and env reference', () => {
  const value = cloudProfile('https://example.com', job());
  assert.equal(value.provider.catalog.include.length, 0);
  assert.equal(value.provider.routes[0].baseUrl, 'https://example.com/api/runner/jobs/job-12345678/model/v1');
  assert.equal(value.provider.routes[0].credentialRef, 'secret://cloud/job');
  assert.ok(!JSON.stringify(value).includes(job().leaseToken));
  assert.equal(value.computerUse.enabled, false);
  const partial = job(); partial.model.cost = { input: 0.3, output: 1.2 };
  assert.deepEqual(cloudProfile('http://127.0.0.1:4310', partial).provider.routes[0].models[0].cost, { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 });
});

test('job and endpoint validation prevents broader inputs and unsafe limits', () => {
  assert.equal(validateJob(job()).mode, 'catalog_search');
  assert.throws(() => validateJob({ ...job(), limits: { ...job().limits, maxSteps: 99 } }));
  assert.throws(() => validateJob({ ...job(), inputs: [{ name: 'x.sh', mime: 'text/plain', url: '/x' }] }));
  assert.throws(() => validateJob({ ...job(), pages: [0] }));
  assert.throws(() => siteOrigin('http://example.com'));
  assert.throws(() => siteOrigin('https://user:pass@example.com'));
  assert.equal(siteOrigin('http://127.0.0.1:7777', true), 'http://127.0.0.1:7777');
});

test('text-only Worker lease pages may be empty or omitted; drawing pages remain bounded', () => {
  for (const mode of ['catalog_search', 'order_review']) {
    assert.deepEqual(validateJob({ ...job(), mode, pages: [] }).pages, []);
    assert.deepEqual(validateJob({ ...job(), mode }).pages, []);
  }
  assert.deepEqual(validateJob({ ...job(), mode: 'reconstruct' }).pages, [1]);
  assert.throws(() => validateJob({ ...job(), mode: 'reconstruct', pages: [] }));
  assert.throws(() => validateJob({ ...job(), pages: [], inputs: [{ name: 'drawing.png', mime: 'image/png', url: '/api/runner/jobs/job-12345678/inputs/drawing.png' }] }));
  for (const pages of [null, false, '', [1, 2, 3, 4, 5], [-1], [1.5]]) assert.throws(() => validateJob({ ...job(), pages }));
});

test('invalid leased jobs report failure with a valid identity and never make a model request', async () => {
  const calls = [];
  const result = await runLeasedJob({ ...job(), limits: { ...job().limits, maxSteps: 0 } }, { origin: 'http://127.0.0.1:4310', runnerId: 'test', signal: new AbortController().signal, request: async (path, options) => { calls.push({ path, options }); return Response.json({ ok: true }); } });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INVALID_LEASED_JOB');
  assert.equal(result.completionReported, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/runner/jobs/${job().id}/complete`);
  assert.equal(calls[0].options.json.success, false);
  assert.equal(calls[0].options.job.leaseToken, job().leaseToken);
  assert.ok(!JSON.stringify(calls[0].options.json).includes(job().leaseToken));
});

test('public values remove keys and paths, events omit provider internals', () => {
  const data = publicValue({ apiKey: 'hidden', text: '/Users/admin/project/data/runs/id/result.json token-12345678 sk-or-v1-aaaaaaaaaaaaaaaa', trace: '/trace' }, { projectRoot: '/Users/admin/project', secrets: ['token-12345678'] });
  assert.equal(data.apiKey, undefined);
  assert.equal(data.trace, undefined);
  assert.equal(data.text, 'data/runs/id/result.json [REDACTED] [REDACTED]');
  assert.equal(publicEvent({ type: 'provider/request', data: { secret: 'x' } }), null);
  assert.equal(publicEvent({ type: 'tool/call', data: { toolUseId: 'same-id', name: 'industrial_search_catalog' } }).data.toolUseId, 'same-id');
});

test('custom image results reuse only identical session input pixels and reject unattached images clearly', () => {
  const image = { path: 'data/uploads/job/image.jpg', sha256: 'a'.repeat(64), bytes: 61616, mime: 'image/jpeg' };
  const payload = { name: 'industrial_read_input', args: { path: image.path }, result: { isError: false, content: [{ type: 'text', text: 'File read.' }, { type: 'image', ref: { sha256: image.sha256, size: image.bytes, mime: image.mime }, mime: image.mime }], structured: { path: image.path, bytes: image.bytes, mime: image.mime } } };
  const reused = sessionInlineImageResult(payload, [image]).result;
  assert.equal(reused.isError, false);
  assert.equal(JSON.parse(reused.content[0].text).verifiedSameBytes, true);
  assert.equal(JSON.parse(reused.content[0].text).source, 'inline_session_image');
  assert.equal(reused.structured, undefined);
  assert.ok(reused.content.every(block => block.type === 'text'));
  const absent = sessionInlineImageResult(payload, []).result;
  assert.equal(absent.isError, true);
  assert.equal(absent.details.code, 'IMAGE_NOT_ATTACHED');
  assert.equal(absent.details.pixelsPresented, false);
  const changed = sessionInlineImageResult({ ...payload, result: { ...payload.result, content: [{ type: 'image', ref: { sha256: 'b'.repeat(64), size: image.bytes }, mime: image.mime }] } }, [image]).result;
  assert.equal(changed.isError, true);
  assert.deepEqual(sessionInlineImageResult({ ...payload, name: 'industrial_geometry' }, [image]), {});
});

test('runner tokens require private regular files', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'cloud-token-test-'));
  try {
    const path = resolve(root, 'token');
    await writeFile(path, 'test-only-token-123456789012345', { mode: 0o600 });
    await setPrivatePermissions(path);
    assert.equal(await readRunnerToken({ RUNNER_TOKEN_FILE: path }), 'test-only-token-123456789012345');
    await writeFile(resolve(root, 'public'), 'test-only-token-123456789012345', { mode: 0o644 });
    await assert.rejects(readRunnerToken({ RUNNER_TOKEN_FILE: resolve(root, 'public') }));
    await symlink(path, resolve(root, 'link'));
    await assert.rejects(readRunnerToken({ RUNNER_TOKEN_FILE: resolve(root, 'link') }));
    await assert.rejects(readRunnerToken({ RUNNER_TOKEN: 'short' }));
    await assert.rejects(readRunnerToken({ RUNNER_TOKEN: 'x'.repeat(513) }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed local runner reads its private token and exits promptly during an idle request', { timeout: 10000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'cloud-managed-test-'));
  const path = resolve(root, 'token');
  const token = 'test-managed-token-123456789012345';
  await writeFile(path, token, { mode: 0o600 });
  await setPrivatePermissions(path);
  let acknowledge;
  const started = new Promise(done => { acknowledge = done; });
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url, '/api/runner/heartbeat');
    acknowledge();
    // Deliberately leave the response pending. SIGTERM must abort fetch, not wait 45 seconds.
    request.on('close', () => response.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cloud-runner.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...runtimeEnvironment(), SITE_ORIGIN: `http://127.0.0.1:${server.address().port}`, CLOUD_RUNNER_ALLOW_LOOPBACK: '1', RUNNER_TOKEN_FILE: path } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    await Promise.race([started, once(child, 'exit').then(() => { throw new Error('Runner exited before contacting the local test server.'); })]);
    const finished = once(child, 'exit');
    const before = Date.now(); child.kill('SIGTERM');
    const [code] = await finished;
    if (process.platform !== 'win32') assert.equal(code, 0); // Windows SIGTERM terminates the process at OS level.
    assert.ok(Date.now() - before < 3000);
    assert.ok(!output.includes(token));
  } finally { child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); }
});

test('guard blocks shell, unrelated uploads, symlink escapes, old runs and path comparisons', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'cloud-guard-test-'));
  const uploadRoot = resolve(root, 'data/uploads/cloud-job');
  const ownRun = resolve(root, 'data/runs/own-run');
  const otherRun = resolve(root, 'data/runs/other-run');
  await Promise.all([uploadRoot, ownRun, otherRun].map(path => mkdir(path, { recursive: true })));
  await Promise.all([resolve(uploadRoot, 'image.png'), resolve(ownRun, 'report.json'), resolve(otherRun, 'private.json')].map(path => writeFile(path, '{}')));
  const runRegistry = resolve(root, 'runs.json');
  await writeFile(runRegistry, JSON.stringify(['own-run']));
  const policy = { root, uploadRoot, runRegistry };
  try {
    assert.equal((await checkCloudTool({ name: 'shell', args: { command: 'echo no' } }, policy)).allow, false);
    assert.equal((await checkCloudTool({ name: 'industrial_read_input', args: { path: 'data/uploads/cloud-job/image.png' } }, policy)).allow, true);
    assert.equal((await checkCloudTool({ name: 'industrial_read_input', args: { path: 'data/runs/own-run/report.json' } }, policy)).allow, true);
    assert.equal((await checkCloudTool({ name: 'industrial_read_input', args: { path: 'data/runs/other-run/private.json' } }, policy)).allow, false);
    await symlink(resolve(otherRun, 'private.json'), resolve(uploadRoot, 'escape.json'));
    assert.equal((await checkCloudTool({ name: 'industrial_read_input', args: { path: 'data/uploads/cloud-job/escape.json' } }, policy)).allow, false);
    assert.equal((await checkCloudTool({ name: 'industrial_geometry', args: { operation: 'compare_views', input: { source: { path: 'data/uploads/cloud-job/image.png' }, projection: { path: 'data/runs/other-run/private.json' } } } }, policy)).allow, false);
    await assert.rejects(safeArtifact(resolve(uploadRoot, 'escape.json'), [uploadRoot]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner credentials never go to cross-origin or non-runner routes', async () => {
  const calls = [];
  const request = runnerClient('https://site.example', 'test-only-master-token', async (...args) => { calls.push(args); return new Response('{}'); });
  await assert.rejects(request('https://evil.example/api/runner/lease'));
  await assert.rejects(request('/api/settings'));
  await request('/api/runner/lease', { json: { runnerId: 'test' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.authorization, 'Bearer test-only-master-token');
  assert.equal(calls[0][1].redirect, 'error');
});

test('local bridge exposes only catalogue, review, bounded CAD and records actual run IDs', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'cloud-api-test-'));
  const policy = { root, uploadRoot: resolve(root, 'data/uploads/test'), runRegistry: resolve(root, 'runs.json') };
  const calls = [];
  const bridge = await startCloudLocalApi({ upstream: 'http://127.0.0.1:4310', policy, signal: new AbortController().signal, fetchImpl: async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify({ success: true, runId: 'run-12345678' }), { status: 200 }); } });
  try {
    assert.equal((await fetch(bridge.origin + '/api/settings')).status, 404);
    const post = input => fetch(bridge.origin + '/api/geometry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal((await post({ operation: 'import', input: { path: '/etc/passwd' } })).status, 422);
    assert.equal((await post({ operation: 'build', input: { sourcePath: '/etc/passwd' } })).status, 422);
    assert.equal(calls.length, 0);
    assert.equal((await post({ operation: 'build', input: { features: [] } })).status, 200);
    assert.equal(calls.length, 1);
    assert.ok(bridge.runs.has('run-12345678'));
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});
