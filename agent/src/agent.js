import { runShell } from './terminal.js';
import { createFilesystem } from './filesystem.js';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { listProcesses, closeProcess } from './processes.js';

export function authorized(header, token) {
  const supplied = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function createAgent({ root, fileMode, allowedApps, processes = listProcesses, close = closeProcess }) {
  const filesystem = await createFilesystem({ root, fileMode });
  const permits = allowedApps === undefined ? null : new Set(allowedApps);
  const tickets = new Map();
  return {
    roots: filesystem.roots,
    async terminal(command, folder) { return runShell(command, await filesystem.directory(folder)); },
    browse: filesystem.browse,
    async files(value = '') {
      return (await filesystem.browse(value)).entries.map(({ name, directory }) => ({ name, directory }));
    },
    download: filesystem.download,
    async applications() {
      tickets.clear();
      if (permits && !permits.size) return [];
      return (await processes()).filter(p => p.pid > 1 && p.pid !== process.pid && (!permits || permits.has(p.name))).map(p => {
        const ticket = randomBytes(24).toString('hex');
        tickets.set(ticket, { ...p, expires: Date.now() + 60_000 });
        return { ...p, ticket };
      });
    },
    async stop(ticket, force) {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      if (!entry || entry.expires < Date.now()) throw Object.assign(new Error('Refresh applications before closing'), { status: 409 });
      const current = (await processes()).find(p => p.pid === entry.pid && p.name === entry.name);
      if (!current || (permits && !permits.has(current.name))) throw Object.assign(new Error('Application changed; refresh the list'), { status: 409 });
      await close(current.pid, force);
    }
  };
}
