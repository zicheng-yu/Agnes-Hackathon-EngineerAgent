import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { publicAssetPath } from '../../server/catalog.mjs';
import { isWithinDirectory, portablePath } from '../../server/paths.mjs';
import { runtimeEnvironment } from '../../server/runtime-environment.mjs';

for (const [platform, paths, root] of [['Windows', path.win32, 'D:\\工程 项目'], ['macOS', path.posix, '/Users/test/工程 项目'], ['Linux', path.posix, '/home/test/工程 项目']]) {
  test(`${platform}: catalogue URLs and strict directory boundaries`, () => {
    assert.equal(publicAssetPath(root, 'assets/catalog/图纸 A/model.glb', paths), '/assets/catalog/%E5%9B%BE%E7%BA%B8%20A/model.glb');
    assert.equal(publicAssetPath(root, paths.join(root, 'data/runs/123/model.step'), paths), '/runs/123/model.step');
    assert.equal(portablePath(paths.join('input-0', 'page.jpg'), paths), 'input-0/page.jpg');
    for (const bad of [root, paths.resolve(root, '../private'), root + '-other/file', paths.resolve(root, 'assets/../../private')]) assert.equal(isWithinDirectory(root, bad, paths), false);
    assert.equal(publicAssetPath(root, '../private/key', paths), undefined);
    assert.equal(isWithinDirectory(paths.join(root, 'assets'), paths.join(root, 'assets/file.step'), paths), true);
    assert.equal(isWithinDirectory(paths.join(root, 'assets'), paths.join(root, 'assets-other/file.step'), paths), false);
  });
}

test('Windows drive and UNC share boundaries cannot become project paths', () => {
  assert.equal(isWithinDirectory('D:\\project', 'E:\\project\\file', path.win32), false);
  assert.equal(isWithinDirectory('\\\\server\\share\\project', '\\\\server\\other\\project\\file', path.win32), false);
});

test('child environment preserves operating-system essentials but not account keys', () => {
  const env = runtimeEnvironment({ PATH: '/bin', HOME: '/home/test', TEMP: 'D:\\tmp', SystemRoot: 'C:\\Windows', AGNES_API_KEY: 'private', OPENAI_API_KEY: 'private' });
  assert.equal(env.HOME, '/home/test'); assert.equal(env.TMPDIR, 'D:\\tmp'); assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.AGNES_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
});
