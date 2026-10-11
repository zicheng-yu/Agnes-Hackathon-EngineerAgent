#!/usr/bin/env node
/** Actual Worker + SQLite budget + AGH + local tools, with a fake OpenRouter fetch only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSqliteD1 } from '../../server/local-live-runtime.mjs';
import { handle } from '../../server/live-runtime/worker-api.mjs';
import { MODEL_ID, TOOL_NAMES } from '../../server/live-runtime/model-proxy.mjs';
import { runnerClient, runLeasedJob } from './cloud-runner.mjs';
import { catalogModel } from '../../server/openrouter-models.mjs';

process.env.CLOUD_RUNNER_ALLOW_LOOPBACK = '1';
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile(new URL('../../server/live-runtime/schema.sql', import.meta.url), 'utf8'));
const DB = createSqliteD1(sqlite);
const token = `offline-runner-${randomUUID()}`;
const id = `gateway-smoke-${randomUUID()}`;
const objects = new Map();
const calls = [];
const imageMode = process.argv.includes('--image');
const alternateModel = process.argv.includes('--alternate-model') ? catalogModel({id:'qwen/offline-contract-model',name:'Offline alternate model',architecture:{input_modalities:['text','image'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:8192},supported_parameters:['tools','tool_choice','max_tokens'],pricing:{prompt:'0.0000003',completion:'0.0000012'}}).modelInfo : null;
let mainCalls = 0;
let receivedBuiltinCatalog = false;
let originalPixels;
let imageRequests = 0;
let confirmedImageReuse = false;
const env = {
  DB, RUNNER_TOKEN: token, OPENROUTER_API_KEY: 'offline-fixture-not-a-provider-key',
  BUCKET: {
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key) { const bytes = objects.get(key); if (bytes === undefined) return null; const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes); return { body: new Response(buffer).body, size: buffer.length, json: async () => JSON.parse(buffer.toString('utf8')) }; },
  },
  async PROVIDER_FETCH(url, options) {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer offline-fixture-not-a-provider-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model,alternateModel?.id || MODEL_ID);
    assert.ok((body.tools || []).length <= 5);
    assert.ok((body.tools || []).every(tool => TOOL_NAMES.includes(tool.function.name)));
    calls.push({ toolNames: (body.tools || []).map(tool => tool.function.name), stream: body.stream });
    const main = Boolean(body.tools?.length);
    if (main) mainCalls++;
    if (main && imageMode) {
      const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []);
      assert.equal(images.length, 1, 'Each actual AGH model request must retain the original drawing pixels.');
      assert.match(images[0], /^data:image\/jpeg;base64,/);
      originalPixels ||= images[0]; assert.equal(images[0], originalPixels); imageRequests++;
      if (mainCalls >= 2) {
        assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('inline_session_image')));
        confirmedImageReuse = true;
      }
    }
    let tool;
    if (main && mainCalls === 1) tool = imageMode ? { name: 'industrial_read_input', arguments: JSON.stringify({ path: `data/uploads/cloud-${id}/input-0/vision-image.jpg` }) } : { name: 'industrial_search_catalog', arguments: JSON.stringify({ query: '法兰', limit: 3 }) };
    if (main && imageMode && mainCalls === 2) tool = { name: 'industrial_geometry', arguments: JSON.stringify({ operation: 'build', input: { id: 'image-transport-fixture', units: 'mm', features: [{ id: 'base', op: 'box', size: [20, 10, 5] }], checks: [{ kind: 'valid', expected: 1 }, { kind: 'solids', expected: 1 }, { kind: 'volume', expected: 1000, tolerance: 0.001 }] } }) };
    return Response.json({ id: `fake-generation-${calls.length}`, model: MODEL_ID, choices: [{ index: 0,
      message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `gateway-tool-${mainCalls}`, type: 'function', function: tool }] } : { role: 'assistant', content: main ? 'Offline transport smoke complete. The tool plan was predefined; no drawing interpretation claim is made.' : '工具链验证' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 20 } });
  },
};
if (imageMode) {
  const bytes = await readFile(new URL('../../assets/evaluation/codex-assisted-EA-V01-20261010/drawing.png', import.meta.url));
  objects.set('offline/drawing.png', bytes);
  sqlite.prepare('INSERT INTO trial_documents(id,owner_id,name,mime,object_key,bytes,created_ms) VALUES(?,?,?,?,?,?,?)').run('offline-drawing', 'offline-owner', 'drawing.png', 'image/png', 'offline/drawing.png', bytes.length, Date.now());
}
sqlite.prepare(`INSERT INTO trial_tasks(id,owner_id,mode,prompt,document_id,pages_json,status,title,created_ms,created_day,model_json)
  VALUES(?,?,?,?,?,?,'queued',?,?,?,?)`).run(id, 'offline-owner', imageMode ? 'reconstruct' : 'catalog_search', imageMode ? 'Offline transport fixture: read the attached drawing and execute the supplied test solid plan.' : '检索法兰并列出编号和用途。', imageMode ? 'offline-drawing' : null, imageMode ? '[1]' : '[]', 'Offline gateway smoke', Date.now(), new Date().toISOString().slice(0, 10), alternateModel ? JSON.stringify(alternateModel) : null);
let origin;
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (incoming.url.endsWith('/model/v1/chat/completions')) {
      const offered = JSON.parse(bytes).tools || [];
      if (offered.some(tool => !TOOL_NAMES.includes(tool.function?.name))) receivedBuiltinCatalog = true;
    }
    const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: bytes }) });
    const response = await handle(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch { outgoing.writeHead(500).end('Offline fixture failure.'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
origin = `http://127.0.0.1:${server.address().port}`;
try {
  const request = runnerClient(origin, token);
  const { job } = await (await request('/api/runner/lease', { json: { runnerId: 'offline-gateway-smoke' } })).json();
  assert.deepEqual(job.pages, imageMode ? [1] : []);
  const result = await runLeasedJob(job, { origin, request, runnerId: 'offline-gateway-smoke', signal: AbortSignal.timeout(180000) });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(receivedBuiltinCatalog, 'The real AGH request must exercise the built-in tool-catalogue boundary.');
  assert.equal(mainCalls, imageMode ? 3 : 2);
  const task = sqlite.prepare('SELECT status,result_json FROM trial_tasks WHERE id=?').get(id);
  assert.equal(task.status, 'completed');
  if (imageMode) {
    const result = JSON.parse(task.result_json);
    assert.ok(result.artifacts.step.startsWith('/api/tasks/'));
    assert.ok(result.publishedArtifacts.some(artifact => artifact.mime === 'model/gltf-binary'));
    assert.equal(imageRequests, 3); assert.equal(confirmedImageReuse, true);
  } else assert.equal(JSON.parse(task.result_json).catalogResults.source, 'local_catalog');
  const rows = sqlite.prepare('SELECT state,actual_micros FROM budget_requests WHERE task_id=?').all(id);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(row => row.state === 'settled' && row.actual_micros === 1000));
  assert.equal(sqlite.prepare('SELECT state FROM budget_tasks WHERE id=?').get(id).state, 'closed');
  console.log(JSON.stringify({ success: true, model:job.model.id, paidProviderCalls: 0, fakeProviderCalls: calls.length, realAghBuiltinCatalogueFiltered: true, realAghIndustrialToolCompleted: true, ...(imageMode ? { originalPixelsOnEveryModelStep: imageRequests, verifiedSameImageRead: confirmedImageReuse, verifiedGeometryAndArtifacts: true } : {}), recordedFixtureCostUsd: rows.length * 0.001 }, null, 2));
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); sqlite.close(); }
