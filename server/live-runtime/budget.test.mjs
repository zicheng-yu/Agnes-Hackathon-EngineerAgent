import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  BUDGET_SCHEMA, TOTAL_LIMIT_MICROS, TASK_LIMIT_MICROS, usdToMicros, requestCeiling,
  admitTask, reserveRequest, markDispatched, markUnknown, cancelUnsentRequest,
  settleRequest, closeTask, getTaskBudget, getBudgetSummary,
} from './budget.mjs';

// Actual SQLite SQL/triggers exercised through the small D1 method surface.
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(BUDGET_SCHEMA);
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  return { db, sqlite };
}
const opts = (taskId = 'task-1', requestId = 'request-1') => ({
  taskId, requestId, model: 'minimax/model', priceRevision: '2026-10-10',
  boundSource: 'model_context_limit', inputTokenBound: 1_048_576,
  maxOutputTokens: 8192, inputMicrosPerMillion: 300_000,
  outputMicrosPerMillion: 1_200_000,
});
const usage = (cost = '0.01', generationId = null) => ({ cost, source: 'openrouter.usage', generationId, promptTokens: 1100, completionTokens: 400 });
const rejects = (p, code) => assert.rejects(p, (error) => error.code === code);

test('cost parser rounds provider decimals up and never treats missing cost as free', () => {
  assert.equal(usdToMicros('0.0123456'), 12346);
  assert.equal(usdToMicros(1e-7), 1);
  assert.equal(usdToMicros(0), 0);
  assert.equal(usdToMicros('1.200000'), 1_200_000);
  for (const cost of [null, undefined]) assert.throws(() => usdToMicros(cost), { code: 'BUDGET_COST_UNKNOWN' });
  for (const cost of ['', true, -1, NaN, Infinity]) assert.throws(() => usdToMicros(cost));
});

test('request ceiling reserves the full context, max output, and any fixed charge', () => {
  assert.equal(requestCeiling(opts()), 324404);
  assert.equal(requestCeiling({ ...opts(), fixedMicros: 5000 }), 329404);
  assert.throws(() => requestCeiling({ ...opts(), inputTokenBound: 0.5 }));
});

test('atomic task admission blocks concurrent tasks and retry admission is idempotent', async () => {
  const { db } = fixture();
  const results = await Promise.allSettled([admitTask(db, { taskId: 'first' }), admitTask(db, { taskId: 'second' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected')[0].reason.code, 'BUDGET_BUSY');
  await admitTask(db, { taskId: 'first' });
  const summary = await getBudgetSummary(db);
  assert.equal(summary.reserved_micros, TASK_LIMIT_MICROS);
  assert.equal(summary.available_micros, TOTAL_LIMIT_MICROS - TASK_LIMIT_MICROS);
});

test('reserve is idempotent for matching payloads and cannot change bounds or task', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  const a = await reserveRequest(db, opts());
  const b = await reserveRequest(db, opts());
  assert.equal(a.id, b.id);
  await rejects(reserveRequest(db, { ...opts(), maxOutputTokens: 8193 }), 'BUDGET_IDEMPOTENCY_CONFLICT');
  await rejects(reserveRequest(db, { ...opts(), boundSource: 'byte_estimate' }), 'BUDGET_UNVERIFIED_TOKEN_BOUND');
});

test('only one unresolved request is allowed; a paid dispatch is never retried', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await rejects(reserveRequest(db, opts('task-1', 'request-2')), 'BUDGET_PENDING_REQUEST');
  await markDispatched(db, 'request-1');
  await rejects(markDispatched(db, 'request-1'), 'BUDGET_ALREADY_DISPATCHED');
  await rejects(cancelUnsentRequest(db, 'request-1'), 'BUDGET_CANNOT_CANCEL_SENT');
});

test('timeout keeps full task reservation frozen through close until verified settlement', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await markDispatched(db, 'request-1');
  await markUnknown(db, 'request-1', { reason: 'transport_timeout', generationId: 'gen-1' });
  const closing = await closeTask(db, 'task-1');
  assert.equal(closing.state, 'closing');
  assert.equal(closing.request_reserved_micros, 324404);
  await rejects(admitTask(db, { taskId: 'task-2' }), 'BUDGET_BUSY');
  await rejects(settleRequest(db, 'request-1', usage(null, 'gen-1')), 'BUDGET_COST_UNKNOWN');
  assert.equal((await getBudgetSummary(db)).reserved_micros, 500000);
  await settleRequest(db, 'request-1', { ...usage('0.02', 'gen-1'), source: 'openrouter.generation' });
  assert.equal((await getTaskBudget(db, 'task-1')).state, 'closed');
  const summary = await getBudgetSummary(db);
  assert.equal(summary.spent_micros, 20000);
  assert.equal(summary.reserved_micros, 0);
  assert.equal(summary.available_micros, 9_980_000);
  await admitTask(db, { taskId: 'task-2' });
});

test('verified usage releases unused request reserve and next calls share the task cap', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await markDispatched(db, 'request-1');
  await settleRequest(db, 'request-1', usage('0.17'));
  await reserveRequest(db, opts('task-1', 'request-2'));
  await markDispatched(db, 'request-2');
  await settleRequest(db, 'request-2', usage('0.02'));
  await rejects(reserveRequest(db, opts('task-1', 'request-3')), 'BUDGET_TASK_LIMIT');
  const task = await getTaskBudget(db, 'task-1');
  assert.equal(task.spent_micros, 190000);
  assert.equal(task.request_reserved_micros, 0);
});

