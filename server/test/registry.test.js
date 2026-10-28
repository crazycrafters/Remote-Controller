import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegistry } from '../src/registry.js';
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('server assigns unique IDs, hashes credentials, persists identities, and revokes devices', async t => {
  const directory = await temporary(t);
  const registry = await createRegistry(directory);
  const info = { hostname: 'WORK-PC', platform: 'win32' };
  const first = await registry.enroll(registry.invite().code, info);
  const second = await registry.enroll(registry.invite().code, info);
  assert.match(first.id, /^WORK-PC-[A-F0-9]{12}$/);
  assert.notEqual(first.id, second.id);
  const raw = await readFile(path.join(directory, 'devices.json'), 'utf8');
  assert.ok(!raw.includes(first.credential));
  assert.ok(!JSON.stringify(registry.list()).includes('credential'));
  await assert.rejects(registry.heartbeat(first.id, second.credential), { status: 401 });
  const restored = await createRegistry(directory);
  assert.equal((await restored.heartbeat(first.id, first.credential)).id, first.id);
  await restored.revoke(first.id);
  await assert.rejects(restored.heartbeat(first.id, first.credential), { status: 401 });
  assert.equal(restored.list()[0].online, false);
});

test('enrollment invitations expire and are single-use even under concurrent attempts', async t => {
  const registry = await createRegistry(await temporary(t));
  const info = { hostname: 'PC', platform: 'linux' };
  const invite = registry.invite();
  const results = await Promise.allSettled([registry.enroll(invite.code, info), registry.enroll(invite.code, info)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const expired = registry.invite();
  const original = Date.now;
  try {
    Date.now = () => expired.expires + 1;
    await assert.rejects(registry.enroll(expired.code, info), { status: 403 });
  } finally { Date.now = original; }
});

test('automatic registration gives duplicate PC names distinct persistent IDs pending approval', async t => {
  const directory = await temporary(t);
  const registry = await createRegistry(directory);
  const info = { hostname: 'SAME-PC', platform: 'linux' };
  const first = await registry.enroll(undefined, info);
  const second = await registry.enroll(undefined, info);
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^SAME-PC-/);
  assert.equal(first.status, 'pending');
  const restored = await createRegistry(directory);
  assert.equal((await restored.heartbeat(first.id, first.credential)).status, 'pending');
  await restored.approve(first.id);
  const afterRestart = await createRegistry(directory);
  assert.equal((await afterRestart.heartbeat(first.id, first.credential)).status, 'registered');
  assert.equal(afterRestart.list().find(d => d.id === second.id).approved, false);
  await assert.rejects(registry.enroll('invalid-code', info), { status: 403 });
});
