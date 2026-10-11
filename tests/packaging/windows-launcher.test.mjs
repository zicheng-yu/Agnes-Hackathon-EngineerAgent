import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launcherName = '启动工程助手.bat';

test('Windows bootstrap stays ASCII with CRLF; macOS launcher keeps LF', async () => {
  const batch = await fs.readFile(path.join(projectRoot, launcherName));
  assert.ok(batch.every(byte => byte < 128), 'CMD bootstrap must not contain localized text or a BOM');
  assert.doesNotMatch(batch.toString('ascii'), /(?<!\r)\n/);
  assert.match(batch.toString('ascii'), /\r\n/);
  const mac = await fs.readFile(path.join(projectRoot, '启动工程助手.command'), 'utf8');
  assert.doesNotMatch(mac, /\r/);
});

test('actual CMD launcher reaches Node and reports failures under legacy and UTF-8 code pages', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineeragent-cmd-'));
  try {
    const project = path.join(root, '中文 空格 & 项目');
    await fs.mkdir(path.join(project, 'scripts'), { recursive: true });
    await fs.copyFile(path.join(projectRoot, launcherName), path.join(project, launcherName));
    await fs.writeFile(path.join(project, 'scripts/start-local.mjs'), `
import fs from 'node:fs';
fs.writeFileSync(process.env.LAUNCHER_RESULT, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),utf8:process.env.PYTHONUTF8,io:process.env.PYTHONIOENCODING}));
console.log('中文构建输出：环境已就绪');
process.exit(Number(process.env.LAUNCHER_EXIT || 0));
`);
    const marker = path.join(root, 'result.json');
    for (const codepage of [936, 437, 65001]) {
      for (const exitCode of [0, 37]) {
        await fs.writeFile(path.join(root, 'run-test.cmd'), `@echo off\r\nchcp ${codepage} >nul\r\ncall "%LAUNCHER_FILE%"\r\n`);
        const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'run-test.cmd'], {
          cwd: root, windowsHide: true, timeout: 15000, input: Buffer.from('\r\n'),
          env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`, LAUNCHER_FILE: path.join(project, launcherName), LAUNCHER_RESULT: marker, LAUNCHER_EXIT: String(exitCode) },
        });
        assert.ifError(result.error);
        assert.equal(result.status, exitCode ? 1 : 0, `initial code page ${codepage}, Node exit ${exitCode}`);
        assert.equal(result.stderr.toString('utf8'), '');
        const stdout = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
        assert.match(stdout, /中文构建输出：环境已就绪/);
        assert.equal(stdout.includes('Startup failed.'), Boolean(exitCode));
        const markerData = JSON.parse(await fs.readFile(marker, 'utf8'));
        assert.deepEqual(markerData, {args:['--install','--open'],cwd:project,utf8:'1',io:'utf-8'});
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
