import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDependencies } from '../agent/bootstrap.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rc-bootstrap-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = { name: 'fixture', dependencies: { 'fixture-dependency': '^1.0.0' } };
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  async function installed() {
    const dependency = path.join(directory, 'node_modules', 'fixture-dependency'); await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.js' }));
    await writeFile(path.join(dependency, 'index.js'), 'module.exports = {};');
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': manifest, 'node_modules/fixture-dependency': { version: '1.0.0' } } }));
  }
  return { directory, installed };
}

test('startup installs missing dependencies once and skips installation when the locked dependencies are present', async t => {
  const { directory, installed } = await fixture(t); let count = 0;
  const install = async () => { count++; await installed(); };
  assert.equal(await ensureDependencies(directory, install), true);
  assert.equal(await ensureDependencies(directory, install), false);
  assert.equal(count, 1);
});

test('startup repairs a runtime dependency version that differs from the lockfile', async t => {
  const { directory, installed } = await fixture(t); await installed();
  await writeFile(path.join(directory, 'node_modules/fixture-dependency/package.json'), JSON.stringify({ name: 'fixture-dependency', version: '0.5.0', main: 'index.js' }));
  assert.equal(await ensureDependencies(directory, installed), true);
});

test('dependency installation failure stops startup rather than continuing with missing modules', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(ensureDependencies(directory, async () => { throw new Error('Registry unavailable'); }), /Registry unavailable/);
  await assert.rejects(ensureDependencies(directory, async () => {}), /still missing/);
});
