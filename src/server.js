import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createAgent, authorized } from './agent.js';

export async function createServer(config) {
  const agent = await createAgent(config);
  const attempts = new Map();
  const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url))])));
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      // Reject cross-origin browser requests, including DNS rebinding via an unexpected Host.
      if (!config.hosts.includes(req.headers.host)) return json(403, { error: 'Unrecognized host' });
      if (req.headers.origin && !config.origins.includes(req.headers.origin)) return json(403, { error: 'Unrecognized origin' });
      const url = new URL(req.url, 'http://agent');
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' }[name] });
        return res.end(assets.get(name));
      }
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      if ((attempts.get(ip)?.count || 0) >= 20) return json(429, { error: 'Too many failed attempts; wait one minute' });
      if (!authorized(req.headers.authorization, config.token)) {
        const entry = attempts.get(ip) || { count: 0, until: now + 60_000 };
        entry.count++; attempts.set(ip, entry);
        return json(401, { error: 'Authentication required' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { status: 'ok', platform: process.platform });
      if (req.method === 'GET' && url.pathname === '/api/files') return json(200, { entries: await agent.files(url.searchParams.get('path') || '') });
      if (req.method === 'GET' && url.pathname === '/api/download') {
        const result = await agent.download(url.searchParams.get('path') || '');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': result.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}` });
        await pipeline(result.file.createReadStream(), res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/applications') return json(200, { applications: await agent.applications() });
      if (req.method === 'POST' && url.pathname === '/api/applications/close') {
        if (req.headers['content-type'] !== 'application/json') return json(415, { error: 'JSON required' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) return json(413, { error: 'Request too large' });
        }
        let data;
        try { data = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (typeof data.ticket !== 'string' || typeof data.force !== 'boolean' || (data.force && data.confirm !== 'FORCE')) return json(400, { error: 'Invalid close request or missing force confirmation' });
        await agent.stop(data.ticket, data.force);
        return json(200, { status: 'close-requested' });
      }
      json(404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || ({ ENOENT: 404, ENOTDIR: 400, EACCES: 403, EPERM: 403 }[error.code]) || 500;
      json(status, { error: error.status ? error.message : status === 500 ? 'Operation failed; check agent permissions and application state' : 'File unavailable or access denied' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.RC_TOKEN;
  if (!token || Buffer.byteLength(token) < 32) throw new Error('Set RC_TOKEN to a random secret of at least 32 bytes');
  if (!process.env.RC_ROOT) throw new Error('Set RC_ROOT to the folder you want to share');
  const host = process.env.RC_BIND || '127.0.0.1';
  const port = Number(process.env.RC_PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RC_PORT');
  const hosts = (process.env.RC_HOSTS || `localhost:${port},127.0.0.1:${port}`).split(',');
  const origins = (process.env.RC_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`).split(',');
  const server = await createServer({ token, root: process.env.RC_ROOT, hosts, origins, allowedApps: (process.env.RC_ALLOWED_APPS || '').split(',').filter(Boolean) });
  server.listen(port, host, () => console.log(`Remote Controller listening on ${host}:${port}; use only localhost or a private encrypted VPN connection.`));
}
