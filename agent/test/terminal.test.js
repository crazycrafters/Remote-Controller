import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/agent.js';
import { runShell } from '../src/terminal.js';

test('terminal executes in the browsed folder and reports nonzero exit without dropping the connection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rc-terminal-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  const agent = await createAgent({ root }); const listing = await agent.browse('nested');
  const result = await agent.terminal(process.platform === 'win32' ? '(Get-Location).Path' : 'pwd', listing.path);
  assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), await realpath(path.join(root, 'nested')));
  assert.equal((await agent.terminal('exit 7', listing.path)).exitCode, 7);
  await assert.rejects(agent.terminal('echo forbidden', '..'), { status: 403 });
});

test('terminal validates commands, bounds execution time, and limits output', async () => {
  assert.throws(() => runShell('', tmpdir()), { status: 400 });
  const windows = process.platform === 'win32';
  const long = await runShell(windows ? 'Start-Sleep -Seconds 10' : 'sleep 10', tmpdir(), { timeout: 100 });
  assert.equal(long.timedOut, true);
  const output = await runShell(windows ? "'x' * 100000" : 'yes x', tmpdir(), { maxBytes: 1024, timeout: 5000 });
  assert.equal(output.truncated, true); assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 1024);
});
