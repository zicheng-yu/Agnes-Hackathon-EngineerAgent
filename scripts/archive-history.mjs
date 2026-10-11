#!/usr/bin/env node
// Move the current task history out of the workbench into output/archive (nothing is deleted outright).
// - data/tasks/*.json and their trace folders (AGH-backed and debug runs)
// - metered OpenRouter trial task rows (documents, tasks, events, artifacts, call links) exported as JSON
// The append-only spend ledger (budget_tasks / budget_requests) is never modified, so the US$10 cap stays exact.
// Run with the workbench stopped: node scripts/archive-history.mjs
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archive = join(root, 'output/archive', `history-${stamp}`);
await mkdir(join(archive, 'data-tasks'), { recursive: true });

const taskDir = join(root, 'data/tasks');
const entries = await readdir(taskDir).catch(() => []);
for (const name of entries) {
  await cp(join(taskDir, name), join(archive, 'data-tasks', name), { recursive: true });
  await rm(join(taskDir, name), { recursive: true, force: true });
}

const ledger = join(root, 'data/live-runtime/budget.sqlite');
const db = new DatabaseSync(ledger);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const tables = ['trial_events', 'trial_artifacts', 'trial_model_calls', 'trial_tasks', 'trial_documents'];
const exported = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
await writeFile(join(archive, 'trial-history.json'), JSON.stringify(exported, null, 2), { mode: 0o600 });
db.exec('BEGIN IMMEDIATE');
try { for (const table of tables) db.exec(`DELETE FROM ${table}`); db.exec('COMMIT'); }
catch (error) { db.exec('ROLLBACK'); throw error; }
const spend = db.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(actual_micros),0) AS micros FROM budget_requests WHERE state='settled'").get();
db.close();
console.log(JSON.stringify({ archive, taskFilesMoved: entries.length, trialRowsArchived: Object.fromEntries(tables.map(t => [t, exported[t].length])), spendLedgerKept: { settledRequests: spend.requests, usd: spend.micros / 1e6 } }, null, 2));
