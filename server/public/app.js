import { createControls } from './controls.js';
import { createDeviceRefresh } from './device-refresh.js';
const $ = id => document.getElementById(id);
let devices = [];
let testNoAuth = false;
let signedIn = false;
let events = null;
const pageId = location.pathname.startsWith('/pcs/') ? decodeURIComponent(location.pathname.slice(5)) : null;
let loadedPC = null;
function message(value = '') { $('message').textContent = value; }
function show(value) { signedIn = value; $('login').hidden = signedIn; $('workspace').hidden = !signedIn; $('logout').hidden = testNoAuth || !signedIn; if (!signedIn) { events?.close(); events = null; deviceRefresh.invalidate(); devices = []; $('devices').replaceChildren(); $('remote').hidden = true; $('remote-files').replaceChildren(); $('remote-apps').replaceChildren(); } }
async function api(route, data) {
  const response = await fetch(route, data === undefined ? { signal: AbortSignal.timeout(65_000) } : { signal: AbortSignal.timeout(65_000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) show(false); throw Object.assign(new Error(`${result.error}${response.status >= 500 && result.requestId && !result.error.includes(result.requestId) ? ` (reference ${result.requestId})` : ''}`), { status: response.status }); }
  return result;
}
const manage = createControls({ api, message });
function render() {
  const search = $('search').value.toLowerCase();
  $('devices').replaceChildren();
  for (const device of devices.filter(d => `${d.id} ${d.hostname}`.toLowerCase().includes(search))) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'device-label';
    label.textContent = device.hostname;
    const details = document.createElement('p'); details.className = 'process-meta'; details.textContent = `${device.id} · ${device.platform} · ${device.connected ? 'Connected' : 'Disconnected'} · Last seen ${new Date(device.lastSeen).toLocaleString()}`;
    const dot = document.createElement('span'); dot.className = `presence-dot ${device.connected ? 'connected' : 'disconnected'}`; dot.setAttribute('aria-label', device.connected ? 'Connected' : 'Disconnected'); dot.title = device.connected ? 'Connected' : 'Disconnected'; label.prepend(dot);
    const disconnect = document.createElement('button'); disconnect.className = 'danger'; disconnect.textContent = 'Disconnect'; disconnect.disabled = !device.connected;
    disconnect.onclick = () => execute(async () => { if (confirm(`Disconnect ${device.id}? Restart its agent to reconnect.`)) { await api('/api/disconnect', { id: device.id }); await refresh(); } });
    const approve = document.createElement('button'); approve.textContent = 'Approve';
    approve.hidden = device.approved || device.revoked;
    approve.onclick = () => execute(async () => { await api('/api/approve', { id: device.id }); await refresh(); });
    const open = document.createElement('a'); open.textContent = 'Open workspace →'; open.href = `/pcs/${encodeURIComponent(device.id)}`;
    if (!device.connected) { open.removeAttribute('href'); open.setAttribute('aria-disabled', 'true'); }
    if (device.connected) { const link = document.createElement('a'); link.href = open.href; link.append(...label.childNodes); label.append(link); }
    const actions = document.createElement('div'); actions.className = 'row'; actions.append(open, approve, disconnect);
    row.append(label, details, actions); $('devices').append(row);
  }
  if (!$('devices').children.length) $('devices').textContent = 'No matching computers.';
  route();
}
function route() {
  $('pc-overview').hidden = Boolean(pageId); $('remote').hidden = !pageId;
  if (!pageId) return;
  const device = devices.find(device => device.id === pageId);
  $('remote-title').textContent = pageId;
  $('pc-details').textContent = device ? `${device.hostname} · ${device.platform} · Last seen ${new Date(device.lastSeen).toLocaleString()}` : 'Device not found on this server';
  const connected = Boolean(device?.connected);
  $('pc-live-status').replaceChildren();
  const dot = document.createElement('span'); dot.className = `presence-dot ${connected ? 'connected' : 'disconnected'}`;
  $('pc-live-status').append(dot, connected ? 'Connected' : 'Disconnected');
  $('remote-controls').disabled = !connected;
  if (connected && loadedPC !== pageId) { loadedPC = pageId; void manage(pageId); }
  if (!connected) loadedPC = null;
}
let apiVersion = '?';
const deviceRefresh = createDeviceRefresh({
  load: async () => (await api('/api/devices')).devices,
  apply: value => { devices = value; show(true); render(); startEvents(); },
  state: value => {
    if (value.status === 'retrying') { devices = devices.map(device => ({ ...device, connected: false })); render(); }
    $('connection-status').textContent = value.status === 'connected' ? `Connected · API ${apiVersion} · Long polling` : value.status === 'refreshing' ? 'Refreshing devices…' : `Connection interrupted; retrying automatically. Last device list retained. ${value.error}`;
  }
});
function startEvents() {
  if (events || !signedIn) return;
  events = new EventSource('/api/events');
  events.addEventListener('devices', event => {
    try { devices = JSON.parse(event.data).devices; render(); }
    catch { $('connection-status').textContent = 'Status update failed; refreshing device list.'; }
  });
  events.onerror = () => {
    devices = devices.map(device => ({ ...device, connected: false })); render();
    $('connection-status').textContent = 'Connection to server interrupted; reconnecting status stream…';
  };
}
const refresh = () => deviceRefresh.refresh();
async function execute(fn) { message(); try { await fn(); } catch (error) { message(error.message); } }
$('signin').onsubmit = event => { event.preventDefault(); const password = $('password').value; $('password').value = ''; void execute(async () => { await api('/api/login', { password }); await refresh(); }); };
$('refresh').onclick = () => execute(refresh);
$('logout').onclick = () => execute(async () => { await api('/api/logout', {}); show(false); });
$('search').oninput = render;
async function initialize() {
  try {
    const config = await api('/api/config'); testNoAuth = config.testNoAuth; apiVersion = config.apiVersion || 'older server';
    if (testNoAuth) document.querySelector('footer').textContent = 'Local test mode · No password · Direct localhost access only';
    await refresh();
  } catch (error) {
    if (error.status === 401) { $('connection-status').textContent = 'Server reached. Sign in to view devices.'; return; }
    $('connection-status').textContent = `Cannot reach the management server; retrying automatically. ${error.message}`;
    setTimeout(initialize, deviceRefresh.nextDelay());
  }
}
void initialize();

async function backgroundRefresh() {
  if (signedIn && !document.hidden) { try { await refresh(); } catch { /* Status banner reports outages without replacing operation messages. */ } }
  setTimeout(backgroundRefresh, deviceRefresh.nextDelay());
}
setTimeout(backgroundRefresh, 5000);
