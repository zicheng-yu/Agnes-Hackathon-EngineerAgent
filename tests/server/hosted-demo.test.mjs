import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, hostedDemoConfig, hostedDemoGuard } from '../../server/hosted-demo.mjs';

const call = (guard, req) => new Promise(resolve => {
  const res = { headers: {}, statusCode: 200, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); } };
  guard({ method: 'POST', headers: {}, socket: { remoteAddress: '10.0.0.1' }, ...req }, res, () => resolve({ status: 'next' }));
});

test('hosted demo stays off unless explicitly enabled', () => {
  assert.deepEqual(hostedDemoConfig({ ENGINEERAGENT_PUBLIC_ORIGIN: 'https://a.example' }).origins, []);
  assert.equal(hostedDemoConfig({}).enabled, false);
  const config = hostedDemoConfig({ ENGINEERAGENT_PUBLIC_DEMO: '1', ENGINEERAGENT_PUBLIC_ORIGIN: 'https://a.example/, https://b.example' });
  assert.deepEqual(config.origins, ['https://a.example', 'https://b.example']);
});

test('hosted demo locks settings and limits model tasks per visitor', async () => {
  let time = 0;
  const guard = hostedDemoGuard({ modelTasksPerHour: 2, modelTasksPerDay: 3, toolCallsPerHour: 5 }, createRateLimiter({ now: () => time }));
  assert.equal((await call(guard, { path: '/api/settings' })).status, 403);
  assert.equal((await call(guard, { method: 'GET', path: '/api/settings' })).status, 'next');
  const task = ip => call(guard, { path: '/api/tasks', body: { mode: 'reconstruct' }, headers: { 'x-real-ip': ip } });
  assert.equal((await task('1.1.1.1')).status, 'next');
  assert.equal((await task('1.1.1.1')).status, 'next');
  const limited = await task('1.1.1.1');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['Retry-After']) > 0);
  assert.equal((await task('2.2.2.2')).status, 'next');
  assert.equal((await task('3.3.3.3')).status, 429, 'daily cap applies to everyone');
  time = 86_400_000;
  assert.equal((await task('1.1.1.1')).status, 'next');
  assert.equal((await call(guard, { path: '/api/geometry' })).status, 'next');
});
