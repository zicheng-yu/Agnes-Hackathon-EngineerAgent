import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const controllerRoute = 'external-codex-controller';
export const controllerModel = 'codex-current-conversation';
const tools = new Set(['industrial_read_input', 'industrial_get_document', 'industrial_search_catalog', 'industrial_review_order', 'industrial_geometry']);

export function validateDecision(value) {
  if (!value || value.type !== 'tool' || !tools.has(value.name) || !value.args || typeof value.args !== 'object' || Array.isArray(value.args) || typeof value.decision !== 'string' || !value.decision.trim() || value.decision.length > 8000) throw new Error('A controller decision requires type=tool, an allowed industrial tool name, object args and a short evidence/decision summary.');
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('Controller decision exceeds 1 MiB.');
  return { type: 'tool', id: typeof value.id === 'string' ? value.id : randomUUID(), name: value.name, args: value.args, decision: value.decision };
}

/** This endpoint does no inference and never computes tool results. It transports only the
 * external controller's explicit next decision to AGH's normal model→core→tool pipeline. */
export async function startControllerTransport() {
  const token = randomBytes(32).toString('hex');
  let pending = null;
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('local controller transport authentication required'); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== controllerModel || !Array.isArray(body.messages)) throw new Error();
      const catalog = Array.isArray(body.tools) ? body.tools : [];
      let decision = null;
      // Requests without tools are background title work, not controller decision turns.
      if (pending && catalog.some(tool => tool?.function?.name === pending.name)) { decision = pending; pending = null; }
      else if (pending && catalog.length) throw new Error('AGH did not expose the selected industrial tool.');
      const envelope = { id: `controller-${++requests}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: controllerModel };
      const delta = decision
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `controller-${randomUUID()}`, type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.args) } }] }
        : { role: 'assistant', content: 'External controller transport turn ended. Tool decisions came from Codex in the current conversation; this endpoint performs no model inference. Inspect the actual AGH tool result before the next decision.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: decision ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch { if (!response.headersSent) response.writeHead(400); response.end('invalid controller transport request'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl, token,
    queue(value) { if (pending) throw new Error('Previous controller decision has not been consumed.'); pending = validateDecision(value); },
    get pending() { return pending !== null; },
    get requests() { return requests; },
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }),
  };
}

export function controllerProfile(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || url.username || url.password || url.search || url.hash) throw new Error('Controller transport must be loopback-only.');
  return {
    name: 'local-dev', computerUse: { enabled: false },
    adapters: { secrets: { kind: 'env' } },
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], catalog: { include: [] }, routes: [{
      route: controllerRoute, api: 'openai-completions', baseUrl,
      displayName: 'External Codex controller transport — no local inference',
      credentialRef: 'secret://controller/transport',
      models: [{ id: controllerModel, name: 'Codex current conversation — external decisions', api: 'openai-completions', route: controllerRoute, baseUrl,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 65536, toolCallFormats: ['native'], thinkingReplay: 'drop', contract_id: null }],
    }] },
  };
}
