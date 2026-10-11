import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteD1 } from '../local-live-runtime.mjs';
import { handle } from './worker-api.mjs';
import { admitTask, reserveRequest, markDispatched, markUnknown, getBudgetSummary } from './budget.mjs';
import { hash } from './worker-security.mjs';

async function fixture(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const DB = createSqliteD1(sqlite);
  const env = { DB, BUCKET: {}, SESSION_SECRET: 'fixture-session-secret'.repeat(3), RUNNER_TOKEN: 'fixture-runner-token'.repeat(3) };
  const health = () => handle(new Request('https://fixture.invalid/api/health'), env);
  const state = () => ({ task: sqlite.prepare("SELECT status FROM trial_tasks WHERE id='task-recovery'").get()?.status,
    request: sqlite.prepare("SELECT state FROM budget_requests WHERE id='request-recovery'").get()?.state,
    budget: sqlite.prepare("SELECT state FROM budget_tasks WHERE id='task-recovery'").get()?.state });
  return { sqlite, DB, env, health, state };
}

async function reserve(f, { terminal = false, expired = true } = {}) {
  await f.DB.prepare(`INSERT INTO trial_tasks(id,owner_id,mode,prompt,pages_json,status,title,created_ms,created_day,lease_expires_ms)
    VALUES('task-recovery','owner','catalog_search','fixture','[]','running','fixture',?,'2026-10-10',?)`)
    .bind(Date.now(), Date.now() + (expired ? -1000 : 600000)).run();
  await reserveRequest(f.DB, { taskId: 'task-recovery', requestId: 'request-recovery', model: 'fixture/model', priceRevision: 'fixture-1', boundSource: 'model_context_limit', inputTokenBound: 1048576, maxOutputTokens: 8192, inputMicrosPerMillion: 300000, outputMicrosPerMillion: 1200000 });
  if (terminal) await f.DB.prepare("UPDATE trial_tasks SET status='failed',cancel_requested=1 WHERE id='task-recovery'").run();
}

test('expired task releases only its provably unsent reservation and admits the next task', async () => {
  const f = await fixture();
  try {
    await reserve(f);
    assert.equal((await f.health()).status, 200);
    assert.deepEqual(f.state(), { task: 'failed', request: 'cancelled', budget: 'closed' });
    await admitTask(f.DB, { taskId: 'next-task' });
    assert.equal((await getBudgetSummary(f.DB)).spent_micros, 0);
  } finally { f.sqlite.close(); }
});

test('restart recovers a task whose failed status persisted before cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engineeragent-reservation-recovery-'));
  const path = join(root, 'ledger.sqlite');
  try {
    const before = await fixture(path);
    await reserve(before, { terminal: true });
    before.sqlite.close();
    const after = await fixture(path);
    try {
      assert.equal((await after.health()).status, 200);
      assert.deepEqual(after.state(), { task: 'failed', request: 'cancelled', budget: 'closed' });
      assert.equal((await getBudgetSummary(after.DB)).available_micros, 10000000);
    } finally { after.sqlite.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a live reservation is not reclaimed; dispatched and unknown requests remain frozen after expiry', async () => {
  const f = await fixture();
  try {
    await reserve(f, { expired: false });
    await f.health();
    assert.deepEqual(f.state(), { task: 'running', request: 'reserved', budget: 'active' });
    await markDispatched(f.DB, 'request-recovery');
    await f.DB.prepare("UPDATE trial_tasks SET lease_expires_ms=1 WHERE id='task-recovery'").run();
    await f.health();
    assert.deepEqual(f.state(), { task: 'failed', request: 'dispatched', budget: 'closing' });
    await markUnknown(f.DB, 'request-recovery');
    await f.health();
    assert.deepEqual(f.state(), { task: 'failed', request: 'unknown', budget: 'closing' });
    assert.equal((await getBudgetSummary(f.DB)).reserved_micros, 500000);
    await assert.rejects(admitTask(f.DB, { taskId: 'next-task' }), { code: 'BUDGET_BUSY' });
  } finally { f.sqlite.close(); }
});

test('when cleanup wins the race, late markDispatched fails before any paid fetch', async () => {
  const f = await fixture();
  try {
    await reserve(f); await f.health();
    let paidFetches = 0;
    await assert.rejects((async () => { await markDispatched(f.DB, 'request-recovery'); paidFetches++; })(), { code: 'BUDGET_ALREADY_DISPATCHED' });
    assert.equal(paidFetches, 0);
  } finally { f.sqlite.close(); }
});

test('when markDispatched wins between selection and cleanup, its reservation stays frozen', async () => {
  const f = await fixture();
  try {
    await reserve(f);
    const original = f.DB.prepare.bind(f.DB);
    let raced = false;
    f.DB.prepare = (sql) => {
      const statement = original(sql);
      if (sql.includes("UPDATE budget_requests SET state='cancelled'")) {
        const originalRun = statement.run.bind(statement);
        statement.run = async () => { if (!raced) { raced = true; await markDispatched(f.DB, 'request-recovery'); } return originalRun(); };
      }
      return statement;
    };
    assert.equal((await f.health()).status, 200);
    assert.equal(raced, true);
    assert.deepEqual(f.state(), { task: 'failed', request: 'dispatched', budget: 'closing' });
    assert.equal((await getBudgetSummary(f.DB)).reserved_micros, 500000);
  } finally { f.sqlite.close(); }
});

test('normal completion also cancels a background request still reserved but never dispatched', async () => {
  const f = await fixture();
  try {
    await reserve(f, { expired: false });
    const lease = 'fixture-job-lease'.repeat(3);
    await f.DB.prepare("UPDATE trial_tasks SET lease_hash=? WHERE id='task-recovery'").bind(await hash(lease)).run();
    const response = await handle(new Request('https://fixture.invalid/api/runner/jobs/task-recovery/complete', {
      method: 'POST', headers: { authorization: `Bearer ${f.env.RUNNER_TOKEN}`, 'x-job-lease': lease, 'content-type': 'application/json' }, body: JSON.stringify({ success: true, result: {} }),
    }), f.env);
    assert.equal(response.status, 200);
    assert.deepEqual(f.state(), { task: 'completed', request: 'cancelled', budget: 'closed' });
  } finally { f.sqlite.close(); }
});
