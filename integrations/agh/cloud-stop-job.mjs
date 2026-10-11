/** Stop only a verified daemon created in one cloud job's fresh isolated home. */
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cli, environment, integration, projectRoot, profile, runtime } from './common.mjs';
import { verifiedExistingDaemonSocket } from './daemon-connection.mjs';
import { isWithin } from './cloud-runner-protocol.mjs';

try {
  const root = await realpath(process.argv[2]);
  if (!isWithin(await realpath(resolve(integration, '.local/cloud-jobs')), root)) throw new Error('Job is outside the cloud runner directory.');
  const env = environment(resolve(root, 'home'));
  // The official command is portable. The additional identity-checked fallback below fixes
  // this machine's known macOS boottime-clock issue without guessing at PIDs elsewhere.
  await cli(['daemon', 'stop'], env, 10000).catch(() => {});
  const owner = JSON.parse(await readFile(resolve(env.AGH_HOME, 'data/daemon/owner.json'), 'utf8'));
  if (await verifiedExistingDaemonSocket({ env, runtime, projectRoot, profile }) === owner.socketPath) process.kill(owner.pid, 'SIGTERM');
} catch { /* No unverified process is killed and no credential/path is logged. */ }
