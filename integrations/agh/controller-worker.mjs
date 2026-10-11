import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createClient, memoryJournal } from './vendor-runtime/packages/sdk/src/index.node.ts';
import { integration, projectRoot, runtime, profile, environment, daemonClientOptions, installPlugin, cli } from './common.mjs';
import { allowedInputPath } from './industrial-tools/index.mjs';
import { controllerModel, controllerRoute, controllerProfile, startControllerTransport, validateDecision } from './controller-transport.mjs';
import { geometryEventCollector, verifiedGeometryArtifacts } from './result-artifacts.mjs';
import { exportTrace } from './export-trace.mjs';
import { selectSessionModel } from './model-config.mjs';
import { verifiedExistingDaemonSocket } from './daemon-connection.mjs';
import { configureControllerInput } from './controller-input.mjs';

const args = process.argv.slice(2);
const interactive = args.length === 1 && args[0] === '--stdio';
let batch;
if (!interactive) {
  if (args.length !== 2 || args[0] !== '--input') throw new Error('Use --stdio or --input data/uploads/ID/controller.json.');
  const input = await allowedInputPath(projectRoot, args[1]);
  batch = JSON.parse(await readFile(input.actual, 'utf8'));
  if (!['external-codex-assisted', 'controller-transport-smoke'].includes(batch.execution) || !Array.isArray(batch.decisions) || !batch.decisions.length || batch.decisions.length > 16) throw new Error('Batch requires explicit execution provenance and 1–16 decisions.');
  batch.decisions = batch.decisions.map(validateDecision);
}
const execution = batch?.execution || 'external-codex-assisted';
const decisionMode = interactive ? 'live-stdin' : 'batch-replay';
await mkdir(resolve(integration, '.local'), { recursive: true, mode: 0o700 });
const outputDir = await mkdtemp(resolve(integration, '.local/controller-'));
const env = environment(resolve(outputDir, 'home'));
const workspace = resolve(outputDir, 'workspace');
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(resolve(env.AGH_HOME, 'profiles/local-dev'), { recursive: true, mode: 0o700 });
const transport = await startControllerTransport();
// Generated solely for this loopback process; never printed or written to the profile.
env.AGNES_SECRET_CONTROLLER_TRANSPORT = transport.token;
await writeFile(resolve(env.AGH_HOME, 'profiles/local-dev/profile.yaml'), JSON.stringify(controllerProfile(transport.baseUrl), null, 2), { mode: 0o600 });
const emit = value => console.log(JSON.stringify(value));
const geometry = geometryEventCollector();
const paired = new Map();
const steps = [];
const decisionsPath = resolve(outputDir, 'controller-decisions.jsonl');
let client, session, error, trace, html;
let inputLines;
const cancellation = new AbortController();
const cancel = () => { cancellation.abort(); inputLines?.close(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, cancel);
// Set raw before readiness is announced, so a caller's first long plan cannot be truncated.
const restoreInput = interactive ? configureControllerInput(process.stdin, cancel) : () => undefined;
try {
  client = createClient({ ...await daemonClientOptions(env), auth: { kind: 'local' }, journal: memoryJournal() });
  await client.initialize();
  const plugin = await installPlugin(client);
  await client.workspace.add(workspace);
  session = await client.session.new({ cwd: workspace, sessionKey: `agnes:local:local-dev:cli:session:${randomUUID()}` });
  await selectSessionModel(session, { route: controllerRoute, model: controllerModel });
  session.listeners.add((method, params) => {
    if (method !== '_agnes/v1/session.event') return;
    const event = params.event;
    geometry.accept(event);
    if (event.type === 'tool/call') paired.set(event.data.toolUseId, { call: event.data });
    if (event.type === 'tool/result' && paired.has(event.data.toolUseId)) paired.get(event.data.toolUseId).result = event.data;
    emit({ type: 'agh_event', execution, event });
  });
  await session.attach();
  if (cancellation.signal.aborted) throw new Error('Controller session cancelled.');
  emit({ type: 'controller_ready', execution, decisionMode, autonomousAgnes: false, localInference: false, externalModelApiCalls: 0, route: controllerRoute, model: controllerModel, sessionId: session.id, outputDir, plugin });
  const run = async raw => {
    if (steps.length >= 16) throw new Error('Controller session is limited to 16 decisions.');
    const decision = validateDecision(raw);
    const previous = new Set(paired.keys());
    await appendFile(decisionsPath, JSON.stringify({ ...decision, execution, receivedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    transport.queue(decision);
    const turn = await session.prompt(`EXTERNAL CONTROLLER DECISION. This is ${execution}, not autonomous Agnes reasoning. The loopback endpoint only forwards an explicit decision from the current Codex conversation.\n${JSON.stringify(decision)}`, { signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(120000)]), titleLocale: 'en' });
    const outcomes = [...paired].filter(([id]) => !previous.has(id)).map(([toolUseId, value]) => ({ toolUseId, ...value }));
    const exact = outcomes.find(value => value.call.name === decision.name && isDeepStrictEqual(value.call.args, decision.args));
    const result = exact?.result;
    const success = turn.reason === 'completed' && !transport.pending && outcomes.length === 1 && Boolean(result) && !result.isError && result.structured?.success !== false && result.structured?.manifest?.verification?.passed !== false;
    const step = { type: 'controller_step', execution, decisionId: decision.id, success, name: decision.name, toolUseId: exact?.toolUseId, result: result?.structured, error: success ? undefined : 'The real AGH tool call/result did not establish successful execution.', turn };
    steps.push(step);
    emit(step);
    return success;
  };
  if (interactive) {
    const lines = inputLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (cancellation.signal.aborted) break;
      if (!line.trim()) continue;
      const command = JSON.parse(line);
      if (command.type === 'finish') { lines.close(); break; }
      await run(command);
      if (cancellation.signal.aborted) break;
    }
  } else for (const decision of batch.decisions) { if (!await run(decision)) break; }
} catch (failure) {
  // No credentials/provider bodies are emitted on errors.
  error = { code: 'CONTROLLER_RUN_FAILED', message: String(failure.message).replaceAll(transport.token, '[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1500) };
} finally {
  restoreInput();
  await client?.close().catch(() => undefined);
  if (session) try {
    trace = resolve(outputDir, 'trace.agnes.jsonl'); html = resolve(outputDir, 'trace.html');
    await exportTrace(session.id, 'agnes', trace, env);
    await exportTrace(session.id, 'html', html, env);
  } catch { error ||= { code: 'TRACE_EXPORT_FAILED', message: 'The controller ledger could not be exported.' }; }
  try {
    // Only this fresh runner-owned home is stopped. Never remove an active lock.
    await cli(['daemon', 'stop'], env);
    const owner = JSON.parse(await readFile(resolve(env.AGH_HOME, 'data/daemon/owner.json'), 'utf8'));
    if (await verifiedExistingDaemonSocket({ env, runtime, profile, projectRoot }) === owner.socketPath) process.kill(owner.pid, 'SIGTERM');
  } catch { /* A normally stopped daemon no longer has an owner record. */ }
  await transport.close();
}
const geometryRuns = await verifiedGeometryArtifacts(geometry.results, projectRoot).catch(() => []);
if (cancellation.signal.aborted) error ||= { code: 'CONTROLLER_CANCELLED', message: 'The external controller session was cancelled.' };
const success = !error && steps.length > 0 && steps.at(-1).success && !geometry.state.unresolvedFailure && (interactive || steps.length === batch.decisions.length);
const summary = { type: 'result', execution, decisionMode, success, autonomousAgnes: false, localInference: false, externalModelApiCalls: 0, sessionId: session?.id, outputDir, controllerDecisions: decisionsPath, steps, geometryRuns, artifacts: geometryRuns.at(-1)?.artifacts, trace, html, error, scope: 'Actual AGH tool execution of externally supplied Codex decisions; not autonomous Agnes model reasoning or full drawing acceptance.' };
await writeFile(resolve(outputDir, 'result.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
emit(summary);
if (!success) process.exitCode = 1;
