import { tmpdir } from 'node:os';

/** Preserve OS essentials without inheriting unrelated model/account credentials. */
export function runtimeEnvironment(env = process.env) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA'];
  return { ...Object.fromEntries(keys.filter(key => env[key]).map(key => [key, env[key]])), TMPDIR: env.TMPDIR || env.TEMP || env.TMP || tmpdir(), LANG: env.LANG || 'en_US.UTF-8', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}
