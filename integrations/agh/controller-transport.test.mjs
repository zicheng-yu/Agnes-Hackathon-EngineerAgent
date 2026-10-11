import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerModel, controllerProfile, startControllerTransport, validateDecision } from './controller-transport.mjs';

test('controller profile has a distinct identity and excludes external provider catalogues', () => {
  const profile = controllerProfile('http://127.0.0.1:32123/v1');
  assert.deepEqual(profile.provider.catalog.include, []);
  assert.equal(profile.provider.routes[0].route, 'external-codex-controller');
  assert.equal(profile.provider.routes[0].models[0].id, 'codex-current-conversation');
  assert.equal(profile.adapters.secrets.kind, 'env');
  assert.equal(JSON.stringify(profile).includes('apiKey'), false);
  assert.throws(() => controllerProfile('https://example.com/v1'), /loopback/);
  assert.throws(() => validateDecision({ type: 'tool', name: 'exec', args: {}, decision: 'Forbidden general shell.' }), /allowed/);
});

test('controller transport forwards one explicit decision unchanged and never invents tool results', async () => {
  const transport = await startControllerTransport();
  try {
    const decision = { type: 'tool', name: 'industrial_geometry', args: { operation: 'build', input: { id: 'source-decided', features: [{ id: 'stock', op: 'box', size: [72, 48, 8] }] } }, decision: 'Transport-only test with explicitly supplied tool arguments.' };
    const endpoint = `${transport.baseUrl}/chat/completions`;
    const post = body => fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    transport.queue(decision);
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
    const title = await post({ model: controllerModel, messages: [], tools: [] });
    assert.match(await title.text(), /performs no model inference/);
    assert.equal(transport.pending, true, 'Background requests cannot consume a decision.');
    const response = await post({ model: controllerModel, messages: [], tools: [{ type: 'function', function: { name: decision.name } }] });
    const chunks = (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const actual = chunks[0].choices[0].delta.tool_calls[0];
    assert.equal(actual.function.name, decision.name);
    assert.deepEqual(JSON.parse(actual.function.arguments), decision.args);
    assert.equal(transport.pending, false);
    const following = await post({ model: controllerModel, messages: [{ role: 'tool', content: '{"success":false}' }], tools: [{ type: 'function', function: { name: decision.name } }] });
    const text = await following.text();
    assert.equal(text.includes('tool_calls'), false, 'No additional decision may be fabricated.');
    assert.match(text, /Inspect the actual AGH tool result/);
  } finally { await transport.close(); }
});
