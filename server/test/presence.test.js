import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPresence } from '../src/presence.js';

test('presence changes immediately on connect/disconnect and expires after a missed heartbeat', async t => {
  let time = 1000, changes = 0;
  const presence = createPresence({ now: () => time, changed: () => changes++ });
  t.after(() => presence.close());
  presence.touch('PC'); assert.equal(presence.connected('PC'), true); assert.equal(changes, 1);
  presence.touch('PC'); assert.equal(changes, 1);
  presence.disconnect('PC'); assert.equal(presence.connected('PC'), false); assert.equal(changes, 2);
  presence.touch('PC'); time += 7000;
  assert.equal(presence.connected('PC'), false);
  await delay(1100); assert.equal(changes, 4);
});
