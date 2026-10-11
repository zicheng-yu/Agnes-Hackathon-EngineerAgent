import { BudgetError, cancelUnsentRequest, closeTask, getBudgetSummary, getTaskBudget } from './budget.mjs';
import { MODEL_ID, MODEL_INFO, proxyModel, reconcileOutstanding } from './model-proxy.mjs';
import { HttpError, clean, equalSecret, fail, hash, id, json, limitedBytes, readJson, runnerAuth, safeName, sameOrigin, visitor } from './worker-security.mjs';

const MiB = 1024 * 1024;
const modes = new Set(['reconstruct', 'order_review', 'catalog_search']);
const inputTypes = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const artifactTypes = { glb: 'model/gltf-binary', step: 'application/step', stp: 'application/step', json: 'application/json', svg: 'image/svg+xml', png: 'image/png' };
const statuses = new Set(['completed', 'failed', 'cancelled']);
const taskTitles = { reconstruct: '图纸重建', order_review: '订单评审', catalog_search: '零件检索' };
const iso = (value) => new Date(value).toISOString();
const parse = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const sqlAll = async (statement) => (await statement.all()).results || [];

async function runnerOnline(env) {
  const record = await env.DB.prepare('SELECT MAX(last_seen_ms) AS last_seen FROM trial_runners').first();
  return Number(record?.last_seen || 0) >= Date.now() - 90000;
}

export async function taskUsage(env, taskId) {
  const budget = await getTaskBudget(env.DB, taskId);
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS requests,
    COALESCE(SUM(prompt_tokens),0) AS input_tokens,COALESCE(SUM(completion_tokens),0) AS output_tokens,
    COUNT(CASE WHEN state IN ('dispatched','unknown') THEN 1 END) AS uncertain,
    COUNT(CASE WHEN state='reserved' THEN 1 END) AS pending
    FROM budget_requests WHERE task_id=? AND state<>'cancelled'`).bind(taskId).first();
  const details = await env.DB.prepare('SELECT COALESCE(SUM(cached_tokens),0) AS cached,COALESCE(SUM(reasoning_tokens),0) AS reasoning FROM trial_model_calls WHERE task_id=?').bind(taskId).first();
  const taskModel = await env.DB.prepare('SELECT model_json FROM trial_tasks WHERE id=?').bind(taskId).first();
  return { billingMode: 'managed', costUsd: (budget?.spent_micros || 0) / 1e6, heldUsd: budget?.state === 'closed' ? 0 : Math.max(0, (budget?.budget_micros || 0) - (budget?.spent_micros || 0)) / 1e6,
    promptTokens: totals.input_tokens, completionTokens: totals.output_tokens, cachedTokens: details.cached, reasoningTokens: details.reasoning,
    requestCount: totals.requests, status: totals.uncertain ? 'unknown' : totals.pending || budget?.state !== 'closed' ? 'pending' : 'settled', model: parse(taskModel?.model_json)?.id || MODEL_ID };
}

async function publicTask(env, task) {
  const rows = await sqlAll(env.DB.prepare('SELECT event_json FROM trial_events WHERE task_id=? ORDER BY sequence LIMIT 300').bind(task.id));
  return { id: task.id, status: task.status, createdAt: iso(task.created_ms), title: task.title, mode: task.mode,
    events: rows.map((row) => parse(row.event_json)).filter(Boolean), ...(task.result_json ? { result: parse(task.result_json, {}) } : {}),
    ...(task.error ? { error: task.error } : {}), usage: await taskUsage(env, task.id) };
}

async function ownedTask(env, taskId, owner) {
  const task = await env.DB.prepare('SELECT * FROM trial_tasks WHERE id=? AND owner_id=?').bind(taskId, owner).first();
  if (!task) fail(404, 'TASK_NOT_FOUND');
  return task;
}

async function leasedJob(request, env, jobId, modelOnly = false) {
  if (!modelOnly) await runnerAuth(request, env);
  const lease = modelOnly ? request.headers.get('authorization')?.replace(/^Bearer /, '') : request.headers.get('x-job-lease');
  if (!lease || lease.length < 24 || lease.length > 512) fail(401, 'JOB_LEASE_REQUIRED');
  const job = await env.DB.prepare('SELECT * FROM trial_tasks WHERE id=?').bind(jobId).first();
  if (!job?.lease_hash || !await equalSecret(await hash(lease), job.lease_hash)) fail(403, 'JOB_LEASE_INVALID');
  if (modelOnly && (job.status !== 'running' || job.cancel_requested || job.lease_expires_ms <= Date.now())) fail(409, 'JOB_NOT_RUNNING');
  return job;
}

async function closeFinishedTaskBudget(env, taskId) {
  // Only a terminal task can release an unsent reservation. A still-running
  // task (including one owned by another server process) is left untouched.
  const task = await env.DB.prepare('SELECT status FROM trial_tasks WHERE id=?').bind(taskId).first();
  if (!task || !statuses.has(task.status)) return;
  const unsent = await sqlAll(env.DB.prepare("SELECT id FROM budget_requests WHERE task_id=? AND state='reserved'").bind(taskId));
  for (const request of unsent) {
    try { await cancelUnsentRequest(env.DB, request.id); }
    catch (error) {
      // markDispatched may have won the race after the SELECT. Its guarded
      // UPDATE prevents us from releasing a request that may have been sent.
      if (error?.code !== 'BUDGET_CANNOT_CANCEL_SENT') throw error;
    }
  }
  await closeTask(env.DB, taskId);
}

async function expireJobs(env) {
  const stale = await sqlAll(env.DB.prepare(`SELECT id FROM trial_tasks WHERE
    (status='running' AND lease_expires_ms<?) OR (status='queued' AND created_ms<?)`).bind(Date.now(), Date.now() - 180000));
  for (const row of stale) {
    const result = await env.DB.prepare("UPDATE trial_tasks SET status='failed',cancel_requested=1,error=?,completed_ms=? WHERE id=? AND status IN ('running','queued')")
      .bind('执行连接超时；已确认费用保留，未知费用等待核账。', Date.now(), row.id).run();
    if (result.meta.changes) await closeFinishedTaskBudget(env, row.id);
  }
  // Recover a restart after the terminal status was persisted but before
  // reservation cleanup. Unknown/dispatched requests remain frozen.
  const unfinished = await sqlAll(env.DB.prepare(`SELECT t.id FROM trial_tasks t JOIN budget_tasks b ON b.id=t.id
    WHERE t.status IN ('completed','failed','cancelled') AND b.state<>'closed'`));
  for (const task of unfinished) await closeFinishedTaskBudget(env, task.id);
}

function fileHeaders(mime, name, size) {
  return { 'content-type': mime, 'content-length': String(size), 'cache-control': 'private, no-store',
    'content-disposition': `${['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'].includes(mime) ? 'inline' : 'attachment'}; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" };
}

