#!/usr/bin/env node
/** Reproducible submission snapshot; never traverses private runtime directories. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pythonPath, aghSnapshotPath } from './setup-local.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_BYTES = 200_000_000;
export const ARCHIVE_NAME = '本科生组-U263-盼盼法式小面包-余梓丞.zip';
export const INNER_NAME = 'EngineerAgent.zip';
export const RECORDS_DIR = 'AGH执行记录';
export const REPOSITORY_URL = 'https://github.com/zicheng-yu/Agnes-Hackathon-EngineerAgent';
export const DEMO_URL = 'https://engineeragent.zichengyu.site/';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const FIXED_TIME = [2026, 10, 10, 0, 0, 0];
const EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.css', '.html', '.json', '.jsonl', '.md', '.txt', '.py', '.svg', '.png', '.pdf', '.jpg', '.jpeg', '.webp', '.glb', '.step', '.stp', '.stl', '.zip', '.yaml', '.yml', '.toml', '.csv', '.sql']);
const SOURCE_ROOTS = ['.github', 'src', 'server', 'tools', 'tests', 'scripts', 'public', 'docs', 'assets', 'dist'];
const TOP_FILES = ['README.md', 'LICENSE', '启动工程助手.command', '启动工程助手.bat', 'package.json', 'package-lock.json', 'requirements.txt', 'index.html', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', '.env.example', '.gitignore', '.gitattributes'];
const FORBIDDEN_SEGMENTS = new Set(['node_modules', '.venv', 'vendor-runtime', '.local', '.git', '__pycache__', '.openai', 'data', 'output', 'site-preview', 'deployment', 'references']);
export const EXCLUSIONS = [
  { path: 'node_modules/; .venv/', reason: 'Platform-dependent installed dependencies; restore from the included lock/requirements files.' },
  { path: 'integrations/agh/vendor-runtime/', reason: 'Official runtime source/build/dependencies omitted; restore the exact runtime-lock.json commit with setup-runtime.mjs. LICENSE and NOTICE are retained in third-party/agnes-harness/.' },
  { path: 'integrations/agh/.local/; data/', reason: 'Accounts, credentials, uploaded documents, task history and local run data are private; the app creates fresh directories.' },
  { path: '.env and secret/config credential files', reason: 'Only the blank .env.example is included. No model key is part of the archive.' },
  { path: 'site-preview/; deployment/; output/; references/', reason: 'Separate hosted checkout, old deployment archives, screenshots and original demonstration archive are not needed to run this implementation.' },
  { path: '**/__pycache__/; **/*.pyc; **/*.log; **/import.stdout.json; **/.DS_Store', reason: 'Caches and historical local import logs are omitted; public asset geometry, metadata, provenance and licenses are retained.' },
];

export function isAllowed(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some(x => !x || x === '..' || FORBIDDEN_SEGMENTS.has(x))) return false;
  const name = segments.at(-1);
  if (TOP_FILES.includes(normalized)) return true;
  if (name.startsWith('.') || name === 'import.stdout.json' || /(?:^|[-_.])(credentials?|secrets?)(?:[-_.]|$)/i.test(name)) return false;
  const allowedRoot = SOURCE_ROOTS.includes(segments[0]) || normalized.startsWith('integrations/agh/');
  return allowedRoot && (EXTENSIONS.has(path.extname(name).toLowerCase()) || /^(LICENSE|NOTICE|COPYING)(?:\.|$)/i.test(name));
}

export function portableText(text, projectRoot) {
  // Generated manifests previously recorded the developer machine's absolute root.
  // Rewrite only that known prefix; preserve geometry numbers and upstream URLs.
  return text.replaceAll(projectRoot + '/', '').replaceAll(projectRoot + '\\', '').replaceAll(JSON.stringify(projectRoot), '"."');
}

