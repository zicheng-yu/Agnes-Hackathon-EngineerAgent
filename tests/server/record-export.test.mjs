import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { historyArchive, taskEntries, zip } from '../../server/record-export.mjs';

function unzip(buffer) {
  const files = new Map();
  for (let at = 0; buffer.readUInt32LE(at) === 0x04034b50;) {
    const size = buffer.readUInt32LE(at + 18), nameLength = buffer.readUInt16LE(at + 26), extra = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    files.set(name, inflateRawSync(buffer.subarray(start, start + size)));
    at = start + size;
  }
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size, 'central directory lists every entry');
  return files;
}

test('exports official AGH traces with task records and artifacts, without secrets or local paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-export-'));
  try {
    const dataRoot = join(root, 'data');
    await mkdir(join(dataRoot, 'tasks', 'task-1'), { recursive: true });
    await mkdir(join(dataRoot, 'runs', 'run-1', 'views'), { recursive: true });
    await writeFile(join(dataRoot, 'runs', 'run-1', 'model.step'), 'ISO-10303-21;');
    await writeFile(join(dataRoot, 'runs', 'run-1', 'manifest.json'), JSON.stringify({ status: 'completed', files: { step: `${root}/data/runs/run-1/model.step` } }));
    const task = { id: 'task-1', title: '图纸重建 · 底板', mode: 'reconstruct', status: 'completed', createdAt: '2026-10-10T00:00:00Z', instruction: '重建底板',
      events: [{ type: 'tool/call', toolUseId: 'a', toolName: 'industrial_geometry', input: '生成模型' }, { type: 'tool/result', toolUseId: 'a', toolName: 'industrial_geometry', output: '几何检查通过（1/1）' }],
      usage: { model: 'agnes-3.0-flash', providerId: 'agnes-ai', requestCount: 3 },
      result: { sessionId: 's-1', answer: 'done', geometryRuns: [{ runId: 'run-1', verification: { checks: [{ kind: 'bbox', axis: 'x', expected: 120, actual: 120, passed: true }] } }] } };
    await writeFile(join(dataRoot, 'tasks', 'task-1.json'), JSON.stringify(task));
    await writeFile(join(dataRoot, 'tasks', 'debug.json'), JSON.stringify({ id: 'debug', mode: 'geometry', createdAt: '2026-10-09T00:00:00Z' }));
    await writeFile(join(dataRoot, 'tasks', 'task-1', 'trace.jsonl'), [{ seq: 1, type: 'session/start', data: { cwd: `${root}/data/x` } }, { seq: 2, type: 'tool/call', data: { note: 'key sk-SECRETSECRETSECRET123 and custom-secret-value' } }].map(e => JSON.stringify(e)).join('\n'));
    const { entries } = await taskEntries(task, { root, dataRoot, aghCommit: 'abc', secrets: ['custom-secret-value'] });
    const files = unzip(zip(entries));
    assert.deepEqual([...files.keys()].sort(), ['README.md', 'artifacts/manifest.json', 'artifacts/model.step', 'task.json', 'trace.agnes.jsonl']);
    const trace = files.get('trace.agnes.jsonl').toString();
    assert.equal(trace.trim().split('\n').length, 2);
    assert.doesNotMatch(trace, /SECRETSECRET|custom-secret-value/);
    assert.doesNotMatch(files.get('artifacts/manifest.json').toString(), new RegExp(root));
    assert.match(files.get('README.md').toString(), /agnes-3.0-flash（agnes-ai），模型请求 3 次[\s\S]*\| bbox x \| 120 \| 120 \| 通过 \|/);
    const archive = await historyArchive({ root, dataRoot, aghCommit: 'abc', secrets: [] });
    assert.equal(archive.count, 1, 'direct CAD debug runs are not AGH records');
    assert.ok(unzip(archive.buffer).has('01-reconstruct-task-1/trace.agnes.jsonl'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