async function serveObject(env, key, mime, name) {
  const object = await env.BUCKET.get(key);
  if (!object) fail(404, 'FILE_NOT_FOUND');
  return new Response(object.body, { headers: fileHeaders(mime, name, object.size) });
}

function publicDocument(record) { return { id: record.id, name: record.name, mime: record.mime, url: `/api/documents/${record.id}/file`, pages: [] }; }

async function createDocument(request, env, owner) {
  const bytes = await limitedBytes(request, 12 * MiB + 100000);
  let form;
  try { form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') || '' }, body: bytes }).formData(); } catch { fail(400, 'INVALID_UPLOAD'); }
  const file = form.get('file') || form.get('document');
  if (!file || typeof file.arrayBuffer !== 'function' || !inputTypes[file.type] || file.size < 1 || file.size > 12 * MiB) fail(400, 'UNSUPPORTED_DOCUMENT', '支持 PDF、PNG、JPEG、WebP，每份不超过 12 MiB。');
  const data = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder().decode(data.slice(0, 12));
  const signatureOk = file.type === 'application/pdf' ? head.startsWith('%PDF-') : file.type === 'image/png' ? data[0] === 137 && head.slice(1, 4) === 'PNG' : file.type === 'image/jpeg' ? data[0] === 255 && data[1] === 216 : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
  if (!signatureOk) fail(400, 'DOCUMENT_SIGNATURE_MISMATCH');
  const documentId = id(), key = `private/documents/${owner}/${documentId}${inputTypes[file.type]}`;
  const name = String(file.name || `drawing${inputTypes[file.type]}`).replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 140);
  const created = Date.now();
  await env.DB.prepare('INSERT INTO trial_documents(id,owner_id,name,mime,object_key,bytes,created_ms) VALUES(?,?,?,?,?,?,?)').bind(documentId, owner, name, file.type, key, data.length, created).run();
  try { await env.BUCKET.put(key, data, { httpMetadata: { contentType: file.type } }); }
  catch { await env.DB.prepare('DELETE FROM trial_documents WHERE id=?').bind(documentId).run(); fail(503, 'DOCUMENT_STORAGE_UNAVAILABLE'); }
  return json(publicDocument({ id: documentId, name, mime: file.type }), 201);
}

