import { randomUUID } from 'node:crypto';
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createCommands({ timeout = 20_000 } = {}) {
  const jobs = new Map();
  return {
    submit(deviceId, operation, args = {}) {
      if (!['roots', 'files', 'download', 'applications', 'close'].includes(operation)) throw fail(400, 'Unsupported operation');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail(400, 'Invalid operation arguments');
      if (jobs.size >= 100 || [...jobs.values()].filter(j => j.deviceId === deviceId).length >= 10) throw fail(429, 'Too many pending requests');
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { jobs.delete(id); reject(fail(504, 'Agent did not respond; refresh before retrying an action')); }, timeout);
        jobs.set(id, { id, deviceId, operation, args, dispatched: false, resolve, reject, timer });
      });
    },
    next(deviceId) {
      const job = [...jobs.values()].find(j => j.deviceId === deviceId && !j.dispatched);
      if (!job) return null;
      job.dispatched = true;
      return { id: job.id, operation: job.operation, args: job.args };
    },
    finish(deviceId, id, result, error) {
      const job = jobs.get(id);
      if (!job) return; // A timed-out response must never execute or complete a newer command.
      if (job.deviceId !== deviceId || !job.dispatched) throw fail(403, 'Command does not belong to this device');
      clearTimeout(job.timer); jobs.delete(id);
      if (error) job.reject(fail([400, 403, 404, 409, 413].includes(error.status) ? error.status : 502, typeof error.message === 'string' ? error.message.slice(0, 300) : 'Agent operation failed'));
      else job.resolve(result);
    },
    disconnect(deviceId) {
      for (const [id, job] of jobs) if (job.deviceId === deviceId) { clearTimeout(job.timer); jobs.delete(id); job.reject(fail(409, 'Device disconnected or was revoked')); }
    },
    close() {
      for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(fail(503, 'Management server stopped')); }
      jobs.clear();
    }
  };
}
