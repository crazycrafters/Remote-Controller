# Remote Controller MVP

A Node.js agent for managed PCs and a separate central management server. Requires
Node.js 22 or newer. No third-party runtime dependencies.

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
browse drives/folders, download files, and manage allowlisted applications from
this single dashboard. No separate agent dashboard or token is required.

Password-free server mode accepts only direct localhost connections. Normal
server startup retains administrator authentication for network deployment.
The agent's automatic device credential is still used behind the scenes.

## Configure the agent's server address

Copy `agent/.env.example` to `agent/.env`, then edit:

```dotenv
RC_SERVER_URL=https://YOUR-SERVER-IP:PORT
RC_FILE_MODE=system
RC_ALLOWED_APPS=notepad
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
required. Revoked devices cannot reconnect simply by starting again.

**PCname-OS is not inherently unique.** Give company PCs unique hostnames. If a
different installation claims an existing ID without its credential, registration
fails with a collision error; it never replaces the existing PC. Restore the
original identity directory if reinstalling the same PC. Do not copy identity
files into disk images shipped to multiple workers.

Old random IDs migrate to PCname-OS during an authenticated startup handshake.
Renaming a PC updates its ID using the same saved credential, unless the new name
collides. Legacy pending devices are automatically approved on authenticated
reconnection. Existing revocations are preserved.

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

The agent polls the server once per second for typed commands. The server uses
that outbound channel for file browsing, downloads, listing allowed applications,
and closing applications. It works behind typical NAT/firewalls without port
forwarding on employee PCs. It is polling, not a WebSocket or direct server-to-PC
network connection.

The dashboard shows **Connected** after a recent poll; stale connections become
unavailable after 10 seconds. Heartbeats run every 30 seconds, with inventory
presence expiring after 90 seconds. Reconnection retries occur every 5 seconds.
The server can manage a PC while its agent is running and reachable; a powered-off
or sleeping PC cannot be controlled. Automatic OS startup/service installation is
not implemented.

Commands time out after 20 seconds, are not replayed automatically, and do not
survive a server restart. A timed-out action may already have started on the PC;
refresh state before retrying. Revocation rejects future device requests and
cancels queued commands; it cannot undo an action already executed.

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

RC_ALLOWED_APPS is a comma-separated list of exact process names (Windows: omit
`.exe`). Empty means no application may be closed. Normal close requests use
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
