import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from '../src/commands.js';

test('commands are isolated by device, dispatched once, and completed by the correct agent', async t => {
  const commands = createCommands(); t.after(() => commands.close());
  const result = commands.submit('PC-Linux', 'files', { path: '/' });
  assert.equal(commands.next('OTHER-PC'), null);
  const job = commands.next('PC-Linux');
  assert.equal(commands.next('PC-Linux'), null);
  assert.throws(() => commands.finish('OTHER-PC', job.id, {}), { status: 403 });
  commands.finish('PC-Linux', job.id, { entries: [] });
  assert.deepEqual(await result, { entries: [] });
  assert.throws(() => commands.submit('PC-Linux', 'shell'), { status: 400 });
});

test('queued commands expire, reject on revocation, and are not replayed', async t => {
  const commands = createCommands({ timeout: 20 }); t.after(() => commands.close());
  await assert.rejects(commands.submit('PC', 'close', {}), { status: 504 });
  assert.equal(commands.next('PC'), null);
  const result = commands.submit('PC', 'files');
  const rejected = assert.rejects(result, { status: 409 });
  commands.disconnect('PC'); await rejected;
  assert.equal(commands.next('PC'), null);
});
