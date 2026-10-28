import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { createAgent } from '../src/agent.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rc-file-actions-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['one', 'two', 'destination', 'one/empty']) await mkdir(path.join(root, name));
  await writeFile(path.join(root, 'one/a.txt'), 'first'); await writeFile(path.join(root, 'two/b.txt'), 'second');
  return { root, agent: await createAgent({ root }) };
}
async function unzip(filename) {
  const zip = await new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const entries = {};
  await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) { entries[entry.fileName] = ''; zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error); const chunks = [];
        stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
        stream.on('end', () => { entries[entry.fileName] = Buffer.concat(chunks).toString(); zip.readEntry(); });
      });
    }); zip.readEntry();
  }); return entries;
}

test('multiple selected folders produce a valid ZIP with contents and empty directories', async t => {
  const { agent } = await fixture(t); const archive = await agent.archive(['one', 'two']);
  try {
    const entries = await unzip(archive.filename);
    assert.equal(entries['one/a.txt'], 'first'); assert.equal(entries['two/b.txt'], 'second'); assert.equal(entries['one/empty/'], '');
  } finally { await archive.cleanup(); }
});

test('copy/paste preserves sources, rejects collisions without overwriting, and prevents recursive copies', async t => {
  const { root, agent } = await fixture(t);
  assert.equal((await agent.copy(['one', 'two'], 'destination')).copied, 2);
  assert.equal(await readFile(path.join(root, 'destination/one/a.txt'), 'utf8'), 'first');
  assert.equal(await readFile(path.join(root, 'one/a.txt'), 'utf8'), 'first');
  await assert.rejects(agent.copy(['one'], 'destination'), { status: 409 });
  await assert.rejects(agent.copy(['one'], 'one/empty'), { status: 400 });
  await assert.rejects(agent.archive(['one', 'one/empty']), { status: 400 });
  await assert.rejects(agent.copy(['one'], '..'), { status: 403 });
  assert.deepEqual(await readdir(path.join(root, 'destination')), ['one', 'two']);
});

test('ZIP and copy reject symlinks rather than archive unexpected targets', async t => {
  const { root, agent } = await fixture(t);
  await symlink(path.join(root, 'two'), path.join(root, 'one/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(agent.archive(['one']), { status: 400 });
  await assert.rejects(agent.copy(['one'], 'destination'), { status: 400 });
  assert.deepEqual(await readdir(path.join(root, 'destination')), []);
});
