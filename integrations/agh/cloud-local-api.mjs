import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { checkCloudTool } from './cloud-guard/index.mjs';
import { localApi } from './industrial-tools/index.mjs';

/** Narrow loopback bridge, not a tunnel. It never exposes settings or arbitrary HTTP paths. */
export async function startCloudLocalApi({ upstream, policy, signal, fetchImpl = fetch }) {
  const origin = localApi(upstream);
  const runs = new Set();
  await writeFile(policy.runRegistry, '[]', { mode: 0o600 });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    try {
      let payload;
      if (request.method === 'POST') {
        let size = 0;
        const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request exceeds 1 MiB.'); chunks.push(chunk); }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      let path;
      if (request.method === 'GET' && request.url === '/api/catalog') path = '/api/catalog';
      else if (request.method === 'POST' && request.url === '/api/orders/review' && typeof payload?.text === 'string' && payload.text.length <= 100000) path = '/api/orders/review';
      else if (request.method === 'POST' && request.url === '/api/geometry') {
        const guard = await checkCloudTool({ name: 'industrial_geometry', args: payload }, policy);
        if (!guard.allow) throw new Error(guard.reason);
        // The current CAD DSL has no file-import operation; source/projection are the only
        // documented filesystem arguments. Reject future/invented path fields fail-closed.
        const scan = (node, parent = '') => {
          if (!node || typeof node !== 'object') return;
          for (const [key, value] of Object.entries(node)) {
            if (/(?:path|file(?:name)?|url|uri)$/i.test(key) && !(payload.operation === 'compare_views' && key === 'path' && ['source', 'projection'].includes(parent))) throw new Error('Unsupported filesystem field in CAD input.');
            scan(value, key);
          }
        };
        scan(payload.input);
        path = '/api/geometry';
      } else { response.writeHead(404).end(JSON.stringify({ success: false, error: 'Local resource is not available to website tasks.' })); return; }
      const remote = await fetchImpl(`${origin}${path}`, { method: request.method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]), ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
      const text = await remote.text();
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Local result exceeds 2 MiB.');
      const result = JSON.parse(text);
      if (path === '/api/geometry' && /^[A-Za-z0-9_-]{8,128}$/.test(result.runId || '')) {
        runs.add(result.runId);
        await writeFile(policy.runRegistry, JSON.stringify([...runs]), { mode: 0o600 });
      }
      response.writeHead(remote.status).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(422).end(JSON.stringify({ success: false, error: String(error.message).slice(0, 800) }));
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${server.address().port}`, runs, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}
