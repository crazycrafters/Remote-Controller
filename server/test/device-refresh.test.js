import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRefresh } from '../public/device-refresh.js';

test('refresh requests are coalesced and an outage preserves the last successful list', async () => {
  let release, calls = 0, fail = false;
  const initial = new Promise(resolve => { release = resolve; });
  let displayed = []; const states = [];
  const refresh = createDeviceRefresh({ load: async () => { calls++; if (fail) throw new Error('Offline'); return initial; }, apply: value => { displayed = value; }, state: value => states.push(value) });
  const first = refresh.refresh(); const second = refresh.refresh();
  assert.equal(first, second); release([{ id: 'PC-Linux' }]); await first;
  assert.equal(calls, 1); fail = true;
  await assert.rejects(refresh.refresh(), /Offline/);
  assert.deepEqual(displayed, [{ id: 'PC-Linux' }]);
  assert.equal(states.at(-1).status, 'retrying'); assert.equal(refresh.nextDelay(), 10_000);
  fail = false; await refresh.refresh(); assert.equal(refresh.nextDelay(), 5000);
});

test('a response received after logout cannot restore a signed-out device list', async () => {
  let release, applied = false;
  const refresh = createDeviceRefresh({ load: () => new Promise(resolve => { release = resolve; }), apply: () => { applied = true; }, state: () => {} });
  const request = refresh.refresh(); await Promise.resolve(); refresh.invalidate(); release([]); await request;
  assert.equal(applied, false);
});

test('signing in again can refresh while a previous session response is still outstanding', async () => {
  const releases = []; let displayed;
  const refresh = createDeviceRefresh({ load: () => new Promise(resolve => releases.push(resolve)), apply: value => { displayed = value; }, state: () => {} });
  const old = refresh.refresh(); await Promise.resolve(); refresh.invalidate();
  const current = refresh.refresh(); await Promise.resolve();
  releases[0]([{ id: 'old' }]); await old;
  assert.equal(refresh.refresh(), current);
  releases[1]([{ id: 'current' }]); await current;
  assert.deepEqual(displayed, [{ id: 'current' }]);
});
