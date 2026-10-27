# Remote Controller — personal MVP

A Node.js home-computer agent with a browser dashboard. Browse a permitted folder,
download files, and close explicitly permitted applications without taking over
someone else's desktop. Requires Node.js 22 or newer. No third-party dependencies.

## Start locally

```sh
npm ci --ignore-scripts
npm run check
npm test
mkdir -p "$HOME/RemoteShare"
export RC_ROOT="$HOME/RemoteShare"
export RC_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
# Store this token securely; enter it in the dashboard on connection.
npm start
```

Open the dashboard on port 4310 on the same machine. By default the agent binds
only to loopback. The token stays in dashboard memory, never localStorage or a URL.
Reloading the page requires authenticating again. Do not commit tokens.

### Windows PowerShell

```powershell
npm ci --ignore-scripts
$env:RC_ROOT = Join-Path $HOME 'RemoteShare'
New-Item -ItemType Directory -Force $env:RC_ROOT | Out-Null
$env:RC_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Optional: exact ProcessName values, without .exe, separated by commas.
$env:RC_ALLOWED_APPS = 'notepad'
npm start
```

Use the same Windows user account as the applications to manage. Keep the terminal
open. This version does not install a background service or start automatically.

## Connect from the office through Tailscale

1. Install Tailscale on both computers and join your private tailnet. Restrict
   access to the agent to your own office device using tailnet access rules.
2. Keep RC_BIND at its loopback default. On the home PC, run
   `tailscale serve --bg http://127.0.0.1:4310` to publish the agent privately over
   HTTPS in your tailnet. Follow the CLI's HTTPS setup instructions if needed.
3. Add your exact Tailscale DNS host to RC_HOSTS and its HTTPS origin to
   RC_ORIGINS, then restart the agent. For example, replacing the example domain:

```powershell
$env:RC_HOSTS = 'localhost:4310,127.0.0.1:4310,home-pc.example-tailnet.ts.net'
$env:RC_ORIGINS = 'http://localhost:4310,http://127.0.0.1:4310,https://home-pc.example-tailnet.ts.net'
npm start
```

4. Open the private HTTPS address reported by Tailscale on your office PC and
   authenticate with your RC_TOKEN. Check connection status, open a shared folder,
   and download a test file. Confirm it matches the original.

Tailscale Serve is a deployment option, not exercised in cloud tests. Do not use
Tailscale Funnel, expose this HTTP port publicly, or configure router forwarding.
Direct binding to a private VPN address is also possible with RC_BIND; configure
RC_HOSTS and RC_ORIGINS to exactly match the address you use. HTTP transport is
only appropriate inside the encrypted VPN or on loopback.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| RC_ROOT | Existing dedicated folder to share | Required |
| RC_TOKEN | Random secret, at least 32 bytes | Required |
| RC_BIND | Listen interface | 127.0.0.1 |
| RC_PORT | Listen port | 4310 |
| RC_HOSTS | Comma-separated exact allowed Host headers | localhost:4310,127.0.0.1:4310 |
| RC_ORIGINS | Comma-separated exact browser origins | Local HTTP origins on RC_PORT |
| RC_ALLOWED_APPS | Comma-separated exact process names | Empty: closing disabled |

No arbitrary commands or PIDs can be submitted by the dashboard. Application
close requests use short-lived, single-use tickets from the agent. Refreshing
applications invalidates previous tickets, including in other open dashboards.
Linux/macOS process names come from `ps`; Windows names come from `Get-Process`.
POSIX uses SIGTERM for normal close and SIGKILL for force. Windows uses
CloseMainWindow for normal close and Stop-Process for force. Applications without
windows may reject normal close. Normal close is a request, not a guarantee of
exit or saved data. The dashboard requires confirmation before closing and typed
FORCE confirmation for forced termination.

## Validation and platform status

`npm test` exercises authenticated HTTP requests, downloads, traversal and symlink
restrictions, close authorization, force confirmation, and termination of a real
disposable process on POSIX. `npm run check` checks JavaScript syntax.

Ubuntu checks passed during development. Windows/macOS CI is configured but must
run before claiming support on those systems. Windows close behavior needs a
manual Notepad smoke test: allowlist `notepad`, launch it, refresh applications,
request Close, and verify the window closes. Test force termination only on a
disposable instance. macOS needs equivalent manual testing with a noncritical app.
The dashboard needs a manual browser check; no browser automation ran in cloud.

## Architecture and limits

- `src/server.js`: HTTP boundary, authentication, host/origin validation, assets.
- `src/agent.js`: restricted filesystem and application-control policy.
- `src/processes.js`: Windows and POSIX adapters, fixed utility invocations.
- `public/`: responsive dashboard using browser APIs and safe text rendering.
- `test/`: isolated integration and policy tests.

This is a single-device, single-owner prototype. No accounts, pairing service,
cloud relay, screen sharing, keyboard input, billing, signed installer, bundled
runtime, or automatic updates. Node.js must currently be installed on the home
PC. Packaging with a runtime is a later milestone.

Use a dedicated shared folder, run as a standard user, and do not share sensitive
system folders. Path traversal and resolved symlink escapes are blocked; this is
not an OS sandbox against another local user concurrently replacing directories.
Process IDs can be recycled between checking and closing; the current name check
reduces mistakes but is not a privileged process-identity guarantee. Do not
allowlist shells, runtimes, system tools, or critical applications. Downloads
stream from the agent, but the browser buffers a download in memory; use modest
file sizes. Directory listings are not paginated yet. Do not use for public or
multi-tenant deployment without further security review and hardening.
