import assert from 'node:assert/strict';
import test from 'node:test';
import { checkModelCapabilities, configureModel, modelSettings, selectSessionModel } from './model-config.mjs';
import { validateMethod } from './vendor-runtime/packages/protocol/src/index.ts';

const fakeEnvironment = {
  AGH_ALLOW_MODEL_RUN: '1', AGNES_BASE_URL: 'https://example.invalid/v1',
  AGNES_MODEL: 'agnes-3.0-flash', AGNES_API_KEY: 'offline-in-memory-placeholder-not-an-account',
};

test('disabled guard runs before credential configuration', () => {
  assert.throws(() => modelSettings({}), { code: 'MODEL_RUN_DISABLED' });
});

test('session model selection uses the pinned primary slot and actual official RPC schema', async () => {
  const sessionId = 'agnes:local:local-dev:cli:session:offline-selection';
  let selected;
  const result = await selectSessionModel({ id: sessionId, setModel: async selection => {
    assert.equal(validateMethod('_agnes/v1/session.setModel', 'params', { sessionId, ...selection }).ok, true);
    selected = selection;
    return { effectiveFromSeq: 1 };
  } }, { route: 'account-industrial-agnes-ai', model: 'agnes-3.0-flash' });
  assert.deepEqual(selected, { slot: 'primary', route: 'account-industrial-agnes-ai', model: 'agnes-3.0-flash' });
  assert.equal(result.effectiveFromSeq, 1);
  assert.equal(validateMethod('_agnes/v1/session.setModel', 'params', { sessionId, ...selected, slot: 'main' }).ok, false, 'Regression: main is not an AGH model slot.');
});

test('official schema and installed catalogue validate without network or secret persistence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network is forbidden in this schema-only test.'); };
  try {
    const settings = modelSettings(fakeEnvironment);
    const capabilities = await checkModelCapabilities(settings, 1);
    assert.equal(capabilities.protocol, 'openai-completions');
    assert.equal(capabilities.visionSupported, true);
    assert.equal(capabilities.imageLimit, 4);
    let saves = 0;
    const client = { config: {
      get: async () => ({ revision: 7 }),
      save: async (payload) => {
        saves += 1;
        assert.equal(validateMethod('_agnes/v1/config.save', 'params', payload).ok, true);
        assert.equal(payload.apiKey, fakeEnvironment.AGNES_API_KEY);
        assert.equal(payload.expectedRevision, 7);
        assert.equal(payload.providerId, 'agnes-ai');
        assert.equal(payload.accountId, 'industrial-agnes-ai');
        return { configured: true, revision: 8, provider: { route: 'account-industrial-agnes-ai' }, effect: 'new-sessions' };
      },
    } };
    const result = await configureModel(client, settings, 1);
    assert.equal(saves, 1);
    assert.equal(result.route, 'account-industrial-agnes-ai');
    assert.equal(JSON.stringify(result).includes(fakeEnvironment.AGNES_API_KEY), false);
    await assert.rejects(checkModelCapabilities({ ...settings, model: 'unknown-arbitrary-model' }), { code: 'MODEL_UNSUPPORTED' });
    await assert.rejects(checkModelCapabilities({ ...settings, model: 'agnes-2.5-pro' }, 1), { code: 'MODEL_VISION_UNSUPPORTED' });
    await assert.rejects(checkModelCapabilities(settings, 5), { code: 'MODEL_IMAGE_LIMIT' });
    assert.equal(validateMethod('session/prompt', 'params', { sessionId: 'agnes:local:local-dev:cli:session:offline', prompt: [{ type: 'text', text: 'Schema only.' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }).ok, true);
  } finally { globalThis.fetch = originalFetch; }
});
