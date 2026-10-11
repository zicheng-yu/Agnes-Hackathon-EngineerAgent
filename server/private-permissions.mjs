import { execFile } from 'node:child_process';
import { chmod, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runtimeEnvironment } from './runtime-environment.mjs';
const exec = promisify(execFile);
let native;
function windowsNative() {
  if (native === undefined) {
    try { native = createRequire(import.meta.url)(fileURLToPath(new URL('../integrations/agh/vendor-runtime/packages/cli/dist/local/node_modules/@agnes/system-node/dist/native/agnes-system.node', import.meta.url))); }
    catch { native = null; }
  }
  return native;
}

const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = Get-Item -LiteralPath $env:ENGINEERAGENT_PRIVATE_PATH -Force
if ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private path cannot be a reparse point' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $target.FullName
$trusted = @($me.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Private path has an untrusted owner' }
if ($env:ENGINEERAGENT_PRIVATE_ACTION -eq 'check') {
  $broad = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted })
  [Console]::Write(($broad.Count -eq 0).ToString()); exit
}
if ($target.PSIsContainer) { $next = New-Object Security.AccessControl.DirectorySecurity; $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
else { $next = New-Object Security.AccessControl.FileSecurity; $inherit = [Security.AccessControl.InheritanceFlags]::None }
$next.SetOwner($acl.GetOwner([Security.Principal.SecurityIdentifier]))
$next.SetAccessRuleProtection($true, $false)
foreach ($id in $trusted) {
  $sid = New-Object Security.Principal.SecurityIdentifier($id)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
  $next.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target.FullName -AclObject $next
`;
async function windowsAcl(path, action) {
  try {
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, env: { ...runtimeEnvironment(), ENGINEERAGENT_PRIVATE_PATH: path, ENGINEERAGENT_PRIVATE_ACTION: action } });
    return result.stdout.trim().toLowerCase() === 'true';
  } catch { throw new Error('Windows private ACL operation failed; check directory ownership and access rights.'); }
}

export async function hasPrivatePermissions(path) {
  const info = await lstat(path);
  if ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink()) return false;
  if (process.platform !== 'win32') return (!process.getuid || info.uid === process.getuid()) && (info.mode & 0o077) === 0;
  const runtime = windowsNative();
  return runtime ? runtime.hasPrivateDacl(toNamespacedPath(path)) : windowsAcl(path, 'check');
}

/** Tighten only an application-owned object, never its ancestors or another user's path. */
export async function setPrivatePermissions(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Expected a private regular path.');
  if (process.platform !== 'win32') { await chmod(path, directory ? 0o700 : 0o600); return; }
  if (!await hasPrivatePermissions(path)) await windowsAcl(path, 'protect');
  if (!await hasPrivatePermissions(path)) throw new Error('Windows private ACL could not be verified.');
}
