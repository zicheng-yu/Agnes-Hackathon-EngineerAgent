#!/usr/bin/env node
/** Restore the portable package without touching machine-wide model accounts. */
import { spawn, execFile } from 'node:child_process';
import { access, readFile, readdir, realpath, stat, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_NODE = [24, 10, 0];
export const PYTHON_SERIES = [3, 12];
const exec = promisify(execFile);
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };

export function versionAtLeast(version, minimum = MIN_NODE) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim());
  if (!match) return false;
  const actual = match.slice(1).map(value => Number(value || 0));
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== (minimum[i] || 0)) return actual[i] > (minimum[i] || 0);
  }
  return true;
}

export function pythonPath(root = projectRoot, platform = process.platform) {
  return path.join(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

// Domestic mirrors keep first installs working on mainland networks. Explicit user
// settings win; ENGINEERAGENT_MIRROR=off restores the official registries.
export const MIRRORS = {
  npm: 'https://registry.npmmirror.com',
  node: 'https://npmmirror.com/mirrors/node',
  pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple',
};
export function mirrorEnvironment(env = process.env) {
  if (env.ENGINEERAGENT_MIRROR === 'off') return { ...env };
  return { ...env,
    npm_config_registry: env.npm_config_registry || MIRRORS.npm,
    ENGINEERAGENT_NODE_DIST: env.ENGINEERAGENT_NODE_DIST || MIRRORS.node,
    PIP_INDEX_URL: env.PIP_INDEX_URL || MIRRORS.pypi };
}

/** Offline-friendly copy of the locked AGH commit shipped in the submission package (a shallow .git). */
export function aghSnapshotPath(root, commit) {
  return path.join(root, 'third-party/agnes-harness', `agh-${commit.slice(0, 12)}.git.tar.gz`);
}

export async function nativeBuildEnvironment(root, npm, base = process.env) {
  const env = { ...base };
  if (process.platform !== 'win32') {
    const compiler = process.env.CC || (process.platform === 'darwin' ? 'clang' : 'cc');
    if (!(await probe(compiler, ['--version'], root)).ok) throw new Error(process.platform === 'darwin' ? 'AGH 原生模块需要 Xcode Command Line Tools。请运行 xcode-select --install 后重试。' : 'AGH 原生模块需要 C/C++ 编译工具链及本机 Node 头文件。请先安装发行版对应的开发包。');
    return env;
  }
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = await probe(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], root);
  if (!visualStudio.ok || !visualStudio.stdout) throw new Error('Windows AGH 构建需要 Visual Studio Build Tools 的“使用 C++ 的桌面开发”和 Windows SDK；安装后重新运行。');
  const cache = path.join(root, '.runtime/node-headers');
  const headers = process.env.AGNES_NODE_HEADERS || path.join(cache, process.versions.node);
  if (!await exists(path.join(headers, 'include/node/node_api.h')) || !await exists(path.join(headers, process.arch, 'node.lib'))) {
    if (process.env.AGNES_NODE_HEADERS) throw new Error('AGNES_NODE_HEADERS 缺少 include/node/node_api.h 或当前架构的 node.lib，请指向匹配本机 Node 版本的完整目录。');
    console.log(`恢复 Node ${process.versions.node} 的 Windows 编译文件…`);
    await run(npm.command, [...npm.prefix, 'exec', '--yes', '--package=node-gyp@13.1.0', '--', 'node-gyp', 'install', `--target=${process.versions.node}`, `--devdir=${cache}`, ...(env.ENGINEERAGENT_NODE_DIST ? [`--disturl=${env.ENGINEERAGENT_NODE_DIST}`] : [])], { cwd: root, env });
  }
  env.AGNES_NODE_HEADERS = headers;
  return env;
}

async function restoreSdkNative(runtime) {
  // CLI bundles have their own native package. Source-based SDK imports must use
  // the exact same binary, without changing upstream source or its Git revision.
  const built = path.join(runtime, 'packages/cli/dist/local/node_modules/@agnes/system-node/dist/native/agnes-system.node');
  const target = path.join(runtime, 'packages/system-node/dist/native/agnes-system.node');
  if (await exists(built)) { await mkdir(path.dirname(target), { recursive: true }); await copyFile(built, target); }
}

// Run npm's JS entry directly on Windows: no shell interpolation of an extracted
// directory name, and no requirement to change PowerShell execution policy.
export async function npmCommand() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    if (process.platform !== 'win32') {
      try { candidates.push(await realpath(path.join(directory, 'npm'))); } catch {}
    }
  }
  for (const candidate of candidates) {
    if (/npm-cli\.js$/.test(candidate) && await exists(candidate)) return { command: process.execPath, prefix: [candidate] };
  }
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  throw new Error('找不到 npm。请安装包含 npm 的官方 Node.js，并重新打开终端。');
}

