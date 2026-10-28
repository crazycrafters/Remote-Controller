import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function managementUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a server origin without credentials, query, or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Management requires HTTPS, except on loopback for development');
  return url.origin;
}
export async function connectDevice({ server, directory, code, fetcher = fetch }) {
  server = managementUrl(server);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'identity.json');
  let identity;
  try { identity = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function request(route, data, credential) {
    const response = await fetcher(server + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Device request failed');
    return result;
  }
  if (!identity) {
    const assigned = await request('/api/enroll', { code, device: { hostname: hostname(), platform: process.platform } });
    identity = { server, ...assigned };
    await writeFile(filename, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  }
  if (identity.server !== server) throw new Error('Device is enrolled to a different server; use a separate data directory');
  return { id: identity.id, heartbeat: () => request('/api/heartbeat', { id: identity.id }, identity.credential) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Remote Controller device inventory agent is running visibly. It reports this computer name, operating system, and online status. No screen, file, or application activity is sent to the management server.');
  const device = await connectDevice({ server: process.env.RC_SERVER_URL || 'http://127.0.0.1:4320', directory: process.env.RC_DEVICE_DATA || '.remote-controller-device', code: process.env.RC_ENROLLMENT_CODE });
  console.log(`Device ID: ${device.id}. Keep this terminal open. Press Ctrl+C to stop reporting.`);
  let stopped = false;
  const stop = () => { stopped = true; clearInterval(timer); };
  let lastStatus;
  const report = async () => { try {
    const result = await device.heartbeat();
    if (result.status !== lastStatus) console.log(result.status === 'pending' ? 'Awaiting administrator approval.' : 'Device approved and registered.');
    lastStatus = result.status;
  } catch (error) { console.error(error.message); } };
  await report();
  const timer = setInterval(() => { if (!stopped) void report(); }, 30_000);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
