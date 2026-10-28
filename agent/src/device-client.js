import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

export function managementUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a server origin without credentials, query, or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Management requires HTTPS, except on loopback for development');
  return url.origin;
}
export async function connectDevice({ server, directory, code, fetcher = fetch, signal }) {
  server = managementUrl(server);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'identity.json');
  let identity;
  try { identity = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function request(route, data, credential) {
    const response = await fetcher(server + route, { method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]), headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}`, 'X-Device-Id': identity.id } : {}) }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Device request failed'), { status: response.status, requestId: result.requestId });
    return result;
  }
  if (identity && identity.server !== server) throw new Error('Device is enrolled to a different server; use a separate data directory');
  const device = { hostname: hostname(), platform: process.platform };
  device.id = `${device.hostname}-${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[device.platform]}`;
  const assigned = await request('/api/enroll', { code, device, ...(identity ? { previous: { id: identity.id, credential: identity.credential } } : {}) });
  identity = { server, ...assigned };
  // Save after each handshake so legacy random IDs migrate and renamed PCs retain their credentials.
  const { rename } = await import('node:fs/promises');
  await writeFile(filename + '.tmp', JSON.stringify(identity), { mode: 0o600 });
  await rename(filename + '.tmp', filename);
  return {
    id: identity.id,
    heartbeat: () => request('/api/heartbeat', { id: identity.id }, identity.credential),
    poll: () => request('/api/device/poll', { id: identity.id }, identity.credential),
    result: (commandId, result, error) => request('/api/device/result', { id: identity.id, commandId, result, error }, identity.credential)
  };
}
