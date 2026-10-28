import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.js';
import { createCommands } from './commands.js';

export async function createManagementServer({ directory, password, hosts, origins, secureCookies = true, testNoAuth = false }) {
  if (!testNoAuth && (typeof password !== 'string' || password.length < 12)) throw new Error('Set RC_ADMIN_PASSWORD to at least 12 characters');
  const registry = await createRegistry(directory);
  const commands = createCommands();
  const connections = new Map();
  const salt = randomBytes(16);
  const passwordHash = testNoAuth ? null : scryptSync(password, salt, 32);
  const sessions = new Map();
  const failures = new Map();
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'controls.js'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  assets.set('style.css', await readFile(new URL('../public/style.css', import.meta.url)));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) return json(403, { error: 'Unrecognized host or origin' });
      if (testNoAuth && (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        Object.keys(req.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))
      )) return json(403, { error: 'Password-free testing is limited to direct localhost connections' });
      const url = new URL(req.url, 'http://management');
      for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
      for (const [key, value] of failures) if (value.until < Date.now()) failures.delete(key);
      if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { testNoAuth: Boolean(testNoAuth) });
      if (req.method === 'GET' && ['/', '/app.js', '/controls.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript' });
        return res.end(assets.get(name));
      }
      const ip = req.socket.remoteAddress;
      if ((failures.get(ip)?.count || 0) >= 10) return json(429, { error: 'Too many attempts; wait one minute' });
      const recordFailure = () => {
        const entry = failures.get(ip) || { count: 0, until: Date.now() + 60_000 };
        entry.count++; failures.set(ip, entry);
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
        recordFailure(); // Bound registration attempts as well as failed authentication.
        const assigned = await registry.enroll(data.code, data.device, data.previous);
        commands.disconnect(assigned.id); connections.delete(assigned.id);
        if (data.previous?.id && data.previous.id !== assigned.id) { commands.disconnect(data.previous.id); connections.delete(data.previous.id); }
        return json(201, assigned);
      }
      if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
        const data = await body();
        const credential = req.headers.authorization?.replace(/^Bearer /, '');
        try { return json(200, await registry.heartbeat(data.id, credential)); }
        catch (error) { recordFailure(); throw error; }
      }
      if (req.method === 'POST' && ['/api/device/poll', '/api/device/result'].includes(url.pathname)) {
        const credential = req.headers.authorization?.replace(/^Bearer /, '');
        let device;
        try { device = registry.authenticate(req.headers['x-device-id'], credential); }
        catch (error) { recordFailure(); throw error; }
        if (device.approved === false) return json(403, { error: 'Device not approved' });
        const data = await body(url.pathname.endsWith('/result') ? 12 * 1024 * 1024 : 4096);
        if (data.id !== device.id) return json(403, { error: 'Device identity mismatch' });
        if (url.pathname.endsWith('/poll')) {
          connections.set(device.id, Date.now());
          return json(200, { command: commands.next(device.id) });
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
      if (req.method === 'GET' && url.pathname === '/api/devices') return json(200, { devices: registry.list().map(device => ({ ...device, connected: !device.revoked && Date.now() - (connections.get(device.id) || 0) < 10_000 })) });
      if (req.method === 'POST' && url.pathname === '/api/control') {
        const data = await body();
        const device = registry.list().find(device => device.id === data.id && !device.revoked && device.approved);
        if (!device || Date.now() - (connections.get(device.id) || 0) >= 10_000) return json(409, { error: 'Agent is not connected; start it and refresh devices' });
        return json(200, await commands.submit(device.id, data.operation, data.args));
      }
      if (req.method === 'POST' && url.pathname === '/api/invites') return json(201, registry.invite());
      if (req.method === 'POST' && url.pathname === '/api/approve') {
        const data = await body(); return json(200, await registry.approve(data.id));
      }
      if (req.method === 'POST' && url.pathname === '/api/revoke') {
        const data = await body();
        const result = await registry.revoke(data.id);
        commands.disconnect(data.id); connections.delete(data.id);
        return json(200, result);
      }
      json(404, { error: 'Not found' });
    } catch (error) { json(error.status || 500, { error: error.status ? error.message : 'Management operation failed' }); }
  });
  server.on('close', () => commands.close());
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
