import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function geometryEventCollector() {
  const calls = new Map();
  const results = [];
  const state = { unresolvedFailure: false, geometryFailure: false, comparisonFailure: false };
  return {
    results, state,
    accept(event) {
      if (event?.type === 'tool/call') calls.set(event.data.toolUseId, { name: event.data.name, operation: event.data.args?.operation });
      const call = calls.get(event?.data?.toolUseId);
      if (event?.type === 'tool/result' && call?.name === 'industrial_geometry') {
        const value = event.data.structured;
        const operation = value?.manifest?.operation || call.operation;
        const failureKind = operation === 'compare_views' ? 'comparisonFailure' : 'geometryFailure';
        if (event.data.isError || value?.success === false || value?.manifest?.status === 'failed' || value?.manifest?.verification?.passed === false) state[failureKind] = true;
        else if (value?.manifest?.verification?.passed === true) state[failureKind] = false;
        state.unresolvedFailure = state.geometryFailure || state.comparisonFailure;
        if (!event.data.isError && value?.success && value.runId && ['build', 'patch', 'assembly'].includes(value.manifest?.operation)) results.push(value);
      }
    },
  };
}

/** Verify files produced by an actual geometry tool result, not paths claimed in model prose. */
export async function verifiedGeometryArtifacts(results, root) {
  const accepted = [];
  const runs = await realpath(resolve(root, 'data/runs'));
  for (const result of results) {
    if (!/^[A-Za-z0-9_-]+$/.test(result.runId)) continue;
    const runRoot = resolve(runs, result.runId);
    const files = result.manifest?.files;
    if (!files || result.manifest.verification?.passed !== true) continue;
    const checked = {};
    try {
      for (const key of ['step', 'glb', 'feature_plan']) {
        const file = await realpath(files[key]);
        const rel = relative(runRoot, file);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Artifact is outside its run directory.');
        if (!(await stat(file)).isFile()) throw new Error('Artifact is not a file.');
        const bytes = await readFile(file);
        if (!bytes.length) throw new Error('Artifact is empty.');
        if (key === 'step' && !bytes.toString('utf8').startsWith('ISO-10303-21;')) throw new Error('Invalid STEP header.');
        if (key === 'glb' && bytes.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('Invalid GLB header.');
        if (key === 'feature_plan') {
          const plan = JSON.parse(bytes.toString('utf8'));
          if (!(Array.isArray(plan.features) && plan.features.length) && !(Array.isArray(plan.parts) && plan.parts.length && Array.isArray(plan.instances) && plan.instances.length)) throw new Error('Missing saved feature/assembly graph.');
        }
        checked[key] = file;
      }
      accepted.push({ runId: result.runId, operation: result.manifest.operation, files: checked, artifacts: result.artifacts, verification: result.manifest.verification });
    } catch { /* Incomplete or mismatched tool output cannot establish task success. */ }
  }
  return accepted;
}
