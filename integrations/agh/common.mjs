import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifiedExistingDaemonSocket } from './daemon-connection.mjs';
import { runtimeEnvironment } from '../../server/runtime-environment.mjs';

export const integration = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(integration, '../..');
export const runtime = resolve(integration, 'vendor-runtime');
export const entry = resolve(runtime, 'packages/cli/dist/local/agnes.mjs');
export const profile = 'local-dev';
export const packageId = '@panpan/industrial-tools';
const exec = promisify(execFile);

export function isolatedHome(home) {
  const local = resolve(realpathSync(integration), '.local');
  const target = resolve(home);
  const isChild = path => { const rel = relative(local, path); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  if (!isChild(target)) throw new Error('AGH_INDUSTRIAL_HOME must be a child directory of integrations/agh/.local.');
  let ancestor = target;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  let actual;
  try { actual = resolve(realpathSync(ancestor), relative(ancestor, target)); }
  catch { throw new Error('AGH_INDUSTRIAL_HOME symlink escapes or points to an unavailable directory.'); }
  if (!isChild(actual)) throw new Error('AGH_INDUSTRIAL_HOME symlink escapes the project-local integration directory.');
  return target;
}

// A new plugin content hash uses a new development home. Existing accounts and package
// snapshots stay untouched; installPlugin still uses official inspect/install/trust/enable.
export function environment(home = process.env.AGH_INDUSTRIAL_HOME || resolve(integration, '.local/home-v0.2.1')) {
  return {
    ...runtimeEnvironment(),
    AGH_HOME: isolatedHome(home), AGNES_PROFILE: profile, AGH_INDUSTRIAL_ROOT: projectRoot,
    AGH_INDUSTRIAL_API: process.env.AGH_INDUSTRIAL_API || 'http://127.0.0.1:4310',
  };
}

export async function privateDirectory(directory) {
  if (process.platform === 'win32') {
    const { windowsEnsurePrivateDirectorySync } = await import('./vendor-runtime/packages/system-node/src/index.ts');
    windowsEnsurePrivateDirectorySync(directory);
  } else await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function prepareHome(env) {
  await privateDirectory(resolve(env.AGH_HOME, 'profiles', profile));
  const path = resolve(env.AGH_HOME, 'profiles', profile, 'profile.yaml');
  try { await writeFile(path, 'name: local-dev\ncomputerUse:\n  enabled: false\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export async function cli(args, env, timeout = 60000) {
  return exec(process.execPath, [entry, ...args], {
    cwd: projectRoot, env, timeout, maxBuffer: 16 * 1024 * 1024,
  });
}

export async function daemonSocket(env) {
  await prepareHome(env);
  const existing = await verifiedExistingDaemonSocket({ env, runtime, profile, projectRoot });
  if (existing) return existing;
  await cli(['sessions', '--json'], env);
  const owner = JSON.parse(await readFile(resolve(env.AGH_HOME, 'data/daemon/owner.json'), 'utf8'));
  return owner.socketPath;
}

/** Use upstream verified discovery for Windows pipes; retain Unix socket handling. */
export async function daemonClientOptions(env) {
  const socketPath = await daemonSocket(env);
  const transport = { kind: 'unix', path: socketPath };
  if (process.platform !== 'win32') return { transport };
  const { resolveDaemonScope, readDaemonDiscovery } = await import('./vendor-runtime/packages/daemon/src/index.ts');
  const { localPipeFactories } = await import('./vendor-runtime/packages/cli/src/boot/pipe-factory.ts');
  const scope = await resolveDaemonScope({ env, home: env.AGH_HOME, profile, cwd: projectRoot });
  const discovery = await readDaemonDiscovery(scope);
  if (!discovery || discovery.socketPath !== socketPath) throw new Error('AGH daemon pipe identity could not be verified.');
  transport.serverIdentity = { pid: discovery.owner.pid, processStartId: discovery.owner.processStartId };
  return { transport, transportFactories: localPipeFactories(socketPath, scope) };
}

export async function waitOperation(client, receipt) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const operation = await client.packages.operation.get({ profile, operationId: receipt.operationId });
    if (['completed', 'failed', 'cancelled', 'rolled-back'].includes(operation.state)) {
      if (operation.state !== 'completed') throw new Error(`Package operation ${operation.state}: ${operation.error?.safeMessage || ''}`);
      return operation;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Package operation timed out: ${receipt.operationId}`);
}

export async function installPlugin(client) {
  const { randomUUID } = await import('node:crypto');
  const base = () => ({ profile, clientId: undefined, commandId: randomUUID() });
  const clientId = await client.clientId();
  const params = () => ({ ...base(), clientId });
  // Official PackageSource intentionally accepts only workspace-relative file:./ paths.
  const source = { type: 'file', ref: 'file:./integrations/agh/industrial-tools' };
  const inspected = await waitOperation(client, await client.packages.inspect({ ...params(), source }));
  const preview = inspected.preview;
  if (!preview || preview.blockers.length) throw new Error('Industrial plugin inspection was blocked.');
  const listed = (await client.packages.list({ profile })).packages.find((p) => p.id === packageId);
  if (listed && listed.integrity !== preview.integrity) {
    throw new Error('Installed plugin differs from source. Update through AGH package management or use a fresh isolated home.');
  }
  if (!listed) await waitOperation(client, await client.packages.install({ ...params(), source, expectedIntegrity: preview.integrity }));
  await waitOperation(client, await client.packages.trust({ ...params(), id: packageId, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash }));
  await waitOperation(client, await client.packages.enable({ ...params(), id: packageId }));
  const actual = (await client.packages.list({ profile })).packages.find((p) => p.id === packageId);
  if (!actual || actual.actual !== 'running' || !actual.trusted) throw new Error('Industrial plugin has not reached running/trusted state.');
  return { id: actual.id, version: actual.version, actual: actual.actual, trusted: actual.trusted, integrity: preview.integrity, capabilityHash: preview.capabilityHash };
}
