# Remote Controller MVP

A Node.js agent for managed PCs and a separate central management server. Requires
Node.js 22 or newer. The agent uses `yazl` to create ZIP archives. Startup installs missing runtime dependencies automatically.

## Quick test: two terminals, no passwords

Run from the repository root on the same computer:

```sh
npm ci --ignore-scripts
```

```sh
# Terminal 1: start the central dashboard on port 4320
npm run dev:server
```

```sh
# Terminal 2: one agent for registration AND remote controls
npm run dev:agent
```

Open the local server dashboard on port 4320, refresh **Company computers**, and
select **Manage**. The agent registers and is automatically approved. You can
browse drives/folders, download files, and manage running applications from
this single dashboard. No separate agent dashboard or token is required.

Password-free server mode accepts only direct localhost connections. Normal
server startup retains administrator authentication for network deployment.
The agent's automatic device credential is still used behind the scenes.

## Configure the agent's server address

Copy `agent/.env.example` to `agent/.env`, then edit:

```dotenv
RC_SERVER_URL=https://YOUR-SERVER-IP:PORT
RC_FILE_MODE=system
RC_ALLOWED_APPS=
```

Use an actual HTTPS origin with a trusted certificate for a server on another
computer. HTTP is accepted only on loopback for local development; the default
is `http://127.0.0.1:4320`. Never disable TLS certificate validation.
The server address is a URL, not a device ID. The agent loads `.env` from its
working directory; npm workspace commands run inside `agent/`.

On each managed PC, from `agent/`:

```sh
npm start
```

That single process registers, sends heartbeats, receives commands, performs file
and application actions, and reconnects after network interruptions. It does not
open an inbound HTTP port. The optional old direct-control interface is retained
only for compatibility (`npm run control`); it is not needed for this workflow.

## Device identity and automatic approval

The agent sends its hostname, OS, and `PCname-OS` ID. Examples:

- `OFFICE-PC-Windows`
- `BUILD-BOX-Linux`
- `DESIGN-MAC-macOS`

For a new ID, the server automatically registers and approves the PC and issues a
credential that the agent stores locally. On later starts, it verifies the saved
credential and reuses that record. No manual code, token transfer, or approval is
required. Disconnect is temporary: restarting the agent reconnects with the same saved identity.

**PCname-OS is not inherently unique.** Give company PCs unique hostnames. If a
different installation claims an existing ID without its credential, registration
fails with a collision error; it never replaces the existing PC. Restore the
original identity directory if reinstalling the same PC. Do not copy identity
files into disk images shipped to multiple workers.

Old random IDs migrate to PCname-OS during an authenticated startup handshake.
Renaming a PC updates its ID using the same saved credential, unless the new name
collides. Legacy pending devices are automatically approved on authenticated
reconnection. Previously revoked PCs recover during an authenticated startup using their saved identity.

## Server deployment

Deploy only `server/` to the management machine. From that directory:

```powershell
$env:RC_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Administrator password' -AsSecureString)).Password
npm start
```

For remote access, put the server behind an HTTPS reverse proxy, and configure
RC_MANAGEMENT_HOSTS and RC_MANAGEMENT_ORIGINS for its exact public/private HTTPS
address. Leave RC_MANAGEMENT_LOCAL_HTTP unset so login cookies are Secure.
RC_MANAGEMENT_BIND defaults to loopback; RC_MANAGEMENT_PORT defaults to 4320.
The server also loads an optional `.env` in its working directory. See
[server setup](server/README.md).

Use a company-controlled/private network and restrict server access. With automatic
registration, anyone able to reach its enrollment endpoint can add a PC record;
a hostname is not proof of company ownership. Only authenticated administrators
(or direct local test users) can issue management requests. Each device can fetch
and complete only its own requests.

## What the connection supports

The agent holds a long-poll request open for up to 10 seconds; the server wakes it
immediately when a typed command is available. The server uses
that outbound channel for file browsing, downloads, listing allowed applications,
and closing applications. It works behind typical NAT/firewalls without port
forwarding on employee PCs. It is polling, not a WebSocket or direct server-to-PC
network connection.

The dashboard shows **Connected** after a recent poll; a blue dot marks a connected agent and a red dot marks a disconnected agent.
Status changes are pushed to the dashboard using server-sent events. Heartbeats
run every 2 seconds; unexpected losses turn red after about 6–7 seconds. Clean
disconnects update immediately. Registry timestamps persist at most every 30
seconds to avoid unnecessary disk writes. Initial registration retries occur every 5 seconds. Established connections retry
with bounded backoff without registering again or replaying actions.
The server can manage a PC while its agent is running and reachable; a powered-off
or sleeping PC cannot be controlled. Automatic OS startup/service installation is
not implemented.

