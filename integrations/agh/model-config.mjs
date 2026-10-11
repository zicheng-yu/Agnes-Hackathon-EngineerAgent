import { getApiKeyProvider } from './vendor-runtime/packages/ai/src/index.ts';
import { validateMethod } from './vendor-runtime/packages/protocol/src/index.ts';

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** Pure environment validation. Never logs values, probes an endpoint or reads stored secrets. */
export function modelSettings(env) {
  if (env.AGH_ALLOW_MODEL_RUN !== '1') reject('MODEL_RUN_DISABLED', 'Real model use is disabled.');
  const { AGNES_BASE_URL: baseUrl, AGNES_MODEL: model, AGNES_API_KEY: key } = env;
  if (!baseUrl || !model || !key?.trim()) reject('MODEL_SETTINGS_REQUIRED', 'The enabled task requires AGNES_BASE_URL, AGNES_MODEL and AGNES_API_KEY from the application.');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { reject('MODEL_ENDPOINT_INVALID', 'The configured model endpoint is invalid.'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || baseUrl !== baseUrl.trim()) {
    reject('MODEL_ENDPOINT_INVALID', 'Use a provider base URL without embedded credentials, query or fragment.');
  }
  if (!/^[^\s\p{Cc}\p{Z}]{1,256}$/u.test(model)) reject('MODEL_ID_INVALID', 'The configured model ID is invalid.');
  return { providerId: env.AGNES_PROVIDER_ID || 'agnes-ai', baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey: key.trim() };
}

/** Only loads the installed upstream catalogue. No provider request or credential mutation. */
export async function checkModelCapabilities(settings, imageCount = 0) {
  const provider = getApiKeyProvider(settings.providerId);
  if (!provider) reject('MODEL_PROVIDER_UNSUPPORTED', 'Select a provider registered by the pinned AGH runtime.');
  const adapter = await provider.createAdapter();
  const record = adapter.models(provider.route).find((model) => model.id === settings.model);
  if (!record) reject('MODEL_UNSUPPORTED', 'This model ID is not in the installed AGH provider catalogue; a custom base URL cannot add arbitrary model IDs.');
  if (imageCount && !record.input.includes('image')) reject('MODEL_VISION_UNSUPPORTED', 'The installed AGH catalogue marks this model as text-only. Choose a registered vision model for drawing images.');
  const limit = record.inputLimits?.images?.maxPerRequest;
  if (imageCount && limit && imageCount > limit) reject('MODEL_IMAGE_LIMIT', 'The image count exceeds this model catalogue limit.');
  return { providerId: provider.id, protocol: provider.api, model: record.id, visionSupported: record.input.includes('image'), imageLimit: limit ?? null };
}

/** Call only after the explicit enable guard. config.save owns validation and secret storage. */
export async function configureModel(client, settings, imageCount = 0) {
  const capabilities = await checkModelCapabilities(settings, imageCount);
  const before = await client.config.get();
  const payload = {
    providerId: settings.providerId, baseUrl: settings.baseUrl, model: settings.model,
    apiKey: settings.apiKey, expectedRevision: before.revision,
    accountId: `industrial-${settings.providerId}`, label: 'Industrial task connection', enabled: true, makeDefault: true,
  };
  if (!validateMethod('_agnes/v1/config.save', 'params', payload).ok) reject('MODEL_CONFIGURATION_INVALID', 'Model settings do not satisfy the official AGH configuration schema.');
  let saved;
  try { saved = await client.config.save(payload); }
  catch { reject('MODEL_CONFIGURATION_FAILED', 'AGH could not verify/save this account. The endpoint must offer an authenticated /models catalogue containing the selected registered model. No key or provider response is included in this error.'); }
  if (!saved.configured || !saved.provider?.route) reject('MODEL_CONFIGURATION_FAILED', 'AGH did not return a configured model route.');
  if (saved.effect === 'restart-required') reject('MODEL_RESTART_REQUIRED', 'AGH saved the connection but requires this isolated daemon to restart before a task can use it.');
  return { ...capabilities, route: saved.provider.route, revision: saved.revision };
}

/** The pinned SDK names its main generation slot `primary`, not `main`. */
export async function selectSessionModel(session, connection) {
  const selection = { slot: 'primary', route: connection.route, model: connection.model };
  if (!validateMethod('_agnes/v1/session.setModel', 'params', { sessionId: session.id, ...selection }).ok) {
    reject('MODEL_SESSION_SELECTION_INVALID', 'The session model selection does not satisfy the installed AGH protocol.');
  }
  return session.setModel(selection);
}
