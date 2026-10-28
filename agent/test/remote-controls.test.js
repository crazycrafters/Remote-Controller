import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand } from '../src/remote-controls.js';

test('remote close validates force confirmation and delegates only approved tickets', async () => {
  const calls = [];
  const agent = { stop: async (...args) => calls.push(args) };
  await assert.rejects(executeCommand(agent, { operation: 'close', args: { ticket: 'ticket', force: true } }), { status: 400 });
  await executeCommand(agent, { operation: 'close', args: { ticket: 'ticket', force: true, confirm: 'FORCE' } });
  assert.deepEqual(calls, [['ticket', true]]);
  await assert.rejects(executeCommand(agent, { operation: 'shell', args: {} }), { status: 400 });
});

test('central download size limits close the file handle on rejection', async () => {
  let closed = false;
  const agent = { download: async () => ({ size: 9 * 1024 * 1024, file: { close: async () => { closed = true; } } }) };
  await assert.rejects(executeCommand(agent, { operation: 'download', args: { path: 'large' } }), { status: 413 });
  assert.equal(closed, true);
});
