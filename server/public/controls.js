const $ = id => document.getElementById(id);
export function createControls({ api, message }) {
  let selected, current = '', parent = null, busy = false;
  const command = (operation, args = {}) => api('/api/control', { id: selected, operation, args });
  async function work(fn) {
    if (busy) return message('Wait for the current device request to finish.');
    busy = true; $('remote').setAttribute('aria-busy', 'true'); $('remote-progress').textContent = 'Working on the managed PC…'; message();
    try { await fn(); } catch (error) { message(error.message); }
    finally { busy = false; $('remote').setAttribute('aria-busy', 'false'); $('remote-progress').textContent = ''; }
  }
  function button(label, fn, className = 'secondary') {
    const element = document.createElement('button'); element.textContent = label; element.className = className;
    element.onclick = () => work(fn);
    return element;
  }
  async function files(folder) {
    const result = await command('files', { path: folder });
    current = result.path; parent = result.parent;
    $('remote-mode').textContent = result.mode === 'system' ? 'All drives and folders accessible to this agent. Downloads up to 8 MiB.' : 'Configured shared folder. Downloads up to 8 MiB.';
    $('remote-path').textContent = current || 'Computer'; $('remote-up').disabled = parent === null;
    $('remote-files').replaceChildren();
    for (const entry of result.entries) {
      const row = document.createElement('li');
      row.append(button(`${entry.directory ? '📁' : '📄'} ${entry.name}`, async () => {
        if (entry.directory) return files(entry.path);
        const download = await command('download', { path: entry.path });
        const bytes = Uint8Array.from(atob(download.data), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes]));
        const link = document.createElement('a'); link.href = url; link.download = download.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }, 'file-name'));
      $('remote-files').append(row);
    }
    if (!result.entries.length) $('remote-files').textContent = 'This folder is empty.';
  }
  async function applications() {
    const result = await command('applications'); $('remote-apps').replaceChildren();
    for (const application of result.applications) {
      const row = document.createElement('li'); const label = document.createElement('span');
      label.textContent = `${application.name} · PID ${application.pid}`;
      async function close(force) {
        if (force ? prompt(`Force stop ${application.name}? Unsaved data may be lost. Type FORCE.`) !== 'FORCE' : !confirm(`Request ${application.name} to close? Unsaved data may be lost.`)) return;
        await command('close', { ticket: application.ticket, force, ...(force ? { confirm: 'FORCE' } : {}) });
        await applications(); message('Close requested. Refresh applications to check its status.');
      }
      const actions = document.createElement('div'); actions.className = 'row';
      actions.append(button('Close', () => close(false)), button('Force stop', () => close(true), 'danger'));
      row.append(label, actions); $('remote-apps').append(row);
    }
    if (!result.applications.length) $('remote-apps').textContent = 'No allowlisted applications are running. Configure RC_ALLOWED_APPS on the agent.';
  }
  $('remote-computer').onclick = () => work(() => files(''));
  $('remote-up').onclick = () => work(() => parent === null ? undefined : files(parent));
  $('remote-refresh-files').onclick = () => work(() => files(current));
  $('remote-refresh-apps').onclick = () => work(applications);
  return id => work(async () => {
    selected = id; current = ''; parent = null;
    $('remote').hidden = false; $('remote-title').textContent = `Manage ${id}`;
    $('remote-files').replaceChildren(); $('remote-apps').replaceChildren();
    const results = await Promise.allSettled([files(''), applications()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
}
