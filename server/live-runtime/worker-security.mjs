export class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
export const id = () => crypto.randomUUID();
export const safeName = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,180}$/.test(value) && value !== '.' && value !== '..';
const bytes = (value) => new TextEncoder().encode(value);
const hex = (value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
export const hash = async (value) => hex(await crypto.subtle.digest('SHA-256', bytes(value)));
export async function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [ah, bh] = await Promise.all([hash(a), hash(b)]);
  let different = 0; for (let i = 0; i < ah.length; i++) different |= ah.charCodeAt(i) ^ bh.charCodeAt(i);
  return different === 0;
}
async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) fail(503, 'SESSION_NOT_CONFIGURED');
  return crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function visitor(request, env, create = false) {
  const token = request.headers.get('cookie')?.split(';').map((v) => v.trim()).find((v) => v.startsWith('ea_visitor='))?.slice(11);
  const key = await signingKey(env.SESSION_SECRET);
  if (token) {
    const match = /^([0-9a-f-]{36})\.(\d{10})\.([0-9a-f]{64})$/.exec(token);
    if (match && Number(match[2]) > Date.now() / 1000 && Number(match[2]) < Date.now() / 1000 + 32 * 86400) {
      const signature = Uint8Array.from(match[3].match(/../g), (v) => parseInt(v, 16));
      if (await crypto.subtle.verify('HMAC', key, signature, bytes(`${match[1]}.${match[2]}`))) return { id: match[1], cookie: null };
    }
  }
  if (!create) fail(401, 'VISITOR_SESSION_REQUIRED', '请刷新页面后重试。');
  const identity = id(), expires = Math.floor(Date.now() / 1000) + 30 * 86400;
  const value = `${identity}.${expires}`;
  const signature = hex(await crypto.subtle.sign('HMAC', key, bytes(value)));
  return { id: identity, cookie: `ea_visitor=${value}.${signature}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict` };
}
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) fail(403, 'CROSS_ORIGIN_WRITE');
  if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'CROSS_ORIGIN_WRITE');
}
export async function runnerAuth(request, env) {
  if (!await equalSecret(request.headers.get('authorization'), `Bearer ${env.RUNNER_TOKEN || ''}`) || !env.RUNNER_TOKEN) fail(401, 'RUNNER_AUTH_REQUIRED');
}
export async function limitedBytes(request, max) {
  if (Number(request.headers.get('content-length')) > max) fail(413, 'PAYLOAD_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > max) { await reader.cancel(); fail(413, 'PAYLOAD_TOO_LARGE'); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const out = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
export async function readJson(request, max = 200_000) {
  const data = await limitedBytes(request, max);
  try { const value = JSON.parse(new TextDecoder().decode(data)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { fail(400, 'INVALID_JSON'); }
}
const protectedKey = /^(?:authorization|api_?key|lease_?token|runner_?token|secret|password|token|trace|headers|thinking|reasoning|reasoning_content|controllerDecisions|outputDir|localPath|privatePath|runIds|usage|tokenUsage|llmCost|modelCost)$/i;
export function clean(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return value.replace(/sk-(?:or-v1-)?[\w-]{12,}/g, '[REDACTED]').replace(/(?:\/Users\/|\/home\/|\/private\/|[A-Z]:\\)[^\s"'<>]+/g, '[LOCAL_PATH]').slice(0, 120000);
  if (Array.isArray(value)) return value.slice(0, 400).map((v) => clean(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !protectedKey.test(key)).slice(0, 100).map(([key, v]) => [key, clean(v, depth + 1)]));
  return value;
}