export function run(command, args, { cwd = projectRoot, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 执行失败 (${signal || code})。请查看上方错误；修复后可重新运行。`)));
  });
}

async function probe(command, args, cwd = projectRoot, timeout = 60_000) {
  try {
    const result = await exec(command, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    // Avoid echoing the inherited environment, command arguments, or arbitrary
    // subprocess output into the compact prerequisite report.
    return { ok: false, code: String(error.code || 'failed') };
  }
}

const PYTHON_METADATA = String.raw`
import sys, json, pathlib, importlib.metadata
result = {'version': '.'.join(map(str, sys.version_info[:3])), 'seriesOk': sys.version_info[:2] == (3, 12), 'missing': []}
try:
    from packaging.requirements import Requirement
    def check(filename):
        for raw in filename.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith('#'): continue
            if line.startswith('-r '): check(filename.parent / line[3:].strip()); continue
            req = Requirement(line)
            if req.marker and not req.marker.evaluate(): continue
            try:
                version = importlib.metadata.version(req.name)
                if req.specifier and version not in req.specifier: result['missing'].append(str(req))
            except importlib.metadata.PackageNotFoundError: result['missing'].append(str(req))
    check(pathlib.Path(sys.argv[1]) / 'requirements.txt')
except Exception as error:
    result['missing'].append(type(error).__name__ + ': requirement verification unavailable')
print(json.dumps(result), flush=True)
`;

const PYTHON_IMPORTS = String.raw`
import json, importlib
errors = []
for name in ['cadquery', 'trimesh', 'numpy', 'networkx', 'scipy', 'resvg_py', 'PIL', 'pypdf', 'pypdfium2', 'matplotlib']:
    print(json.dumps({'event': 'checking', 'module': name}), flush=True)
    try: importlib.import_module(name)
    except Exception as error: errors.append(name + ': ' + type(error).__name__ + ': ' + str(error))
print(json.dumps({'event': 'result', 'imports': errors}), flush=True)
`;

/** Native CAD wheels can take minutes on first macOS signature validation.
 * Stream module names while retaining a hard deadline and the precise failure.
 * Exported so the timeout/crash paths are tested without loading CAD or a model.
 */
export function probePythonImports(command, args, { cwd = projectRoot, timeoutMs = 600_000, heartbeatMs = 15_000, onProgress } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let currentModule = '', pending = '', diagnostics = '', result, timedOut = false, settled = false, spawnError;
    const notify = () => onProgress?.({ module: currentModule, elapsedSeconds: Math.floor((Date.now() - started) / 1000) });
    const parse = line => {
      try {
        const value = JSON.parse(line);
        if (value.event === 'checking' && typeof value.module === 'string') { currentModule = value.module; notify(); }
        if (value.event === 'result' && Array.isArray(value.imports)) result = value;
      } catch {}
    };
    child.stdout.on('data', bytes => {
      pending += bytes.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) parse(line);
      // Third-party import chatter must not grow an unbounded buffer.
      if (pending.length > 32_000) pending = pending.slice(-32_000);
    });
    child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const heartbeat = setInterval(notify, heartbeatMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(heartbeat);
      if (pending) parse(pending);
      const safe = text => text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]').slice(-2_000);
      resolve({ ok: code === 0 && Boolean(result) && result.imports.length === 0, imports: result?.imports?.map(safe) || [],
        timedOut, module: currentModule, code, signal, detail: safe(spawnError || diagnostics.trim()), elapsedMs: Date.now() - started });
    };
    child.once('error', error => { spawnError = error.code || error.message; finish(null, null); });
    child.once('close', finish);
  });
}

export function pythonReport(metadata, imports) {
  const base = { ready: false, version: metadata.version, interpreterReady: true, missing: metadata.missing || [] };
  if (!metadata.seriesOk) return { ...base, details: '需要 Python 3.12' };
  if (base.missing.length) return { ...base, details: `依赖缺失或版本不符：${base.missing.join(', ')}` };
  if (imports.ok) return { ...base, ready: true, details: 'CAD / 文档依赖可导入' };
  const location = imports.module ? `（${imports.module}）` : '';
  if (imports.timedOut) return { ...base, importTimedOut: true, details: `原生依赖导入超时${location}，Python ${metadata.version} 本身可运行；首次原生库加载可能较慢，可保留环境后重试检查。` };
  const errors = imports.imports?.join('; ') || imports.detail || `进程退出 ${imports.signal || imports.code || '未知状态'}`;
  return { ...base, details: `依赖导入失败${location}：${errors}` };
}

export async function inspectPython(root = projectRoot, { onProgress } = {}) {
  const interpreter = pythonPath(root);
  if (!await exists(interpreter)) return { ready: false, version: null, interpreterReady: false, details: '未安装项目 .venv 或解释器链接失效' };
  const metadataProbe = await probe(interpreter, ['-c', PYTHON_METADATA, root], root, 20_000);
  if (!metadataProbe.ok) return { ready: false, version: null, interpreterReady: false, details: `Python 解释器检查失败（${metadataProbe.code}）` };
  let metadata;
  try { metadata = JSON.parse(metadataProbe.stdout.split('\n').at(-1)); }
  catch { return { ready: false, version: null, interpreterReady: false, details: 'Python 解释器检查未返回有效版本信息' }; }
  // Do not spend time importing native libraries when pip must install them first.
  if (!metadata.seriesOk || metadata.missing.length) return pythonReport(metadata, {});
  const imports = await probePythonImports(interpreter, ['-u', '-c', PYTHON_IMPORTS], { cwd: root, onProgress });
  return pythonReport(metadata, imports);
}

async function nodePackages(root) {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const locked = lock.packages?.[`node_modules/${name}`];
      if (!locked || ![lock.packages['']?.dependencies?.[name], lock.packages['']?.devDependencies?.[name]].includes(spec)) return false;
      const installed = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== locked.version) return false;
    }
    const result = await probe(process.execPath, ['--input-type=module', '-e', 'await Promise.all(["dotenv","express","multer","react","react-dom","three","vite","@vitejs/plugin-react"].map(name=>import(name)));'], root);
    return result.ok;
  } catch { return false; }
}

export async function inspectLocal(root = projectRoot, { onPythonProgress } = {}) {
  const lock = JSON.parse(await readFile(path.join(root, 'integrations/agh/runtime-lock.json'), 'utf8'));
  const runtime = path.join(root, 'integrations/agh/vendor-runtime');
  const entry = path.join(runtime, 'packages/cli/dist/local/agnes.mjs');
  const loader = path.join(runtime, 'node_modules/tsx/dist/loader.mjs');
  const npm = await npmCommand().catch(() => null);
  const [git, npmVersion, packages, py, revision, dirty] = await Promise.all([
    probe('git', ['--version'], root),
    npm ? probe(npm.command, [...npm.prefix, '--version'], root) : { ok: false },
    nodePackages(root),
    inspectPython(root, { onProgress: onPythonProgress }),
    probe('git', ['rev-parse', 'HEAD'], runtime),
    probe('git', ['status', '--porcelain', '--untracked-files=no'], runtime),
  ]);
  const python = py;
  const runtimeExists = await exists(runtime);
  const revisionOk = revision.ok && revision.stdout === lock.commit;
  const clean = dirty.ok && !dirty.stdout;
  const built = await exists(entry) && await exists(loader) && (process.platform !== 'win32' || await exists(path.join(runtime, 'packages/system-node/dist/native/agnes-system.node')));
  const runtimeHelp = revisionOk && clean && built ? await probe(process.execPath, [entry, '--help'], root) : { ok: false };
  const agh = { ready: revisionOk && clean && built && runtimeHelp.ok, installed: runtimeExists, revision: revision.ok ? revision.stdout : null,
    clean, built, expectedRevision: lock.commit };
  const node = { ready: versionAtLeast(process.versions.node), version: process.versions.node };
  const report = { node, npm: { ready: npmVersion.ok, version: npmVersion.stdout || null }, git: { ready: git.ok }, packages: { ready: packages }, python, agh };
  return { ...report, ready: Object.values(report).every(item => item.ready) };
}

export function printReport(report) {
  const rows = [
    ['Node.js ≥24.10', report.node.ready, report.node.version], ['npm', report.npm.ready, report.npm.version],
    ['Git', report.git.ready, ''], ['前后端依赖', report.packages.ready, 'package-lock.json'],
    ['Python 3.12 / CAD', report.python.ready, [report.python.version, report.python.details].filter(Boolean).join(' — ')],
    ['官方 AGH', report.agh.ready, report.agh.ready ? report.agh.expectedRevision.slice(0, 12) : '需要恢复锁定运行时'],
  ];
  for (const [name, ok, detail] of rows) console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` · ${detail}` : ''}`);
}

