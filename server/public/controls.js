const $ = id => document.getElementById(id);
export function createControls({ api, message }) {
  let selected, current = '', parent = null, busy = false, cwd = null;
  const selection = new Set(); let clipboard = [], available = [];
  function selectionState() {
    $('selection-count').textContent = `${selection.size} selected`;
    $('copy-files').disabled = !selection.size; $('zip-upload').disabled = !selection.size;
    $('paste-files').disabled = !clipboard.length || !cwd;
    $('select-all-files').disabled = !cwd || !available.length;
    $('select-all-files').checked = available.length > 0 && selection.size === available.length;
    $('clipboard-status').textContent = clipboard.length ? `${clipboard.length} item(s) copied; open a destination folder and choose Paste here.` : '';
  }
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
    current = result.path; parent = result.parent; cwd = result.cwd;
    $('terminal-cwd').textContent = cwd || 'Choose a filesystem folder';
    $('terminal-command').disabled = !cwd; $('terminal-run').disabled = !cwd;
    $('remote-mode').textContent = result.mode === 'system' ? 'All drives and folders accessible to this agent. Downloads up to 8 MiB.' : 'Configured shared folder. Downloads up to 8 MiB.';
    $('remote-path').textContent = current || 'Computer'; $('remote-up').disabled = parent === null;
    selection.clear(); available = cwd ? result.entries.map(entry => entry.path) : []; selectionState();
    $('remote-files').replaceChildren();
    for (const entry of result.entries) {
      const row = document.createElement('li');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'file-selection'; checkbox.disabled = !cwd; checkbox.setAttribute('aria-label', `Select ${entry.name}`);
      checkbox.onchange = () => { if (checkbox.checked) selection.add(entry.path); else selection.delete(entry.path); selectionState(); };
      row.append(checkbox);
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
      const name = document.createElement('span'); name.className = 'process-name'; name.textContent = application.name;
      const metadata = document.createElement('span'); metadata.className = 'process-meta'; metadata.textContent = `PID ${application.pid}${application.profile ? ` · Profile: ${application.profile}` : ''}`; label.append(name, metadata);
      async function close(force) {
        if (force ? prompt(`Force stop ${application.name}? Unsaved data may be lost. Type FORCE.`) !== 'FORCE' : !confirm(`Request ${application.name} to close? Unsaved data may be lost.`)) return;
        await command('close', { ticket: application.ticket, force, ...(force ? { confirm: 'FORCE' } : {}) });
        await applications(); message('Close requested. Refresh applications to check its status.');
      }
      const actions = document.createElement('div'); actions.className = 'row';
      actions.append(button('Close', () => close(false)), button('Force stop', () => close(true), 'danger'));
      row.append(label, actions); $('remote-apps').append(row);
    }
    if (!result.applications.length) $('remote-apps').textContent = 'No accessible applications are running.';
  }
  async function archives() {
    const result = await api(`/api/archives?deviceId=${encodeURIComponent(selected)}`); $('server-archives').replaceChildren();
    for (const archive of result.archives) {
      const row = document.createElement('li'); const link = document.createElement('a'); link.href = `/api/archives/${archive.id}/download`; link.textContent = `${archive.name} · ${(archive.size / 1024).toFixed(1)} KiB`; row.append(link); $('server-archives').append(row);
    }
    if (!result.archives.length) $('server-archives').textContent = 'No uploaded archives for this PC.';
  }
  $('select-all-files').onchange = () => {
    selection.clear(); if ($('select-all-files').checked) for (const value of available) selection.add(value);
    for (const checkbox of document.querySelectorAll('#remote-files .file-selection')) checkbox.checked = $('select-all-files').checked;
    selectionState();
  };
  $('copy-files').onclick = () => { clipboard = [...selection]; selectionState(); };
  $('paste-files').onclick = () => work(async () => {
    if (!cwd || !clipboard.length) return;
    $('remote-progress').textContent = 'Copying items into this folder…';
    const result = await command('copy', { paths: clipboard, destination: current });
    await files(current); message(`Copied ${result.copied} item(s).`);
  });
  $('zip-upload').onclick = () => work(async () => {
    if (!selection.size) return;
    $('remote-progress').textContent = 'Creating ZIP on the PC and uploading it to the server…';
    const archive = await command('zipupload', { paths: [...selection] });
    await archives(); $('server-archives').closest('details').open = true; message(`Uploaded ${archive.name} to the server.`);
  });
  $('refresh-archives').onclick = () => work(archives);
  $('terminal-form').onsubmit = event => {
    event.preventDefault();
    void work(async () => {
      if (!cwd) throw new Error('Choose a filesystem folder before running a command');
      const text = $('terminal-command').value; $('terminal-command').value = '';
      $('terminal-output').textContent += `\n${cwd} $ ${text}\n`;
      const result = await command('terminal', { path: current, command: text });
      $('terminal-output').textContent += `${result.stdout}${result.stderr}\n[exit ${result.exitCode ?? result.signal}${result.timedOut ? ' · timed out' : ''}${result.truncated ? ' · output limit reached' : ''}]\n`;
      if ($('terminal-output').textContent.length > 300000) $('terminal-output').textContent = $('terminal-output').textContent.slice(-300000);
      $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
    });
  };
  $('remote-computer').onclick = () => work(() => files(''));
  $('remote-up').onclick = () => work(() => parent === null ? undefined : files(parent));
  $('remote-refresh-files').onclick = () => work(() => files(current));
  $('remote-refresh-apps').onclick = () => work(applications);
  return id => work(async () => {
    selected = id; current = ''; parent = null; cwd = null;
    $('terminal-output').textContent = 'Select a folder above to run commands there.';
    $('remote').hidden = false; $('remote-title').textContent = id;
    $('remote-files').replaceChildren(); $('remote-apps').replaceChildren();
    const results = await Promise.allSettled([files(''), applications(), archives()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
}
