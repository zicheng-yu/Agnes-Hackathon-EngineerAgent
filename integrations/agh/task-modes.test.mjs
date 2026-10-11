import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { businessEventCollector, instructionsForMode } from './task-modes.mjs';
import { integration, isolatedHome } from './common.mjs';

const emit = (collector, name, input, result, id = 'call-1') => {
  collector.accept({ type: 'tool/call', data: { toolUseId: id, name, args: input } });
  collector.accept({ type: 'tool/result', data: { toolUseId: id, structured: result } });
};

test('orders require actual paired review of unchanged input; blocked findings remain valid reports', () => {
  const input = '名称：法兰；数量：300';
  const collector = businessEventCollector('order_review', input);
  const review = { dataSource: 'synthetic_demo', items: [{ quantity: 300, status: 'blocked' }], summary: { lineCount: 1, canCommit: false } };
  collector.accept({ type: 'assistant/message', data: { text: 'The order was reviewed.' } });
  collector.accept({ type: 'tool/result', data: { toolUseId: 'invented', structured: review } });
  assert.equal(collector.outcome().success, false);
  emit(collector, 'industrial_review_order', { text: input.replace('300', '30') }, review);
  assert.equal(collector.outcome().error.code, 'ORDER_INPUT_CHANGED');
  emit(collector, 'industrial_review_order', { text: input }, { ...review, items: [], summary: { lineCount: 0, canCommit: false } }, 'empty');
  assert.equal(collector.outcome().error.code, 'NO_REVIEWABLE_ORDER');
  emit(collector, 'industrial_review_order', { text: input }, review, 'correct');
  assert.equal(collector.outcome().success, true);
  assert.equal(collector.outcome().orderReview.items[0].quantity, 300);
  collector.accept({ type: 'tool/call', data: { toolUseId: 'failed', name: 'industrial_review_order', args: { text: input } } });
  collector.accept({ type: 'tool/result', data: { toolUseId: 'failed', isError: true, structured: { error: 'offline' } } });
  assert.equal(collector.outcome().success, false, 'An earlier report must not hide a later unresolved failure.');
});

test('catalogue tasks accept truthful zero results but reject missing/invalid tool evidence', () => {
  const collector = businessEventCollector('catalog_search', 'unknown');
  emit(collector, 'industrial_geometry', {}, { success: true });
  assert.equal(collector.outcome().success, false);
  emit(collector, 'industrial_search_catalog', { query: 'unknown' }, { success: true, source: 'local_catalog', items: [], totalAssets: 45, totalMatches: 0, returnedCount: 0 }, 'search');
  assert.equal(collector.outcome().success, true);
  assert.equal(collector.outcome().catalogResults.totalMatches, 0);
  assert.throws(() => instructionsForMode('invented'), /Unsupported/);
  assert.match(instructionsForMode('reconstruct'), /do NOT build anything: call industrial_request_clarification/);
  assert.match(instructionsForMode('reconstruct'), /complete only after build, validate and project/);
  assert.match(instructionsForMode('order_review'), /complete USER TASK text exactly as supplied/);
});

test('AGH home override stays under the project including symlink resolution', async () => {
  await mkdir(resolve(integration, '.local'), { recursive: true });
  const parent = await mkdtemp(resolve(integration, '.local/hometest-'));
  try {
    assert.equal(isolatedHome(resolve(parent, 'new/home')), resolve(parent, 'new/home'));
    assert.throws(() => isolatedHome('/tmp/outside'), /must be a child/);
    await symlink(tmpdir(), resolve(parent, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => isolatedHome(resolve(parent, 'escape/new-home')), /symlink escapes/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
