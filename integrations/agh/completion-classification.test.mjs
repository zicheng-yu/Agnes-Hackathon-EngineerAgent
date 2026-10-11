import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecoveredSchemaFailure } from './completion-classification.mjs';

const call = (id, operation = 'build', planId = 'part-1') => ({ type: 'tool/call', data: { toolUseId: id, name: 'industrial_geometry', args: { operation, input: { id: planId } } } });
const failed = (id, code) => ({ type: 'tool/result', data: { toolUseId: id, isError: true, ...(code ? { code } : { structured: { success: false } }) } });
const success = id => ({ type: 'tool/result', data: { toolUseId: id, isError: false, structured: { success: true, runId: 'run-1', manifest: { verification: { passed: true } } } } });
const fixture = () => ({
  mode: 'reconstruct', result: { reason: 'blocked', lastSeq: 143 }, error: { code: 'AGH_TURN_INCOMPLETE', message: 'AGH did not complete this task.' }, unresolvedGeometryFailure: false,
  geometryRuns: [{ runId: 'run-1', verification: { passed: true }, files: { step: 'actual/model.step', glb: 'actual/model.glb', feature_plan: 'actual/feature-plan.json' } }],
  events: [call('invalid'), failed('invalid', 'TOOL_ARGS_INVALID'), call('kernel-error'), failed('kernel-error'), call('repaired'), success('repaired'),
    { type: 'verifier/signal', data: { scope: 'turn', verdict: 'fail', reasons: ['schema_invalid'] } },
    { type: 'turn/end', data: { reason: 'blocked', error: { code: 'HOOK_BLOCKED', message: 'Website task reached its maximum tool/model steps.' } } }],
});

test('only repaired historical schema failures classify engineering artifacts without rewriting AGH', () => {
  const input = fixture(); const before = structuredClone(input);
  const outcome = classifyRecoveredSchemaFailure(input);
  assert.equal(outcome.success, true);
  assert.equal(outcome.engineeringStatus, 'verified');
  assert.equal(outcome.runtimeStatus, 'blocked');
  assert.equal(outcome.runtimeCompleted, false);
  assert.deepEqual(outcome.runtimeWarning.originalError, input.error);
  assert.match(outcome.runtimeWarning.message, /并未 completed/);
  assert.deepEqual(outcome.runtimeWarning.repairedToolUseIds, ['invalid', 'kernel-error']);
  assert.deepEqual(input, before);
});

test('no artifacts, unresolved errors, budget stops and unrelated errors remain failed', () => {
  const base = fixture();
  for (const change of [
    { mode: 'catalog_search' }, { geometryRuns: [] }, { unresolvedGeometryFailure: true },
    { result: { reason: 'budget' } }, { result: { reason: 'error' } },
    { error: { code: 'TRACE_EXPORT_FAILED' } },
    { geometryRuns: [{ ...base.geometryRuns[0], files: { step: 'only.step' } }] },
    { geometryRuns: [{ ...base.geometryRuns[0], verification: { passed: false } }] },
  ]) assert.equal(classifyRecoveredSchemaFailure({ ...base, ...change }), null);
});

test('same-plan later verified repair and the sole historical schema verdict are mandatory', () => {
  const variants = [
    input => { input.events[4] = call('repaired', 'build', 'unrelated-part'); },
    input => { input.events.splice(4, 2); },
    input => { input.events[6].data.reasons.push('output_truncated'); },
    input => { input.events[6].data.reasons = ['no_progress:4']; },
    input => { input.events[7].data.error.message = 'Some other guard blocked this task.'; },
    input => { input.events[0].data.name = 'shell'; },
    input => { input.events[1].data.code = 'SOME_OTHER_ERROR'; },
    input => { input.events.splice(6, 0, call('late-invalid'), failed('late-invalid', 'TOOL_ARGS_INVALID')); },
  ];
  for (const mutate of variants) { const input = fixture(); mutate(input); assert.equal(classifyRecoveredSchemaFailure(input), null); }
});
