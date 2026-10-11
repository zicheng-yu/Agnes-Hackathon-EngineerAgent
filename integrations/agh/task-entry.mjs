try {
  await import('./task-worker.mjs');
} catch (error) {
  const known = typeof error.code === 'string' && error.code.startsWith('MODEL_');
  console.log(JSON.stringify({
    type: 'result', success: false, modelRequestSubmitted: false,
    error: { code: known ? error.code : 'AGH_TASK_START_FAILED', message: known ? error.message : 'Task startup failed. Check the input JSON, local paths and AGH build; no provider details or credentials are included.' },
  }));
  process.exitCode = 2;
}
