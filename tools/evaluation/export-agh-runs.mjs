// Export the demo-case AGH runs kept in the task history into assets/evaluation for the submission
// package (data/ is excluded from packaging). Copies the official AGH trace export, the task record,
// and the final verified geometry artifacts. Usage: node tools/evaluation/export-agh-runs.mjs [--cases id1,id2]
// With --cases only those case directories and report entries are replaced; every other record is kept as is.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../..');
const destination = path.join(root, 'assets/evaluation');
const runsRoot = await fs.realpath(path.join(root, 'data/runs'));
const { cases } = JSON.parse(await fs.readFile(path.join(root, 'assets/demo-cases/cases.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'integrations/agh/runtime-lock.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
function clean(value) {
  if (typeof value === 'string') return value.replaceAll(`${root}/`, '').replace(/sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]').replace(/(?:\/Users\/|\/home\/|\/private\/)[^\s"'<>]+/g, '[LOCAL_PATH]');
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(apiKey|authorization|accessToken|secret|token|api_key)$/i.test(key)).map(([key, item]) => [key, clean(item)]));
  return value;
}

// Most recent completed history task for each demo case, matched by its exact instruction.
const tasks = [];
for (const name of await fs.readdir(path.join(root, 'data/tasks'))) {
  if (!name.endsWith('.json')) continue;
  const task = JSON.parse(await fs.readFile(path.join(root, 'data/tasks', name), 'utf8'));
  if (task.mode !== 'geometry') tasks.push(task);
}
const casesArg = process.argv.indexOf('--cases');
const selected = casesArg > 0 ? new Set(String(process.argv[casesArg + 1] || '').split(',').filter(Boolean)) : null;
if (selected && ![...selected].every(id => cases.some(item => item.id === id))) throw new Error(`Unknown case in --cases: ${[...selected].join(', ')}`);
const previous = selected ? JSON.parse(await fs.readFile(path.join(destination, 'report.json'), 'utf8')) : null;
if (selected) for (const id of selected) await fs.rm(path.join(destination, 'agh-runs', id), { recursive: true, force: true });
else await fs.rm(path.join(destination, 'agh-runs'), { recursive: true, force: true });
const report = { generatedAt: new Date().toISOString(), aghCommit: lock.commit, aghRepository: lock.repository, note: '评委测试案例的真实 AGH 运行记录。trace.agnes.jsonl 为 AGH 官方导出器输出（已去除密钥与本机路径）；产物为该次运行实际生成的文件。', runs: [] };
for (const item of cases) {
  if (selected && !selected.has(item.id)) {
    const kept = previous.runs.find(run => run.case === item.id);
    if (kept) report.runs.push(kept);
    continue;
  }
  const task = tasks.filter(t => t.mode === item.mode && t.instruction?.trim() === item.instruction.trim() && ['completed', 'failed'].includes(t.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!task) { report.runs.push({ case: item.id, title: item.title, kind: item.kind, status: 'not_run' }); continue; }
  const dir = path.join(destination, 'agh-runs', item.id);
  await fs.mkdir(dir, { recursive: true });
  const files = {};
  const tracePath = path.join(root, 'data/tasks', task.id, 'trace.jsonl');
  let traceSha256 = null, eventCount = 0;
  try {
    const lines = (await fs.readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.stringify(clean(JSON.parse(line))));
    const text = lines.join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'trace.agnes.jsonl'), text);
    traceSha256 = sha256(text); eventCount = lines.length; files.trace = `/assets/evaluation/agh-runs/${item.id}/trace.agnes.jsonl`;
  } catch { /* A run without an exported trace is reported as such. */ }
  const result = task.result || {};
  const geometry = result.geometryRuns?.at(-1);
  let assembly;
  if (geometry?.runId && /^[A-Za-z0-9_-]+$/.test(geometry.runId)) {
    const run = path.join(runsRoot, geometry.runId);
    for (const [key, file] of [['step', 'model.step'], ['glb', 'model.glb'], ['plan', 'feature-plan.json'], ['plan', 'assembly-plan.json'], ['front', 'views/front.svg'], ['top', 'views/top.svg'], ['side', 'views/side.svg']]) {
      try { await fs.copyFile(path.join(run, file), path.join(dir, path.basename(file))); files[key] = `/assets/evaluation/agh-runs/${item.id}/${path.basename(file)}`; } catch { /* optional view */ }
    }
    const manifest = JSON.parse(await fs.readFile(path.join(run, 'manifest.json'), 'utf8'));
    if (manifest.operation === 'assembly') assembly = {
      instances: manifest.instance_count, bom: manifest.bom?.map(b => ({ part: b.part_id, quantity: b.quantity })),
      partChecksPassed: manifest.verification?.part_checks_passed, pathCheckPassed: manifest.verification?.path_check_passed,
      placementChecks: manifest.verification?.assembly_checks?.map(c => ({ kind: c.kind, instance: c.instance, axis: c.axis, expected: c.expected, actual: c.actual, passed: c.passed })),
    };
    delete manifest.files;
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(clean(manifest), null, 2));
    files.manifest = `/assets/evaluation/agh-runs/${item.id}/manifest.json`;
  }
  const record = clean({ ...task, result: { ...result, traceUrl: undefined } });
  await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(record, null, 2));
  files.task = `/assets/evaluation/agh-runs/${item.id}/task.json`;
  const calls = (task.events || []).filter(e => e.type === 'tool/call').map(e => e.toolName);
  const checks = geometry?.verification?.checks?.map(c => ({ kind: c.kind, axis: c.axis ?? undefined, diameter: c.diameter ?? undefined, expected: c.expected, actual: c.actual, passed: c.passed }));
  report.runs.push({ case: item.id, title: item.title, kind: item.kind, mode: item.mode, expect: item.expect, taskId: task.id, sessionId: result.sessionId, createdAt: task.createdAt,
    model: task.usage?.model || result.model, providerId: task.usage?.providerId || result.providerId, status: task.status, outcome: result.outcome || (task.status === 'completed' ? 'completed' : 'failed'),
    modelRequests: task.usage?.requestCount, tokens: task.usage ? { prompt: task.usage.promptTokens, completion: task.usage.completionTokens, cached: task.usage.cachedTokens } : undefined,
    toolCalls: calls, checks, assembly, clarification: result.clarification, order: result.orderReview?.summary ? { lines: result.orderReview.summary.lineCount, ready: result.orderReview.summary.ready, blocked: result.orderReview.summary.blocked, unmatched: result.orderReview.summary.unmatched, toProduce: result.orderReview.summary.toProduce, totalHours: result.orderReview.summary.totalHours } : undefined,
    catalog: result.catalogResults ? { totalMatches: result.catalogResults.totalMatches, matchMode: result.catalogResults.matchMode, items: (result.catalogResults.items || []).map(i => i.displayCode) } : undefined,
    traceEvents: eventCount, traceSha256, files });
}
// Records of retired cases (no longer in cases.json) stay listed after a partial export.
if (selected) for (const run of previous.runs) if (!cases.some(item => item.id === run.case)) report.runs.push({ ...run, retired: true });
await fs.writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.runs.map(r => ({ case: r.case, status: r.status, outcome: r.outcome, model: r.model, tools: r.toolCalls?.length, events: r.traceEvents })), null, 1));
