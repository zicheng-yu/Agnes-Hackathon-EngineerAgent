#!/usr/bin/env node
import { portablePath } from '../../server/paths.mjs';
import { runtimeEnvironment } from '../../server/runtime-environment.mjs';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integration, projectRoot, runtime } from './common.mjs';
import { artifactMime, isWithin, publicValue, readRunnerToken, safeArtifact, siteOrigin, validateJob } from './cloud-runner-protocol.mjs';

const exec = promisify(execFile);
export function runnerClient(origin, token, fetchImpl = fetch) {
  return async (path, { job, method = 'POST', json, bytes, contentType, signal } = {}) => {
    const target = new URL(path, origin);
    if (target.origin !== origin || !target.pathname.startsWith('/api/runner/')) throw new Error('Runner requests must stay on the configured Site runner API.');
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
    const response = await fetchImpl(target, { method, redirect: 'error', signal: requestSignal, headers: { authorization: `Bearer ${token}`, ...(job ? { 'X-Job-Lease': job.leaseToken } : {}), ...(contentType || json ? { 'content-type': contentType || 'application/json' } : {}) }, ...(json ? { body: JSON.stringify(json) } : bytes ? { body: bytes } : {}) });
    if (!response.ok) throw new Error(`Runner API HTTP ${response.status}.`);
    return response;
  };
}

export async function prepareInputs(job, request, uploadRoot, signal) {
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const prepared = [];
  for (const [index, input] of job.inputs.entries()) {
    const directory = resolve(uploadRoot, `input-${index}`);
    await mkdir(directory, { mode: 0o700 });
    const source = resolve(directory, `source${extname(input.name).toLowerCase()}`);
    const expectedPrefix = `/api/runner/jobs/${encodeURIComponent(job.id)}/inputs/`;
    if (!new URL(input.url, 'https://placeholder.invalid').pathname.startsWith(expectedPrefix)) throw new Error('Input URL must belong to this job.');
    const response = await request(input.url, { job, method: 'GET', signal });
    const announced = Number(response.headers.get('content-length'));
    if (announced > 12 * 1024 * 1024) throw new Error('Input exceeds 12 MiB.');
    const chunks = []; let count = 0;
    for await (const chunk of response.body) { count += chunk.length; if (count > 12 * 1024 * 1024) throw new Error('Input exceeds 12 MiB.'); chunks.push(chunk); }
    if (!count) throw new Error('Input is empty.');
    await writeFile(source, Buffer.concat(chunks), { mode: 0o600 });
    if (input.mime === 'text/plain') {
      if (count > 200000) throw new Error('Text input exceeds 200 kB.');
      prepared.push({ name: input.name, localName: portablePath(relative(uploadRoot, source)), mime: input.mime });
    } else {
      const { stdout } = await exec(resolve(projectRoot, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'), [resolve(integration, 'cloud-prepare-vision.py'), source, JSON.stringify(job.pages || [1])], { timeout: 60000, maxBuffer: 1024 * 1024, signal });
      const images = JSON.parse(stdout).images;
      for (const image of images) {
        const actual = await realpath(image);
        if (!isWithin(directory, actual)) throw new Error('Prepared image escaped its input directory.');
        prepared.push({ name: `${input.name} / ${prepared.length + 1}`, localName: portablePath(relative(uploadRoot, actual)), mime: 'image/jpeg' });
      }
    }
    if (prepared.length > 4) throw new Error('At most four prepared drawing images/files are allowed per task.');
  }
  return prepared;
}

async function publishArtifacts(summary, job, request, safeOptions) {
  const roots = [];
  const files = [];
  for (const id of summary.runIds || []) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) continue;
    const root = await realpath(resolve(projectRoot, 'data/runs', id));
    if (!isWithin(await realpath(resolve(projectRoot, 'data/runs')), root)) continue;
    roots.push(root);
    const collect = async (directory, depth = 0) => {
      if (depth > 2) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await collect(resolve(directory, entry.name), depth + 1);
        else if (entry.isFile() && artifactMime[extname(entry.name).toLowerCase()] && entry.name !== 'input.json') files.push({ file: resolve(directory, entry.name), root, id });
      }
    };
    await collect(root);
  }
  if (files.length > 96) throw new Error('Too many generated artifacts.');
  // First publish binary/view assets; report JSON is rewritten to these returned URLs afterward.
  files.sort((a, b) => Number(a.file.endsWith('.json')) - Number(b.file.endsWith('.json')));
  const urlMap = new Map();
  const artifacts = [];
  let total = 0;
  for (const item of files) {
    const artifact = await safeArtifact(item.file, roots);
    total += artifact.bytes.length;
    if (total > 100 * 1024 * 1024) throw new Error('Generated artifacts exceed 100 MiB.');
    const relativeName = portablePath(relative(item.root, item.file));
    const name = `${item.id}__${relativeName.replaceAll('/', '__')}`;
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(name)) throw new Error('Unsafe generated artifact name.');
    const bytes = artifact.mime === 'application/json' ? Buffer.from(JSON.stringify(publicValue(JSON.parse(artifact.bytes), { ...safeOptions, urlMap }))) : artifact.bytes;
    const response = await request(`/api/runner/jobs/${job.id}/artifacts/${name}`, { job, method: 'PUT', bytes, contentType: artifact.mime });
    const uploaded = await response.json();
    if (typeof uploaded.url !== 'string' || !uploaded.url.startsWith('/api/')) throw new Error('Invalid artifact publication receipt.');
    for (const key of [item.file, relative(projectRoot, item.file), `/runs/${item.id}/${relativeName}`]) urlMap.set(key, uploaded.url);
    artifacts.push({ name, url: uploaded.url, mime: artifact.mime, bytes: bytes.length });
  }
  return { artifacts, result: publicValue(summary, { ...safeOptions, urlMap }) };
}