async function createTask(request, env, owner) {
  if (env.PUBLIC_TRIAL_ENABLED !== '1' && (!env.RUNNER_TOKEN || !await equalSecret(request.headers.get('authorization'), `Bearer ${env.RUNNER_TOKEN}`)))
    fail(503, 'PUBLIC_TRIAL_NOT_OPEN', '公开测试尚未开放。');
  if (!env.OPENROUTER_API_KEY || !await runnerOnline(env)) fail(503, 'RUNNER_OFFLINE', '执行器暂时离线，请稍后再试。');
  await expireJobs(env);
  const body = await readJson(request);
  if (!modes.has(body.mode) || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 60000) fail(400, 'INVALID_TASK');
  let document = null;
  if (body.documentId) { document = await env.DB.prepare('SELECT * FROM trial_documents WHERE id=? AND owner_id=?').bind(body.documentId, owner).first(); if (!document) fail(404, 'DOCUMENT_NOT_FOUND'); }
  const pages = body.pages || (document ? [1] : []);
  if (!Array.isArray(pages) || pages.length > 4 || pages.some((page) => !Number.isInteger(page) || page < 1 || page > 1000)) fail(400, 'INVALID_PAGES');
  const selectedModel = env.MODEL_INFO || MODEL_INFO;
  if (document && !selectedModel.input?.includes('image')) fail(422, 'MODEL_VISION_UNSUPPORTED', '所选模型不支持图片输入。');
  const taskId = id(), created = Date.now(), title = taskTitles[body.mode];
  // SQL trigger inserts budget_tasks in this same transaction and enforces daily quota.
  await env.DB.prepare(`INSERT INTO trial_tasks(id,owner_id,mode,prompt,document_id,pages_json,status,title,created_ms,created_day,model_json)
    VALUES(?,?,?,?,?,?,'queued',?,?,?,?)`).bind(taskId, owner, body.mode, body.instruction.trim(), document?.id || null, JSON.stringify(pages), title, created, iso(created).slice(0, 10), JSON.stringify(selectedModel)).run();
  return json(await publicTask(env, await env.DB.prepare('SELECT * FROM trial_tasks WHERE id=?').bind(taskId).first()), 201);
}

export function normalizeEvent(entry) {
  const event = entry?.type === 'agh_event' ? entry.event : entry;
  if (entry?.type === 'session') return { time: iso(Date.now()), type: 'session', message: 'AGH 已建立任务会话，使用已注册的工业工具。', phase: 'start' };
  if (!event || !['tool/call', 'tool/result', 'assistant/message', 'turn/start', 'turn/end', 'turn/terminal', 'request/error'].includes(event.type)) return null;
  const data = event.data || event.params || {};
  const short = (value, max = 7000) => { const safe = clean(value); return (typeof safe === 'string' ? safe : JSON.stringify(safe ?? '')).slice(0, max); };
  const toolName = typeof data.name === 'string' ? data.name : undefined;
  const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId.slice(0, 120) : undefined;
  if (event.type === 'tool/call') return { time: iso(Date.now()), type: 'tool', phase: 'call', message: `调用工具 ${toolName || ''}`, toolName, toolUseId, input: short(data.args) };
  if (event.type === 'tool/result') return { time: iso(Date.now()), type: data.isError ? 'error' : 'tool', phase: 'result', message: data.isError ? '工具返回问题' : '工具执行完成', toolName, toolUseId, output: short(data.result ?? data.structured ?? data.content) };
  if (event.type === 'assistant/message') {
    const value = data.content ?? data.text ?? data.message;
    const content = Array.isArray(value) ? value.filter((v) => v.type === 'text').map((v) => v.text || '').join('\n') : typeof value === 'string' ? value : '';
    return content ? { time: iso(Date.now()), type: 'assistant', message: short(content, 10000) } : null;
  }
  return { time: iso(Date.now()), type: event.type === 'request/error' ? 'error' : 'status', phase: event.type, message: event.type === 'turn/start' ? 'AGH 正在规划与执行。' : event.type === 'request/error' ? '模型请求遇到问题。' : '本轮 AGH 执行结束。' };
}

