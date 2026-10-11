import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { hasPrivatePermissions } from '../../server/private-permissions.mjs';

export const industrialToolNames = Object.freeze(['industrial_read_input', 'industrial_get_document', 'industrial_search_catalog', 'industrial_review_order', 'industrial_geometry', 'industrial_request_clarification']);
export const cloudRoute = 'engineeragent-cloud';
export const maxArtifactBytes = 20 * 1024 * 1024;
export const inputMime = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain' });
export const artifactMime = Object.freeze({ '.glb': 'model/gltf-binary', '.step': 'application/step', '.stp': 'application/step', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' });
export const isWithin = (parent, child) => { const value = relative(parent, child); return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };

export function siteOrigin(value, allowLoopback = false) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('SITE_ORIGIN must be an HTTPS origin.');
  return url.origin;
}

export function validateJob(value) {
  if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.id) || !['reconstruct', 'order_review', 'catalog_search'].includes(value.mode)) throw new Error('Invalid cloud job identity or mode.');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 100000) throw new Error('Invalid cloud job prompt.');
  if (typeof value.leaseToken !== 'string' || value.leaseToken.length < 24 || value.leaseToken.length > 512 || /\s/.test(value.leaseToken)) throw new Error('Invalid job lease.');
  const model = value.model;
  if (!model || typeof model.id !== 'string' || !/^[^\s\p{Cc}]{1,200}$/u.test(model.id) || !Array.isArray(model.input) || !model.input.includes('text') || model.input.some(x => !['text', 'image'].includes(x))) throw new Error('Invalid cloud model declaration.');
  const limits = value.limits || {};
  for (const [key, min, max] of [['timeoutMs', 1000, 600000], ['maxSteps', 1, 24], ['maxOutputTokens', 256, 16384]]) if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error(`Invalid cloud limit: ${key}.`);
  const inputs = value.inputs || [];
  if (!Array.isArray(inputs) || inputs.length > 4) throw new Error('Cloud jobs accept up to 4 files.');
  for (const input of inputs) {
    const extension = extname(input.name || '').toLowerCase();
    if (!inputMime[extension] || input.mime !== inputMime[extension] || typeof input.url !== 'string') throw new Error('Only PNG, JPEG, WebP, PDF and UTF-8 text inputs are supported.');
    if (input.mime !== 'text/plain' && !model.input.includes('image')) throw new Error('The model does not support drawing images.');
  }
  const needsPages = value.mode === 'reconstruct' || inputs.some(input => input.mime !== 'text/plain');
  const pages = value.pages === undefined ? (needsPages ? [1] : []) : value.pages;
  if (!Array.isArray(pages) || (needsPages && !pages.length) || pages.length > 4 || pages.some(page => !Number.isInteger(page) || page < 1 || page > 1000)) throw new Error('Select 1–4 valid drawing pages; text-only business tasks may omit pages.');
  return { ...value, inputs, pages };
}

/** Raw prompts and task outputs are user data; only selected AGH event types leave this machine. */
export function publicValue(value, { projectRoot = '', secrets = [], urlMap = new Map() } = {}) {
  if (typeof value === 'string') {
    if (urlMap.has(value)) return urlMap.get(value);
    let clean = value;
    for (const secret of secrets.filter(Boolean)) clean = clean.split(secret).join('[REDACTED]');
    clean = clean.replace(/sk-(?:or-v1-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
    if (projectRoot) for (const prefix of [`${projectRoot}/`, `${projectRoot}\\`, projectRoot.replaceAll('\\', '/') + '/']) clean = clean.split(prefix).join('');
    clean = clean.replace(/(?:\/Users\/|\/home\/|[A-Z]:[\\/])[^\s"'<>]+/gi, '[LOCAL_PATH]');
    return clean.slice(0, 120000);
  }
  if (Array.isArray(value)) return value.slice(0, 400).map(item => publicValue(item, { projectRoot, secrets, urlMap }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(authorization|apiKey|leaseToken|token|trace|html|controllerDecisions|outputDir)$/i.test(key)).map(([key, child]) => [key, publicValue(child, { projectRoot, secrets, urlMap })]));
  return value;
}

const visibleEvents = new Set(['tool/call', 'tool/result', 'assistant/message', 'turn/end', 'turn/start', 'turn/terminal', 'request/error']);
export function publicEvent(event, options) {
  if (!event || !visibleEvents.has(event.type)) return null;
  return publicValue(event, options);
}

export async function readRunnerToken(env) {
  const validate = token => {
    if (typeof token !== 'string' || token.length < 24 || token.length > 512 || /\s/.test(token)) throw new Error('Invalid runner token.');
    return token;
  };
  if (env.RUNNER_TOKEN?.trim()) return validate(env.RUNNER_TOKEN.trim());
  if (!env.RUNNER_TOKEN_FILE) throw new Error('Set RUNNER_TOKEN or a mode-0600 RUNNER_TOKEN_FILE.');
  const info = await lstat(env.RUNNER_TOKEN_FILE);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || !await hasPrivatePermissions(env.RUNNER_TOKEN_FILE)) throw new Error('Runner token file must be an owned private file (Windows ACL or POSIX mode 0600).');
  const token = (await readFile(env.RUNNER_TOKEN_FILE, 'utf8')).trim();
  return validate(token);
}

export async function safeArtifact(file, roots) {
  const actual = await realpath(file);
  if (!roots.some(root => isWithin(root, actual))) throw new Error('Artifact is outside this job.');
  const info = await lstat(actual);
  const mime = artifactMime[extname(actual).toLowerCase()];
  if (!mime || !info.isFile() || info.size === 0 || info.size > maxArtifactBytes) throw new Error('Artifact type or size is not publishable.');
  const bytes = await readFile(actual);
  if (mime === 'model/gltf-binary' && bytes.subarray(0, 4).toString() !== 'glTF') throw new Error('Invalid GLB header.');
  if (mime === 'application/step' && !bytes.toString('utf8', 0, 64).startsWith('ISO-10303-21;')) throw new Error('Invalid STEP header.');
  return { actual, mime, bytes };
}

export function cloudProfile(origin, job) {
  const baseUrl = `${origin}/api/runner/jobs/${encodeURIComponent(job.id)}/model/v1`;
  const model = job.model;
  // AGH's usage calculator multiplies all four rates, including zero cache tokens.
  // Missing cache rates otherwise yield NaN and reject the official ledger envelope.
  const cost = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => {
    const rate = model.cost?.[key] ?? 0;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new Error('Invalid model price metadata.');
    return [key, rate];
  }));
  return {
    name: 'local-dev', computerUse: { enabled: false }, adapters: { secrets: { kind: 'env' } },
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], catalog: { include: [] }, routes: [{
      route: cloudRoute, api: 'openai-completions', baseUrl, credentialRef: 'secret://cloud/job', displayName: 'EngineerAgent metered model gateway',
      models: [{ id: model.id, name: model.name || model.id, api: 'openai-completions', route: cloudRoute, baseUrl,
        reasoning: Boolean(model.reasoning), input: model.input, cost,
        contextWindow: model.contextWindow || 128000, maxTokens: job.limits.maxOutputTokens, toolCallFormats: ['native'], thinkingReplay: 'drop', contract_id: null }],
    }] },
  };
}