Commands time out after 60 seconds, are not replayed automatically, and do not
survive a server restart. File/process operations run with two workers, while
heartbeats and connection handling continue independently. Result delivery can
retry the same response, but never re-executes an action. A timed-out action may already have started on the PC;
refresh state before retrying. Disconnect cancels queued commands and asks the agent to stop. It cannot undo
an action already executed. Restarting the agent reconnects normally.

## Files and applications

System mode browses all drives/folders the agent's account can access. Windows
lists available local, removable, and mapped drive letters. Ubuntu/macOS expose
`/`, including disks at their normal mount paths. Windows UNC/device namespaces
cannot be entered directly; use mapped drives. OS permissions still apply.

To restrict file access, set RC_FILE_MODE=folder and RC_ROOT to an existing absolute
folder path. If RC_FILE_MODE is omitted, RC_ROOT selects folder mode; otherwise
system mode is the default. Folder mode blocks traversal and symlink escapes;
this is not a sandbox against another local user concurrently replacing paths.

Central downloads are limited to **8 MiB per file** in this MVP and buffered in
memory. Only regular files are downloaded. Upload, rename, delete, and copying
between remote folders are not implemented.

Applications are listed and can be closed without an allowlist or a separate
credential prompt. Optional RC_ALLOWED_APPS restricts this to a comma-separated
list of exact process names (Windows: omit `.exe`); leave it blank for normal
application management. Normal close requests use
CloseMainWindow on Windows or SIGTERM on POSIX. Force stop requires typed FORCE
confirmation and uses Stop-Process/SIGKILL. Close requests can lose unsaved data;
they do not guarantee that the application has exited. Process IDs are rechecked
by name but can still be recycled between checking and acting.

The agent identifies itself and prints each operation in its terminal. No screen
capture, keylogging, browsing-history collection, or employee activity recording
is implemented. This is disclosed device management, not an employee-monitoring
product.

## Storage and layout

```text
agent/
  src/index.js          # Unified startup and reconnection loop
  src/device-client.js  # Registration and authenticated server requests
  src/remote-controls.js# Execute typed management operations
  src/agent.js          # File/process policy
  src/filesystem.js     # Drive/folder access
  src/processes.js      # OS process adapters
  public/               # Legacy optional direct-control dashboard
server/
  src/server.js         # Admin and device APIs
  src/registry.js       # PCname-OS identity and persistence
  src/commands.js       # Per-device request queue
  public/               # Central management dashboard and controls
agent/test/             # Agent tests
server/test/            # Server tests
test/                   # Cross-package integration tests
```

Each package is independently deployable with its own README and package.json.
RC_DEVICE_DATA defaults to `agent/.remote-controller-device` and RC_MANAGEMENT_DATA
to `server/.remote-controller-server` when using npm workspace commands. Defaults
are relative to the process working directory. Set both to absolute paths for a
stable deployment; preserve existing paths when upgrading. Back up the server
registry and protect agent identity files with account permissions/Windows ACLs.
Never commit credentials or `.env` files.

## Validation and limits

```sh
npm run check
npm test
```

Tests cover file policies, credentials, identity migration, collisions, command
isolation/expiry, and a real unified-agent process that loads `.env`, registers,
serves central file operations, restarts, reconnects, and respects revocation.
Ubuntu checks run in cloud. A headless Chromium smoke also verified automatic
connection, Manage, folder/parent navigation, the application panel, and an actual
central file download with no browser runtime exceptions. Windows/macOS behavior
still needs native validation. CI targets all three operating systems.

This prototype uses one administrator password, a single-process JSON registry,
and in-memory command queues. A commercial deployment needs database-backed
organization isolation, administrator roles/SSO/MFA, audit records, signed
installers/updates, service startup, transport streaming, and load testing.

## Troubleshooting operation errors

The dashboard reports permission, missing-file, and server-storage errors with
a request reference. Unexpected server errors emit a `management-error` record
with that reference, route, and error code in the management terminal, without
logging credentials or request bodies. Check RC_MANAGEMENT_DATA permissions,
disk space, and that only one server process owns the registry. Temporary
Windows file-replacement contention is retried with bounded delays.

Long polling requires your reverse proxy to allow at least 20 seconds for agent
requests and at least 65 seconds for administrator control requests. A socket
transport is not needed for these file/process commands; screen streaming would
need a separate design.

