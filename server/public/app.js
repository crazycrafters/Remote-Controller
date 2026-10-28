import { createControls } from './controls.js';
const $ = id => document.getElementById(id);
let devices = [];
let testNoAuth = false;
let signedIn = false;
function message(value = '') { $('message').textContent = value; }
function show(value) { signedIn = value; $('login').hidden = signedIn; $('workspace').hidden = !signedIn; $('logout').hidden = testNoAuth || !signedIn; if (!signedIn) { devices = []; $('devices').replaceChildren(); $('remote').hidden = true; $('remote-files').replaceChildren(); $('remote-apps').replaceChildren(); } }
async function api(route, data) {
  const response = await fetch(route, data === undefined ? { signal: AbortSignal.timeout(65_000) } : { signal: AbortSignal.timeout(65_000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) show(false); throw new Error(`${result.error}${response.status >= 500 && result.requestId && !result.error.includes(result.requestId) ? ` (reference ${result.requestId})` : ''}`); }
  return result;
}
const manage = createControls({ api, message });
function render() {
  const search = $('search').value.toLowerCase();
  $('devices').replaceChildren();
  for (const device of devices.filter(d => `${d.id} ${d.hostname}`.toLowerCase().includes(search))) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${device.id} · ${device.platform} · ${device.revoked ? 'Revoked' : !device.approved ? 'Pending approval' : device.connected ? 'Connected' : device.online ? 'Reconnecting' : 'Offline'} · Last seen ${new Date(device.lastSeen).toLocaleString()}`;
    const revoke = document.createElement('button'); revoke.className = 'danger'; revoke.textContent = 'Revoke'; revoke.disabled = device.revoked;
    revoke.onclick = () => execute(async () => { if (confirm(`Revoke management access for ${device.id}?`)) { await api('/api/revoke', { id: device.id }); await refresh(); } });
    const approve = document.createElement('button'); approve.textContent = 'Approve';
    approve.hidden = device.approved || device.revoked;
    approve.onclick = () => execute(async () => { await api('/api/approve', { id: device.id }); await refresh(); });
    const open = document.createElement('button'); open.textContent = 'Manage'; open.disabled = !device.connected || device.revoked; open.onclick = () => manage(device.id);
    const actions = document.createElement('div'); actions.className = 'row'; actions.append(open, approve, revoke);
    row.append(label, actions); $('devices').append(row);
  }
  if (!$('devices').children.length) $('devices').textContent = 'No matching computers.';
}
async function refresh() { devices = (await api('/api/devices')).devices; show(true); render(); }
async function execute(fn) { message(); try { await fn(); } catch (error) { message(error.message); } }
$('signin').onsubmit = event => { event.preventDefault(); const password = $('password').value; $('password').value = ''; void execute(async () => { await api('/api/login', { password }); await refresh(); }); };
$('refresh').onclick = () => execute(refresh);
$('logout').onclick = () => execute(async () => { await api('/api/logout', {}); show(false); });
$('search').oninput = render;
void execute(async () => { const config = await api('/api/config'); testNoAuth = config.testNoAuth; if (testNoAuth) document.querySelector('footer').textContent = 'Local test mode · No password · Direct localhost access only'; await refresh(); });

setInterval(() => {
  if (signedIn && !document.hidden) void refresh().catch(error => message(error.message));
}, 5000);
