import { setTimeout as delay } from 'node:timers/promises';
import { executeCommand } from './remote-controls.js';

// A long poll and a separate heartbeat continue while bounded workers perform file/process I/O.
// Only posting the same completed result may be retried; actions themselves are never replayed.
export async function runConnection({ device, agent, signal, log = console.log, report = console.error, heartbeatMs = 30_000 }) {
  const lifetime = new AbortController();
  signal = AbortSignal.any([signal, lifetime.signal]);
  const pending = new Set();
  const pause = ms => delay(ms, undefined, { signal });
  const heartbeat = (async () => {
    while (!signal.aborted) {
      try { await device.heartbeat(); }
      catch (error) { if (!signal.aborted) report(`Heartbeat: ${error.message}`); }
      try { await pause(heartbeatMs); } catch { break; }
    }
  })();
  async function execute(command) {
    log(`Management request: ${command.operation}`);
    let result, error;
    try { result = await executeCommand(agent, command); }
    catch (failure) {
      const messages = { ENOENT: 'This file or folder no longer exists.', EACCES: 'The agent account cannot access this file or folder.', EPERM: 'The operating system denied this operation.', EBUSY: 'This file or application is busy.', ENOTDIR: 'The selected path is not a folder.' };
      error = { status: failure.status || ({ ENOENT: 404, EACCES: 403, EPERM: 403, ENOTDIR: 400 }[failure.code]) || 502, message: failure.status ? failure.message : messages[failure.code] || 'File or application operation failed on the managed PC.' };
    }
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      try { await device.result(command.id, result, error); return; }
      catch (failure) {
        if (signal.aborted) return;
        if ((failure.status && failure.status < 500 && failure.status !== 429) || attempt === 2) { report(`Result delivery failed: ${failure.message}. The action will not be executed again.`); return; }
        try { await pause(250 * 2 ** attempt); } catch { return; }
      }
    }
  }
  let failures = 0;
  try {
    while (!signal.aborted) {
      if (pending.size >= 2) { await Promise.race(pending); continue; }
      try {
        const { command } = await device.poll();
        if (failures) log('Management connection restored.');
        failures = 0;
        if (command && !signal.aborted) {
          const task = execute(command).finally(() => pending.delete(task)); pending.add(task);
        }
      } catch (error) {
        if (signal.aborted) break;
        failures++;
        if (failures === 1) report(`Management connection interrupted: ${error.message}. Reconnecting without replaying actions.`);
        try { await pause(Math.min(15_000, 500 * 2 ** Math.min(failures - 1, 5))); } catch { break; }
      }
    }
  } finally { lifetime.abort(); await Promise.allSettled([heartbeat, ...pending]); }
}
