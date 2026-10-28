# Remote Controller management server

## Password-free local testing

From this directory, run `npm run dev` to open the admin dashboard on localhost port 4320
without entering a password or token. This mode is limited to direct localhost
connections. For device registration, also run `npm start` in the agent directory
while the management server is running. See the root README for the three-terminal
local test walkthrough.


Deploy this directory to the administrator's server, not to managed PCs. Requires
Node.js 22+. No third-party runtime dependencies; the agent directory is not needed
at runtime. This package owns the admin dashboard, registry, ID assignment,
approval, and revocation.

For local development, from this directory:

```powershell
$env:RC_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Administrator password' -AsSecureString)).Password
$env:RC_MANAGEMENT_LOCAL_HTTP = '1'
npm start
```

Open the dashboard locally on port 4320. For remote use, configure an HTTPS reverse
proxy, leave RC_MANAGEMENT_LOCAL_HTTP unset, and set exact allowed
RC_MANAGEMENT_HOSTS and RC_MANAGEMENT_ORIGINS. The server binds to loopback by
default; RC_MANAGEMENT_BIND and RC_MANAGEMENT_PORT override the listener.

RC_MANAGEMENT_DATA selects persistent registry storage (default:
`.remote-controller-server` under the working directory). Back up this directory.
Run only one server process against a registry; this prototype uses a JSON file,
not a shared database. Admin passwords must have at least 12 characters.

Managed PCs register automatically with a PC-name ID and appear as pending.
Verify each device against your deployment records before approving it. A device
name is self-reported, not proof of company ownership. Optional one-use enrollment
codes preapprove registration. This server provides inventory, not central file
access, screen sharing, or employee activity monitoring.

## Checks

```sh
npm run check
npm test
```

Cross-package client/server integration tests run from the repository root with
`npm run test:integration`.