export async function choosePython(root, { platform = process.platform, env = process.env, home = homedir(), probeCommand = probe } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const inEnvironment = (directory, conda = false) => paths.join(directory, platform === 'win32' ? (conda ? 'python.exe' : 'Scripts/python.exe') : 'bin/python');
  const candidates = [];
  const add = (command, prefix = []) => {
    if (command && !candidates.some(item => item.command === command && String(item.prefix) === String(prefix))) candidates.push({ command, prefix });
  };
  // An explicit interpreter must be honored, including paths with spaces. Never
  // interpolate it into a shell command or silently replace an invalid override.
  if (env.ENGINEERAGENT_PYTHON) {
    if (!paths.isAbsolute(env.ENGINEERAGENT_PYTHON)) throw new Error('ENGINEERAGENT_PYTHON 必须是 Python 3.12 可执行文件的绝对路径。');
    add(env.ENGINEERAGENT_PYTHON);
  } else {
    if (env.VIRTUAL_ENV) add(inEnvironment(env.VIRTUAL_ENV));
    if (env.CONDA_PREFIX) add(inEnvironment(env.CONDA_PREFIX, true));
    if (platform === 'win32') add('py', ['-3.12']);
    add('python3.12');
    if (platform !== 'win32') add('python3');
    add('python');
    // Conda environments on another drive are not registered with the Windows
    // Python Launcher. Its per-user registry also works on macOS and Linux,
    // without activating an environment or executing conda.bat through a shell.
    let registry = '';
    try { registry = await readFile(path.join(home, '.conda/environments.txt'), 'utf8'); }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    for (const directory of registry.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      if (paths.isAbsolute(directory)) add(inEnvironment(directory, true));
    }
  }
  const detected = new Set();
  for (const candidate of candidates) {
    const result = await probeCommand(candidate.command, [...candidate.prefix, '-I', '-c', 'import sys; print("%s.%s.%s" % sys.version_info[:3])'], root, 10_000);
    if (!result.ok || !/^\d+\.\d+\.\d+$/.test(result.stdout)) continue;
    detected.add(result.stdout);
    if (result.stdout.startsWith('3.12.')) return candidate;
  }
  const detail = detected.size ? `已检测到 Python ${[...detected].join('、')}，但 CAD 依赖需要 3.12。` : '未找到可运行的 Python 3.12。';
  const override = env.ENGINEERAGENT_PYTHON ? '请检查 ENGINEERAGENT_PYTHON 指定的解释器。' : '已检查系统命令、当前环境和 Conda 环境登记。';
  throw new Error(`${detail}${override}\n可使用已有 Python 3.12 的 Conda 环境，或先安装 Python 3.12：https://www.python.org/downloads/ 。自定义位置可通过 ENGINEERAGENT_PYTHON 指定可执行文件的绝对路径，详见 README.md。`);
}