async function runnerRoute(request, env, path) {
  const model = /^\/api\/runner\/jobs\/([\w-]+)\/model\/v1\/chat\/completions$/.exec(path);
  if (model && request.method === 'POST') return proxyModel(request, env, await leasedJob(request, env, model[1], true));
  await runnerAuth(request, env);
  if (path === '/api/runner/heartbeat' && request.method === 'POST') {
    const body = await readJson(request, 10000);
    if (!/^[\w-]{1,80}$/.test(body.runnerId || '') || !['idle', 'busy'].includes(body.status)) fail(400, 'INVALID_RUNNER_HEARTBEAT');
    await env.DB.prepare('INSERT INTO trial_runners(id,status,last_seen_ms) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_seen_ms=excluded.last_seen_ms').bind(body.runnerId, body.status, Date.now()).run();
    await expireJobs(env);
    return json({ ok: true });
  }
  if (path === '/api/runner/lease' && request.method === 'POST') {
    const body = await readJson(request, 10000);
    if (!/^[\w-]{1,80}$/.test(body.runnerId || '')) fail(400, 'INVALID_RUNNER');
    await expireJobs(env);
    const leaseToken = `${id()}${id()}`;
    const job = await env.DB.prepare(`UPDATE trial_tasks SET status='running',runner_id=?,lease_hash=?,lease_expires_ms=?,started_ms=?
      WHERE id=(SELECT id FROM trial_tasks WHERE status='queued' AND lease_hash IS NULL ORDER BY created_ms LIMIT 1)
      AND status='queued' AND lease_hash IS NULL RETURNING *`).bind(body.runnerId, await hash(leaseToken), Date.now() + 600000, Date.now()).first();
    if (!job) return json({ job: null });
    const document = job.document_id ? await env.DB.prepare('SELECT * FROM trial_documents WHERE id=?').bind(job.document_id).first() : null;
    const name = document ? `source${inputTypes[document.mime]}` : null;
    const modelInfo = parse(job.model_json, env.MODEL_INFO || MODEL_INFO);
    return json({ job: { id: job.id, mode: job.mode, prompt: job.prompt, inputs: document ? [{ name, mime: document.mime, url: `/api/runner/jobs/${job.id}/inputs/${name}` }] : [], pages: parse(job.pages_json, []), model: modelInfo, limits: { timeoutMs: 600000, maxSteps: job.mode === 'reconstruct' ? 16 : 10, maxOutputTokens: Math.min(8192,modelInfo.maxTokens) }, leaseToken } });
  }
  const match = /^\/api\/runner\/jobs\/([\w-]+)\/(.+)$/.exec(path);
  if (!match) fail(404, 'NOT_FOUND');
  const job = await leasedJob(request, env, match[1]);
  const action = match[2];
  if (action === 'heartbeat' && request.method === 'POST') {
    if (job.runner_id) await env.DB.prepare("UPDATE trial_runners SET status='busy',last_seen_ms=? WHERE id=?").bind(Date.now(), job.runner_id).run();
    return json({ cancelled: Boolean(job.cancel_requested || job.lease_expires_ms <= Date.now() || statuses.has(job.status)) });
  }
  if (action.startsWith('inputs/') && request.method === 'GET') {
    const document = await env.DB.prepare('SELECT * FROM trial_documents WHERE id=? AND owner_id=?').bind(job.document_id, job.owner_id).first();
    if (!document || action !== `inputs/source${inputTypes[document.mime]}`) fail(404, 'INPUT_NOT_FOUND');
    return serveObject(env, document.object_key, document.mime, `source${inputTypes[document.mime]}`);
  }
  if (action === 'events' && request.method === 'POST') {
    const body = await readJson(request, 150000);
    if (!Array.isArray(body.events) || body.events.length > 20) fail(400, 'INVALID_EVENTS');
    const statements = [];
    for (const entry of body.events) {
      if (!Number.isInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > 10000) fail(400, 'INVALID_EVENT_SEQUENCE');
      const normalized = normalizeEvent(entry);
      if (normalized) statements.push(env.DB.prepare('INSERT OR IGNORE INTO trial_events(task_id,sequence,event_json) VALUES(?,?,?)').bind(job.id, entry.sequence, JSON.stringify(normalized)));
    }
    if (statements.length) await env.DB.batch(statements);
    return json({ ok: true });
  }
  if (action.startsWith('artifacts/') && request.method === 'PUT') {
    const name = decodeURIComponent(action.slice(10)), extension = name.split('.').at(-1).toLowerCase(), mime = artifactTypes[extension];
    if (!safeName(name) || !mime) fail(400, 'INVALID_ARTIFACT');
    const bytes = await limitedBytes(request, 25 * MiB);
    if (!bytes.length) fail(400, 'EMPTY_ARTIFACT');
    const key = `private/artifacts/${job.id}/${name}`;
    const prior = await env.DB.prepare('SELECT bytes,object_key FROM trial_artifacts WHERE task_id=? AND name=?').bind(job.id, name).first();
    if (prior) return json({ url: `/api/tasks/${job.id}/artifacts/${encodeURIComponent(name)}` });
    let stored = bytes;
    if (mime === 'application/json') { try { stored = new TextEncoder().encode(JSON.stringify(clean(JSON.parse(new TextDecoder().decode(bytes))))); } catch { fail(400, 'INVALID_ARTIFACT_JSON'); } }
    await env.DB.prepare('INSERT INTO trial_artifacts(task_id,name,mime,bytes,object_key) VALUES(?,?,?,?,?)').bind(job.id, name, mime, stored.length, key).run();
    try { await env.BUCKET.put(key, stored, { httpMetadata: { contentType: mime } }); }
    catch { await env.DB.prepare('DELETE FROM trial_artifacts WHERE task_id=? AND name=?').bind(job.id, name).run(); fail(503, 'ARTIFACT_STORAGE_UNAVAILABLE'); }
    return json({ url: `/api/tasks/${job.id}/artifacts/${encodeURIComponent(name)}` }, 201);
  }
  if (action === 'complete' && request.method === 'POST') {
    const body = await readJson(request, 1 * MiB);
    if (body.result !== undefined && (!body.result || typeof body.result !== 'object' || Array.isArray(body.result))) fail(400, 'INVALID_TASK_RESULT');
    const result = clean(body.result || {});
    delete result.cost; delete result.totalCost;
    const messages = await sqlAll(env.DB.prepare('SELECT event_json FROM trial_events WHERE task_id=? ORDER BY sequence DESC LIMIT 300').bind(job.id));
    const finalAnswer = messages.map((row) => parse(row.event_json)).find((event) => event?.type === 'assistant')?.message;
    if (finalAnswer) result.answer = finalAnswer;
    const verified = await sqlAll(env.DB.prepare('SELECT name,mime,bytes FROM trial_artifacts WHERE task_id=?').bind(job.id));
    result.publishedArtifacts = verified.map((a) => ({ ...a, url: `/api/tasks/${job.id}/artifacts/${encodeURIComponent(a.name)}` }));
    const status = job.cancel_requested ? 'cancelled' : body.success === true ? 'completed' : 'failed';
    const error = body.error ? String(clean(typeof body.error === 'string' ? body.error : body.error.message || '任务执行失败')).slice(0, 1500) : null;
    await env.DB.prepare(`UPDATE trial_tasks SET status=?,result_json=?,error=?,completed_ms=? WHERE id=? AND status IN ('queued','running')`)
      .bind(status, JSON.stringify(result), error, Date.now(), job.id).run();
    await closeFinishedTaskBudget(env, job.id);
    return json({ ok: true, usage: await taskUsage(env, job.id) });
  }
  fail(404, 'NOT_FOUND');
}

