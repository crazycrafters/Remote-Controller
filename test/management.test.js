import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createManagementServer } from '../server/src/server.js';
import { connectDevice, managementUrl } from '../agent/src/device-client.js';
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-management-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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

test('local test mode opens both dashboards without passwords while preserving origin and proxy checks', async t => {
  const directory = await temporary(t);
  const { createServer } = await import('../agent/src/control-server.js');
  const hosts = [];
  const management = await createManagementServer({ directory, hosts, origins: [], testNoAuth: true });
  const agent = await createServer({ root: directory, hosts, origins: [], testNoAuth: true });
  for (const server of [management, agent]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    hosts.push(`127.0.0.1:${server.address().port}`);
  }
  const managementBase = `http://127.0.0.1:${management.address().port}`;
  const agentBase = `http://127.0.0.1:${agent.address().port}`;
  assert.equal((await fetch(managementBase + '/api/devices')).status, 200);
  assert.equal((await fetch(agentBase + '/api/files')).status, 200);
  for (const base of [managementBase, agentBase]) {
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.testNoAuth, true);
    assert.equal((await fetch(base + '/', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/config', { headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 403);
    assert.equal((await fetch(base + '/api/config', { headers: { Forwarded: 'for=203.0.113.1' } })).status, 403);
  }
  const device = await connectDevice({ server: managementBase, directory: path.join(directory, 'device') });
  assert.equal((await device.heartbeat()).status, 'pending');
  const approve = await fetch(managementBase + '/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: device.id }) });
  assert.equal(approve.status, 200);
  assert.equal((await device.heartbeat()).status, 'registered');
});
