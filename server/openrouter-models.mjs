import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export const catalogueUrl = 'https://openrouter.ai/api/v1/models';
const Mi = 1000000;
const numericPrice = value => typeof value === 'string' && /^\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(value) && Number.isFinite(Number(value)) ? Number(value) : NaN;

export function catalogModel(raw, checkedAt = new Date().toISOString()) {
  const pricing = raw.pricing || {}, prompt = numericPrice(pricing.prompt), completion = numericPrice(pricing.completion);
  let disabledReason;
  const input = (raw.architecture?.input_modalities || []).filter(value => ['text', 'image'].includes(value));
  if (!input.includes('text') || !raw.architecture?.output_modalities?.includes('text') || !['tools','tool_choice','max_tokens'].every(parameter=>raw.supported_parameters?.includes(parameter))) disabledReason = '模型必须支持文本输出、工具调用与输出 Token 上限。';
  const contextWindow = Number(raw.context_length), maxTokens = Math.min(8192, Number(raw.top_provider?.max_completion_tokens || 8192));
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10000000 || !Number.isSafeInteger(maxTokens) || maxTokens < 256) disabledReason = '缺少可保守估算的上下文或输出上限。';
  if (![prompt, completion].every(value => Number.isFinite(value) && value >= 0)) disabledReason = '目录没有有效的输入/输出价格。';
  let inputPrice = prompt;
  for (const [key, value] of Object.entries(pricing)) {
    if (['prompt', 'completion'].includes(key)) continue;
    const price = numericPrice(value);
    if (!Number.isFinite(price) || price < 0) { disabledReason = '存在无法验证的附加计费字段。'; continue; }
    if (key === 'input_cache_read') inputPrice = Math.max(inputPrice, price);
    else if (price !== 0) disabledReason = `含额外计费 ${key}，当前无法保证单任务费用上限。`;
  }
  const inputMicrosPerMillion = Math.ceil(inputPrice * Mi * Mi), outputMicrosPerMillion = Math.ceil(completion * Mi * Mi);
  const ceilingMicros = Math.ceil((contextWindow * inputMicrosPerMillion + maxTokens * outputMicrosPerMillion) / Mi) + 1;
  if (!disabledReason && ceilingMicros > 500000) disabledReason = `完整上下文的保守单次预占约 US$${(ceilingMicros / Mi).toFixed(3)}，超过单任务 US$0.50。`;
  return { id: raw.id, name: raw.name || raw.id, input, contextWindow, maxOutputTokens: maxTokens, selectable: !disabledReason, ...(disabledReason ? { disabledReason } : {}),
    pricing: { inputUsdPerMillion: inputPrice * Mi, outputUsdPerMillion: completion * Mi }, estimatedRequestCeilingUsd: ceilingMicros / Mi,
    modelInfo: { id: raw.id, name: raw.name || raw.id, input, contextWindow, maxTokens, cost: { input: inputPrice * Mi, output: completion * Mi, cacheRead: Number.isFinite(numericPrice(pricing.input_cache_read)) ? numericPrice(pricing.input_cache_read) * Mi : 0, cacheWrite: 0 },
      pricing: { inputMicrosPerMillion, outputMicrosPerMillion, fixedMicros: 1, checkedAt, source: catalogueUrl }, providerOptions: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: inputPrice * Mi, completion: completion * Mi } } } };
}

export function createOpenRouterCatalog({ path, fetchImpl = fetch, now = () => Date.now() }) {
  let cache, pending;
  const load = async ({ refresh = false } = {}) => {
    if (!cache) try { cache = JSON.parse(await readFile(path, 'utf8')); } catch {}
    if (!refresh && cache?.models && now() - cache.fetchedMs < 15 * 60 * 1000) return cache;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(catalogueUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('模型服务目录读取失败，请稍后重试。');
      const body = await response.json(); if (!Array.isArray(body.data)) throw new Error('模型服务目录格式异常。');
      const fetchedMs = now(), checkedAt = new Date(fetchedMs).toISOString();
      cache = { fetchedMs, source: catalogueUrl, models: body.data.filter(model => typeof model.id === 'string' && model.id.length <= 200).map(model => catalogModel(model, checkedAt)) };
      if (path) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(cache), { mode: 0o600 }); }
      return cache;
    })();
    try { return await pending; } finally { pending = null; }
  };
  return {
    async list(options) { const data = await load(options); return { source: data.source, checkedAt: new Date(data.fetchedMs).toISOString(), models: data.models.map(({ modelInfo, ...view }) => view) }; },
    async resolve(id, options) { const model = (await load(options)).models.find(model => model.id === id); if (!model) throw new Error('所选模型不在服务商目录中，请确认模型 ID 后重试。'); if (!model.selectable) throw new Error(model.disabledReason); return model.modelInfo; },
  };
}
