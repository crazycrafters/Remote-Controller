import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createArchiveStore } from '../src/archives.js';

test('server persists uploaded ZIPs, filters by PC, and prevents path traversal and replacement', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-archives-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createArchiveStore(directory); const id = randomUUID();
  const data = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]);
  await store.save(id, 'PC-Linux', Readable.from(data));
  assert.equal((await store.list('PC-Linux')).length, 1); assert.deepEqual(await store.list('Other-PC'), []);
  const download = await store.download(id); const chunks = [];
  for await (const chunk of download.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data);
  await assert.rejects(store.save(id, 'PC-Linux', Readable.from(data)), { status: 409 });
  await assert.rejects(store.download('../secret'), { status: 400 });
  await assert.rejects(store.save(randomUUID(), 'PC-Linux', Readable.from('not a zip')), { status: 400 });
  assert.equal((await store.list('PC-Linux')).length, 1);
});
