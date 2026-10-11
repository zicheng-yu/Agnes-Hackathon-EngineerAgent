import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspectLocalPort, selectLocalService, serviceIdentity } from '../../server/local-service.mjs';

test('an unrelated HTTP 200 listener is occupied, not a ready workbench', async t => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.deepEqual(await inspectLocalPort(server.address().port, serviceIdentity(process.cwd())), { available: false, running: false });
});

test('only the same checkout can be reused; another copy is not this workbench', async t => {
  const identity = serviceIdentity(process.cwd());
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ application: 'EngineerAgent', instanceId: identity })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.deepEqual(await inspectLocalPort(server.address().port, identity), { available: false, running: true });
  assert.deepEqual(await inspectLocalPort(server.address().port, 'another-checkout'), { available: false, running: false });
});

test('default port falls back, then repeat launch reuses the same checkout', async () => {
  const visited = [];
  const options = { root: process.cwd(), inspect: async port => { visited.push(port); return { available: port === 4312, running: false }; } };
  assert.equal((await selectLocalService(options)).port, 4312);
  assert.deepEqual(visited, [4310, 4311, 4312]);
  const reused = await selectLocalService({ root: process.cwd(), inspect: async port => ({ available: false, running: port === 4311 }) });
  assert.equal(reused.port, 4311);
  assert.equal(reused.running, true);
});

test('an explicit occupied PORT fails clearly and never switches ports', async () => {
  const visited = [];
  await assert.rejects(selectLocalService({ root: process.cwd(), preferred: 4310, allowFallback: false,
    inspect: async port => { visited.push(port); return { available: false, running: false }; } }), /指定端口 4310/);
  assert.deepEqual(visited, [4310]);
});

test('port fallback is bounded, including the highest valid port', async () => {
  const visited = [];
  await assert.rejects(selectLocalService({ root: process.cwd(), preferred: 65534,
    inspect: async port => { visited.push(port); return { available: false, running: false }; } }), /65534–65535/);
  assert.deepEqual(visited, [65534, 65535]);
});
