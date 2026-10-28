# Managed PC agent

Deploy this directory to each PC. Requires Node.js 22+. No server source or
third-party runtime dependencies are needed.

1. Copy `.env.example` to `.env` here.
2. Set RC_SERVER_URL to your management server's HTTPS origin, including its port.
3. Run `npm start`.

One process registers as PCname-OS, is automatically approved, maintains its
outbound command channel, and performs authorized file/application requests.
It retries network failures and reports management operations in its terminal.
It does not serve a local dashboard or open a listening port by default.

Local development defaults to `http://127.0.0.1:4320`; start `npm run dev` in
`server/` on the same PC, then `npm start` here. Open the server dashboard on port
4320 and select Manage. No passwords or manually copied tokens are needed.

RC_DEVICE_DATA chooses the persistent identity directory (default:
`.remote-controller-device` relative to this working directory). Keep it between
launches. Do not clone populated identities to other PCs. PC names must be unique
within each OS; duplicate names are rejected instead of replacing a device.
Returning devices authenticate automatically using saved credentials. Revoked
identities stay blocked. An OS service/installer is not included yet.

Set RC_FILE_MODE=system to browse accessible drives, or RC_FILE_MODE=folder and
an absolute RC_ROOT for a restricted folder. RC_ALLOWED_APPS is a comma-separated
list of process names allowed to close. Central downloads are limited to 8 MiB.
Only HTTPS is accepted for remote server origins; HTTP is for loopback testing.

`npm run control` retains the legacy direct-control dashboard for compatibility;
it requires RC_TOKEN and is unnecessary for the central workflow.

Run `npm run check` and `npm test` here for agent checks. Cross-package integration
tests run from the repository root. See the root README for deployment details.
