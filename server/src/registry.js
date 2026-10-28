import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const digest = value => scryptSync(value, 'remote-controller-device-credential-v1', 32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
export function deviceId(info) {
  if (!info || typeof info.hostname !== 'string' || !/^[a-zA-Z0-9_.-]{1,255}$/.test(info.hostname) || !['win32', 'linux', 'darwin'].includes(info.platform)) throw fail(400, 'Invalid device details');
  return `${info.hostname}-${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[info.platform]}`;
}
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
  function authenticateIn(rows, id, credential) {
    if (typeof credential !== 'string' || credential.length !== 64) throw fail(401, 'Device authentication required');
    const device = rows.find(d => d.id === id && !d.revoked);
    if (!device || !timingSafeEqual(Buffer.from(digest(credential)), Buffer.from(device.credentialHash))) throw fail(401, 'Device authentication failed');
    return device;
  }
  return {
    invite() {
      for (const [key, expires] of invites) if (expires < Date.now()) invites.delete(key);
      const code = randomBytes(12).toString('hex');
      const expires = Date.now() + 10 * 60_000;
      invites.set(code, expires);
      return { code, expires };
    },
    async enroll(code, info, previous) {
      const id = deviceId(info);
      if (info.id !== undefined && info.id !== id) throw fail(400, 'Device ID does not match PCname-OS');
      if (code && (!invites.has(code) || invites.get(code) < Date.now())) throw fail(403, 'Enrollment code is invalid or expired');
      if (code) invites.delete(code);
      return transaction(next => {
        const existing = next.find(d => d.id === id);
        if (previous) {
          const device = authenticateIn(next, previous.id, previous.credential);
          if (existing && existing !== device) throw fail(409, 'PCname-OS already belongs to another PC; give this PC a unique hostname');
          device.id = id; device.hostname = info.hostname; device.platform = info.platform;
          device.approved = true; device.lastSeen = Date.now();
          return { id, credential: previous.credential, status: 'registered' };
        }
        if (existing) throw fail(409, 'PCname-OS already exists; restore this PC identity file or use a unique hostname');
        const credential = randomBytes(32).toString('hex');
        next.push({ id, hostname: info.hostname, platform: info.platform, credentialHash: digest(credential), enrolledAt: Date.now(), lastSeen: Date.now(), revoked: false, approved: true });
        return { id, credential, status: 'registered' };
      });
    },
    authenticate(id, credential) {
      const { credentialHash, ...device } = authenticateIn(devices, id, credential);
      return device;
    },
    heartbeat(id, credential) {
      return transaction(next => {
        const device = authenticateIn(next, id, credential);
        device.lastSeen = Date.now();
        return { id: device.id, status: 'registered' };
      });
    },
    list() {
      return devices.map(({ credentialHash, ...device }) => ({ ...device, approved: device.approved !== false, online: !device.revoked && Date.now() - device.lastSeen < 90_000 }));
    },
    approve(id) {
      return transaction(next => {
        const device = next.find(d => d.id === id);
        if (!device) throw fail(404, 'Device not found');
        if (device.revoked) throw fail(409, 'Cannot approve a revoked device');
        device.approved = true;
        return { status: 'registered' };
      });
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
