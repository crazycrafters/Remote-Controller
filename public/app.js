let token = '';
let folder = '';
const $ = id => document.getElementById(id);
function message(text = '') { $('message').textContent = text; }
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) disconnect();
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return response;
}
function button(label, action, className = 'secondary') {
  const el = document.createElement('button');
  el.textContent = label; el.className = className;
  el.onclick = async () => { el.disabled = true; message(); try { await action(); } catch (error) { message(error.message); } finally { el.disabled = false; } };
  return el;
}
async function files() {
  const data = await (await api(`/api/files?path=${encodeURIComponent(folder)}`)).json();
  $('folder').textContent = '/' + folder;
  $('up').disabled = !folder;
  $('files').replaceChildren();
  for (const entry of data.entries) {
    const li = document.createElement('li');
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    li.append(button(`${entry.directory ? '📁' : '📄'} ${entry.name}`, async () => {
      if (entry.directory) {
        const previous = folder;
        folder = relative;
        try { await files(); } catch (error) { folder = previous; throw error; }
      } else {
        const response = await api(`/api/download?path=${encodeURIComponent(relative)}`);
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = entry.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    }, 'file-name'));
    const type = document.createElement('span'); type.textContent = entry.directory ? 'Folder' : 'Download'; type.className = 'muted'; li.append(type);
    $('files').append(li);
  }
  if (!data.entries.length) $('files').textContent = 'This folder is empty.';
}
async function apps() {
  const data = await (await api('/api/applications')).json();
  $('apps').replaceChildren();
  for (const app of data.applications) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = `${app.name} · PID ${app.pid}`;
    const actions = document.createElement('div'); actions.className = 'row';
    async function close(force) {
      const agreed = force ? prompt(`Force stop ${app.name}? Unsaved progress may be lost. Type FORCE to confirm.`) === 'FORCE' : confirm(`Request ${app.name} to close? Unsaved progress may be lost.`);
      if (!agreed) return;
      await api('/api/applications/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: app.ticket, force, ...(force ? { confirm: 'FORCE' } : {}) }) });
      await apps(); message('Close requested. Refresh to check whether the application exited.');
    }
    actions.append(button('Close', () => close(false)), button('Force stop', () => close(true), 'danger'));
    li.append(name, actions); $('apps').append(li);
  }
  if (!data.applications.length) $('apps').textContent = 'No permitted applications are running. Configure RC_ALLOWED_APPS on the agent to enable controls.';
}
function disconnect() { token = ''; folder = ''; $('workspace').hidden = true; $('login').hidden = false; $('status').textContent = 'Disconnected'; $('files').replaceChildren(); $('apps').replaceChildren(); }
$('connect').onsubmit = async event => {
  event.preventDefault(); token = $('token').value; $('token').value = ''; message();
  try {
    const health = await (await api('/api/health')).json();
    $('status').textContent = `Connected · ${health.platform}`; $('workspace').hidden = false; $('login').hidden = true;
    await files(); await apps();
  } catch (error) { message(error.message); }
};
function action(id, fn) { $(id).onclick = async () => { message(); try { await fn(); } catch (error) { message(error.message); } }; }
action('refresh-files', files); action('refresh-apps', apps);
action('up', async () => { const previous = folder; folder = folder.split('/').slice(0, -1).join('/'); try { await files(); } catch (error) { folder = previous; throw error; } });
$('disconnect').onclick = disconnect;
