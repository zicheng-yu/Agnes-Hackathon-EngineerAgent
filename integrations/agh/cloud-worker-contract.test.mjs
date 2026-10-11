import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSqliteD1 } from '../../server/local-live-runtime.mjs';
import { handle } from '../../server/live-runtime/worker-api.mjs';
import { getBudgetSummary } from '../../server/live-runtime/budget.mjs';
import { runnerClient, runLeasedJob } from './cloud-runner.mjs';
import { validateJob } from './cloud-runner-protocol.mjs';
import { MODEL_ID, modelPayload } from '../../server/live-runtime/model-proxy.mjs';

test('gateway filters only declared builtin tools and still rejects unsafe historical tool calls', () => {
  const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
  const payload = modelPayload({ model: MODEL_ID, messages: [{ role: 'user', content: '检索法兰' }], tools: [tool('shell'), tool('read'), tool('industrial_search_catalog')] });
  assert.deepEqual(payload.tools.map(item => item.function.name), ['industrial_search_catalog']);
  assert.throws(() => modelPayload({ messages: [{ role: 'assistant', tool_calls: [{ id: 'bad', type: 'function', function: { name: 'shell', arguments: '{}' } }] }] }), /TOOL_NOT_ALLOWED/);
  assert.throws(() => modelPayload({ messages: [{ role: 'user', content: 'x' }], tools: [tool('industrial_search_catalog'), tool('industrial_search_catalog')] }), /INVALID_TOOL_CATALOG/);
});

test('actual local Worker leases document-free business tasks and malformed leases close their budget', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../../server/live-runtime/schema.sql', import.meta.url), 'utf8'));
  const DB = createSqliteD1(sqlite);
  const token = 'contract-test-runner-token-123456789012345';
  const env = { DB, BUCKET: {}, RUNNER_TOKEN: token };
  const calls = [];
  const origin = 'http://127.0.0.1:4310';
  const request = runnerClient(origin, token, (url, options) => {
    calls.push(new URL(url).pathname);
    return handle(new Request(url, options), env);
  });
  try {
    for (const mode of ['catalog_search', 'order_review']) {
      const id = `contract-${mode}`;
      sqlite.prepare(`INSERT INTO trial_tasks(id,owner_id,mode,prompt,pages_json,status,title,created_ms,created_day)
        VALUES(?,?,?,?,?,'queued',?,?,?)`).run(id, 'fixture-owner', mode, '法兰需求测试', '[]', '契约测试', Date.now(), new Date().toISOString().slice(0, 10));
      const response = await request('/api/runner/lease', { json: { runnerId: 'contract-runner' } });
      const { job } = await response.json();
      // This payload comes from the production Worker handler, not a hand-written fixture.
      assert.equal(job.id, id);
      assert.deepEqual(job.inputs, []);
      assert.deepEqual(job.pages, []);
      assert.equal(validateJob(job).mode, mode);
      assert.equal((await getBudgetSummary(DB)).reserved_micros, 500000);
      const outcome = await runLeasedJob({ ...job, model: { ...job.model, id: '' } }, { origin, request, runnerId: 'contract-runner', signal: new AbortController().signal });
      assert.equal(outcome.completionReported, true);
      assert.equal(outcome.error.code, 'INVALID_LEASED_JOB');
      assert.equal(sqlite.prepare('SELECT status FROM trial_tasks WHERE id=?').get(id).status, 'failed');
      assert.equal(sqlite.prepare('SELECT state FROM budget_tasks WHERE id=?').get(id).state, 'closed');
      assert.equal((await getBudgetSummary(DB)).reserved_micros, 0);
    }
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM budget_requests').get().count, 0);
    assert.ok(calls.every(path => path.endsWith('/lease') || path.endsWith('/complete')));
  } finally { sqlite.close(); }
});