test('repeated reconciliation does not double charge and differing settlement conflicts', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await markDispatched(db, 'request-1');
  await settleRequest(db, 'request-1', usage('0.01', 'gen-1'));
  await settleRequest(db, 'request-1', usage('0.01', 'gen-1'));
  await rejects(settleRequest(db, 'request-1', usage('0.02', 'gen-1')), 'BUDGET_IDEMPOTENCY_CONFLICT');
  assert.equal((await getBudgetSummary(db)).spent_micros, 10000);
});

test('a reconciliation from a different generation cannot unfreeze an unknown request', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await markDispatched(db, 'request-1');
  await markUnknown(db, 'request-1', { generationId: 'gen-original' });
  await rejects(settleRequest(db, 'request-1', usage('0.01', 'gen-other')), 'BUDGET_IDEMPOTENCY_CONFLICT');
  assert.equal((await getTaskBudget(db, 'task-1')).unknown_requests, 1);
  assert.equal((await getBudgetSummary(db)).spent_micros, 0);
  await settleRequest(db, 'request-1', usage('0.01', 'gen-original'));
  assert.equal((await getTaskBudget(db, 'task-1')).unknown_requests, 0);
});

test('unsent requests can be cancelled, but callers cannot invent provider costs', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await rejects(settleRequest(db, 'request-1', usage('0')), 'BUDGET_NOT_DISPATCHED');
  await rejects(settleRequest(db, 'request-1', { ...usage(), source: 'estimate' }), 'BUDGET_UNVERIFIED_COST');
  await cancelUnsentRequest(db, 'request-1');
  assert.equal((await closeTask(db, 'task-1')).state, 'closed');
  assert.equal((await getBudgetSummary(db)).available_micros, TOTAL_LIMIT_MICROS);
});

test('twenty full-cost tasks exhaust the $10 pool; subsequent admission is rejected', async () => {
  const { db } = fixture();
  for (let i = 0; i < 20; i++) {
    const taskId = `task-${i}`, requestId = `request-${i}`;
    await admitTask(db, { taskId });
    // Exact $0.50 reservation for this budget-boundary test.
    await reserveRequest(db, { ...opts(taskId, requestId), inputTokenBound: 1_000_000,
      maxOutputTokens: 1_000_000, inputMicrosPerMillion: 250000, outputMicrosPerMillion: 250000 });
    await markDispatched(db, requestId);
    await settleRequest(db, requestId, usage('0.5'));
    await closeTask(db, taskId);
  }
  await rejects(admitTask(db, { taskId: 'task-21' }), 'BUDGET_TOTAL_LIMIT');
  const summary = await getBudgetSummary(db);
  assert.equal(summary.spent_micros, TOTAL_LIMIT_MICROS);
  assert.equal(summary.available_micros, 0);
});

test('unexpected provider ceiling breach is recorded honestly and stops all further spend', async () => {
  const { db } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  await markDispatched(db, 'request-1');
  const settled = await settleRequest(db, 'request-1', usage('0.34'));
  assert.equal(settled.exceededReservation, true);
  await rejects(reserveRequest(db, opts('task-1', 'request-2')), 'BUDGET_CEILING_BREACH');
  await closeTask(db, 'task-1');
  await rejects(admitTask(db, { taskId: 'task-2' }), 'BUDGET_CEILING_BREACH');
  assert.equal((await getBudgetSummary(db)).spent_micros, 340000);
  assert.equal((await getBudgetSummary(db)).ceiling_breaches, 1);
});

test('SQL integrity prevents deleting ledger or closing unresolved reservations', async () => {
  const { db, sqlite } = fixture();
  await admitTask(db, { taskId: 'task-1' });
  await reserveRequest(db, opts());
  assert.throws(() => sqlite.exec("UPDATE budget_tasks SET state='closed' WHERE id='task-1'"), /BUDGET_UNRESOLVED/);
  assert.throws(() => sqlite.exec("DELETE FROM budget_requests WHERE id='request-1'"), /BUDGET_APPEND_ONLY/);
  assert.throws(() => sqlite.exec("UPDATE budget_requests SET state='settled',actual_micros=0,cost_source='openrouter.usage' WHERE id='request-1'"), /BUDGET_REQUEST_TRANSITION/);
});
