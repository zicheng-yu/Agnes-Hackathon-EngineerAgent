import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';

// Identify this checkout without exposing its local path through the API.
export function serviceIdentity(root) {
  const canonical = realpathSync(root);
  return createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
}

export function isProjectService(value, identity) {
  return value?.application === 'EngineerAgent' && value?.instanceId === identity;
}

export async function inspectLocalPort(port, identity) {
  const available = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => ['EADDRINUSE', 'EACCES'].includes(error.code) ? resolve(false) : reject(error));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
  if (available) return { available: true, running: false };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    if (response.ok && isProjectService(await response.json(), identity)) return { available: false, running: true };
  } catch {}
  return { available: false, running: false };
}

export async function selectLocalService({ root, preferred = 4310, allowFallback = true, inspect = inspectLocalPort }) {
  const identity = serviceIdentity(root);
  const maximum = Math.min(65535, preferred + (allowFallback ? 19 : 0));
  for (let port = preferred; port <= maximum; port++) {
    const result = await inspect(port, identity);
    if (result.available || result.running) return { port, identity, running: result.running };
  }
  throw new Error(allowFallback
    ? `端口 ${preferred}–${maximum} 均被占用。请设置 PORT 为其他空闲端口后重试。`
    : `指定端口 ${preferred} 已被其他程序占用。请改用其他 PORT，或取消 PORT 设置以自动选择空闲端口。`);
}
