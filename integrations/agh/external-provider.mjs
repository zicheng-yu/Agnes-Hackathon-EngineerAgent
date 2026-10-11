import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { validateProviderEndpoint } from '../../server/provider-settings.mjs';
import { industrialToolNames, cloudProfile } from './cloud-runner-protocol.mjs';

const names = new Set(industrialToolNames);
export function externalSettings(value) {
  if (!['agnes-ai', 'openai-compatible', 'anthropic-compatible'].includes(value?.providerId)) throw new Error('Unsupported external account provider.');
  if (typeof value.model !== 'string' || !/^[^\s\p{Cc}]{1,200}$/u.test(value.model) || typeof value.apiKey !== 'string' || !value.apiKey.trim()) throw new Error('External model and API key are required.');
  return { ...value, baseUrl: validateProviderEndpoint(value.providerId, value.baseUrl), api: value.providerId === 'anthropic-compatible' ? 'anthropic-messages' : 'openai-completions' };
}

/** A loopback protocol-preserving bridge: the model account key never enters AGH. */
export async function startExternalProvider(value, { signal, fetchImpl = fetch, maxRequests = 8 } = {}) {
  const settings = externalSettings(value), token = randomBytes(32).toString('hex');
  const anthropic = settings.api === 'anthropic-messages';
  const path = anthropic ? '/v1/messages' : '/v1/chat/completions';
  const target = settings.baseUrl + (anthropic ? '/v1/messages' : '/chat/completions');
  let requests = 0;
  const server = createServer(async (request, response) => {
    const authenticated = anthropic ? request.headers['x-api-key'] === token : request.headers.authorization === `Bearer ${token}`;
    if (!authenticated || request.method !== 'POST' || request.url?.split('?')[0] !== path) { response.writeHead(403).end('Task model route unavailable.'); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 24 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== settings.model || !Array.isArray(body.messages) || body.messages.length > 100 || requests >= maxRequests) { response.writeHead(429).end('Task model request limit reached.'); return; }
      if (body.tools) {
        if (!Array.isArray(body.tools) || body.tools.length > 128) throw new Error();
        body.tools = body.tools.filter(tool => names.has(anthropic ? tool?.name : tool?.function?.name));
      }
      const tokenField = !anthropic && body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
      const maxTokens = body[tokenField] ?? 8192;
      body[tokenField] = Math.min(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 8192, 8192);
      if (tokenField === 'max_completion_tokens') delete body.max_tokens;
      // Optional per-connection switch for reasoning models (e.g. MiniMax-M3): answer without a thinking phase,
      // so the whole output budget goes to tool calls and the answer.
      if (settings.thinkingDisabled === true) { body.thinking = { type: 'disabled' }; delete body.reasoning_effort; delete body.reasoning; }
      requests++;
      const disconnected = new AbortController(); response.once('close', () => { if (!response.writableEnded) disconnected.abort(); });
      const upstream = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), disconnected.signal, AbortSignal.timeout(180000)]),
        headers: { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${settings.apiKey}` }) }, body: JSON.stringify(body) });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body) { if (response.destroyed) break; response.write(chunk); }
      response.end();
    } catch { if (!response.headersSent) response.writeHead(502); response.end('External model request failed; provider details are not logged.'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { token, settings, get requests() { return requests; }, baseUrl: origin + (anthropic ? '' : '/v1'), close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

export function externalProfile(transport, job) {
  const profile = cloudProfile('http://127.0.0.1', job);
  const route = profile.provider.routes[0];
  route.api = transport.settings.api; route.baseUrl = transport.baseUrl; route.displayName = 'EngineerAgent external account';
  const model = route.models[0]; model.api = route.api; model.baseUrl = route.baseUrl;
  if (route.api === 'anthropic-messages') model.compat = {};
  return profile;
}