export function assertNoCredential(text, relative) {
  // Report the filename only. Never echo a matching credential into build logs.
  if (/\bsk-[A-Za-z0-9_-]{28,}\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    throw new Error(`Possible credential detected in ${relative}; archive was not produced.`);
  }
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const isText = relative => !/\.(?:png|jpg|jpeg|webp|glb|zip)$/i.test(relative);

async function walk(base, prefix = '') {
  const entries = await fs.readdir(base, { withFileTypes: true });
  const names = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (FORBIDDEN_SEGMENTS.has(entry.name) || (entry.name.startsWith('.') && !(prefix === '' && entry.name === '.github'))) continue;
      names.push(...await walk(path.join(base, entry.name), relative));
    } else if (entry.isFile() && isAllowed(relative)) names.push(relative);
  }
  return names;
}

/** The only document at the top of the submission: links and the shortest path to a running app. */
export function howToStart(demoUrl) {
  const demo = demoUrl ? `<${demoUrl}>` : '（链接待发布）';
  return `# EngineerAgent 启动说明

- 在线体验（无需安装）：${demo}
- 开源仓库：<${REPOSITORY_URL}>

## 本地运行

1. 安装 Node.js ≥ 24.10、Python 3.12、Git，以及本平台的编译工具：macOS 运行 \`xcode-select --install\`；Windows 安装 Visual Studio Build Tools（“使用 C++ 的桌面开发”）；Linux 安装 \`build-essential\` 和 \`python3.12-venv\`。
2. 解压 \`${INNER_NAME}\`，进入 \`EngineerAgent\` 文件夹。
3. 启动：macOS 双击 \`启动工程助手.command\`；Windows 双击 \`启动工程助手.bat\`；Linux（或任意平台）在该文件夹运行 \`node scripts/start-local.mjs --install --open\`。
4. 浏览器打开 http://127.0.0.1:4310 ，点击输入框下方的模型按钮填写 Agnes API Key，再点任一测试案例即可运行。

首次启动会自动安装依赖（约 10 分钟）：Python 包走清华源，npm 包走 npmmirror，AGH 源码已随包附带，无需访问 GitHub。

## 包内容

- \`${INNER_NAME}\`：源码、前端构建、45 条工程资产、测试案例与安装脚本。
- \`${RECORDS_DIR}/\`：测试案例的 AGH 原生执行记录（\`trace.agnes.jsonl\`）、任务记录与产物，索引见 \`report.json\`。
`;
}

/** Shallow .git of the locked AGH commit, so a fresh install needs no GitHub access. */
async function aghSnapshot(projectRoot, lock) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'engineeragent-agh-'));
  try {
    const repo = path.join(work, 'repo');
    await exec('git', ['clone', '--quiet', '--depth', '1', '--no-checkout', pathToFileURL(path.join(projectRoot, 'integrations/agh/vendor-runtime')).href, repo]);
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo });
    if (stdout.trim() !== lock.commit) throw new Error('Installed AGH runtime is not at the locked commit; cannot build the snapshot.');
    await exec('git', ['remote', 'set-url', 'origin', lock.repository], { cwd: repo });
    const archive = path.join(work, 'agh.tar.gz');
    await exec('tar', ['-czf', archive, '-C', repo, '.git']);
    return await fs.readFile(archive);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

