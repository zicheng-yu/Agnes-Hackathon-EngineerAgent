import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { integration } from './common.mjs';
import { createIndustrialTools, localApi, normalizeToolInput } from './industrial-tools/index.mjs';

test('plugin enforces input boundaries and preserves local API success/error semantics', async () => {
  await mkdir(resolve(integration, '.local'), { recursive: true });
  const root = await mkdtemp(resolve(integration, '.local/tooltest-'));
  try {
    await mkdir(resolve(root, 'data/uploads/item'), { recursive: true });
    await mkdir(resolve(root, 'data/runs'), { recursive: true });
    await writeFile(resolve(root, 'data/uploads/item/input.json'), '{"length":42}');
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5ioAAAAASUVORK5CYII=', 'base64');
    await writeFile(resolve(root, 'data/uploads/item/image.png'), imageBytes);
    await writeFile(resolve(root, 'private.txt'), 'must not be readable');
    await symlink(resolve(root, 'private.txt'), resolve(root, 'data/uploads/item/escape.txt'));
    const calls = [];
    const tools = createIndustrialTools({ root, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const input = options.body ? JSON.parse(options.body) : null;
      return new Response(JSON.stringify(input?.operation === 'validate' ? { success: false, error: 'dimension mismatch' } : { success: true, runId: 'fixture-only' }), { status: 200 });
    } });
    const tool = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const stored = [];
    const ctx = { signal: new AbortController().signal, timeoutMs: 1000, artifacts: { put: async (data, metadata) => { stored.push({ data, metadata }); return 'artifact://fixture'; } } };
    assert.equal((await tool.industrial_read_input.execute({ path: 'data/uploads/item/input.json' }, ctx)).structured.text, '{"length":42}');
    assert.equal((await tool.industrial_read_input.execute({ path: 'private.txt' }, ctx)).isError, true);
    assert.equal((await tool.industrial_read_input.execute({ path: 'data/uploads/item/escape.txt' }, ctx)).isError, true);
    const image = await tool.industrial_read_input.execute({ path: 'data/uploads/item/image.png' }, ctx);
    assert.deepEqual(image.content[1], { type: 'image', ref: 'artifact://fixture', mime: 'image/png' });
    assert.deepEqual(stored[0].data, imageBytes);
    assert.equal((await tool.industrial_get_document.execute({ documentId: '../private' }, ctx)).isError, true);
    const failed = await tool.industrial_geometry.execute({ operation: 'validate', input: { id: 'part' } }, ctx);
    assert.equal(failed.isError, true);
    assert.equal(failed.structured.error, 'dimension mismatch');
    const built = await tool.industrial_geometry.execute({ operation: 'build', input: { id: 'part' } }, ctx);
    assert.match(failed.structured.nextStep, /^repair:/);
    assert.match(built.structured.nextStep, /^validate:/);
    assert.equal(built.isError, false);
    assert.ok(tool.industrial_geometry.parameters.properties.operation.anyOf.some((value) => value.const === 'compare_views'));
    const compared = await tool.industrial_geometry.execute({ operation: 'compare_views', input: {
      source: { path: 'source.png', px_per_mm: 8 }, projection: { path: 'top.svg', px_per_mm: 6 },
      registration: { rotation_degrees: 0, translation_px: [0, 0], source_origin_px: [0, 0], projection_origin_px: [0, 0] },
      pre_cropped_views: true, tolerance_mm: 0.15, normalization_length_mm: 80,
    } }, ctx);
    assert.equal(compared.isError, false);
    assert.equal(JSON.parse(calls.at(-1).options.body).operation, 'compare_views');
    assert.equal(calls[0].url, 'http://127.0.0.1:4310/api/geometry');
    assert.deepEqual(JSON.parse(calls[0].options.body), { operation: 'validate', input: { id: 'part' } });
    assert.equal(tool.industrial_geometry.meta.isReadOnly, false);
    assert.equal(tool.industrial_geometry.meta.replay, 'never');
    assert.throws(() => localApi('https://example.com'), /127.0.0.1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('catalogue search filters stable identities and order review sends exact original text', async () => {
  const calls = [];
  const catalog = [
    { id: 'a', displayCode: 'FG-017', name: '带颈法兰', category: '连接件', format: 'STEP', material: null, privatePath: '/not/returned' },
    { id: 'b', displayCode: 'FG-019', name: '法兰支架', category: '支架', format: 'STL', material: 'steel' },
  ];
  const tools = Object.fromEntries(createIndustrialTools({ root: '/tmp', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/catalog')) return new Response(JSON.stringify(catalog));
    return new Response(JSON.stringify({ dataSource: 'synthetic_demo', items: [], summary: { canCommit: false } }));
  } }).map(tool => [tool.name, tool]));
  const found = await tools.industrial_search_catalog.execute({ query: '法兰', format: 'stl' });
  assert.equal(found.isError, false);
  assert.equal(found.structured.totalAssets, 2);
  assert.equal(found.structured.totalMatches, 1);
  assert.equal(found.structured.items[0].displayCode, 'FG-019');
  assert.equal('privatePath' in found.structured.items[0], false);
  assert.equal((await tools.industrial_search_catalog.execute({ query: 'FG-017' })).structured.items[0].material, null);
  assert.equal((await tools.industrial_search_catalog.execute({ query: 'unknown' })).structured.totalMatches, 0);
  assert.equal((await tools.industrial_search_catalog.execute({ limit: 46 })).isError, true);
  const text = '名称：法兰；数量：300\n备注：不得改成30';
  const result = await tools.industrial_review_order.execute({ text });
  assert.equal(result.structured.dataSource, 'synthetic_demo');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:4310/api/orders/review');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { text });
  assert.equal((await tools.industrial_review_order.execute({ text: '' })).isError, true);
  assert.equal(tools.industrial_review_order.meta.isReadOnly, true, 'Review must not allocate real inventory.');
});

test('clarification records missing evidence without generating geometry', async () => {
  const tool = Object.fromEntries(createIndustrialTools({ root: integration, fetchImpl: async () => { throw new Error('no network expected'); } }).map((tool) => [tool.name, tool]));
  const result = await tool.industrial_request_clarification.execute({ question: '请补充板厚', missing: [{ item: '厚度', evidence: '主视图标注为 ?' }] }, {});
  assert.deepEqual(result.structured, { success: true, status: 'needs_input', question: '请补充板厚', missing: [{ item: '厚度', evidence: '主视图标注为 ?' }], note: result.structured.note });
  assert.equal((await tool.industrial_request_clarification.execute({ question: '', missing: [] }, {})).isError, true);
});

test('geometry arguments serialised as {item:[...]} with numeric strings become the same plain plan', () => {
  const wrapped = { id: 'p-1', features: { item: [{ id: 'plate', op: 'box', size: { item: ['120', '80', '12'] } }, { id: 'bore', op: 'hole', diameter: '30', points: { item: { item: ['0', '0'] } } }] }, checks: { item: { kind: 'bbox', axis: 'x', expected: '120' } } };
  assert.deepEqual(normalizeToolInput(wrapped), { id: 'p-1', features: [{ id: 'plate', op: 'box', size: [120, 80, 12] }, { id: 'bore', op: 'hole', diameter: 30, points: [[0, 0]] }], checks: [{ kind: 'bbox', axis: 'x', expected: 120 }] });
  const nested = { features: { item: { item: [{ id: 'plate', op: 'box', size: '[120, 80, 12]' }, { id: 'bore', op: 'hole', diameter: '30', points: { item: ['0', '0'] } }] } } };
  assert.deepEqual(normalizeToolInput(nested), { features: [{ id: 'plate', op: 'box', size: [120, 80, 12] }, { id: 'bore', op: 'hole', diameter: 30, points: [[0, 0]] }] });
  const plain = { id: '7', name: '120', features: [{ id: 'a', op: 'box', size: [1, 2, 3] }] };
  assert.deepEqual(normalizeToolInput(plain), plain);
});
