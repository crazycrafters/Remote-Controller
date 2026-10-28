import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.js';
import { createPresence } from './presence.js';
import { createCommands } from './commands.js';

export async function createManagementServer({ directory, password, hosts, origins, secureCookies = true, testNoAuth = false }) {
  if (!testNoAuth && (typeof password !== 'string' || password.length < 12)) throw new Error('Set RC_ADMIN_PASSWORD to at least 12 characters');
  const registry = await createRegistry(directory);
  const commands = createCommands();
  const disconnected = new Set();
  const persistedHeartbeats = new Map();
  const subscribers = new Set();
  const snapshot = () => registry.list().map(device => ({ ...device, connected: !device.revoked && presence.connected(device.id) }));
  const publish = () => { const data = `event: devices\ndata: ${JSON.stringify({ devices: snapshot() })}\n\n`; for (const response of subscribers) if (!response.destroyed) response.write(data); };
  const presence = createPresence({ changed: publish });
  const salt = randomBytes(16);
  const passwordHash = testNoAuth ? null : scryptSync(password, salt, 32);
  const sessions = new Map();
  const failures = new Map();
  const enrollments = new Map();
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'controls.js', 'device-refresh.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  assets.set('style.css', await readFile(new URL('../public/style.css', import.meta.url)));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const json = (status, data) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) return json(403, { error: 'Unrecognized host or origin' });
      if (testNoAuth && (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        Object.keys(req.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))
      )) return json(403, { error: 'Password-free testing is limited to direct localhost connections' });
      const url = new URL(req.url, 'http://management');
      for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
      for (const [key, value] of enrollments) if (value.until < Date.now()) enrollments.delete(key);
      for (const [key, value] of failures) if (value.until < Date.now()) failures.delete(key);
      if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { testNoAuth: Boolean(testNoAuth), apiVersion: 2, transport: 'long-poll' });
      if (req.method === 'GET' && (['/', '/app.js', '/controls.js', '/device-refresh.js', '/style.css'].includes(url.pathname) || /^\/pcs\/[^/]+$/.test(url.pathname))) {
        const name = url.pathname === '/' || url.pathname.startsWith('/pcs/') ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript' });
        return res.end(assets.get(name));
      }
      const ip = req.socket.remoteAddress;
      const recordFailure = (key = `login:${ip}`) => {
        const entry = failures.get(key) || { count: 0, until: Date.now() + 60_000 };
        entry.count++; failures.set(key, entry);
      };
      async function body(maxBytes = 4096) {
        if (req.headers['content-type'] !== 'application/json') throw Object.assign(new Error('JSON required'), { status: 415 });
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw Object.assign(new Error('Request too large'), { status: 413 });
          chunks.push(chunk);
        }
        const value = Buffer.concat(chunks).toString('utf8');
        try { const data = JSON.parse(value); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; }
        catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (testNoAuth) return json(200, { status: 'local-test' });
        if ((failures.get(`login:${ip}`)?.count || 0) >= 10) return json(429, { error: 'Too many sign-in attempts; wait one minute' });
        const data = await body();
        if (typeof data.password !== 'string' || !timingSafeEqual(scryptSync(data.password, salt, 32), passwordHash)) {
          recordFailure(); return json(401, { error: 'Invalid administrator password' });
        }
        const session = randomBytes(32).toString('hex');
        sessions.set(session, Date.now() + 8 * 60 * 60_000);
        res.setHeader('Set-Cookie', `rc_admin=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? '; Secure' : ''}`);
        return json(200, { status: 'signed-in' });
      }
      if (req.method === 'POST' && url.pathname === '/api/enroll') {
        const data = await body();
        if (!data.previous) {
          const bucket = enrollments.get(ip) || { count: 0, until: Date.now() + 60_000 };
          if (bucket.count >= 60) return json(429, { error: 'Too many enrollment attempts; wait one minute' });
          bucket.count++; enrollments.set(ip, bucket);
        }
        const assigned = await registry.enroll(data.code, data.device, data.previous);
        commands.disconnect(assigned.id); presence.disconnect(assigned.id); disconnected.delete(assigned.id);
        if (data.previous?.id && data.previous.id !== assigned.id) { commands.disconnect(data.previous.id); presence.disconnect(data.previous.id); }
        return json(201, assigned);
      }
      if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
        const data = await body();
        const credential = req.headers.authorization?.replace(/^Bearer /, '');
        try {
          registry.authenticate(data.id, credential);
          const result = { id: data.id, status: 'registered', disconnected: disconnected.has(data.id) };
          if (Date.now() - (persistedHeartbeats.get(data.id) || 0) >= 30_000) { await registry.heartbeat(data.id, credential); persistedHeartbeats.set(data.id, Date.now()); }
          if (!disconnected.has(data.id)) presence.touch(data.id);
          return json(200, result);
        }
        catch (error) { recordFailure(`device:${ip}`); throw error; }
      }
      if (req.method === 'POST' && ['/api/device/poll', '/api/device/result', '/api/device/disconnect'].includes(url.pathname)) {
        const credential = req.headers.authorization?.replace(/^Bearer /, '');
        let device;
        try { device = registry.authenticate(req.headers['x-device-id'], credential); }
        catch (error) { recordFailure(`device:${ip}`); throw error; }
        if (device.approved === false) return json(403, { error: 'Device not approved' });
        const data = await body(url.pathname.endsWith('/result') ? 12 * 1024 * 1024 : 4096);
        if (data.id !== device.id) return json(403, { error: 'Device identity mismatch' });
        if (url.pathname.endsWith('/disconnect')) { presence.disconnect(device.id); commands.disconnect(device.id); return json(200, { status: 'disconnected' }); }
        if (disconnected.has(device.id)) return json(200, { disconnected: true });
        if (url.pathname.endsWith('/poll')) {
          presence.touch(device.id);
          const controller = new AbortController();
          const cancel = () => controller.abort();
          res.once('close', cancel);
          try {
            const command = await commands.wait(device.id, controller.signal);
            if (controller.signal.aborted) presence.disconnect(device.id);
            return json(200, { command, disconnected: disconnected.has(device.id) });
          } finally { res.off('close', cancel); }
        }
        commands.finish(device.id, data.commandId, data.result, data.error);
        return json(200, { status: 'received' });
      }
      const session = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('rc_admin='))?.slice(9);
      if (!testNoAuth && !sessions.has(session)) return json(401, { error: 'Administrator sign-in required' });
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessions.delete(session);
        res.setHeader('Set-Cookie', 'rc_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(200, { status: 'signed-out' });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        subscribers.add(res); res.write(`event: devices\ndata: ${JSON.stringify({ devices: snapshot() })}\n\n`);
        const keepAlive = setInterval(() => {
          if (!testNoAuth && !sessions.has(session)) { res.end(); return; }
          res.write(': keepalive\n\n');
        }, 15_000);
        res.once('close', () => { clearInterval(keepAlive); subscribers.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices') return json(200, { devices: snapshot() });
      if (req.method === 'POST' && url.pathname === '/api/control') {
        const data = await body(16 * 1024);
        const device = registry.list().find(device => device.id === data.id && !device.revoked && device.approved);
        if (!device || !presence.connected(device.id)) return json(409, { error: 'Agent is not connected; start it and refresh devices' });
        return json(200, await commands.submit(device.id, data.operation, data.args));
      }
      if (req.method === 'POST' && url.pathname === '/api/invites') return json(201, registry.invite());
      if (req.method === 'POST' && url.pathname === '/api/approve') {
        const data = await body(); return json(200, await registry.approve(data.id));
      }
      if (req.method === 'POST' && ['/api/revoke', '/api/disconnect'].includes(url.pathname)) {
        const data = await body();
        if (!registry.list().some(device => device.id === data.id)) return json(404, { error: 'Device not found' });
        disconnected.add(data.id); commands.disconnect(data.id); presence.disconnect(data.id);
        return json(200, { status: 'disconnected' });
      }
      json(404, { error: 'Not found' });
    } catch (error) {
      const storageErrors = {
        EEXIST: 'Server storage path is not a directory. Check RC_MANAGEMENT_DATA.',
        ENOTDIR: 'Server storage path is not a directory. Check RC_MANAGEMENT_DATA.',
        EACCES: 'Server storage access denied. Check permissions for RC_MANAGEMENT_DATA.',
        EPERM: 'Server storage is locked or access is denied. Check RC_MANAGEMENT_DATA and other running server instances.',
        EBUSY: 'Server storage is busy. Retry shortly and check for another server instance.',
        ENOSPC: 'Server storage is full. Free disk space before retrying.',
        ENOENT: 'Server storage is unavailable. Check RC_MANAGEMENT_DATA.'
      };
      if (!error.status) console.error(JSON.stringify({ event: 'management-error', requestId, route: req.url?.split('?')[0], code: error.code || error.name }));
      json(error.status || 500, { error: error.status ? error.message : storageErrors[error.code] || `Server could not complete this request. Reference: ${requestId}`, requestId });
    }
  });
  server.on('close', () => { commands.close(); presence.close(); for (const response of subscribers) response.end(); subscribers.clear(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const testNoAuth = process.argv.includes('--test-no-auth');
  const port = Number(process.env.RC_MANAGEMENT_PORT || 4320);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid management port');
  const server = await createManagementServer({
    testNoAuth,
    directory: process.env.RC_MANAGEMENT_DATA || '.remote-controller-server',
    password: process.env.RC_ADMIN_PASSWORD,
    hosts: ((!testNoAuth && process.env.RC_MANAGEMENT_HOSTS) || `localhost:${port},127.0.0.1:${port}`).split(','),
    origins: ((!testNoAuth && process.env.RC_MANAGEMENT_ORIGINS) || `http://localhost:${port},http://127.0.0.1:${port}`).split(','),
    secureCookies: process.env.RC_MANAGEMENT_LOCAL_HTTP !== '1'
  });
  if (testNoAuth) console.log('LOCAL TEST MODE: no administrator password required. Direct localhost connections only.');
  server.listen(port, testNoAuth ? '127.0.0.1' : process.env.RC_MANAGEMENT_BIND || '127.0.0.1', () => console.log(`Device management server listening on port ${port}. HTTPS required except local development.`));
}