export async function handle(request, env, ctx = {}) {
  try {
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if (!path.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404);
    if (!env.DB || !env.BUCKET) fail(503, 'LIVE_STORAGE_NOT_CONFIGURED');
    if (path.startsWith('/api/runner/')) return await runnerRoute(request, env, path);
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED');
    if (request.method === 'POST') sameOrigin(request);
    const owner = await visitor(request, env, path === '/api/health' && request.method === 'GET');
    if (path === '/api/health' && request.method === 'GET') {
      await expireJobs(env);
      return json({ preview: false, publicTrial: true, cad: true, agh: true, modelConfigured: env.PUBLIC_TRIAL_ENABLED === '1' && Boolean(env.OPENROUTER_API_KEY) && await runnerOnline(env), model: env.MODEL_INFO?.id || MODEL_ID, version: 'live-1' }, 200, owner.cookie ? { 'set-cookie': owner.cookie } : {});
    }
    if (path === '/api/usage' && request.method === 'GET') {
      // GET-only reconciliation is safe to repeat and never starts paid generation.
      if (ctx.waitUntil) ctx.waitUntil(reconcileOutstanding(env));
      const budget = await getBudgetSummary(env.DB);
      return json({ currency: 'USD', budgetUsd: budget.total_limit_micros / 1e6, usedUsd: budget.spent_micros / 1e6, heldUsd: budget.reserved_micros / 1e6, remainingUsd: budget.available_micros / 1e6,
        taskLimitUsd: budget.task_limit_micros / 1e6, billingMode:'managed', model: env.MODEL_INFO?.name || 'MiniMax M3', modelId: env.MODEL_INFO?.id || MODEL_ID, runnerOnline: await runnerOnline(env), requests: budget.attempted_requests, uncertain: budget.unknown_reserved_micros > 0, ceilingBreaches: budget.ceiling_breaches });
    }
    if (path === '/api/documents' && request.method === 'POST') return await createDocument(request, env, owner.id);
    const document = /^\/api\/documents\/([\w-]+)(\/file)?$/.exec(path);
    if (document && request.method === 'GET') {
      const record = await env.DB.prepare('SELECT * FROM trial_documents WHERE id=? AND owner_id=?').bind(document[1], owner.id).first();
      if (!record) fail(404, 'DOCUMENT_NOT_FOUND');
      return document[2] ? serveObject(env, record.object_key, record.mime, record.name) : json(publicDocument(record));
    }
    if (path === '/api/tasks' && request.method === 'POST') return await createTask(request, env, owner.id);
    if (path === '/api/tasks' && request.method === 'GET') {
      await expireJobs(env);
      const tasks = await sqlAll(env.DB.prepare('SELECT * FROM trial_tasks WHERE owner_id=? ORDER BY created_ms DESC LIMIT 30').bind(owner.id));
      return json(await Promise.all(tasks.map((task) => publicTask(env, task))));
    }
    const taskMatch = /^\/api\/tasks\/([\w-]+)(?:\/(cancel|artifacts\/(.+)))?$/.exec(path);
    if (taskMatch) {
      await expireJobs(env);
      const task = await ownedTask(env, taskMatch[1], owner.id);
      if (!taskMatch[2] && request.method === 'GET') return json(await publicTask(env, task));
      if (taskMatch[2] === 'cancel' && request.method === 'POST') {
        if (!statuses.has(task.status)) {
          await env.DB.prepare("UPDATE trial_tasks SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE id=? AND status IN ('queued','running')").bind(task.id).run();
          if (task.status === 'queued') await closeFinishedTaskBudget(env, task.id);
        }
        return json(await publicTask(env, await ownedTask(env, task.id, owner.id)));
      }
      if (taskMatch[3] && request.method === 'GET') {
        const name = decodeURIComponent(taskMatch[3]); if (!safeName(name)) fail(404, 'ARTIFACT_NOT_FOUND');
        const artifact = await env.DB.prepare('SELECT * FROM trial_artifacts WHERE task_id=? AND name=?').bind(task.id, name).first();
        if (!artifact) fail(404, 'ARTIFACT_NOT_FOUND');
        return serveObject(env, artifact.object_key, artifact.mime, name);
      }
    }
    fail(404, 'NOT_FOUND');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    const code = error instanceof BudgetError ? error.code : String(error?.message || '').match(/(?:BUDGET|TRIAL)_[A-Z_]+/)?.[0];
    if (code) return json({ error: code, message: ({ BUDGET_BUSY: '已有任务正在执行或等待费用核账，请稍后重试。', BUDGET_TASK_LIMIT: '本次任务的费用余量不足以启动下一次模型调用。', BUDGET_TOTAL_LIMIT: '本次公开测试的 10 美元额度已用完。', TRIAL_DAILY_LIMIT: '每个浏览器每天最多测试 5 个任务。' })[code] || '当前安全额度或执行条件不允许继续请求。' }, 429);
    return json({ error: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }, 500);
  }
}

export default { fetch: handle };
