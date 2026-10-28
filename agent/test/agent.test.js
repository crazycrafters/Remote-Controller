import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAgent } from '../src/agent.js';
import { createServer } from '../src/control-server.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'shared');
  await mkdir(root); await writeFile(path.join(root, 'hello.txt'), 'hello home');
  await writeFile(path.join(directory, 'private.txt'), 'private');
  return { directory, root };
}

test('file API lists and downloads permitted files and blocks traversal and symlinks', async t => {
  const { directory, root } = await fixture(t);
  const agent = await createAgent({ root });
  assert.deepEqual(await agent.files(), [{ name: 'hello.txt', directory: false }]);
  const result = await agent.download('hello.txt');
  assert.equal(await result.file.readFile('utf8'), 'hello home'); await result.file.close();
  await assert.rejects(agent.download('../private.txt'), { status: 403 });
  await assert.rejects(agent.files(directory), { status: 400 });
  await symlink(directory, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(agent.download('escape/private.txt'), { status: 403 });
  assert.equal((await agent.files()).some(e => e.name === 'escape'), false);
});

test('application controls require allowlist, fresh one-use ticket, and matching process', async () => {
  let rows = [{ pid: 10001, name: 'game' }, { pid: 10002, name: 'other' }, { pid: process.pid, name: 'game' }];
  const calls = [];
  const agent = await createAgent({ root: tmpdir(), allowedApps: ['game'], processes: async () => rows, close: async (...args) => calls.push(args) });
  const [app] = await agent.applications();
  assert.equal((await agent.applications()).length, 1);
  await assert.rejects(agent.stop(app.ticket, false), { status: 409 });
  const [fresh] = await agent.applications();
  await agent.stop(fresh.ticket, false);
  assert.deepEqual(calls, [[10001, false]]);
  await assert.rejects(agent.stop(fresh.ticket, true), { status: 409 });
  const [changed] = await agent.applications(); rows = [];
  await assert.rejects(agent.stop(changed.ticket, true), { status: 409 });
});

test('HTTP authentication, origin checks, file requests, and force confirmation', async t => {
  const { root } = await fixture(t);
  const token = 'a-test-secret-that-is-long-enough-for-tests';
  const calls = [];
  const hosts = [];
  const server = await createServer({ root, token, hosts, origins: ['http://127.0.0.1:4310'], allowedApps: ['game'], processes: async () => [{ pid: 10001, name: 'game' }], close: async (...args) => calls.push(args) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  hosts.push(`127.0.0.1:${server.address().port}`);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(base + '/', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/files', { headers: {} })).status, 401);
  assert.equal((await fetch(base + '/api/files', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/files', { headers })).status, 200);
  assert.equal(await (await fetch(base + '/api/download?path=hello.txt', { headers })).text(), 'hello home');
  assert.equal((await fetch(base + '/api/download?path=..%2Fprivate.txt', { headers })).status, 403);
  const { applications: [app] } = await (await fetch(base + '/api/applications', { headers })).json();
  const post = body => fetch(base + '/api/applications/close', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ ticket: app.ticket, force: true }))).status, 400);
  assert.equal((await post(JSON.stringify({ ticket: app.ticket, force: true, confirm: 'FORCE' }))).status, 200);
  assert.deepEqual(calls, [[10001, true]]);
});

test('native process adapter finds and terminates a real disposable process', { skip: process.platform === 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  const { listProcesses, closeProcess } = await import('../src/processes.js');
  const rows = await listProcesses();
  assert.ok(rows.some(p => p.pid === child.pid));
  const exited = once(child, 'exit');
  await closeProcess(child.pid, false);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
});

test('disabled application controls do not invoke an unavailable OS process utility', async () => {
  const agent = await createAgent({ root: tmpdir(), processes: async () => { throw new Error('Unavailable process utility'); } });
  assert.deepEqual(await agent.applications(), []);
});
