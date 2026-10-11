#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupLocal, buildNeeded, npmCommand, projectRoot, run } from './setup-local.mjs';
import { selectLocalService, isProjectService } from '../server/local-service.mjs';

export function localPort(raw = process.env.PORT || '4310') {
  if (!/^\d+$/.test(String(raw))) throw new Error('PORT 必须是 1–65535 的整数。');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。');
  return port;
}

function openBrowser(url) {
  // This URL is built exclusively from the validated loopback port.
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  child.once('error', () => console.log(`请在浏览器打开 ${url}`));
  child.unref();
}

export async function startLocal(args = []) {
  const allowed = ['--install', '--check', '--open', '--help'];
  if (args.some(arg => !allowed.includes(arg))) throw new Error('不支持的参数；使用 --help 查看用法。');
  if (args.includes('--help')) {
    console.log('node scripts/start-local.mjs [--install] [--open] [--check]\n--install 自动安装缺失依赖；--open 服务就绪后打开浏览器；--check 只检查，不安装、不启动服务。');
    return;
  }
  const checking = args.includes('--check');
  const requestedPort = localPort();
  await setupLocal({ install: !checking && args.includes('--install') });
  const rebuild = await buildNeeded();
  if (checking) { console.log(rebuild ? '前端需要构建（启动时自动 npm run build）。' : '前端构建已就绪。'); return; }
  const { port, identity, running } = await selectLocalService({ root: projectRoot, preferred: requestedPort, allowFallback: !process.env.PORT });
  const url = `http://127.0.0.1:${port}`;
  if (running) {
    console.log(`本项目工作台已在运行：${url}`);
    if (args.includes('--open')) openBrowser(url);
    return;
  }
  if (port !== requestedPort) console.log(`默认端口 ${requestedPort} 已被其他程序占用，自动改用 ${port}。`);
  if (rebuild) {
    console.log('\n构建工作台前端…');
    const npm = await npmCommand();
    await run(npm.command, [...npm.prefix, 'run', 'build']);
  }
  console.log(`\nEngineerAgent · ${url}\n首次模型任务会自动启动本机 AGH，无需第二个终端。\n请保留此窗口；按 Ctrl+C 停止服务。\n`);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot, env: { ...process.env, NODE_ENV: 'production', PORT: String(port) }, stdio: ['inherit','inherit','inherit','ipc'], shell: false,
  });
  let exited = false;
  const stop = signal => { if (!exited) { if(child.connected)child.send({type:'shutdown'},()=>{});else child.kill(signal); } };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const finished = new Promise((resolve, reject) => {
    const cleanup = () => { exited = true; process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve(); else reject(new Error(`服务已退出 (${signal || code})，请查看上方错误。`)); });
  });
  // Attach the rejection handler immediately; health polling never masks a crash.
  const polling = (async () => {
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
        if (response.ok && isProjectService(await response.json(), identity)) {
          console.log(`工作台已就绪：${url}`);
          if (args.includes('--open') && !exited) openBrowser(url);
          return;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!exited) console.log(`服务尚未返回就绪状态，请查看日志；可稍后打开 ${url}`);
  })();
  await Promise.all([finished, polling]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLocal(process.argv.slice(2)).catch(error => { console.error(`\n${error.message}`); process.exitCode = 1; });
}
