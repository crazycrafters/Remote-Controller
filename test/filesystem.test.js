import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createFilesystem, discoverRoots, validateSystemPath } from '../src/filesystem.js';
import { createServer } from '../src/server.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-system-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  await mkdir(first); await mkdir(second);
  await writeFile(path.join(second, 'outside.txt'), 'file in another folder');
  return { directory, first, second };
}

test('system mode navigates roots, parents, outside folders, and symlink directories', async t => {
  const { directory, first, second } = await fixture(t);
  const fs = await createFilesystem({ fileMode: 'system', root: first });
  const roots = await fs.roots();
  assert.equal(roots.mode, 'system');
  assert.ok(roots.roots.some(root => root.path === path.parse(directory).root));
  assert.equal((await fs.browse()).parent, null);
  const listing = await fs.browse(second);
  assert.equal(listing.parent, directory);
  assert.deepEqual(listing.entries, [{ name: 'outside.txt', directory: false, path: path.join(second, 'outside.txt') }]);
  const download = await fs.download(listing.entries[0].path);
  assert.equal(await download.file.readFile('utf8'), 'file in another folder'); await download.file.close();
  const link = path.join(first, 'other-folder');
  await symlink(second, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fs.browse(first)).entries[0].directory, true);
  assert.equal((await fs.browse(link)).entries[0].name, 'outside.txt');
  assert.equal((await fs.browse(path.parse(directory).root)).parent, '');
  await assert.rejects(fs.browse('relative/path'), { status: 400 });
  await assert.rejects(fs.download(second), { status: 400 });
});

test('Windows discovery includes available local and mapped drive letters', async () => {
  const inspected = [];
  const roots = await discoverRoots('win32', async value => {
    inspected.push(value);
    if (!['C:\\', 'D:\\', 'Z:\\'].includes(value)) throw Object.assign(new Error('Unavailable'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  });
  assert.equal(inspected.length, 26);
  assert.deepEqual(roots.map(r => r.path), ['C:\\', 'D:\\', 'Z:\\']);
  for (const value of ['C:\\Users\\watto', 'D:/Games', 'z:\\']) assert.equal(validateSystemPath(value, 'win32'), value);
  for (const value of ['C:relative', '\\Windows', '\\\\server\\share', '\\\\?\\C:\\', 'C:\\bad\0']) assert.throws(() => validateSystemPath(value, 'win32'), { status: 400 });
});

test('mode configuration preserves existing folder restriction and defaults new installs to system', async t => {
  const { first } = await fixture(t);
  assert.equal((await (await createFilesystem({})).roots()).mode, 'system');
  assert.equal((await (await createFilesystem({ root: first })).roots()).mode, 'folder');
  await assert.rejects(createFilesystem({ fileMode: 'folder' }), { status: 400 });
  await assert.rejects(createFilesystem({ fileMode: 'unknown' }), { status: 400 });
});

test('authenticated HTTP system browsing returns absolute navigation paths and downloads across folders', async t => {
  const { first, second } = await fixture(t);
  const hosts = [];
  const server = await createServer({ fileMode: 'system', root: first, token: 'test-token', hosts, origins: [] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const host = `127.0.0.1:${server.address().port}`; hosts.push(host);
  const base = `http://${host}`;
  const headers = { Authorization: 'Bearer test-token' };
  assert.equal((await fetch(base + '/api/roots')).status, 401);
  assert.equal((await (await fetch(base + '/api/roots', { headers })).json()).mode, 'system');
  const response = await fetch(base + '/api/files?path=' + encodeURIComponent(second), { headers });
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.equal(listing.path, second);
  const file = await fetch(base + '/api/download?path=' + encodeURIComponent(listing.entries[0].path), { headers });
  assert.equal(await file.text(), 'file in another folder');
  assert.equal((await fetch(base + '/api/files?path=relative', { headers })).status, 400);
  assert.equal((await fetch(base + '/api/files?path=' + encodeURIComponent(path.join(second, 'missing')), { headers })).status, 404);
});
