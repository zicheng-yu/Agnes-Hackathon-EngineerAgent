import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { createClient, memoryJournal } from './vendor-runtime/packages/sdk/src/index.node.ts';
import { allowedInputPath } from './industrial-tools/index.mjs';
import { integration, projectRoot, environment, daemonClientOptions, installPlugin } from './common.mjs';
import { checkModelCapabilities, configureModel, modelSettings, selectSessionModel } from './model-config.mjs';
import { geometryEventCollector, verifiedGeometryArtifacts } from './result-artifacts.mjs';
import { businessEventCollector, instructionsForMode } from './task-modes.mjs';
import { exportTrace } from './export-trace.mjs';

if (process.env.AGH_ALLOW_MODEL_RUN !== '1') throw new Error('MODEL_RUN_DISABLED');
const settings = modelSettings(process.env);
delete process.env.AGNES_API_KEY;
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--input') throw new Error('Expected --input data/uploads/ID/task.json');
const taskFile = await allowedInputPath(projectRoot, args[1]);
const task = JSON.parse(await readFile(taskFile.actual, 'utf8'));
const mode = task.mode || 'reconstruct';
const instructions = instructionsForMode(mode);
if (typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 100000) throw new Error('Task requires a non-empty prompt up to 100000 characters.');
if (task.images && (!Array.isArray(task.images) || task.images.length > 4)) throw new Error('At most 4 local drawing images per task with the current runtime profile.');
await checkModelCapabilities(settings, task.images?.length || 0);
const content = [{ type: 'text', text: `${instructions}\n\nUSER TASK:\n${task.prompt}` }];
for (const path of task.images || []) {
  const file = await allowedInputPath(projectRoot, path);
  const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extname(file.actual).toLowerCase()];
  if (!mimeType) throw new Error('Vision input must be PNG/JPEG; convert PDF pages first.');
  if (file.info.size > 4 * 1024 * 1024) throw new Error('Resize each vision input below 4 MiB before submission.');
  content[0].text += `\nAttached image already visible; optional read tool path: ${file.relative}. Use only supplied paths; never invent a file path.`;
  content.push({ type: 'image', data: (await readFile(file.actual)).toString('base64'), mimeType });
}
const env = environment();
const client = createClient({ ...await daemonClientOptions(env), auth: { kind: 'local' }, journal: memoryJournal() });
const outputDir = resolve(integration, '.local/runs', randomUUID());
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const taskWorkspace = resolve(outputDir, 'workspace');
await mkdir(taskWorkspace, { mode: 0o700 });
let session;
let result;
let failure;
let trace;
let html;
let modelRequestSubmitted = false;
let modelConnection;
const geometryEvents = geometryEventCollector();
const businessEvents = mode === 'reconstruct' ? null : businessEventCollector(mode, task.prompt);
const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cancellation.abort());
try {
  await client.initialize();
  // This branch is only reachable after explicit application enablement; upstream config.save
  // verifies the remote catalogue and owns secret storage in this project's isolated home.
  modelConnection = await configureModel(client, settings, task.images?.length || 0);
  settings.apiKey = '';
  const plugin = await installPlugin(client);
  await client.workspace.add(taskWorkspace);
  session = await client.session.new({ cwd: taskWorkspace, sessionKey: `agnes:local:local-dev:cli:session:${randomUUID()}` });
  await selectSessionModel(session, modelConnection);
  console.log(JSON.stringify({ type: 'session', mode, sessionId: session.id, plugin, model: modelConnection, outputDir }));
  session.listeners.add((method, params) => {
    if (method === '_agnes/v1/session.event') {
      geometryEvents.accept(params.event);
      businessEvents?.accept(params.event);
      console.log(JSON.stringify({ type: 'agh_event', event: params.event }));
    }
  });
  await session.attach();
  modelRequestSubmitted = true;
  result = await session.prompt(content, { signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10 * 60 * 1000)]), titleLocale: 'zh-CN' });
} catch (error) {
  failure = { code: error.code || 'AGH_TASK_FAILED', message: error.message };
} finally {
  settings.apiKey = '';
  await client.close().catch(() => undefined);
  if (session) {
    try {
      await exportTrace(session.id, 'agnes', resolve(outputDir, 'trace.agnes.jsonl'), env);
      trace = resolve(outputDir, 'trace.agnes.jsonl');
      await exportTrace(session.id, 'html', resolve(outputDir, 'trace.html'), env);
      html = resolve(outputDir, 'trace.html');
    } catch {
      failure ||= { code: 'TRACE_EXPORT_FAILED', message: 'AGH trace export did not complete; the durable session remains in the isolated home.' };
    }
  }
}
const geometryRuns = mode === 'reconstruct' ? await verifiedGeometryArtifacts(geometryEvents.results, projectRoot).catch(() => []) : [];
if (!failure && mode === 'reconstruct' && geometryEvents.state.unresolvedFailure) {
  failure = { code: 'GEOMETRY_VALIDATION_UNRESOLVED', message: 'A geometry tool failure or failed dimension check remains unresolved. Available earlier artifacts are retained but do not establish task success.' };
}
if (!failure && mode === 'reconstruct' && result?.reason === 'completed' && !geometryRuns.length) {
  failure = { code: 'NO_VERIFIED_GEOMETRY', message: 'The model turn finished without a verified geometry tool result and actual STEP, GLB, feature/assembly graph files. A text answer is not a reconstruction result.' };
}
const latestGeometry = geometryRuns.at(-1);
const business = businessEvents?.outcome();
if (!failure && result?.reason === 'completed' && business && !business.success) failure = business.error;
const summary = { type: 'result', mode, success: !failure && result?.reason === 'completed', execution: 'real-model', modelRequestSubmitted, sessionId: session?.id, result, error: failure, trace, html, geometryRuns, artifacts: latestGeometry?.artifacts, graph: latestGeometry?.files.feature_plan, orderReview: business?.orderReview, catalogResults: business?.catalogResults, toolEvidence: business?.toolEvidence };
await writeFile(resolve(outputDir, 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary));
if (!summary.success) process.exitCode = 1;
