import test from 'node:test';
import assert from 'node:assert/strict';
import { sameMacProcess } from './daemon-connection.mjs';

test('macOS daemon reuse tolerates boot-clock microsecond drift but requires exact process-start identity', () => {
  const recorded = 'darwin:1789912719.807033:8682:1791561510.426101';
  assert.equal(sameMacProcess(recorded, 'alive 1789912719.755231 1791561510.426101\n', 8682), true);
  assert.equal(sameMacProcess(recorded, 'alive 1789912719.755231 1791561511.426101\n', 8682), false);
  assert.equal(sameMacProcess(recorded, 'alive 1789912719.755231 1791561510.426101\n', 8683), false);
  assert.equal(sameMacProcess(recorded, 'alive 1789912720.900000 1791561510.426101\n', 8682), false);
  assert.equal(sameMacProcess(recorded, 'dead\n', 8682), false);
});
