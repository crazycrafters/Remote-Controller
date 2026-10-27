# Remote Controller — personal MVP

A Node.js home-computer agent with a browser dashboard. Browse all available drives and folders,
download files, and close explicitly permitted applications without taking over
someone else's desktop. Requires Node.js 22 or newer. No third-party dependencies.

## Start locally

```sh
npm ci --ignore-scripts
npm run check
npm test
export RC_FILE_MODE=system
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
$env:RC_FILE_MODE = 'system'
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
   authenticate with your RC_TOKEN. Check connection status, select a drive, open a folder,
   and download a test file. Confirm it matches the original.

Tailscale Serve is a deployment option, not exercised in cloud tests. Do not use
Tailscale Funnel, expose this HTTP port publicly, or configure router forwarding.
Direct binding to a private VPN address is also possible with RC_BIND; configure
RC_HOSTS and RC_ORIGINS to exactly match the address you use. HTTP transport is
only appropriate inside the encrypted VPN or on loopback.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| RC_FILE_MODE | `system` for all drives, `folder` for a restricted folder | `system` if RC_ROOT is unset; otherwise `folder` |
| RC_ROOT | Existing folder to share in folder mode | Required only in folder mode |
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

## Whole-computer file access

System mode starts at **Computer**. On Windows it lists available drive letters,
including local, removable, and mapped drives accessible to the agent's user.
Disconnected or inaccessible drives are omitted. On Ubuntu and macOS, select
**Filesystem** (`/`); mounted disks appear at their normal paths, such as
`/media`, `/mnt`, or `/Volumes`. Refresh Computer after connecting a disk.

Select folders to navigate, use **Parent** to move up, and **Computer** to switch
drives. Select a file to download it. Directory symlinks and junctions can be
followed in system mode. Only regular files can be downloaded, not device nodes
or other special files. Windows UNC shares and device namespaces cannot be entered
directly; use mapped drive letters. Drive mappings belong to the account/session
running the agent.

Access follows the agent user's OS permissions. Protected folders return an
access error; this feature does not bypass Windows permissions or macOS privacy
controls. Existing RC_ROOT setups remain restricted unless RC_FILE_MODE=system
is explicitly set. To restrict access again, use RC_FILE_MODE=folder and RC_ROOT.
File uploads, deletion, renaming, and copying between remote folders are not yet
implemented. System mode expands browsing and downloading across the computer.

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
- `src/agent.js`: application-control policy.
- `src/filesystem.js`: drive discovery, navigation, file downloads, optional folder restrictions.
- `src/processes.js`: Windows and POSIX adapters, fixed utility invocations.
- `public/`: responsive dashboard using browser APIs and safe text rendering.
- `test/`: isolated integration and policy tests.

This is a single-device, single-owner prototype. No accounts, pairing service,
cloud relay, screen sharing, keyboard input, billing, signed installer, bundled
runtime, or automatic updates. Node.js must currently be installed on the home
PC. Packaging with a runtime is a later milestone.

Run as a standard user. In system mode, anyone holding the access token can
browse and download files readable by that user across the computer. Folder mode
blocks traversal and resolved symlink escapes; it is not an OS sandbox against
another local user concurrently replacing directories.
Process IDs can be recycled between checking and closing; the current name check
reduces mistakes but is not a privileged process-identity guarantee. Do not
allowlist shells, runtimes, system tools, or critical applications. Downloads
stream from the agent, but the browser buffers a download in memory; use modest
file sizes. Directory listings are not paginated yet. Do not use for public or
multi-tenant deployment without further security review and hardening.
