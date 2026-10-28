const $ = id => document.getElementById(id);
let devices = [];
function message(value = '') { $('message').textContent = value; }
function show(signedIn) { $('login').hidden = signedIn; $('workspace').hidden = !signedIn; $('logout').hidden = !signedIn; if (!signedIn) { devices = []; $('devices').replaceChildren(); $('code').textContent = ''; } }
async function api(route, data) {
  const response = await fetch(route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) show(false); throw new Error(result.error); }
  return result;
}
function render() {
  const search = $('search').value.toLowerCase();
  $('devices').replaceChildren();
  for (const device of devices.filter(d => `${d.id} ${d.hostname}`.toLowerCase().includes(search))) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${device.id} · ${device.platform} · ${device.revoked ? 'Revoked' : !device.approved ? 'Pending approval' : device.online ? 'Online' : 'Offline'} · Last seen ${new Date(device.lastSeen).toLocaleString()}`;
    const revoke = document.createElement('button'); revoke.className = 'danger'; revoke.textContent = 'Revoke'; revoke.disabled = device.revoked;
    revoke.onclick = () => execute(async () => { if (confirm(`Revoke inventory access for ${device.id}?`)) { await api('/api/revoke', { id: device.id }); await refresh(); } });
    const approve = document.createElement('button'); approve.textContent = 'Approve';
    approve.hidden = device.approved || device.revoked;
    approve.onclick = () => execute(async () => { await api('/api/approve', { id: device.id }); await refresh(); });
    const actions = document.createElement('div'); actions.className = 'row'; actions.append(approve, revoke);
    row.append(label, actions); $('devices').append(row);
  }
  if (!$('devices').children.length) $('devices').textContent = 'No matching computers.';
}
async function refresh() { devices = (await api('/api/devices')).devices; show(true); render(); }
async function execute(fn) { message(); try { await fn(); } catch (error) { message(error.message); } }
$('signin').onsubmit = event => { event.preventDefault(); const password = $('password').value; $('password').value = ''; void execute(async () => { await api('/api/login', { password }); await refresh(); }); };
$('invite').onclick = () => execute(async () => { const invite = await api('/api/invites', {}); $('code').textContent = `Enrollment code: ${invite.code} — expires ${new Date(invite.expires).toLocaleTimeString()}`; });
$('refresh').onclick = () => execute(refresh);
$('logout').onclick = () => execute(async () => { await api('/api/logout', {}); show(false); });
$('search').oninput = render;
void execute(refresh);
