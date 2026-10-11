import { createClient, memoryJournal } from './vendor-runtime/packages/sdk/src/index.node.ts';
import { exportSession } from './vendor-runtime/packages/cli/src/commands/export.ts';
import { daemonClientOptions, projectRoot } from './common.mjs';

/** Reuse the official CLI exporter and privacy filters through a fresh SDK client. Avoid
 * re-entering the CLI's macOS launcher identity bug after a model turn has finished. */
export async function exportTrace(sessionId, format, path, env) {
  if (!['agnes', 'html'].includes(format)) throw new Error('Unsupported trace export format.');
  const client = createClient({ ...await daemonClientOptions(env), auth: { kind: 'local' }, journal: memoryJournal() });
  try {
    await client.initialize();
    await exportSession({ positional: [sessionId], format, out: path, raw: false }, { cwd: projectRoot, io: { stdout: { write() {} }, stderr: { write() {} } } }, client);
  } finally { await client.close().catch(() => undefined); }
}
