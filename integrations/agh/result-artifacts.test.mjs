import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { integration } from './common.mjs';
import { geometryEventCollector, verifiedGeometryArtifacts } from './result-artifacts.mjs';

test('task success requires a paired geometry tool event and actual graph/STEP/GLB files', async () => {
  await mkdir(resolve(integration, '.local'), { recursive: true });
  const root = await mkdtemp(resolve(integration, '.local/resulttest-'));
  try {
    const dir = resolve(root, 'data/runs/unit-fixture');
    await mkdir(dir, { recursive: true });
    const files = { step: resolve(dir, 'model.step'), glb: resolve(dir, 'model.glb'), feature_plan: resolve(dir, 'feature-plan.json') };
    // File contract fixtures only; these bytes do not claim to be CAD engine output.
    await writeFile(files.step, 'ISO-10303-21;\nUNIT TEST HEADER ONLY');
    await writeFile(files.glb, 'glTFUNIT TEST HEADER ONLY');
    const result = { success: true, runId: 'unit-fixture', manifest: { operation: 'build', files, verification: { passed: true } }, artifacts: {} };
    const collector = geometryEventCollector();
    collector.accept({ type: 'assistant/message', data: { text: 'Claimed CAD completed' } });
    collector.accept({ type: 'tool/result', data: { toolUseId: 'unpaired', structured: result } });
    assert.equal(collector.results.length, 0);
    collector.accept({ type: 'tool/call', data: { toolUseId: 'paired', name: 'industrial_geometry' } });
    collector.accept({ type: 'tool/result', data: { toolUseId: 'paired', structured: result } });
    assert.equal((await verifiedGeometryArtifacts(collector.results, root)).length, 0);
    await writeFile(files.feature_plan, JSON.stringify({ features: [{ id: 'box', op: 'box', size: [1, 1, 1] }] }));
    assert.equal((await verifiedGeometryArtifacts(collector.results, root)).length, 1);
    collector.accept({ type: 'tool/call', data: { toolUseId: 'failed-check', name: 'industrial_geometry' } });
    collector.accept({ type: 'tool/result', data: { toolUseId: 'failed-check', structured: { success: true, manifest: { operation: 'validate', verification: { passed: false } } } } });
    assert.equal(collector.state.unresolvedFailure, true);
    collector.accept({ type: 'tool/result', data: { toolUseId: 'failed-check', structured: { success: true, manifest: { operation: 'validate', verification: { passed: true } } } } });
    assert.equal(collector.state.unresolvedFailure, false);
    const comparisonOnly = geometryEventCollector();
    comparisonOnly.accept({ type: 'tool/call', data: { toolUseId: 'comparison', name: 'industrial_geometry', args: { operation: 'compare_views' } } });
    comparisonOnly.accept({ type: 'tool/result', data: { toolUseId: 'comparison', structured: { success: true, runId: 'comparison-only', manifest: { operation: 'compare_views', verification: { passed: true } } } } });
    assert.equal(comparisonOnly.results.length, 0, 'A comparison is not a model-building artifact.');
    collector.accept({ type: 'tool/call', data: { toolUseId: 'comparison-failed', name: 'industrial_geometry', args: { operation: 'compare_views' } } });
    collector.accept({ type: 'tool/result', data: { toolUseId: 'comparison-failed', structured: { success: false, manifest: { operation: 'compare_views', verification: { passed: false } } } } });
    collector.accept({ type: 'tool/result', data: { toolUseId: 'paired', structured: result } });
    assert.equal(collector.state.unresolvedFailure, true, 'Successful geometry alone must not clear a failed view comparison.');
    collector.accept({ type: 'tool/result', data: { toolUseId: 'comparison-failed', structured: { success: true, manifest: { operation: 'compare_views', verification: { passed: true } } } } });
    assert.equal(collector.state.unresolvedFailure, false);
    await writeFile(files.feature_plan, JSON.stringify({ features: [] }));
    assert.equal((await verifiedGeometryArtifacts(collector.results, root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
