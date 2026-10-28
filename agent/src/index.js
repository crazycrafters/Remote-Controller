import { setTimeout as delay } from 'node:timers/promises';
import { connectDevice } from './device-client.js';
import { createAgent } from './agent.js';
import { executeCommand } from './remote-controls.js';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = process.env.RC_SERVER_URL || 'http://127.0.0.1:4320';
const agent = await createAgent({ root: process.env.RC_ROOT, fileMode: process.env.RC_FILE_MODE, allowedApps: (process.env.RC_ALLOWED_APPS || '').split(',').filter(Boolean) });
console.log('Remote Controller agent: connecting to configured management server. Authorized administrators can browse/download files and close allowlisted applications.');
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
while (!stopped) {
  try {
    const device = await connectDevice({ server, directory: process.env.RC_DEVICE_DATA || '.remote-controller-device', code: process.env.RC_ENROLLMENT_CODE });
    console.log(`Connected as ${device.id}. Remote management active; Ctrl+C stops the agent.`);
    let heartbeat = 0;
    while (!stopped) {
      if (Date.now() - heartbeat > 30_000) { await device.heartbeat(); heartbeat = Date.now(); }
      const { command } = await device.poll();
      if (command && !stopped) {
        console.log(`Management request: ${command.operation}`);
        let result, error;
        try { result = await executeCommand(agent, command); }
        catch (failure) { error = { status: failure.status || ({ ENOENT: 404, EACCES: 403, EPERM: 403 }[failure.code]) || 502, message: failure.status ? failure.message : 'File unavailable, access denied, or application operation failed' }; }
        // Do not retry application actions automatically if returning their result fails.
        await device.result(command.id, result, error);
      }
      if (!stopped) await delay(1000);
    }
  } catch (error) {
    console.error(`Management connection: ${error.message}`);
    if (!stopped) await delay(5000);
  }
}
