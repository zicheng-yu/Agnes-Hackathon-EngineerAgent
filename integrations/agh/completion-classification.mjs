/**
 * A narrowly bounded product outcome, never a rewrite of the official AGH turn result.
 * geometryRuns must come from verifiedGeometryArtifacts (real STEP/GLB/graph checks).
 * No file, session, trace or budget state is modified by this pure helper.
 */
export function classifyRecoveredSchemaFailure({ mode, result, error, events, geometryRuns, unresolvedGeometryFailure }) {
  if (mode !== 'reconstruct' || result?.reason !== 'blocked' || unresolvedGeometryFailure !== false
    || !Array.isArray(events) || !Array.isArray(geometryRuns) || !geometryRuns.length
    || (error && !['AGH_TURN_INCOMPLETE', 'HOOK_BLOCKED'].includes(error.code))) return null;
  const accepted = geometryRuns.filter(run => run?.verification?.passed === true
    && ['step', 'glb', 'feature_plan'].every(key => typeof run.files?.[key] === 'string' && run.files[key].length));
  if (accepted.length !== geometryRuns.length) return null;
  const acceptedIds = new Set(accepted.map(run => run.runId));
  const calls = new Map(), failures = [], repairs = [];
  let lastTurnVerdict, lastTurnEnd, schemaFailures = 0, index = 0;
  for (const event of events) {
    index++;
    const data = event?.data;
    if (event?.type === 'verifier/signal' && data?.scope === 'turn') lastTurnVerdict = data;
    if (event?.type === 'turn/end') lastTurnEnd = data;
    if (event?.type === 'tool/call' && typeof data?.toolUseId === 'string') calls.set(data.toolUseId, data);
    if (event?.type !== 'tool/result') continue;
    const call = calls.get(data?.toolUseId);
    const failed = data?.isError === true || data?.structured?.success === false;
    if (failed) {
      // Only a failed attempt at a later verified build of the same named plan qualifies.
      if (call?.name !== 'industrial_geometry' || !['build', 'patch', 'assembly'].includes(call.args?.operation)
        || typeof call.args?.input?.id !== 'string' || !call.args.input.id) return null;
      if (data.code === 'TOOL_ARGS_INVALID') schemaFailures++;
      failures.push({ index, toolUseId: data.toolUseId, operation: call.args.operation, planId: call.args.input.id });
    } else if (call?.name === 'industrial_geometry' && data?.structured?.success === true
      && data.structured.manifest?.verification?.passed === true && acceptedIds.has(data.structured.runId)) {
      repairs.push({ index, operation: call.args?.operation, planId: call.args?.input?.id, runId: data.structured.runId });
    }
  }
  if (!schemaFailures || !failures.length || failures.some(failure => !repairs.some(repair => repair.index > failure.index
    && repair.operation === failure.operation && repair.planId === failure.planId))) return null;
  if (lastTurnVerdict?.verdict !== 'fail' || !Array.isArray(lastTurnVerdict.reasons)
    || lastTurnVerdict.reasons.length !== 1 || lastTurnVerdict.reasons[0] !== 'schema_invalid') return null;
  if (lastTurnEnd?.reason !== 'blocked' || lastTurnEnd.error?.code !== 'HOOK_BLOCKED'
    || lastTurnEnd.error?.message !== 'Website task reached its maximum tool/model steps.') return null;
  const originalError = error || { code: 'AGH_TURN_INCOMPLETE', message: 'AGH did not complete this task.' };
  return {
    success: true,
    engineeringStatus: 'verified',
    runtimeStatus: 'blocked',
    runtimeCompleted: false,
    error: undefined,
    runtimeWarning: {
      code: 'AGH_HISTORICAL_SCHEMA_FAILURE',
      title: '产物已验证 · AGH 收尾异常',
      message: '实际 STEP、GLB 与特征计划已生成并通过列出的几何检查，失败的建模尝试已由同一零件的成功建模修复。固定版本 AGH 在回合收尾时仍把历史参数 schema 错误计为未通过，随后达到本任务步数上限；原 AGH 回合状态为 blocked，并未 completed。',
      originalReason: result.reason,
      originalError: { ...originalError },
      verifierReasons: [...lastTurnVerdict.reasons],
      repairedToolUseIds: failures.map(failure => failure.toolUseId),
      verifiedRunIds: [...acceptedIds],
      scope: '工程产物及列出的检查已完成；不代表 AGH 回合正常完成，也不代表制造认证。',
    },
  };
}
