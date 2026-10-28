import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRegistry, deviceId } from '../src/registry.js';
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('PCname-OS identities persist securely and revocation blocks reconnection', async t => {
  const directory = await temporary(t);
  const registry = await createRegistry(directory);
  const info = { hostname: 'WORK-PC', platform: 'win32' };
  const first = await registry.enroll(registry.invite().code, info);
  const second = await registry.enroll(undefined, { ...info, hostname: 'SECOND-PC' });
  assert.equal(first.id, 'WORK-PC-Windows');
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

test('automatic approval rejects name collisions and authenticates returning PCs', async t => {
  const directory = await temporary(t);
  const registry = await createRegistry(directory);
  const info = { hostname: 'SAME-PC', platform: 'linux' };
  const first = await registry.enroll(undefined, info);
  assert.equal(first.id, 'SAME-PC-Linux');
  assert.equal(first.status, 'registered');
  assert.equal(registry.list()[0].approved, true);
  await assert.rejects(registry.enroll(undefined, info), { status: 409 });
  const restored = await createRegistry(directory);
  const returning = await restored.enroll(undefined, info, first);
  assert.equal(returning.id, first.id);
  assert.equal(returning.credential, first.credential);
  assert.equal(restored.list().length, 1);
  await assert.rejects(restored.enroll(undefined, info, { ...first, credential: '0'.repeat(64) }), { status: 401 });
  await restored.revoke(first.id);
  await assert.rejects(restored.enroll(undefined, info, first), { status: 401 });
});

test('legacy IDs migrate on authenticated handshake and hostname changes retain identity', async t => {
  const directory = await temporary(t);
  const registry = await createRegistry(directory);
  const info = { hostname: 'PC', platform: 'darwin' };
  const original = await registry.enroll(undefined, info);
  const filename = path.join(directory, 'devices.json');
  const records = JSON.parse(await readFile(filename, 'utf8'));
  const { scryptSync } = await import('node:crypto');
  records[0].credentialHash = scryptSync(original.credential, 'remote-controller-device-credential-v1', 32).toString('hex');
  delete records[0].credentialAlgorithm;
  records[0].id = 'PC-OLD-RANDOM-ID'; records[0].approved = false;
  await writeFile(filename, JSON.stringify(records));
  const restored = await createRegistry(directory);
  const migrated = await restored.enroll(undefined, info, { ...original, id: records[0].id });
  assert.equal(migrated.id, 'PC-macOS');
  const renamed = await restored.enroll(undefined, { ...info, hostname: 'RENAMED' }, migrated);
  assert.equal(renamed.id, 'RENAMED-macOS');
  assert.equal(restored.list().length, 1);
  assert.equal(deviceId({ hostname: 'PC', platform: 'win32' }), 'PC-Windows');
  assert.throws(() => deviceId({ hostname: '../PC', platform: 'linux' }), { status: 400 });
});
