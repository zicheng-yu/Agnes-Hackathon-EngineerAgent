import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient, memoryJournal } from './vendor-runtime/packages/sdk/src/index.node.ts';
import { startProviderFixture } from './vendor-runtime/tools/acceptance/provider-fixture.ts';
import { integration, projectRoot, environment, daemonClientOptions, installPlugin, cli } from './common.mjs';
import { businessEventCollector } from './task-modes.mjs';
import { exportTrace } from './export-trace.mjs';

const liveGeometry = process.argv.slice(2).includes('--live-geometry');
if (process.argv.slice(2).some((arg) => arg !== '--live-geometry')) throw new Error('Only --live-geometry is supported.');
await mkdir(resolve(integration, '.local'), { recursive: true, mode: 0o700 });
const trial = await mkdtemp(resolve(integration, '.local/offline-'));
const workspace = resolve(trial, 'workspace');
await mkdir(resolve(workspace, 'data/uploads/smoke'), { recursive: true });
await writeFile(resolve(workspace, 'data/uploads/smoke/evidence.json'), JSON.stringify({ fixture: true, drawingId: 'OFFLINE-ONLY', diameter: 42 }));
const env = { ...environment(resolve(trial, 'home')), AGH_INDUSTRIAL_ROOT: workspace };
const apiRequests = [];
const api = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/catalog') {
    apiRequests.push({ path: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ id: 'fixture-flange', displayCode: 'FIXTURE-001', name: '法兰 transport fixture', format: 'STEP', sourceType: 'synthetic_fixture' }]));
    return;
  }
  if (request.method !== 'POST' || !['/api/geometry', '/api/orders/review'].includes(request.url)) { response.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { response.writeHead(400).end(); return; }
  apiRequests.push({ path: request.url, body });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(request.url === '/api/orders/review'
    ? { fixture: true, contractOnly: true, dataSource: 'synthetic_demo', items: [{ quantity: 30, status: 'blocked', note: 'Transport fixture, no real business calculation.' }], summary: { lineCount: 1, canCommit: false } }
    : { success: true, fixture: true, contractOnly: true, operation: body.operation, note: 'Transport fixture; no CAD geometry was generated.' }));
});
await new Promise((done) => api.listen(0, '127.0.0.1', done));
if (!liveGeometry) env.AGH_INDUSTRIAL_API = `http://127.0.0.1:${api.address().port}`;
let client;
let provider;
let sessionId;
const checks = [];
try {
  client = createClient({ ...await daemonClientOptions(env), auth: { kind: 'local' }, journal: memoryJournal() });
  await client.initialize();
  checks.push('official-built-daemon-started');
  const plugin = await installPlugin(client);
  checks.push('industrial-plugin-installed-trusted-running');
  // Official upstream fixture binds only loopback. The token below belongs solely to the
  // newly created local fixture, never to an external account, and is never printed.
  const catalogue = await client.config.test({ providerId: 'deepseek' });
  const model = catalogue.models[0]?.id;
  assert.ok(model);
  provider = await startProviderFixture('OFFLINE FIXTURE: tool transport completed. This is not model reasoning.', undefined, model);
  await client.config.save({ providerId: 'deepseek', baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, expectedRevision: 0 });
  await client.workspace.add(workspace);
  const session = await client.session.new({ cwd: workspace });
  sessionId = session.id;
  const orderText = JSON.parse(await readFile(resolve(projectRoot, 'assets/demo-enterprise/orders.json'), 'utf8'))[0].text;
  const catalogCollector = businessEventCollector('catalog_search', '法兰');
  const orderCollector = businessEventCollector('order_review', orderText);
  session.listeners.add((method, params) => {
    if (method === '_agnes/v1/session.event') {
      catalogCollector.accept(params.event);
      orderCollector.accept(params.event);
    }
  });
  await session.attach();
  provider.queueTool({ name: 'industrial_read_input', args: { path: 'data/uploads/smoke/evidence.json' } });
  const turn = await session.prompt('Offline fixture test: read the synthetic input with industrial_read_input.', { signal: AbortSignal.timeout(60000) });
  assert.equal(turn.reason, 'completed');
  assert.ok(provider.requests.some((request) => request.messages.some((message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('OFFLINE-ONLY'))), 'Actual tool result must reach the local provider.');
  checks.push('actual-tool-read-result-reached-loopback-provider');
  provider.queueTool({ name: 'industrial_read_input', args: { path: '../../../README.md' } });
  await session.prompt('Offline fixture negative test: request an out-of-scope path; the tool must refuse it.', { signal: AbortSignal.timeout(60000) });
  assert.ok(provider.requests.some((request) => request.messages.some((message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('Input must be under data/uploads or data/runs'))));
  checks.push('out-of-scope-file-refused-through-real-runtime');
  const geometryCall = liveGeometry
    ? { operation: 'build', input: { id: 'agh-offline-cube', units: 'mm', features: [{ id: 'stock', op: 'box', size: [20, 30, 10] }], checks: [{ kind: 'bbox', axis: 'z', expected: 10, tolerance: 0.05 }] } }
    : { operation: 'validate', input: { id: 'OFFLINE-TRANSPORT-ONLY', units: 'mm', features: [], checks: [] } };
  provider.queueTool({ name: 'industrial_geometry', args: geometryCall });
  await session.prompt(liveGeometry
    ? 'Offline fixture tool test: call the REAL local CAD API with the supplied cube DSL. This tests tool execution, not drawing recognition.'
    : 'Offline transport fixture: invoke industrial_geometry validate. Its API is a contract fixture, not a CAD engine.', { signal: AbortSignal.timeout(120000) });
  let geometryResult;
  if (liveGeometry) {
    for (const request of [...provider.requests].reverse()) {
      for (const message of [...request.messages].reverse()) {
        if (message.role !== 'tool' || typeof message.content !== 'string') continue;
        try { const parsed = JSON.parse(message.content); if (parsed.runId && parsed.manifest) { geometryResult = parsed; break; } } catch {}
      }
      if (geometryResult) break;
    }
    assert.ok(geometryResult, 'Real CAD API result must reach the provider through the AGH tool.');
    assert.equal(geometryResult.success, true);
    assert.equal(geometryResult.manifest.verification.passed, true);
    checks.push('real-CAD-build-and-dimension-verification-through-real-AGH-tool');
    for (const kind of ['step', 'glb']) {
      const path = geometryResult.artifacts[kind];
      assert.ok(path.startsWith(`/runs/${geometryResult.runId}/`));
      const response = await fetch(`${env.AGH_INDUSTRIAL_API}${path}`);
      assert.equal(response.ok, true);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 100);
      assert.ok(kind === 'step' ? bytes.toString('utf8').startsWith('ISO-10303-21;') : bytes.subarray(0, 4).toString('ascii') === 'glTF');
    }
    checks.push('real-STEP-and-GLB-artifact-URLs-serve-valid-file-headers');
  } else {
    assert.equal(apiRequests.length, 1);
    assert.equal(apiRequests[0].path, '/api/geometry');
    assert.equal(apiRequests[0].body.operation, 'validate');
    assert.ok(provider.requests.some((request) => request.messages.some((message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('Transport fixture; no CAD geometry was generated.'))));
    checks.push('geometry-HTTP-contract-through-real-AGH-tool-to-loopback-fixture');
  }
  provider.queueTool({ name: 'industrial_search_catalog', args: { query: '法兰', limit: 3 } });
  await session.prompt('Offline fixture: invoke the local catalogue search tool for 法兰. Do not invent search results.', { signal: AbortSignal.timeout(60000) });
  const catalogResults = catalogCollector.outcome();
  assert.equal(catalogResults.success, true, JSON.stringify(catalogResults.error));
  assert.ok(catalogResults.catalogResults.totalMatches > 0);
  provider.queueTool({ name: 'industrial_review_order', args: { text: orderText } });
  await session.prompt('Offline fixture: review the supplied synthetic purchase text through industrial_review_order.', { signal: AbortSignal.timeout(60000) });
  const orderResults = orderCollector.outcome();
  assert.equal(orderResults.success, true, JSON.stringify(orderResults.error));
  if (liveGeometry) {
    assert.equal(catalogResults.catalogResults.totalAssets, 45);
    assert.equal(orderResults.orderReview.summary.lineCount, 2);
    assert.equal(orderResults.orderReview.summary.requestedQuantity, 50);
    assert.equal(orderResults.orderReview.summary.totalHours, 10.68);
    checks.push('real-45-asset-catalogue-and-10.68-hour-order-review-through-AGH');
  } else checks.push('catalogue-and-order-HTTP-contract-through-AGH-to-tagged-fixture');
  checks.push('business-success-gate-accepts-actual-paired-tool-events');
  await client.close();
  client = null;
  const trace = resolve(trial, 'trace.agnes.jsonl');
  await exportTrace(sessionId, 'agnes', trace, env);
  await exportTrace(sessionId, 'html', resolve(trial, 'trace.html'), env);
  const lines = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.some((e) => e.type === 'tool/call'));
  assert.ok(lines.some((e) => e.type === 'tool/result'));
  checks.push('native-AGH-ledger-export-includes-tool-call-and-result');
  const report = { success: true, execution: 'offline-deterministic-provider-fixture', realModel: false, realGeometry: liveGeometry, realBusinessTools: liveGeometry, paidApiCalls: 0, sessionId, plugin, checks, geometryResult, catalogResults: catalogResults.catalogResults, orderReview: orderResults.orderReview, trace, eventCount: lines.length, limitations: ['No real model reasoning or vision accuracy was tested.', liveGeometry ? 'CAD was built from a predetermined test DSL; this is not automatic drawing reconstruction. Business data are explicitly synthetic.' : 'This smoke tests plugin transport and AGH recording against tagged HTTP fixtures; no real geometry or business calculation.'] };
  await writeFile(resolve(trial, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { success: false, execution: 'offline-deterministic-provider-fixture', realModel: false, checks, sessionId, error: error.message, trial };
  await writeFile(resolve(trial, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  api.closeAllConnections();
  await new Promise((done) => api.close(done));
  await cli(['daemon', 'stop'], env).catch(() => undefined);
}
