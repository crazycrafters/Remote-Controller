# Remote Controller agent

Deploy this directory to each managed PC. Requires Node.js 22+. No third-party
runtime dependencies; the server directory is not needed on the PC.

From this directory, set the management server origin and start registration:

```powershell
$env:RC_SERVER_URL = 'https://management.example.com'
npm start
```

The agent sends its PC name and OS, receives a server-assigned ID, and saves its
identity in `.remote-controller-device` under the working directory. The server
administrator approves it in the dashboard. `RC_DEVICE_DATA` selects a different
persistent directory. Keep this directory between launches and do not include it
in a disk image copied to other computers. TLS is required except on loopback.

For local development, the server origin defaults to `http://127.0.0.1:4320`.
Optional `RC_ENROLLMENT_CODE` enables preapproved enrollment.

## Direct file and application controls

The existing direct-control API is part of the agent, because it accesses the
managed PC's filesystem and processes. It is separate from central inventory.
Start it with:

```powershell
$env:RC_FILE_MODE = 'system'
$env:RC_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run control
```

This serves its own dashboard on loopback port 4310. See the repository README
for token access, private VPN configuration, and file/process permissions.
Inventory registration does not automatically start the direct-control API.

## Checks

```sh
npm run check
npm test
```
