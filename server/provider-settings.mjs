import { chmod, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setPrivatePermissions } from './private-permissions.mjs';

export const providerIds = ['agnes-ai', 'openai-compatible', 'anthropic-compatible', 'openrouter'];
export const providerDefaults = Object.freeze({
  'agnes-ai': { baseUrl: 'https://api.agnes-ai.cn/v1', model: 'agnes-3.0-flash', usageEnabled: false, visionEnabled: true, billingMode: 'external' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: '', usageEnabled: false, visionEnabled: true, billingMode: 'external' },
  'anthropic-compatible': { baseUrl: 'https://api.anthropic.com', model: '', usageEnabled: false, visionEnabled: true, billingMode: 'external' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'minimax/minimax-m3', usageEnabled: false, visionEnabled: true, billingMode: 'managed' },
});
export function validateProviderEndpoint(providerId, value) {
  if (!providerIds.includes(providerId)) throw new Error('请选择受支持的模型接口。');
  let url; try { url = new URL(value); } catch { throw new Error('API 地址格式无效。'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('外部 API 必须使用 HTTPS，地址中不能包含账号、参数或片段。');
  let baseUrl = url.href.replace(/\/$/, '');
  if (providerId === 'openrouter' && baseUrl !== providerDefaults.openrouter.baseUrl) throw new Error('当前连接使用预设 API 地址与统一费用上限，不支持更换地址。');
  if (providerId !== 'openrouter' && (url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai'))) throw new Error('此地址需选择对应的专用接口，以保留费用保护。');
  if (/\/(?:chat\/completions|messages)$/.test(url.pathname)) throw new Error('请填写 API 基础地址，不要附加 chat/completions 或 messages。');
  if (providerId === 'anthropic-compatible') baseUrl = baseUrl.replace(/\/v1$/, '');
  return baseUrl;
}
const validModel = value => typeof value === 'string' && /^[^\s\p{Cc}]{1,200}$/u.test(value);
const view = value => ({ baseUrl: value.baseUrl, model: value.model, hasKey: Boolean(value.apiKey), usageEnabled: value.usageEnabled === true, visionEnabled: value.visionEnabled === true, thinkingDisabled: value.thinkingDisabled === true, billingMode: value.billingMode });
// Reasoning models such as MiniMax-M3 accept thinking: {type: "disabled"} to answer without a thinking phase.
const thinkingProviders = new Set(['openai-compatible', 'anthropic-compatible']);
// Models documented to accept thinking: {type: "disabled"}; others keep their default behaviour.
export const thinkingSwitchModel = model => /(^|\/)minimax-m3$/i.test(String(model || ''));

export function normalizeSettings(raw = {}, env = {}) {
  const inferredLegacy = !raw.providerId && raw.baseUrl?.includes('openrouter.ai') ? 'openrouter' : undefined;
  const selected = providerIds.includes(raw.providerId) ? raw.providerId : inferredLegacy || (providerIds.includes(env.MODEL_PROVIDER) ? env.MODEL_PROVIDER : 'agnes-ai');
  const providers = {};
  for (const id of providerIds) {
    const saved = raw.version === 2 ? raw.providers?.[id] || {} : selected === id ? raw : {};
    const fallbackKey = id === 'openrouter' ? env.OPENROUTER_API_KEY : id === 'agnes-ai' ? env.AGNES_API_KEY : '';
    providers[id] = { ...providerDefaults[id], baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : id === 'agnes-ai' && env.AGNES_BASE_URL ? env.AGNES_BASE_URL : providerDefaults[id].baseUrl,
      model: typeof saved.model === 'string' ? saved.model : id === 'agnes-ai' && env.AGNES_MODEL ? env.AGNES_MODEL : providerDefaults[id].model,
      usageEnabled: saved.usageEnabled === true, visionEnabled: typeof saved.visionEnabled === 'boolean' ? saved.visionEnabled : providerDefaults[id].visionEnabled,
      thinkingDisabled: thinkingProviders.has(id) && saved.thinkingDisabled === true,
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : fallbackKey || '' };
    if (id === 'openrouter' && saved.modelInfo) providers[id].modelInfo = saved.modelInfo;
  }
  return { version: 2, providerId: selected, providers };
}

export function createProviderSettings({ path, env = process.env, resolveOpenRouterModel }) {
  const load = async () => { let raw = {}; try { raw = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } return normalizeSettings(raw, env); };
  const current = async () => { const data = await load(); return { providerId: data.providerId, ...data.providers[data.providerId] }; };
  const publicSettings = async () => { const data = await load(); return { providerId: data.providerId, ...view(data.providers[data.providerId]), providers: Object.fromEntries(providerIds.map(id => [id, view(data.providers[id])])) }; };
  let saving = Promise.resolve();
  const save = input => {
    const operation = saving.then(async () => {
      const data = await load(), id = input.providerId || data.providerId;
      if (!providerIds.includes(id)) throw new Error('请选择受支持的模型接口。');
      const old = data.providers[id];
      const baseUrl = validateProviderEndpoint(id, input.baseUrl ?? old.baseUrl);
      const model = input.model ?? old.model;
      if (!validModel(model)) throw new Error('请填写有效模型 ID（不含空格）。');
      const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      if (newKey.length > 4096 || /[\r\n]/.test(newKey)) throw new Error('API Key 格式无效。');
      const endpointChanged = new URL(baseUrl).origin !== new URL(old.baseUrl).origin;
      const apiKey = input.clearKey === true ? '' : newKey || (endpointChanged ? '' : old.apiKey);
      // The model dialog only sends endpoint, model and key: calls are enabled once a key exists, and
      // thinking is switched off automatically for models documented to support it (e.g. MiniMax-M3).
      const next = { ...old, baseUrl, model, apiKey, usageEnabled: typeof input.usageEnabled === 'boolean' ? input.usageEnabled : Boolean(apiKey),
        visionEnabled: typeof input.visionEnabled === 'boolean' ? input.visionEnabled : old.visionEnabled,
        thinkingDisabled: thinkingProviders.has(id) && (typeof input.thinkingDisabled === 'boolean' ? input.thinkingDisabled : thinkingSwitchModel(model)) };
      if (id === 'openrouter') {
        if (typeof resolveOpenRouterModel !== 'function') throw new Error('模型目录暂不可用。');
        next.modelInfo = await resolveOpenRouterModel(model);
        next.visionEnabled = next.modelInfo.input.includes('image');
      }
      if (next.usageEnabled && !apiKey) next.usageEnabled = false;
      data.providerId = id; data.providers[id] = next;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await setPrivatePermissions(dirname(path), true);
      const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 }); await setPrivatePermissions(temporary); await rename(temporary, path);
      return { saved: true, endpointKeyCleared: endpointChanged && !newKey, ...await publicSettings() };
    });
    saving = operation.catch(() => {}); return operation;
  };
  return { load, current, publicSettings, save };
}
