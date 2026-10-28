import { setTimeout as delay } from 'node:timers/promises';
import { connectDevice } from './device-client.js';
import { createAgent } from './agent.js';
import { runConnection } from './connection.js';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = process.env.RC_SERVER_URL || 'http://127.0.0.1:4320';
const agent = await createAgent({ root: process.env.RC_ROOT, fileMode: process.env.RC_FILE_MODE, allowedApps: (process.env.RC_ALLOWED_APPS || '').split(',').filter(Boolean) });
console.log('Remote Controller agent: connecting to configured management server. Authorized administrators can browse/download files and close allowlisted applications.');
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
while (!controller.signal.aborted) {
  try {
    const device = await connectDevice({ server, directory: process.env.RC_DEVICE_DATA || '.remote-controller-device', code: process.env.RC_ENROLLMENT_CODE, signal: controller.signal });
    console.log(`Connected as ${device.id}. Remote management active; Ctrl+C stops the agent.`);
    await runConnection({ device, agent, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) break;
    console.error(`Management connection: ${error.message}`);
    try { await delay(5000, undefined, { signal: controller.signal }); } catch { break; }
  }
}