The dashboard connection banner shows **API 2 · Long polling** for this server
build. Device refreshes are coalesced, retain the last successful list during
outages, and retry with a 5–30 second backoff. A brief network outage updates
that banner instead of repeatedly overwriting operation errors. If the exact
old message “Management operation failed” still appears, check that the intended
server process was restarted from the updated MVP checkout and reload the browser.
The current server returns specific errors or a request reference instead.

## Disconnect and live status

The old **Revoke** button is now **Disconnect**. It turns the device red, cancels
pending requests, and stops its agent connection without invalidating its identity.
Restart `npm run dev:agent` (or `npm start` inside `agent/`) to reconnect the same
PC and turn its dot blue. The old `/api/revoke` endpoint is a compatibility alias
for temporary disconnect. Previously revoked identities recover on restart only
when the saved credential matches; knowing a PC name alone does not grant access.

Presence uses server-sent events at `/api/events`. Reverse proxies must disable
response buffering for that route and allow a long-lived stream. Device requests
continue to use authenticated long polling. No per-application credentials are
required; Windows/macOS/Linux permissions still determine which processes the
agent can list or stop.

## PC workspaces and terminal

The overview shows PC cards with live blue/red connection dots. Open a connected
card to navigate to `/pcs/<PC-ID>`. Direct links and page reloads work. The header
shows PC ID, hostname, OS, last-seen time, and connection status. Filesystem and
terminal occupy the left column; running applications occupy the right.

Opening a filesystem folder updates the terminal working directory. The virtual
Computer/drive-picker view disables terminal commands until a real folder is
selected. Commands run through PowerShell on Windows or `/bin/sh` on Ubuntu/macOS,
under the agent's account. Each command gets a fresh noninteractive shell; `cd`
inside one command does not change the next command's directory. Select the folder
in the browser to change subsequent commands. Output is limited to 256 KiB and
commands time out after 15 seconds. Interactive prompts/full-screen programs and
persistent PTY sessions are not implemented. Commands are never automatically
re-executed after a network interruption.

The terminal intentionally permits arbitrary administrative commands with the
agent account's OS permissions. **Folder mode restricts file-browser access and
the initial working directory, not shell capabilities**: an authorized command
can access other locations allowed by that OS account. Network administrator
authentication and localhost-only password-free testing remain enforced.

Applications display PID and, for Chrome/Chromium processes exposing a
`--profile-directory`, a profile label. The agent reads only the matching profile
name from browser Local State metadata and otherwise shows the profile directory.
Renderer processes and browsers that do not expose enough information have no
profile label; profile ownership is not guessed. Raw process command lines and
browser account details are not sent to the dashboard. Windows/macOS profile
discovery and terminal behavior still need native validation.

## Select, copy/paste, and ZIP upload

In a PC workspace, use the checkboxes beside files/folders or **Select all**.
Choose **Copy**, navigate to a destination folder on the same PC, and choose
**Paste here**. Copy preserves sources and refuses existing destination names;
it does not overwrite, cut/move, or copy between PCs. Copying into a selected
folder's own descendants is rejected.

Choose **Zip & upload to server** to create one ZIP containing all selected
files/folders, including their directory structure and empty folders. The ZIP
streams from the agent to the management server; it does not first download to
your browser. Open **Uploaded ZIP archives on server** to see or download it.
The server stores ZIPs and metadata in `RC_MANAGEMENT_DATA/uploads`. Archives
persist across restarts and have no automatic retention/deletion policy.

Current limits: 100 top-level selected items, 10,000 total entries, 1 GiB source
data, and a 256 MiB compressed ZIP. Copy/ZIP requests allow up to 10 minutes.
Symbolic links and special files are rejected. Operations follow the agent's
existing filesystem scope and OS permissions. Large operations show a busy
status; byte-by-byte progress and resumable transfers are not implemented.
Interrupted uploads do not appear as completed archives; temporary ZIPs on the
agent are removed after success/failure. The browser clipboard lasts for the
current PC page only.

## Automatic dependency setup on startup

`npm start`, `npm run dev:agent`, and the agent's `npm run dev` first check
production dependencies against package-lock.json. Missing or outdated runtime
packages are installed before the agent is imported. An up-to-date installation
starts directly, without a registry request. The server uses the same startup
check and currently has no external runtime dependencies.

In this workspace, setup uses `npm ci --omit=dev --ignore-scripts` from the root
lockfile. A standalone package uses its local lockfile, or `npm install --omit=dev
--ignore-scripts` on its first launch if no lockfile exists. Installation preserves
normal TLS/checksum verification. Failed installs stop startup with a clear npm
error; internet access and writable installation directories are required only
when packages need installation. Tests still require a full `npm ci` (including
dev dependencies). No environment configuration or saved device identity is removed.