async function snapshot(projectRoot, staging) {
  const all = [];
  for (const name of TOP_FILES) {
    try { if ((await fs.lstat(path.join(projectRoot, name))).isFile()) all.push(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const name of [...SOURCE_ROOTS, 'integrations/agh']) {
    try { all.push(...await walk(path.join(projectRoot, name), name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const files = [];
  async function add(relative, content, source = relative, transformed = false) {
    if (isText(relative)) assertNoCredential(content.toString('utf8'), relative);
    if (staging) { await fs.mkdir(path.dirname(path.join(staging, relative)), { recursive: true }); await fs.writeFile(path.join(staging, relative), content); }
    files.push({ path: relative, bytes: content.length, sha256: sha256(content), source, transformed });
  }
  for (const relative of [...new Set(all)].sort()) {
    let content = await fs.readFile(path.join(projectRoot, relative));
    let transformed = false;
    // Only public metadata, documentation and plans need relocation. Source code
    // and tests retain their exact bytes, including intentional path fixtures.
    if ((/^(?:assets|docs)\//.test(relative) || /^tools\/.*\.json$/.test(relative)) && /\.(?:json|md|txt|svg)$/i.test(relative)) {
      const before = content.toString('utf8');
      let after = portableText(before, projectRoot);
      if (relative.startsWith('docs/')) after = after.replace(/\/Users\/[^\s`"'<>]+/g, '[未随包附带的本机路径]');
      transformed = before !== after;
      content = Buffer.from(after);
    }
    await add(relative, content, relative, transformed);
  }
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'integrations/agh/runtime-lock.json'), 'utf8'));
  for (const name of ['LICENSE', 'NOTICE']) {
    // Prefer the installed upstream copy; when repackaging an extracted archive,
    // the already-preserved license is available without downloading the runtime.
    let license;
    try { license = await fs.readFile(path.join(projectRoot, 'integrations/agh/vendor-runtime', name)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; license = await fs.readFile(path.join(projectRoot, 'third-party/agnes-harness', name)); }
    await add(`third-party/agnes-harness/${name}`, license, `${lock.repository}@${lock.commit}/${name}`);
  }
  await add(path.relative(projectRoot, aghSnapshotPath(projectRoot, lock.commit)).replaceAll('\\', '/'), await aghSnapshot(projectRoot, lock), `${lock.repository}@${lock.commit} (shallow .git)`);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const catalog = JSON.parse(await fs.readFile(path.join(projectRoot, 'assets/catalog/catalog.json'), 'utf8'));
  const generated = JSON.parse(await fs.readFile(path.join(projectRoot, 'assets/generated/catalog.json'), 'utf8'));
  const ids = [...catalog, ...(generated.assemblies || []), ...(generated.parts || [])].map(x => x.id);
  if (ids.length !== 45 || new Set(ids).size !== 45) throw new Error(`Expected 45 distinct asset records, found ${new Set(ids).size}; update the package review before packaging.`);
  const manifest = {
    schemaVersion: 1, product: 'EngineerAgent', status: 'runnable-local-release', maximumArchiveBytes: MAX_BYTES,
    archiveName: ARCHIVE_NAME, zipTimestamp: FIXED_TIME, compression: 'ZIP DEFLATE level 9',
    assetRecords: ids.length, payloadFiles: files.length, payloadBytes: files.reduce((sum, x) => sum + x.bytes, 0),
    runtime: { ...lock, included: 'source snapshot (shallow .git); dependencies restored on first start', restore: 'node scripts/setup-local.mjs', mirrors: 'PyPI: Tsinghua; npm/pnpm: npmmirror; ENGINEERAGENT_MIRROR=off for official registries' },
    transformations: ['Public asset/plan JSON replaces the known developer project-root prefix with project-relative paths.', 'Documentation removes external developer-machine absolute paths. Source code and binary geometry retain their bytes.'],
    excludes: EXCLUSIONS,
    integrity: 'SHA256 covers each listed payload file after portable-path conversion. Manifest itself is excluded to avoid circular hashing; outer ZIP SHA256 is written next to the archive.',
    files,
  };
  if (staging) await fs.writeFile(path.join(staging, 'submission-manifest.json'), json(manifest));
  return manifest;
}

const ZIP_PYTHON = String.raw`
import sys, json, os, zipfile, hashlib, tempfile, pathlib
mode, source, target = sys.argv[1:4]
if mode == 'create':
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(pathlib.Path(source).rglob('*')):
            if not p.is_file(): continue
            name = 'EngineerAgent/' + p.relative_to(source).as_posix()
            info = zipfile.ZipInfo(name, (2026, 10, 10, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o100755 if p.name.endswith('.command') else 0o100644) << 16
            z.writestr(info, p.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
elif mode == 'bundle':
    # Outer submission archive: top-level entries as they are (HOWTOSTART.md, inner zip, records).
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(pathlib.Path(source).rglob('*')):
            if not p.is_file(): continue
            info = zipfile.ZipInfo(p.relative_to(source).as_posix(), (2026, 10, 10, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.flag_bits |= 0x800
            stored = p.suffix == '.zip'
            z.writestr(info, p.read_bytes(), compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED, compresslevel=None if stored else 9)
elif mode == 'verify':
    with zipfile.ZipFile(source) as z:
        bad = z.testzip()
        if bad: raise RuntimeError('ZIP CRC failed: ' + bad)
        names = z.namelist()
        if len(names) != len(set(names)): raise RuntimeError('Duplicate ZIP entries')
        for n in names:
            p = pathlib.PurePosixPath(n)
            if p.is_absolute() or '..' in p.parts or '\\' in n or not n.startswith('EngineerAgent/'):
                raise RuntimeError('Unsafe archive path')
        manifest = json.loads(z.read('EngineerAgent/submission-manifest.json'))
        expected = {'EngineerAgent/' + x['path'] for x in manifest['files']} | {'EngineerAgent/submission-manifest.json'}
        if set(names) != expected: raise RuntimeError('ZIP entries differ from manifest')
        for entry in manifest['files']:
            content = z.read('EngineerAgent/' + entry['path'])
            if len(content) != entry['bytes'] or hashlib.sha256(content).hexdigest() != entry['sha256']:
                raise RuntimeError('Integrity mismatch: ' + entry['path'])
        z.extractall(target)
        print(json.dumps({'verifiedFiles': len(manifest['files']), 'assetRecords': manifest['assetRecords']}))
else: raise RuntimeError('Unknown operation')
`;

async function verifyArchive(filename, projectRoot) {
  const bytes = (await fs.stat(filename)).size;
  if (bytes > MAX_BYTES) throw new Error(`Archive exceeds ${MAX_BYTES} bytes: ${bytes}`);
  const extracted = await fs.mkdtemp(path.join(os.tmpdir(), 'engineeragent-verify-'));
  try {
    const verified = JSON.parse((await exec(pythonPath(projectRoot), ['-X', 'utf8', '-c', ZIP_PYTHON, 'verify', filename, extracted], { maxBuffer: 2 * 1024 * 1024 })).stdout);
    const { loadCatalog } = await import(pathToFileURL(path.join(projectRoot, 'server/catalog.mjs')).href);
    const packagedRoot = path.join(extracted, 'EngineerAgent');
    const catalog = await loadCatalog(packagedRoot);
    if (catalog.length !== 45) throw new Error(`Extracted catalog contains ${catalog.length} assets, expected 45.`);
    let assetLinks = 0;
    for (const item of catalog) {
      if (!item.modelUrl || !item.manifestUrl) throw new Error(`Incomplete packaged asset ${item.id}`);
      for (const key of ['modelUrl', 'manifestUrl', 'sourceModelUrl', 'stepUrl', 'thumbnailUrl']) {
        if (!item[key] || /^https?:/.test(item[key])) continue;
        const relative = decodeURIComponent(item[key]).replace(/^\//, '');
        if (!relative.startsWith('assets/') || relative.includes('..')) throw new Error(`Unsafe packaged asset link for ${item.id}`);
        await fs.access(path.join(packagedRoot, relative));
        assetLinks++;
      }
    }
    return { ...verified, verifiedAssetLinks: assetLinks, bytes, megabytes: Number((bytes / 1e6).toFixed(2)), sha256: sha256(await fs.readFile(filename)), headroomBytes: MAX_BYTES - bytes };
  } finally { await fs.rm(extracted, { recursive: true, force: true }); }
}

async function bundle(projectRoot, out, inner, manifest, demoUrl) {
  // Outer archive: HOWTOSTART.md, the runnable inner ZIP and a browsable copy of the AGH records.
  const staging = await fs.mkdtemp(path.join(out, '.bundle-'));
  const partial = path.join(out, '.bundle-partial.zip');
  try {
    await fs.writeFile(path.join(staging, 'HOWTOSTART.md'), howToStart(demoUrl));
    await fs.copyFile(inner, path.join(staging, INNER_NAME));
    for (const entry of manifest.files.filter(file => file.path.startsWith('assets/evaluation/'))) {
      const target = path.join(staging, RECORDS_DIR, entry.path.slice('assets/evaluation/'.length));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(projectRoot, entry.path), target);
    }
    await exec(pythonPath(projectRoot), ['-X', 'utf8', '-c', ZIP_PYTHON, 'bundle', staging, partial], { maxBuffer: 2 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    const bytes = (await fs.stat(partial)).size;
    if (bytes > MAX_BYTES) throw new Error(`Submission archive exceeds ${MAX_BYTES} bytes: ${bytes}`);
    const archive = path.join(out, ARCHIVE_NAME);
    await fs.rename(partial, archive);
    const digest = sha256(await fs.readFile(archive));
    await fs.writeFile(archive + '.sha256', `${digest}  ${ARCHIVE_NAME}\n`);
    return { archive, bytes, megabytes: Number((bytes / 1e6).toFixed(2)), sha256: digest, headroomBytes: MAX_BYTES - bytes };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(partial, { force: true });
  }
}

async function main(args) {
  if (args.includes('--help')) { console.log('node scripts/package-submission.mjs [--dry-run | --measure] [--demo-url URL] [--verify path/to/EngineerAgent.zip]'); return; }
  const valueOf = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const unknown = args.filter((arg, i) => !['--dry-run', '--measure', '--verify', '--demo-url'].includes(arg) && !['--verify', '--demo-url'].includes(args[i - 1]));
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
  if (args.includes('--verify')) {
    const file = valueOf('--verify');
    if (!file || file.startsWith('--')) throw new Error('--verify requires an archive path.');
    console.log(json(await verifyArchive(path.resolve(file), root))); return;
  }
  const demoUrl = valueOf('--demo-url') || process.env.ENGINEERAGENT_DEMO_URL || DEMO_URL;
  if (demoUrl && !/^https:\/\/[^\s]+$/.test(demoUrl)) throw new Error('--demo-url must be an https URL.');
  const out = path.join(root, 'output/submission');
  await fs.mkdir(out, { recursive: true });
  if (args.includes('--dry-run')) {
    const manifest = await snapshot(root);
    const target = path.join(out, 'submission-dry-run.json');
    await fs.writeFile(target, json(manifest));
    console.log(json({ dryRun: true, manifest: target, assetRecords: manifest.assetRecords, files: manifest.payloadFiles, uncompressedBytes: manifest.payloadBytes, maximumArchiveBytes: MAX_BYTES }));
    return;
  }
  const staging = await fs.mkdtemp(path.join(out, '.staging-'));
  const partial = path.join(out, '.inner-partial.zip');
  try {
    const manifest = await snapshot(root, staging);
    await exec(pythonPath(root), ['-X', 'utf8', '-c', ZIP_PYTHON, 'create', staging, partial], { maxBuffer: 2 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    const inner = await verifyArchive(partial, root);
    if (args.includes('--measure')) {
      const report = { ...inner, payloadBytes: manifest.payloadBytes, status: 'measurement-only' };
      await fs.writeFile(path.join(out, 'submission-size-budget.json'), json(report));
      console.log(json(report));
      return;
    }
    const innerPath = path.join(out, INNER_NAME);
    await fs.rename(partial, innerPath);
    const outer = await bundle(root, out, innerPath, manifest, demoUrl);
    await fs.writeFile(path.join(out, 'submission-manifest.json'), json(manifest));
    const verification = { archive: ARCHIVE_NAME, ...outer, inner: { name: INNER_NAME, ...inner }, demoUrl: demoUrl || null,
      checks: ['inner ZIP CRC, exact file list and every payload SHA256', 'clean extraction with 45 catalog records and all asset links', 'outer archive within the 200 MB limit'] };
    await fs.writeFile(path.join(out, 'submission-verification.json'), json(verification));
    console.log(json(verification));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(partial, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
