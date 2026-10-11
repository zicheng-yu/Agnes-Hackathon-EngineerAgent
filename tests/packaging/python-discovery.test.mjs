import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { choosePython } from '../../scripts/setup-local.mjs';

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: finds registered Conda Python outside PATH, ignores stale/wrong versions`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'engineeragent-conda-'));
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const base = platform === 'win32' ? 'D:\\Conda 环境 & CAD' : '/opt/Conda 环境 & CAD';
    const prefix = paths.join(base, 'envs/hackathon');
    const executable = paths.join(prefix, platform === 'win32' ? 'python.exe' : 'bin/python');
    const attempts = [];
    try {
      await fs.mkdir(path.join(home, '.conda'));
      await fs.writeFile(path.join(home, '.conda/environments.txt'), `${paths.join(base, 'gone')}\r\n${prefix}\r\n${prefix}\r\nrelative-is-not-an-environment\r\n`);
      const result = await choosePython(home, { platform, home, env: {}, probeCommand: async (command, args) => {
        attempts.push({ command, args });
        return command === executable ? { ok: true, stdout: '3.12.15' }
          : command === 'python' ? { ok: true, stdout: '3.13.4' } : { ok: false };
      } });
      assert.deepEqual(result, { command: executable, prefix: [] });
      assert.ok(attempts.some(item => item.command === 'python'));
      assert.equal(attempts.filter(item => item.command === executable).length, 1);
      assert.ok(attempts.at(-1).args.includes('-I'));
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}

test('activated Conda does not require its registry or a global Python launcher', async () => {
  const seen = [];
  const result = await choosePython(process.cwd(), { platform: 'win32', env: { CONDA_PREFIX: 'D:\\conda\\envs\\cad' },
    probeCommand: async command => { seen.push(command); return { ok: true, stdout: '3.12.15' }; } });
  assert.equal(result.command, 'D:\\conda\\envs\\cad\\python.exe');
  assert.equal(seen.length, 1);
});

test('explicit interpreter paths containing shell characters remain one executable', async () => {
  const command = 'D:\\CAD & 中文\\python.exe';
  const result = await choosePython(process.cwd(), { platform: 'win32', env: { ENGINEERAGENT_PYTHON: command },
    probeCommand: async executable => { assert.equal(executable, command); return { ok: true, stdout: '3.12.15' }; } });
  assert.deepEqual(result, { command, prefix: [] });
});

test('an incompatible explicit override reports the detected version without falling back', async () => {
  let attempts = 0;
  await assert.rejects(choosePython(process.cwd(), { platform: 'linux', env: { ENGINEERAGENT_PYTHON: '/opt/python' },
    probeCommand: async () => { attempts++; return { ok: true, stdout: '3.13.4' }; } }), error => {
    assert.match(error.message, /已检测到 Python 3\.13\.4/);
    assert.match(error.message, /ENGINEERAGENT_PYTHON/);
    return true;
  });
  assert.equal(attempts, 1);
  await assert.rejects(choosePython(process.cwd(), { env: { ENGINEERAGENT_PYTHON: 'python' } }), /绝对路径/);
});

test('a machine without any interpreter receives installation guidance', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'engineeragent-no-python-'));
  try {
    await assert.rejects(choosePython(home, { home, env: {}, probeCommand: async () => ({ ok: false }) }), /未找到可运行的 Python 3\.12/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
