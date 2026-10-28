# Central management server

Deploy only this directory to the management machine. Requires Node.js 22+.
No agent source or third-party runtime dependencies are needed.

## Local test, no passwords

```sh
npm run dev
```

In a second terminal, run `npm start` inside `agent/`. Open the server dashboard
locally on port 4320, refresh devices, and select Manage. The agent registers
and is automatically approved as PCname-OS; no separate file-control server or
manual token transfer is needed. Test mode permits only direct localhost access.

## Remote deployment

Run `npm start` with RC_ADMIN_PASSWORD set (at least 12 characters), put the
listener behind an HTTPS reverse proxy, and configure exact allowed
RC_MANAGEMENT_HOSTS and RC_MANAGEMENT_ORIGINS. RC_MANAGEMENT_BIND defaults to
loopback and RC_MANAGEMENT_PORT to 4320. Leave RC_MANAGEMENT_LOCAL_HTTP unset for
Secure login cookies. An optional `.env` is loaded from the working directory.

Configure the agent's RC_SERVER_URL to this server's trusted HTTPS origin.
Protect the server with your company's private network/access controls. New IDs
are auto-approved; a self-reported hostname is not proof of company ownership.
Admin authentication is still required for network management. The password-free
dev command is for localhost only.

RC_MANAGEMENT_DATA selects registry storage (default `.remote-controller-server`
under the working directory). Back up the registry and preserve this path when
upgrading. Run one server process per registry; it uses a JSON file, not a shared
database. Pending commands are held in memory and expire after 60 seconds.

The server forwards typed file/process commands over agent-initiated long polling.
Revocation blocks future agent requests and cancels queued commands. Device IDs
are PCname-OS; collisions without the original credential are rejected. Existing
random IDs migrate on an authenticated agent startup.

Run `npm run check` and `npm test` here. Cross-package tests run from the
repository root with `npm run test:integration`. See the root README for limits,
permissions, identity storage, and the full startup walkthrough.
