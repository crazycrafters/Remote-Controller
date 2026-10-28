import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRegistry } from '../src/registry.js';
import { createManagementServer } from '../src/management-server.js';
import { connectDevice, managementUrl } from '../src/device-client.js';
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-management-'));
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

test('management API login, enrollment client restart, dashboard inventory, and revocation', async t => {
  const directory = await temporary(t);
  const hosts = [];
  const server = await createManagementServer({ directory: path.join(directory, 'server'), password: 'a-test-admin-password', hosts, origins: [], secureCookies: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const host = `127.0.0.1:${server.address().port}`; hosts.push(host);
  const base = `http://${host}`;
  const post = (route, data, cookie) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/devices')).status, 401);
  assert.equal((await post('/api/login', { password: 'wrong' })).status, 401);
  const login = await post('/api/login', { password: 'a-test-admin-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const options = { server: base, directory: path.join(directory, 'device') };
  const device = await connectDevice(options);
  assert.equal((await device.heartbeat()).status, 'pending');
  const restarted = await connectDevice({ ...options, code: undefined });
  assert.equal(restarted.id, device.id);
  await restarted.heartbeat();
  const devices = await (await fetch(base + '/api/devices', { headers: { Cookie: cookie } })).json();
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].id, device.id);
  assert.equal(devices.devices[0].online, true);
  assert.equal(devices.devices[0].approved, false);
  assert.equal((await post('/api/approve', { id: device.id })).status, 401);
  assert.equal((await post('/api/approve', { id: device.id }, cookie)).status, 200);
  assert.equal((await restarted.heartbeat()).status, 'registered');
  assert.equal((await post('/api/revoke', { id: device.id }, cookie)).status, 200);
  await assert.rejects(device.heartbeat(), /authentication failed/);
  assert.equal((await post('/api/approve', { id: device.id }, cookie)).status, 409);
  assert.equal((await post('/api/logout', {}, cookie)).status, 200);
  assert.equal((await fetch(base + '/api/devices', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(base + '/', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
});

test('device enrollment requires HTTPS outside loopback and disallows embedded credentials', () => {
  assert.equal(managementUrl('https://company.example'), 'https://company.example');
  assert.equal(managementUrl('http://127.0.0.1:4320'), 'http://127.0.0.1:4320');
  for (const url of ['http://company.example', 'https://user:password@company.example', 'https://company.example/path', 'https://company.example?secret=x']) assert.throws(() => managementUrl(url));
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