export async function setupLocal({ root = projectRoot, install = false, quiet = false } = {}) {
  let notified = false, lastSlowNotice = -1;
  const onPythonProgress = quiet ? undefined : ({ module, elapsedSeconds }) => {
    if (!notified) { console.log('检查 Python CAD 依赖（macOS 首次加载原生库可能需要数分钟）…'); notified = true; }
    const interval = Math.floor(elapsedSeconds / 15);
    if (elapsedSeconds >= 15 && interval !== lastSlowNotice) { console.log(`仍在检查 ${module || 'Python 依赖'}，已等待 ${elapsedSeconds} 秒…`); lastSlowNotice = interval; }
  };
  let report = await inspectLocal(root, { onPythonProgress });
  if (!quiet) printReport(report);
  if (report.ready) return report;
  if (!install) throw new Error('本地依赖尚未就绪。运行 node scripts/setup-local.mjs 安装缺失依赖，或双击“启动工程助手”。--check 只检查，不会下载或修改文件。');
  if (!report.node.ready || !report.npm.ready) throw new Error('请先安装 Node.js ≥24.10（包含 npm）：https://nodejs.org/，然后重新运行。');
  if (!report.git.ready) throw new Error('请先安装 Git：https://git-scm.com/downloads，然后重新打开终端运行。');

  // Resolve prerequisites before downloading npm packages; a version mismatch
  // should be actionable without leaving a half-installed project behind.
  const basePython = !report.python.ready && !await exists(path.join(root, '.venv')) ? await choosePython(root) : null;
  const npm = await npmCommand();
  const installEnv = mirrorEnvironment();
  if (installEnv.ENGINEERAGENT_MIRROR !== 'off') console.log(`依赖下载源：npm ${installEnv.npm_config_registry}；Python ${installEnv.PIP_INDEX_URL}（ENGINEERAGENT_MIRROR=off 可改用官方源）`);
  if (!report.packages.ready) {
    console.log('\n安装锁定的前后端依赖…');
    await run(npm.command, [...npm.prefix, 'ci', '--include=dev'], { cwd: root, env: installEnv });
  }
  if (!report.python.ready) {
    const interpreter = pythonPath(root);
    if (await exists(path.join(root, '.venv')) && (!report.python.version || !report.python.version.startsWith('3.12.'))) {
      throw new Error('现有 .venv 不可运行或并非 Python 3.12。为避免覆盖，请先将 .venv 移到其他位置，再重新运行安装。');
    }
    if (report.python.importTimedOut) throw new Error(`${report.python.details}\n并非缺包或版本错误；无需删除 .venv。运行 node scripts/setup-local.mjs --check 可重新检查，若持续卡住请提供上方模块名。`);
    if (!await exists(interpreter)) {
      const python = basePython || await choosePython(root);
      console.log('\n创建项目专用 Python 3.12 环境…');
      await run(python.command, [...python.prefix, '-m', 'venv', '.venv'], { cwd: root });
    }
    console.log('\n安装 CAD 与文档解析依赖（首次下载较大）…');
    await run(interpreter, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: root, env: installEnv });
    await run(interpreter, ['-m', 'pip', 'check'], { cwd: root });
  }
  if (!report.agh.ready) {
    const integration = path.join(root, 'integrations/agh');
    const runtime = path.join(integration, 'vendor-runtime');
    const lock = JSON.parse(await readFile(path.join(integration, 'runtime-lock.json'), 'utf8'));
    if (report.agh.installed && (!report.agh.revision || report.agh.revision !== lock.commit || !report.agh.clean)) {
      throw new Error('已有 AGH 目录不是干净的锁定版本。为避免覆盖本地修改，请保留并移走 integrations/agh/vendor-runtime 后重试。');
    }
    if (!report.agh.installed) {
      await mkdir(integration, { recursive: true });
      const snapshot = aghSnapshotPath(root, lock.commit);
      if (await exists(snapshot)) {
        // The submission package carries the locked commit, so no GitHub access is needed.
        console.log('\n从随包附带的快照恢复锁定的官方 Agnes Harness…');
        await mkdir(runtime, { recursive: true });
        await run('tar', ['-xzf', snapshot, '-C', runtime], { cwd: root });
      } else {
        console.log('\n获取锁定的官方 Agnes Harness…');
        await run('git', ['clone', '--no-checkout', lock.repository, runtime], { cwd: integration });
      }
      await run('git', ['checkout', '--detach', lock.commit], { cwd: runtime });
    }
    console.log(`\n使用 pnpm ${lock.pnpm} 安装并构建官方 AGH…`);
    const pnpm = [...npm.prefix, 'exec', '--yes', `--package=pnpm@${lock.pnpm}`, '--', 'pnpm'];
    await run(npm.command, [...pnpm, 'install', '--frozen-lockfile', '--prod=false'], { cwd: runtime, env: installEnv });
    const buildEnv = await nativeBuildEnvironment(root, npm, installEnv);
    await run(npm.command, [...pnpm, '--filter', '@agnes/cli', 'build:local'], { cwd: runtime, env: buildEnv });
    await restoreSdkNative(runtime);
  }
  notified = false; lastSlowNotice = -1;
  report = await inspectLocal(root, { onPythonProgress });
  printReport(report);
  if (!report.ready) throw new Error('安装完成后仍有检查未通过，请根据上方项目修复。没有启动服务，也没有调用模型。');
  console.log('\n依赖已就绪。启动后点击输入框下方的模型按钮填写 API Key。');
  return report;
}

export async function buildNeeded(root = projectRoot) {
  const target = path.join(root, 'dist/index.html');
  if (!await exists(target)) return true;
  const builtAt = (await stat(target)).mtimeMs;
  async function newer(filename) {
    try {
      const info = await stat(filename);
      if (info.isDirectory()) {
        for (const child of await readdir(filename)) if (await newer(path.join(filename, child))) return true;
        return false;
      }
      return info.mtimeMs > builtAt;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  for (const item of ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json']) {
    if (await newer(path.join(root, item))) return true;
  }
  return false;
}

async function main(args) {
  if (args.includes('--help')) { console.log('node scripts/setup-local.mjs [--check]\n默认安装缺失依赖；--check 只检查，不下载、不调用模型。'); return; }
  if (args.some(arg => arg !== '--check')) throw new Error('不支持的参数；使用 --help 查看用法。');
  await setupLocal({ install: !args.includes('--check') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`\n${error.message}`); process.exitCode = 1; });
}
