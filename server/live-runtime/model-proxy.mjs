import { reserveRequest, markDispatched, markUnknown, settleRequest } from './budget.mjs';
import { clean, fail, hash, json, readJson } from './worker-security.mjs';

export const MODEL_ID = 'minimax/minimax-m3';
export const TOOL_NAMES = Object.freeze(['industrial_read_input', 'industrial_get_document', 'industrial_search_catalog', 'industrial_review_order', 'industrial_geometry', 'industrial_request_clarification']);
export const MODEL_INFO = Object.freeze({ id: MODEL_ID, name: 'MiniMax M3', input: ['text', 'image'], cost: { input: 0.3, output: 1.2 }, contextWindow: 1048576, maxTokens: 8192 });
const allowedTools = new Set(TOOL_NAMES);
const api = 'https://openrouter.ai/api/v1';
const fetchProvider = (env, url, options) => (env.PROVIDER_FETCH || fetch)(url, options);

export function modelPayload(body, modelInfo = MODEL_INFO) {
  if (body.model && body.model !== modelInfo.id) fail(400, 'MODEL_NOT_ALLOWED');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) fail(400, 'INVALID_MESSAGES');
  let images = 0, textSize = 0;
  const text = (value) => { if (typeof value !== 'string') fail(400, 'INVALID_MESSAGE_CONTENT'); textSize += value.length; if (textSize > 250000) fail(413, 'MODEL_TEXT_TOO_LARGE'); return value; };
  const offeredTools = body.tools ?? [];
  if (!Array.isArray(offeredTools) || offeredTools.length > 128 || offeredTools.some((t) => !t || t.type !== 'function' || typeof t.function?.name !== 'string')) fail(400, 'INVALID_TOOL_CATALOG');
  // AGH's standard session also registers built-in shell/filesystem tools. This trusted
  // boundary narrows the declaration catalogue before provider inference; it never grants
  // execution rights. Historical calls, provider-returned calls and the AGH execution hook
  // independently reject any name outside the industrial allowlist.
  const tools = offeredTools.filter(t => allowedTools.has(t.function.name));
  if (tools.length > TOOL_NAMES.length || new Set(tools.map(t => t.function.name)).size !== tools.length) fail(400, 'INVALID_TOOL_CATALOG');
  const toolCalls = (calls) => {
    if (!Array.isArray(calls) || calls.length > 8) fail(400, 'INVALID_TOOL_CALLS');
    return calls.map((call) => { if (call.type !== 'function' || !allowedTools.has(call.function?.name)) fail(400, 'TOOL_NOT_ALLOWED'); return { id: text(call.id), type: 'function', function: { name: call.function.name, arguments: text(call.function.arguments) } }; });
  };
  const messages = body.messages.map((message) => {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) fail(400, 'INVALID_ROLE');
    let content;
    if (message.content === null || message.content === undefined) content = null;
    else if (typeof message.content === 'string') content = text(message.content);
    else if (Array.isArray(message.content)) content = message.content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: text(part.text) };
      if (part.type !== 'image_url' || typeof part.image_url?.url !== 'string') fail(400, 'INVALID_CONTENT_PART');
      const image = part.image_url.url;
      if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length > 5_600_000 || ++images > 4) fail(400, 'INVALID_IMAGE_INPUT');
      return { type: 'image_url', image_url: { url: image, detail: 'auto' } };
    });
    else fail(400, 'INVALID_MESSAGE_CONTENT');
    return { role: message.role, content, ...(message.tool_calls ? { tool_calls: toolCalls(message.tool_calls) } : {}), ...(message.tool_call_id ? { tool_call_id: text(message.tool_call_id) } : {}) };
  });
  const requestedMax = body.max_tokens ?? body.max_completion_tokens ?? modelInfo.maxTokens;
  const maxTokens = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, modelInfo.maxTokens, 8192) : Math.min(modelInfo.maxTokens,8192);
  return { model: modelInfo.id, messages, ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.function.name, description: text(t.function.description || ''), parameters: t.function.parameters || {} } })), tool_choice: 'auto' } : {}),
    stream: false, max_tokens: maxTokens, provider: modelInfo.providerOptions || { only: ['minimax/fp8'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0.3, completion: 1.2 } }, usage: { include: true } };
}

