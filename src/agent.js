import { realpath, readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { listProcesses, closeProcess } from './processes.js';

export function authorized(header, token) {
  const supplied = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function createAgent({ root, allowedApps = [], processes = listProcesses, close = closeProcess }) {
  const base = await realpath(root);
  if (!(await stat(base)).isDirectory()) throw new Error('RC_ROOT must be a directory');
  const permits = new Set(allowedApps);
  const tickets = new Map();
  async function resolve(relative) {
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw Object.assign(new Error('Invalid relative path'), { status: 400 });
    const target = await realpath(path.resolve(base, relative));
    const rel = path.relative(base, target);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Object.assign(new Error('Path is outside the permitted folder'), { status: 403 });
    return target;
  }
  return {
    async files(relative = '') {
      const folder = await resolve(relative);
      const entries = await readdir(folder, { withFileTypes: true });
      // Symlinks are deliberately omitted from listings.
      return entries.filter(e => e.isDirectory() || e.isFile()).map(e => ({ name: e.name, directory: e.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    },
    async download(relative) {
      const target = await resolve(relative);
      // Reject a replaced final-component symlink on supported platforms.
      const { constants } = await import('node:fs');
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = await file.stat();
        if (!info.isFile()) throw Object.assign(new Error('Not a regular file'), { status: 400 });
        return { file, size: info.size, name: path.basename(target) };
      } catch (error) { await file.close(); throw error; }
    },
    async applications() {
      tickets.clear();
      return (await processes()).filter(p => p.pid > 1 && p.pid !== process.pid && permits.has(p.name)).map(p => {
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
      if (!current || !permits.has(current.name)) throw Object.assign(new Error('Application changed; refresh the list'), { status: 409 });
      await close(current.pid, force);
    }
  };
}
