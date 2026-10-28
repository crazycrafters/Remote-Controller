import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const digest = value => scryptSync(value, 'remote-controller-device-credential-v1', 32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function createRegistry(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'devices.json');
  let devices;
  try { devices = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; devices = []; }
  const invites = new Map();
  let queue = Promise.resolve();
  function transaction(fn) {
    const pending = queue.then(async () => {
      const next = structuredClone(devices);
      const result = fn(next);
      await writeFile(filename + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(filename + '.tmp', filename);
      devices = next;
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return {
    invite() {
      for (const [key, expires] of invites) if (expires < Date.now()) invites.delete(key);
      const code = randomBytes(12).toString('hex');
      const expires = Date.now() + 10 * 60_000;
      invites.set(code, expires);
      return { code, expires };
    },
    async enroll(code, info) {
      const expires = invites.get(code);
      if (!expires || expires < Date.now()) throw fail(403, 'Enrollment code is invalid or expired');
      if (!info || typeof info.hostname !== 'string' || info.hostname.length > 255 || !info.hostname || !['win32', 'linux', 'darwin'].includes(info.platform)) throw fail(400, 'Invalid device details');
      invites.delete(code);
      const credential = randomBytes(32).toString('hex');
      const result = await transaction(next => {
        const prefix = info.hostname.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40) || 'PC';
        let id;
        do { id = `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`; } while (next.some(d => d.id === id));
        next.push({ id, hostname: info.hostname, platform: info.platform, credentialHash: digest(credential), enrolledAt: Date.now(), lastSeen: Date.now(), revoked: false });
        return { id, credential };
      });
      return result;
    },
    async heartbeat(id, credential) {
      if (typeof credential !== 'string' || credential.length !== 64) throw fail(401, 'Device authentication required');
      const candidate = digest(credential);
      return transaction(next => {
        const device = next.find(d => d.id === id && !d.revoked);
        if (!device || !timingSafeEqual(Buffer.from(candidate), Buffer.from(device.credentialHash))) throw fail(401, 'Device authentication failed');
        device.lastSeen = Date.now();
        return { id: device.id, status: 'registered' };
      });
    },
    list() {
      return devices.map(({ credentialHash, ...device }) => ({ ...device, online: !device.revoked && Date.now() - device.lastSeen < 90_000 }));
    },
    revoke(id) {
      return transaction(next => {
        const device = next.find(d => d.id === id);
        if (!device) throw fail(404, 'Device not found');
        device.revoked = true;
        return { status: 'revoked' };
      });
    }
  };
}
