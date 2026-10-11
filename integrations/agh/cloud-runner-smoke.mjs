#!/usr/bin/env node
/** Offline protocol smoke: fake model decisions, real AGH dispatch and real local tools.
 * No paid model and no OpenRouter credentials are involved. The local app must be running. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { runnerClient, runLeasedJob } from './cloud-runner.mjs';

process.env.CLOUD_RUNNER_ALLOW_LOOPBACK = '1';
const token = `offline-master-${randomUUID()}`;
const leaseToken = `offline-lease-${randomUUID()}`;
const jobId = `smoke-${randomUUID()}`;
let complete;
let generation = 0;
const events = [];
const uploads = [];
const geometryMode = process.argv.includes('--geometry');
const cancelMode = process.argv.includes('--cancel');
const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body = raw.length && (request.headers['content-type'] || '').includes('application/json') ? JSON.parse(raw) : {};
  if (request.url.endsWith('/model/v1/chat/completions')) {
    assert.equal(request.headers.authorization, `Bearer ${leaseToken}`);
    const offered = body.tools || [];
    const main = offered.some(tool => tool?.function?.name === 'industrial_search_catalog');
    if (cancelMode && main) { generation++; return; } // Hold inference until runner heartbeat requests cancellation.
    let tool;
    if (main) {
      generation++;
      if (generation === 1) tool = { name: 'shell', arguments: JSON.stringify({ command: 'echo CLOUD_GUARD_MUST_BLOCK' }) };
      if (generation === 2) tool = geometryMode ? { name: 'industrial_geometry', arguments: JSON.stringify({ operation: 'build', input: { id: 'cloud-smoke-block', name: 'Cloud transport smoke block', units: 'mm', features: [{ id: 'base', op: 'box', size: [20, 10, 5] }], checks: [{ kind: 'valid', expected: 1 }, { kind: 'solids', expected: 1 }, { kind: 'volume', expected: 1000, tolerance: 0.001 }] } }) } : { name: 'industrial_search_catalog', arguments: JSON.stringify({ query: '轴承', limit: 3 }) };
    }
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `offline-tool-${generation}`, type: 'function', function: tool }] } : { role: 'assistant', content: main ? 'Offline transport smoke complete; catalogue evidence came from the actual AGH industrial tool. This is not a real model quality result.' : 'Offline smoke' };
    const base = { id: `offline-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'offline/test' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  assert.equal(request.headers['x-job-lease'], leaseToken);
  response.setHeader('content-type', 'application/json');
  if (request.url.endsWith('/events')) events.push(...body.events);
  if (request.url.endsWith('/complete')) complete = body;
  if (request.method === 'PUT' && request.url.includes('/artifacts/')) {
    uploads.push({ path: request.url, bytes: raw.length, mime: request.headers['content-type'] });
    response.end(JSON.stringify({ url: request.url.replace('/api/runner/jobs/', '/api/tasks/') })); return;
  }
  response.end(JSON.stringify(request.url.endsWith('/heartbeat') ? { cancelled: cancelMode && generation > 0 } : { ok: true }));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const result = await runLeasedJob({ id: jobId, mode: geometryMode ? 'reconstruct' : 'catalog_search', prompt: geometryMode ? '建立20×10×5 mm矩形块，检查实体与体积。' : '搜索轴承。', inputs: [], leaseToken, model: { id: 'offline/test', input: ['text'] }, limits: { timeoutMs: 120000, maxSteps: 8, maxOutputTokens: 4096 } }, { origin, request: runnerClient(origin, token), runnerId: 'offline-smoke', signal: AbortSignal.timeout(180000) });
  const calls = events.filter(entry => entry.event?.type === 'tool/call');
  const results = events.filter(entry => entry.event?.type === 'tool/result');
  if (cancelMode) {
    assert.equal(result.success, false);
    assert.match(result.error?.code || '', /CANCELLED/);
    assert.equal(complete?.success, false);
    assert.equal(calls.length, 0);
    console.log(JSON.stringify({ success: true, execution: 'offline-model-transport-real-agh-cancellation', paidModelCalls: 0, cancelledPendingInference: true, toolCalls: 0 }, null, 2));
  } else {
  const shell = calls.find(entry => entry.event.data.name === 'shell');
  const blocked = results.find(entry => entry.event.data.toolUseId === shell?.event.data.toolUseId);
  assert.equal(blocked?.event.data.isError, true, 'The actual AGH tool_call guard must refuse shell execution.');
  assert.ok(!JSON.stringify(blocked.event.data).includes('"$ CLOUD_GUARD_MUST_BLOCK"'));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(complete?.success, true);
  if (geometryMode) {
    assert.ok(uploads.some(item => item.mime === 'model/gltf-binary'));
    assert.ok(uploads.some(item => item.mime === 'application/step'));
    assert.ok(complete.result.artifacts.step.startsWith('/api/tasks/'));
    assert.ok(!JSON.stringify(complete).includes('/Users/'));
  } else assert.equal(complete.result.catalogResults.source, 'local_catalog');
  assert.ok(calls.some(entry => entry.event.data.name === (geometryMode ? 'industrial_geometry' : 'industrial_search_catalog')));
  console.log(JSON.stringify({ success: true, execution: 'offline-model-transport-real-agh-tools', paidModelCalls: 0, shellBlocked: true, toolCalls: calls.map(entry => ({ name: entry.event.data.name, toolUseId: entry.event.data.toolUseId })), matchedAssets: complete.result.catalogResults?.totalMatches, uploadedArtifacts: uploads.length }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ success: false, message: error.message, complete, events: events.map(entry => entry.event ? { type: entry.event.type, data: entry.event.data } : entry) }, null, 2));
  process.exitCode = 1;
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
