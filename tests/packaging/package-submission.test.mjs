import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, portableText, assertNoCredential, MAX_BYTES } from '../../scripts/package-submission.mjs';

test('whitelist keeps runnable sources, locks, geometry and attribution', () => {
  for (const name of ['启动工程助手.command', '启动工程助手.bat', '.gitattributes', 'server/live-runtime/schema.sql', 'src/App.tsx', 'server/index.mjs', 'tools/cad/engine.py', 'package-lock.json', '.env.example', 'assets/catalog/a/source.step', 'assets/generated/a/model.glb', 'assets/sources/a/LICENSE', 'integrations/agh/industrial-tools/LICENSE', 'integrations/agh/runtime-lock.json', 'tests/packaging/package-submission.test.mjs']) assert.equal(isAllowed(name), true, name);
});

test('private/config/runtime paths are rejected even under allowed roots', () => {
  for (const name of ['.env', 'data/uploads/input.png', 'integrations/agh/.local/home/accounts.json', 'integrations/agh/vendor-runtime/package.json', 'assets/.env', 'src/credentials.json', 'tools/__pycache__/test.pyc', 'assets/catalog/a/import.stdout.json', 'site-preview/src/App.tsx', 'deployment/archive.zip', 'references/original-demo/demo.zip', 'src/../.env', '/src/App.tsx', 'src\\..\\.env']) assert.equal(isAllowed(name), false, name);
});

test('portable public metadata preserves relative paths and remote provenance', () => {
  const original = '{"manifest":"/tmp/example/assets/generated/x/manifest.json","origin":"https://github.com/example/project","value":0.0005}';
  assert.deepEqual(JSON.parse(portableText(original, '/tmp/example')), { manifest: 'assets/generated/x/manifest.json', origin: 'https://github.com/example/project', value: 0.0005 });
});

test('credential failure never reveals matched value and uses decimal byte limit', () => {
  const marker = 'sk-' + 'a'.repeat(30);
  assert.throws(() => assertNoCredential(marker, 'docs/example.md'), error => error.message.includes('docs/example.md') && !error.message.includes(marker));
  assert.doesNotThrow(() => assertNoCredential('AGNES_API_KEY=\n', '.env.example'));
  assert.equal(MAX_BYTES, 200_000_000);
});
