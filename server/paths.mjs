import path from 'node:path';

/** Strict descendant with filesystem semantics; works with native, win32 and posix paths. */
export function isWithinDirectory(root, target, paths = path) {
  const relative = paths.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

/** Convert a validated relative filesystem path to a portable reference. */
export function portablePath(value, paths = path) {
  return value.split(paths.sep).join('/');
}
