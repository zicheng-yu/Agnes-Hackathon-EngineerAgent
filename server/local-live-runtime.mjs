import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle as workerHandle } from './live-runtime/worker-api.mjs';
import { setPrivatePermissions } from './private-permissions.mjs';
import { historyPage } from './task-history.mjs';

const schemaPath = fileURLToPath(new URL('./live-runtime/schema.sql', import.meta.url));
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const privateMode = 0o600;

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Local runtime directory must be a real directory.');
  await setPrivatePermissions(path, true);
}

async function privateFile(path, data) {
  const handle = await open(path, 'wx', privateMode);
  try { await setPrivatePermissions(path); await handle.writeFile(data); } finally { await handle.close(); }
}

/** Small D1-compatible adapter backed by Node's built-in SQLite. */
export function createSqliteD1(sqlite) {
  return {
    prepare(sql) {
      let parameters = [];
      const statement = {
        bind(...values) { parameters = values; return statement; },
        execute(kind) {
          const query = sqlite.prepare(sql);
          if (kind === 'first') return query.get(...parameters) ?? null;
          if (kind === 'all') return { success: true, results: query.all(...parameters) };
          const result = query.run(...parameters);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
        async first(column) { const row = statement.execute('first'); return column ? row?.[column] ?? null : row; },
        async all() { return statement.execute('all'); },
        async run() { return statement.execute('run'); },
      };
      return statement;
    },
    // Execute synchronously inside this transaction; awaiting each statement
    // would let unrelated HTTP handlers accidentally share the transaction.
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map((statement) => statement.execute('run')); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

/** R2-compatible private objects. Object keys cannot escape or follow symlinks. */
export async function createFileBucket(directory) {
  const requestedRoot = resolve(directory);
  await privateDirectory(requestedRoot);
  // Resolve platform aliases such as macOS /var -> /private/var once. Object
  // paths themselves are still forbidden from following symlinks below here.
  const root = await realpath(requestedRoot);
  async function pathFor(key, create = false) {
    if (typeof key !== 'string' || key.length > 700 || key.startsWith('/') || key.includes('\\')) throw new Error('Invalid object key.');
    const parts = key.split('/');
    if (!parts.length || parts.length > 14 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,200}$/.test(part) || part === '.' || part === '..')) throw new Error('Invalid object key.');
    const target = resolve(root, ...parts);
    if (!within(root, target)) throw new Error('Object key is outside storage.');
    let current = root;
    for (const segment of parts.slice(0, -1)) {
      current = join(current, segment);
      try {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Object parent is not a private directory.');
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await privateDirectory(current);
      }
    }
    try { const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Object is not a regular private file.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  }
  return {
    async put(key, value) {
      const target = await pathFor(key, true);
      const temporary = join(dirname(target), `.write-${randomBytes(16).toString('hex')}`);
      const bytes = typeof value === 'string' ? Buffer.from(value) : value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value);
      try { await privateFile(temporary, bytes); await rename(temporary, target); await setPrivatePermissions(target); }
      finally { await unlink(temporary).catch(() => {}); }
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      let target;
      try { target = await pathFor(key); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
      let handle;
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        const bytes = await handle.readFile();
        return { key, size: bytes.byteLength, body: new Uint8Array(bytes), text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      finally { await handle?.close(); }
    },
    async delete(key) { const target = await pathFor(key); await unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error; }); },
  };
}

async function loadSecrets(directory) {
  const path = join(directory, 'secrets.json');
  try { await privateFile(path, JSON.stringify({ runnerToken: randomBytes(32).toString('hex'), sessionSecret: randomBytes(32).toString('hex') })); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Runtime secrets must be a regular private file.');
  await setPrivatePermissions(path);
  const secrets = JSON.parse(await readFile(path, 'utf8'));
  if (![secrets.runnerToken, secrets.sessionSecret].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new Error('Runtime secrets file is invalid; do not reset an existing billing ledger.');
  const runnerTokenPath = join(directory, 'runner-token.txt');
  try { await privateFile(runnerTokenPath, secrets.runnerToken + '\n'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const tokenStat = await lstat(runnerTokenPath);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) throw new Error('Runner token must be a private regular file.');
    await setPrivatePermissions(runnerTokenPath);
    if ((await readFile(runnerTokenPath, 'utf8')).trim() !== secrets.runnerToken) throw new Error('Runtime runner token files disagree.');
  }
  return { ...secrets, runnerTokenPath };
}

function eligible(settings) { return settings?.providerId === 'openrouter'; }
function enabled(settings) { return eligible(settings) && settings.usageEnabled === true && typeof settings.apiKey === 'string' && settings.apiKey.trim().length > 0; }
function intercepted(req) {
  const path = (req.path || req.url.split('?')[0]).replace(/\/$/, '');
  if (path === '/api/tasks' && req.method === 'POST' && req.body?.mode === 'geometry') return false;
  return /^\/api\/(?:health|usage|documents(?:\/.*)?|tasks(?:\/.*)?|runner\/.*)$/.test(path);
}

/**
 * Await the factory once, mount handle before the existing API routes, and call
 * startRunner after app.listen. Only OpenRouter settings select this adapter.
 * providerFetch/spawnRunner are injected only by offline tests.
 */
export async function createLocalLiveRuntime({ root, getSettings, port = 4310, providerFetch, spawnRunner = spawn, resolveModel }) {
  if (typeof getSettings !== 'function') throw new Error('getSettings is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port.');
  const projectRoot = await realpath(resolve(root));
  const directory = join(projectRoot, 'data', 'live-runtime');
  await privateDirectory(join(projectRoot, 'data'));
  await privateDirectory(directory);
  if (await realpath(directory) !== directory) throw new Error('Runtime storage must not follow a symlink.');
  const secrets = await loadSecrets(directory);
  const databasePath = join(directory, 'budget.sqlite');
  try { await privateFile(databasePath, ''); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const databaseStat = await lstat(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('Budget ledger must be a regular private file.');
  await setPrivatePermissions(databasePath);
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  sqlite.exec(await readFile(schemaPath, 'utf8'));
  if (!sqlite.prepare('PRAGMA table_info(trial_tasks)').all().some(column => column.name === 'model_json')) sqlite.exec('ALTER TABLE trial_tasks ADD COLUMN model_json TEXT');
  const DB = createSqliteD1(sqlite), BUCKET = await createFileBucket(join(directory, 'objects'));
  const background = new Set(), inFlight = new Set();
  const shutdown = new AbortController();
  let child = null, stopping = false, stopPromise = null, lastSpawnMs = 0;
  const origin = `http://127.0.0.1:${port}`;

  async function legacyTaskExists(path) {
    const match = /^\/api\/tasks\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(path);
    if (!match) return false;
    try { const info = await lstat(join(projectRoot, 'data/tasks', `${match[1]}.json`)); return info.isFile() && !info.isSymbolicLink(); }
    catch { return false; }
  }

  async function legacyTasks() {
    const directory = join(projectRoot, 'data/tasks');
    try {
      const files = (await readdir(directory)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name)).slice(-200);
      const tasks = await Promise.all(files.map(async (name) => {
        try { const path = join(directory, name), info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) return null; const task = JSON.parse(await readFile(path, 'utf8')); return task && typeof task.id === 'string' ? task : null; }
        catch { return null; }
      }));
      return tasks.filter(Boolean);
    } catch { return []; }
  }

  async function stopRunner() {
    const current = child;
    if (!current) return;
    child = null;
    if (current.exitCode !== null || current.signalCode !== null) return;
    await new Promise((done) => {
      const hard = setTimeout(() => current.kill('SIGKILL'), 40000);
      const release = setTimeout(done, 45000);
      current.once('exit', () => { clearTimeout(hard); clearTimeout(release); done(); });
      current.kill('SIGTERM');
    });
  }

  async function maybeStart(settings, explicit = false) {
    if (stopping) return false;
    if (!enabled(settings)) { await stopRunner(); return false; }
    if (child && child.exitCode === null && child.signalCode === null) return true;
    if (!explicit && Date.now() - lastSpawnMs < 5000) return false;
    lastSpawnMs = Date.now();
    const runnerPath = join(projectRoot, 'integrations', 'agh', 'cloud-runner.mjs');
    const runnerEnv = {
      PATH: process.env.PATH || '', TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8',
      SITE_ORIGIN: origin, CLOUD_RUNNER_ALLOW_LOOPBACK: '1', RUNNER_TOKEN_FILE: secrets.runnerTokenPath,
      RUNNER_ID: 'engineeragent-local', AGH_INDUSTRIAL_API: origin,
    };
    const running = spawnRunner(process.execPath, [runnerPath], { cwd: projectRoot, env: runnerEnv, stdio: ['ignore', 'ignore', 'ignore'] });
    child = running;
    running.once('exit', () => { if (child === running) child = null; });
    running.once('error', () => { if (child === running) child = null; });
    return true;
  }

  function track(promise) { background.add(promise); promise.finally(() => background.delete(promise)).catch(() => {}); }

  async function middleware(req, res, next) {
    if (!intercepted(req)) return next();
    try {
      const settings = await getSettings();
      if (!eligible(settings)) { await stopRunner(); return next(); }
      const path = (req.path || req.url.split('?')[0]).replace(/\/$/, '');
      if ((req.method === 'GET' || (req.method === 'POST' && path.endsWith('/cancel'))) && await legacyTaskExists(path)) return next();
      if (stopping && (!path.startsWith('/api/runner/') || path.includes('/model/'))) return res.status(503).json({ error: 'LOCAL_RUNTIME_STOPPING' });
      // This also works when mounted ahead of express.json: preserve the
      // existing deterministic geometry endpoint instead of consuming it.
      if (path === '/api/tasks' && req.method === 'POST' && req.body === undefined && req.headers['content-type']?.includes('application/json')) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' }); chunks.push(chunk); }
        try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return res.status(400).json({ error: 'INVALID_JSON' }); }
        if (req.body?.mode === 'geometry') return next();
      }
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return res.status(403).json({ error: 'LOOPBACK_HOST_REQUIRED' });
      await maybeStart(settings);
      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) requestHeaders.append(key, item);
        else if (typeof value === 'string') requestHeaders.set(key, value);
      }
      const init = { method: req.method, headers: requestHeaders };
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.body !== undefined) {
          init.body = Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
          requestHeaders.delete('content-length');
        } else if (!req.readableEnded) { init.body = req; init.duplex = 'half'; }
      }
      const request = new Request(`http://${host}${req.originalUrl || req.url}`, init);
      let modelInfo = settings.modelInfo;
      if (path === '/api/tasks' && req.method === 'POST' && resolveModel) {
        try { modelInfo = await resolveModel(settings.model || 'minimax/minimax-m3'); }
        catch(error) { return res.status(422).json({error:'MODEL_NOT_ELIGIBLE',message:error.message}); }
      }
      const env = { DB, BUCKET, LOCAL_MODE: '1', SESSION_SECRET: secrets.sessionSecret, RUNNER_TOKEN: secrets.runnerToken,
        ...(modelInfo ? { MODEL_INFO: modelInfo } : {}),
        OPENROUTER_API_KEY: enabled(settings) ? settings.apiKey : '', PUBLIC_TRIAL_ENABLED: enabled(settings) ? '1' : '0',
        PROVIDER_FETCH: (url, options = {}) => (providerFetch || fetch)(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal }) };
      const response = await workerHandle(request, env, { waitUntil: track });
      const pathname = new URL(request.url).pathname;
      let output = response;
      if (pathname === '/api/health' && response.ok) {
        output = new Response(JSON.stringify({ ...await response.json(), publicTrial: false, metered: true, localMode: true, providerId:'openrouter',billingMode:'managed',visionEnabled:modelInfo?.input?.includes('image') ?? settings.visionEnabled ?? true }), { status: response.status, headers: response.headers });
      } else if (pathname === '/api/tasks' && req.method === 'GET' && response.ok) {
        const tasks = await response.json();
        const merged = [...tasks, ...await legacyTasks()].filter((task, index, all) => all.findIndex((other) => other.id === task.id) === index)
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        output = new Response(JSON.stringify(req.query?.summary === '1' ? historyPage(merged,req.query) : merged), { status: response.status, headers: response.headers });
      }
      res.statusCode = output.status;
      for (const [key, value] of output.headers) {
        // Secure cookies require HTTPS except browser-specific localhost cases.
        // The local server is bound to loopback, so use a host-only HTTP cookie.
        res.setHeader(key, key.toLowerCase() === 'set-cookie' ? value.replace(/;\s*Secure\b/ig, '') : value);
      }
      if (output.body) {
        for await (const chunk of output.body) {
          if (res.destroyed) break;
          if (!res.write(Buffer.from(chunk))) await new Promise((done) => { res.once('drain', done); res.once('close', done); });
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'LOCAL_RUNTIME_ERROR', message: '本地计费工作台暂时不可用。' });
      else res.end();
    }
  }

  return {
    async hasActiveJobs() { return Boolean(sqlite.prepare("SELECT 1 FROM budget_tasks WHERE state<>'closed' LIMIT 1").get()); },
    handle(req, res, next) {
      const promise = middleware(req, res, next);
      inFlight.add(promise); promise.finally(() => inFlight.delete(promise)).catch(() => {});
      return promise;
    },
    async startRunner() { return maybeStart(await getSettings(), true); },
    async stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      shutdown.abort();
      stopPromise = (async () => { await stopRunner(); await Promise.allSettled([...inFlight]); await Promise.allSettled([...background]); sqlite.close(); })();
      return stopPromise;
    },
  };
}