function responseFor(body, streaming) {
  if (!streaming) return json(body);
  const choice = body.choices?.[0];
  const message = choice?.message || {};
  const delta = { role: 'assistant', ...(message.content !== null && message.content !== undefined ? { content: message.content } : {}), ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
  const base = { id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model || MODEL_ID };
  const chunks = [{ ...base, choices: [{ index: 0, delta, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || 'stop' }], usage: body.usage }];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' } });
}

export async function reconcileGeneration(env, requestId, generationId) {
  if (!generationId || !env.OPENROUTER_API_KEY) return false;
  try {
    const response = await fetchProvider(env, `${api}/generation?id=${encodeURIComponent(generationId)}`, { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return false;
    const data = (await response.json())?.data;
    if (data?.id !== generationId || data?.total_cost === null || data?.total_cost === undefined) return false;
    await settleRequest(env.DB, requestId, { cost: data.total_cost, source: 'openrouter.generation', generationId, promptTokens: data.tokens_prompt ?? null, completionTokens: data.tokens_completion ?? null });
    return true;
  } catch { return false; }
}

export async function reconcileOutstanding(env) {
  const rows = (await env.DB.prepare("SELECT id,generation_id FROM budget_requests WHERE state IN ('dispatched','unknown') AND generation_id IS NOT NULL LIMIT 4").all()).results || [];
  for (const row of rows) await reconcileGeneration(env, row.id, row.generation_id);
}

export async function proxyModel(request, env, job) {
  if (!env.OPENROUTER_API_KEY) fail(503, 'MODEL_NOT_CONFIGURED');
  const original = await readJson(request, 24 * 1024 * 1024);
  const modelInfo = job.model_json ? JSON.parse(job.model_json) : env.MODEL_INFO || MODEL_INFO;
  const payload = modelPayload(original, modelInfo);
  // Same prompt retry reuses one billing identity, never another paid POST.
  const requestId = `model-${await hash(`${job.id}\n${JSON.stringify(payload)}`)}`;
  const prior = await env.DB.prepare('SELECT response_key,error_code FROM trial_model_calls WHERE request_id=?').bind(requestId).first();
  if (prior?.response_key) {
    const stored = await env.BUCKET.get(prior.response_key);
    if (stored) return responseFor(await stored.json(), Boolean(original.stream));
    fail(503, 'MODEL_RECEIPT_UNAVAILABLE');
  }
  const existing = await env.DB.prepare('SELECT state FROM budget_requests WHERE id=?').bind(requestId).first();
  if (existing) fail(409, 'MODEL_REQUEST_ALREADY_ATTEMPTED', '该模型请求已尝试，等待费用与结果核对；不会重复收费调用。');
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM budget_requests WHERE task_id=? AND state<>'cancelled'").bind(job.id).first();
  // Matches the AGH step ceiling for drawing reconstruction; the per-task budget still bounds spend.
  if (count.n >= 16) fail(429, 'MODEL_STEP_LIMIT');
  await reserveRequest(env.DB, { taskId: job.id, requestId, model: modelInfo.id, priceRevision: modelInfo.pricing?.checkedAt || 'minimax-fp8-2026-10-10', boundSource: 'model_context_limit', inputTokenBound: modelInfo.contextWindow, maxOutputTokens: payload.max_tokens, inputMicrosPerMillion: modelInfo.pricing?.inputMicrosPerMillion ?? 300000, outputMicrosPerMillion: modelInfo.pricing?.outputMicrosPerMillion ?? 1200000, fixedMicros: modelInfo.pricing?.fixedMicros || 0 });
  await env.DB.prepare('INSERT INTO trial_model_calls(request_id,task_id,created_ms) VALUES(?,?,?)').bind(requestId, job.id, Date.now()).run();
  await markDispatched(env.DB, requestId);
  let upstream, body;
  try {
    upstream = await fetchProvider(env, `${api}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'x-title': 'EngineerAgent public trial' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, Math.min(180000, job.lease_expires_ms - Date.now()))), redirect: 'error' });
    body = await upstream.json();
  } catch {
    await markUnknown(env.DB, requestId, { reason: 'transport_or_response_error' });
    fail(502, 'MODEL_COST_UNCERTAIN', '模型连接中断，费用预占保留，等待核账。');
  }
  const generationId = typeof body?.id === 'string' && /^[\w:/.-]{1,180}$/.test(body.id) ? body.id : null;
  let settled = false;
  if (body?.usage?.cost !== null && body?.usage?.cost !== undefined) {
    try { await settleRequest(env.DB, requestId, { cost: body.usage.cost, source: 'openrouter.usage', generationId, promptTokens: body.usage.prompt_tokens ?? null, completionTokens: body.usage.completion_tokens ?? null }); settled = true; }
    catch { /* Leave held if provider usage cannot be validated. */ }
  }
  if (!settled) { await markUnknown(env.DB, requestId, { generationId, reason: 'provider_cost_missing' }); settled = await reconcileGeneration(env, requestId, generationId); }
  if (!upstream.ok || body?.error) {
    await env.DB.prepare('UPDATE trial_model_calls SET error_code=? WHERE request_id=?').bind('PROVIDER_REJECTED', requestId).run();
    fail(502, settled ? 'PROVIDER_REJECTED' : 'MODEL_COST_UNCERTAIN', '模型服务未返回可用结果，费用状态已记录。');
  }
  const message = body.choices?.[0]?.message;
  if (!message || (message.tool_calls && (!Array.isArray(message.tool_calls) || message.tool_calls.some((call) => call.type !== 'function' || !allowedTools.has(call.function?.name))))) fail(502, 'PROVIDER_TOOL_NOT_ALLOWED');
  const response = { id: body.id, object: 'chat.completion', created: body.created || Math.floor(Date.now() / 1000), model: modelInfo.id,
    choices: [{ index: 0, message: { role: 'assistant', content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}), ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }, finish_reason: body.choices[0].finish_reason }], usage: body.usage };
  // Provider response is private job state, never served by the public artifact API.
  const responseKey = `private/model/${job.id}/${requestId}.json`;
  await env.BUCKET.put(responseKey, JSON.stringify(response), { httpMetadata: { contentType: 'application/json' } });
  await env.DB.prepare('UPDATE trial_model_calls SET response_key=?,cached_tokens=?,reasoning_tokens=? WHERE request_id=?')
    .bind(responseKey, body.usage?.prompt_tokens_details?.cached_tokens ?? 0, body.usage?.completion_tokens_details?.reasoning_tokens ?? 0, requestId).run();
  return responseFor(response, Boolean(original.stream));
}