export async function runLeasedJob(jobValue, { origin, request, runnerId, signal }) {
  let job;
  try { job = validateJob(jobValue); }
  catch (failure) {
    const validIdentity = typeof jobValue?.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(jobValue.id)
      && typeof jobValue.leaseToken === 'string' && jobValue.leaseToken.length >= 24 && jobValue.leaseToken.length <= 512 && !/\s/.test(jobValue.leaseToken);
    const error = { code: 'INVALID_LEASED_JOB', message: publicValue(String(failure.message), { secrets: [jobValue?.leaseToken] }) };
    let completionReported = false;
    // The queue already reserved this task. Even invalid lease payloads must release that
    // reservation through the authenticated terminal endpoint instead of silently timing out.
    if (validIdentity) for (let attempt = 0; attempt < 3; attempt++) {
      try { await request(`/api/runner/jobs/${jobValue.id}/complete`, { job: { id: jobValue.id, leaseToken: jobValue.leaseToken }, json: { success: false, error, artifacts: [] }, signal: AbortSignal.timeout(5000) }); completionReported = true; break; }
      catch { /* Idempotent terminal notification can be retried after a lost response. */ }
    }
    return { ...(validIdentity ? { id: jobValue.id } : {}), success: false, error, completionReported };
  }
  const root = resolve(integration, '.local/cloud-jobs', `${job.id}-${randomUUID()}`);
  const uploadRoot = resolve(projectRoot, 'data/uploads', `cloud-${job.id}`);
  const cancellation = new AbortController();
  const active = AbortSignal.any([signal, cancellation.signal, AbortSignal.timeout(job.limits.timeoutMs + 120000)]);
  const safeOptions = { projectRoot, secrets: [job.leaseToken] };
  let child, heartbeat, summary, eventQueue = [], sequence = 0, pumping = Promise.resolve();
  const sendEvents = () => {
    const batch = eventQueue.splice(0, 8);
    if (!batch.length) return;
    pumping = pumping.then(async () => {
      const payload = { events: batch };
      for (let attempt = 0; attempt < 3; attempt++) try { await request(`/api/runner/jobs/${job.id}/events`, { job, json: payload, signal: active }); return; } catch { if (active.aborted || attempt === 2) { cancellation.abort(); throw new Error('Execution events could not be delivered.'); } }
    });
    pumping.catch(() => {});
  };
  const cancel = () => { child?.kill('SIGTERM'); };
  active.addEventListener('abort', cancel, { once: true });
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const preparedInputs = await prepareInputs(job, request, uploadRoot, active);
    active.throwIfAborted();
    const { leaseToken: omitted, ...publicJob } = job;
    await writeFile(resolve(root, 'job.json'), JSON.stringify({ ...publicJob, preparedInputs }), { mode: 0o600 });
    child = spawn(process.execPath, ['--import', pathToFileURL(resolve(runtime, 'node_modules/tsx/dist/loader.mjs')).href, resolve(integration, 'cloud-job-worker.mjs')], {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...runtimeEnvironment(), SITE_ORIGIN: origin, AGH_CLOUD_JOB_DIR: root, AGH_CLOUD_LEASE_TOKEN: job.leaseToken, AGH_INDUSTRIAL_API: process.env.AGH_INDUSTRIAL_API || 'http://127.0.0.1:4310', ...(process.env.CLOUD_RUNNER_ALLOW_LOOPBACK === '1' ? { CLOUD_RUNNER_ALLOW_LOOPBACK: '1' } : {}) },
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.length > 1024 * 1024) { cancellation.abort(); return; }
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'agh_event' || entry.type === 'session') { eventQueue.push({ sequence: ++sequence, ...entry }); sendEvents(); }
      } catch { /* Raw library stdout is never sent to the public website. */ }
    });
    child.stderr.on('data', () => {}); // Provider/daemon diagnostics remain private; no key-bearing raw logs.
    let heartbeatBusy = false;
    heartbeat = setInterval(async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try { const response = await request(`/api/runner/jobs/${job.id}/heartbeat`, { job, json: { runnerId }, signal: active }); if ((await response.json()).cancelled) cancellation.abort(); }
      catch { cancellation.abort(); }
      finally { heartbeatBusy = false; }
    }, 5000);
    const killAfterAbort = () => { const timeout = setTimeout(() => child?.kill('SIGKILL'), 20000); timeout.unref(); };
    active.addEventListener('abort', killAfterAbort, { once: true });
    await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    active.removeEventListener('abort', killAfterAbort);
    clearInterval(heartbeat);
    while (eventQueue.length) sendEvents();
    await pumping;
    active.throwIfAborted();
    summary = JSON.parse(await readFile(resolve(root, 'result.json'), 'utf8'));
    const publication = await publishArtifacts(summary, job, request, safeOptions);
    if (active.aborted) { publication.result.success = false; publication.result.error ||= { code: 'TASK_CANCELLED', message: 'Task was cancelled or timed out.' }; }
    await request(`/api/runner/jobs/${job.id}/complete`, { job, json: { success: publication.result.success, result: publication.result, error: publication.result.error, artifacts: publication.artifacts } });
    return { id: job.id, success: publication.result.success };
  } catch (failure) {
    child?.kill('SIGTERM');
    const error = { code: active.aborted ? 'TASK_CANCELLED_OR_TIMED_OUT' : 'RUNNER_FAILED', message: publicValue(String(failure.message).slice(0, 600), safeOptions) };
    await request(`/api/runner/jobs/${job.id}/complete`, { job, json: { success: false, error, artifacts: [] }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    return { id: job.id, success: false, error };
  } finally {
    clearInterval(heartbeat); active.removeEventListener('abort', cancel);
    await exec(process.execPath, ['--import', pathToFileURL(resolve(runtime, 'node_modules/tsx/dist/loader.mjs')).href, resolve(integration, 'cloud-stop-job.mjs'), root], { cwd: projectRoot, timeout: 15000, maxBuffer: 4096, env: runtimeEnvironment() }).catch(() => {});
  }
}

export async function main(env = process.env) {
  const origin = siteOrigin(env.SITE_ORIGIN, env.CLOUD_RUNNER_ALLOW_LOOPBACK === '1');
  const token = await readRunnerToken(env);
  const runnerId = env.RUNNER_ID || 'engineeragent-local';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runnerId)) throw new Error('Invalid RUNNER_ID.');
  const request = runnerClient(origin, token);
  const cancellation = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cancellation.abort());
  console.log(JSON.stringify({ type: 'runner_started', origin, runnerId, requiresComputerOnline: true }));
  while (!cancellation.signal.aborted) {
    try {
      await request('/api/runner/heartbeat', { json: { runnerId, status: 'idle' }, signal: cancellation.signal });
      const response = await request('/api/runner/lease', { json: { runnerId }, signal: cancellation.signal });
      const { job } = await response.json();
      if (job) console.log(JSON.stringify(await runLeasedJob(job, { origin, request, runnerId, signal: cancellation.signal })));
    } catch { if (!cancellation.signal.aborted) console.log(JSON.stringify({ type: 'runner_connection_retry', message: 'Task queue unavailable; no new task was executed.' })); }
    if (env.CLOUD_RUNNER_ONCE === '1' || cancellation.signal.aborted) break;
    await new Promise(done => {
      const finish = () => { clearTimeout(timer); cancellation.signal.removeEventListener('abort', finish); done(); };
      const timer = setTimeout(finish, 3000);
      cancellation.signal.addEventListener('abort', finish, { once: true });
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Set SITE_ORIGIN and RUNNER_TOKEN (or a private RUNNER_TOKEN_FILE), then run node integrations/agh/cloud-runner.mjs. Keep the local app on 127.0.0.1:4310. No upstream provider API key is read by this runner. SIGTERM stops polling and cancels the active task.');
  else main().catch(() => { console.error('Cloud runner configuration/startup failed. No credentials were logged.'); process.exitCode = 1; });
}
