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
  assert.equal((await post('/api/control', { id: 'PC-Linux', operation: 'files' })).status, 401);
  assert.equal((await post('/api/device/poll', { id: 'PC-Linux' })).status, 401);
  assert.equal((await post('/api/login', { password: 'wrong' })).status, 401);
  const login = await post('/api/login', { password: 'a-test-admin-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const options = { server: base, directory: path.join(directory, 'device') };
  const device = await connectDevice(options);
  assert.equal((await device.heartbeat()).status, 'registered');
  const restarted = await connectDevice({ ...options, code: undefined });
  assert.equal(restarted.id, device.id);
  await restarted.heartbeat();
  // Successful reconnects used to exhaust a shared login limiter and break all requests.
  for (let i = 0; i < 12; i++) await connectDevice(options);
  assert.equal((await restarted.heartbeat()).status, 'registered');
  const devices = await (await fetch(base + '/api/devices', { headers: { Cookie: cookie } })).json();
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].id, device.id);
  assert.equal(devices.devices[0].online, true);
  assert.equal(devices.devices[0].approved, true);
  assert.equal((await post('/api/approve', { id: device.id })).status, 401);
  assert.equal((await post('/api/approve', { id: device.id }, cookie)).status, 200);
  assert.equal((await restarted.heartbeat()).status, 'registered');
  assert.equal((await post('/api/revoke', { id: device.id }, cookie)).status, 200);
  assert.equal((await device.poll()).disconnected, true);
  const reconnected = await connectDevice(options);
  assert.equal(reconnected.id, device.id);
  assert.equal((await reconnected.heartbeat()).status, 'registered');
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
  assert.equal((await device.heartbeat()).status, 'registered');
  const approve = await fetch(managementBase + '/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: device.id }) });
  assert.equal(approve.status, 200);
  assert.equal((await device.heartbeat()).status, 'registered');
});

