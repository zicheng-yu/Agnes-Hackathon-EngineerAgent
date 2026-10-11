import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const invalid = () => new Error('Existing project AGH daemon identity or scope could not be verified.');

/** kern.boottime may drift under macOS clock correction. PID + exact libproc process-start
 * timestamp remain mandatory; tolerate only sub-second boot-clock movement, never PID reuse. */
export function sameMacProcess(recorded, observed, pid) {
  const expected = /^darwin:(\d+\.\d+):(\d+):(\d+\.\d+)$/.exec(recorded || '');
  const actual = /^alive (\d+\.\d+) (\d+\.\d+)\s*$/.exec(observed || '');
  return Boolean(expected && actual && Number(expected[2]) === pid && expected[3] === actual[2] && Math.abs(Number(expected[1]) - Number(actual[1])) < 1);
}

async function privateJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw invalid();
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function verifiedExistingDaemonSocket({ env, runtime, profile, projectRoot }) {
  if (process.platform !== 'darwin') return null;
  const home = await realpath(env.AGH_HOME);
  const dataDir = resolve(home, 'data');
  const ownerPath = resolve(dataDir, 'daemon/owner.json');
  let owner;
  try { owner = await privateJson(ownerPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.generation !== 'string') throw invalid();
  const binary = resolve(runtime, 'packages/cli/dist/local/native/macos-process-identity');
  const identify = async () => {
    try { return (await exec(binary, [String(owner.pid)], { timeout: 2000, maxBuffer: 4096 })).stdout; }
    catch (error) { if (error.code === 1 && error.stdout?.trim() === 'dead') return null; throw invalid(); }
  };
  const first = await identify();
  if (!first || !sameMacProcess(owner.processStartId, first, owner.pid)) return null;
  const executable = (await exec('ps', ['-p', String(owner.pid), '-o', 'comm='], { timeout: 2000 })).stdout.trim();
  if (await realpath(executable) !== await realpath(process.execPath)) throw invalid();
  const args = (await exec('ps', ['-p', String(owner.pid), '-o', 'args='], { timeout: 2000 })).stdout.trim();
  const prefix = `${executable} ${resolve(runtime, 'packages/cli/dist/local/daemon.mjs')} --profile ${profile} --workspace ${projectRoot} --data-dir ${dataDir}`;
  if (args !== prefix && !(args.startsWith(`${prefix} --local-web-addr `) && /^ --local-web-addr \S+ --local-web-origin \S+$/.test(args.slice(prefix.length)))) throw invalid();
  const discovery = await privateJson(resolve(dataDir, 'daemon/discovery.json'));
  const scopeID = `sha256-${createHash('sha256').update(JSON.stringify([home, profile, dataDir])).digest('hex')}`;
  if (discovery.protocol !== 'agnesd-discovery' || discovery.version !== 1 || discovery.ready !== true || discovery.scopeID !== scopeID || discovery.profile !== profile || discovery.dataDir !== dataDir || discovery.socketPath !== owner.socketPath || discovery.owner?.pid !== owner.pid || discovery.owner?.processStartId !== owner.processStartId || discovery.owner?.generation !== owner.generation) throw invalid();
  const socket = await lstat(owner.socketPath);
  const socketDir = await lstat(dirname(owner.socketPath));
  if (!socket.isSocket() || socket.isSymbolicLink() || !socketDir.isDirectory() || socketDir.isSymbolicLink() || (socket.mode & 0o077) || (socketDir.mode & 0o077) || (process.getuid && (socket.uid !== process.getuid() || socketDir.uid !== process.getuid()))) throw invalid();
  const { createClient, memoryJournal } = await import('./vendor-runtime/packages/sdk/src/index.node.ts');
  const client = createClient({ transport: { kind: 'unix', path: owner.socketPath }, auth: { kind: 'local' }, journal: memoryJournal(), timeouts: { initialize: 5000, request: 5000 } });
  try {
    await client.initialize();
    const apis = await client.apis();
    if (apis.profile.name !== profile) throw invalid();
    const after = await privateJson(ownerPath);
    const again = await identify();
    if (after.generation !== owner.generation || after.pid !== owner.pid || after.processStartId !== owner.processStartId || after.socketPath !== owner.socketPath || !again || !sameMacProcess(owner.processStartId, again, owner.pid)) throw invalid();
    return owner.socketPath;
  } finally { await client.close().catch(() => undefined); }
}
