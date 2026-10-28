import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runConnection } from '../src/connection.js';

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped'));
    signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
  });
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await delay(10); }
  throw new Error('Connection condition timed out');
}

test('slow file I/O does not stall heartbeats or an independent application request', async t => {
  const controller = new AbortController(); let release;
  const slow = new Promise(resolve => { release = resolve; });
  t.after(() => { controller.abort(); release({ entries: [] }); });
  let heartbeats = 0, index = 0;
  const results = [];
  const commands = [{ id: 'slow', operation: 'files' }, { id: 'fast', operation: 'applications' }];
  const running = runConnection({ signal: controller.signal, heartbeatMs: 10, log: () => {}, report: () => {},
    device: { heartbeat: async () => { heartbeats++; }, poll: async () => index < commands.length ? { command: commands[index++] } : waitForAbort(controller.signal), result: async (id, data) => results.push({ id, data }) },
    agent: { browse: () => slow, applications: async () => [] }
  });
  await until(() => results.some(r => r.id === 'fast') && heartbeats >= 3);
  assert.ok(!results.some(r => r.id === 'slow'));
  release({ entries: [] }); await until(() => results.length === 2);
  controller.abort(); await running;
});

test('transient result delivery retries never execute a destructive action twice', async () => {
  const controller = new AbortController();
  let executed = 0, attempts = 0, polled = false;
  const running = runConnection({ signal: controller.signal, heartbeatMs: 10, log: () => {}, report: () => {},
    device: {
      heartbeat: async () => {},
      poll: async () => { if (polled) return waitForAbort(controller.signal); polled = true; return { command: { id: 'close', operation: 'close', args: { ticket: 'ticket', force: false } } }; },
      result: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('Transient'), { status: 503 }); }
    }, agent: { stop: async () => { executed++; } }
  });
  try { await until(() => attempts === 2); assert.equal(executed, 1); }
  finally { controller.abort(); await running; }
});