test('one agent loads .env, auto-connects, serves central file controls, reconnects, and respects revocation', { timeout: 45_000 }, async t => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const { setTimeout: delay } = await import('node:timers/promises');
  const directory = await temporary(t);
  const root = path.join(directory, 'shared'); await mkdir(root);
  const binary = Buffer.from([0, 1, 2, 255, 128, 10]);
  await writeFile(path.join(root, 'sample.bin'), binary);
  const hosts = [];
  const server = await createManagementServer({ directory: path.join(directory, 'server'), hosts, origins: [], testNoAuth: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const host = `127.0.0.1:${server.address().port}`; hosts.push(host);
  const base = `http://${host}`;
  await writeFile(path.join(directory, '.env'), `RC_SERVER_URL=${base}\n`);
  const env = { ...process.env, RC_ROOT: root, RC_FILE_MODE: 'folder', RC_DEVICE_DATA: path.join(directory, 'identity'), RC_ALLOWED_APPS: '' };
  delete env.RC_SERVER_URL; delete env.RC_ENROLLMENT_CODE;
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  t.after(async () => { for (const child of children) await stop(child); });
  function start() {
    const child = spawn(process.execPath, [path.resolve('agent/src/index.js')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain output without logging credentials or collecting unlimited agent output.
    child.ready = new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('Agent startup timed out')), 7000);
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('Connected as ')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Agent exited before connecting')); });
    });
    child.stderr.resume(); children.push(child); return child;
  }
  async function connected() {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const devices = (await (await fetch(base + '/api/devices')).json()).devices;
      if (devices.length === 1 && devices[0].connected) return devices[0];
      await delay(50);
    }
    throw new Error('Unified agent did not connect');
  }
  const first = start(); await first.ready;
  const device = await connected();
  assert.match(device.id, /-(Windows|Linux|macOS)$/);
  assert.equal(device.approved, true);
  async function control(operation, args = {}) {
    return fetch(base + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: device.id, operation, args }) });
  }
  assert.equal((await fetch(base + '/pcs/' + encodeURIComponent(device.id))).status, 200);
  assert.equal((await (await control('roots')).json()).mode, 'folder');
  const listing = await (await control('files')).json();
  assert.equal(listing.entries[0].name, 'sample.bin');
  const terminal = await (await control('terminal', { path: '', command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' })).json();
  assert.equal(terminal.stdout.trim(), root);
  const downloaded = await (await control('download', { path: 'sample.bin' })).json();
  assert.deepEqual(Buffer.from(downloaded.data, 'base64'), binary);
  assert.equal((await control('files', { path: '..' })).status, 403);
  assert.ok(Array.isArray((await (await control('applications')).json()).applications));
  assert.equal((await control('shell')).status, 400);
  assert.equal((await control('close', { ticket: 'fake', force: true })).status, 400);
  assert.equal((await control('close', { ticket: 'fake', force: false })).status, 409);
  await stop(first);
  // A returning agent must reuse its saved identity and auto-connect without another approval.
  const second = start(); await second.ready; const returning = await connected(); assert.equal(returning.id, device.id);
  // Wait for the new process to poll, rather than relying on the previous connection timestamp.
  assert.equal((await control('files')).status, 200);
  // The agent must reconnect after a real management-server restart, without restarting the agent.
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const replacement = await createManagementServer({ directory: path.join(directory, 'server'), hosts, origins: [], testNoAuth: true });
  replacement.listen(Number(host.split(':')[1]), '127.0.0.1'); await once(replacement, 'listening');
  t.after(() => new Promise(resolve => { replacement.close(resolve); replacement.closeAllConnections(); }));
  const afterServerRestart = await connected();
  assert.equal(afterServerRestart.id, device.id);
  assert.equal((await control('files')).status, 200);
  const disconnectedExit = once(second, 'exit');
  await fetch(base + '/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: device.id }) });
  assert.equal((await control('files')).status, 409);
  await disconnectedExit;
  const third = start(); await third.ready;
  const afterDisconnect = await connected(); assert.equal(afterDisconnect.id, device.id);
  assert.equal((await control('files')).status, 200);
});

test('storage failures return a specific error and request reference without credential values', async t => {
  const { writeFile } = await import('node:fs/promises');
  const directory = await temporary(t); const storage = path.join(directory, 'server');
  const hosts = [];
  const server = await createManagementServer({ directory: storage, hosts, origins: [], testNoAuth: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const host = `127.0.0.1:${server.address().port}`; hosts.push(host);
  const device = await connectDevice({ server: `http://${host}`, directory: path.join(directory, 'identity') });
  await rm(storage, { recursive: true }); await writeFile(storage, 'blocked by a file');
  const logs = []; t.mock.method(console, 'error', value => logs.push(value));
  await assert.rejects(device.heartbeat(), error => {
    assert.match(error.message, /storage path is not a directory/);
    assert.equal(error.status, 500); assert.ok(error.requestId); return true;
  });
  assert.equal(JSON.parse(logs[0]).code, 'EEXIST');
  assert.ok(!logs[0].includes('Bearer'));
});

test('server pushes live presence and temporary disconnect allows the same device to reconnect', { timeout: 10_000 }, async t => {
  const directory = await temporary(t), hosts = [];
  const server = await createManagementServer({ directory: path.join(directory, 'server'), hosts, origins: [], testNoAuth: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const host = `127.0.0.1:${server.address().port}`; hosts.push(host); const base = `http://${host}`;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(); let buffer = '';
  async function snapshot() {
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); const line = frame.split('\n').find(line => line.startsWith('data: ')); if (line) return JSON.parse(line.slice(6)).devices; }
      const { value, done } = await reader.read(); if (done) throw new Error('Presence stream ended'); buffer += new TextDecoder().decode(value);
    }
  }
  assert.deepEqual(await snapshot(), []);
  const options = { server: base, directory: path.join(directory, 'identity') };
  const device = await connectDevice(options); await device.heartbeat();
  assert.equal((await snapshot())[0].connected, true);
  await fetch(base + '/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: device.id }) });
  assert.equal((await snapshot())[0].connected, false);
  assert.equal((await device.poll()).disconnected, true);
  const returning = await connectDevice(options); await returning.heartbeat();
  const recovered = await snapshot(); assert.equal(recovered[0].connected, true); assert.equal(recovered[0].id, device.id);
  await returning.disconnect(); assert.equal((await snapshot())[0].connected, false);
  await reader.cancel(); controller.abort();
});
