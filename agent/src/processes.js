import { execFile } from 'node:child_process';
import { profileLabel } from './profiles.js';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function listProcesses() {
  let rows;
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
    const data = JSON.parse(stdout || '[]');
    rows = [data].flat().filter(Boolean).map(p => ({ pid: p.ProcessId, name: p.Name.replace(/\.exe$/i, ''), commandLine: p.CommandLine || '' }));
  } else {
    const options = { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 };
    const [names, argumentsList] = await Promise.all([
      exec('ps', ['-u', String(process.getuid()), '-o', 'pid=,comm='], options),
      exec('ps', ['-u', String(process.getuid()), '-o', 'pid=,args='], options)
    ]);
    const args = new Map(argumentsList.stdout.trim().split('\n').filter(Boolean).map(line => { const match = line.match(/^\s*(\d+)\s+(.*)$/); return match ? [Number(match[1]), match[2]] : [null, '']; }));
    rows = names.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [, pid, name] = line.match(/^\s*(\d+)\s+(.+)$/);
      return { pid: Number(pid), name: name.split('/').pop(), commandLine: args.get(Number(pid)) || '' };
    });
  }
  const labels = new Map();
  return Promise.all(rows.map(async ({ commandLine, ...row }) => {
    // Raw command lines may contain secrets: return only an optional profile label.
    const key = `${row.name}\0${commandLine}`;
    if (/chrome|chromium/i.test(row.name) && !labels.has(key)) labels.set(key, profileLabel(row.name, commandLine));
    const profile = await labels.get(key);
    return { ...row, ...(profile ? { profile } : {}) };
  }));
}

export async function closeProcess(pid, force) {
  if (process.platform === 'win32') {
    // A fixed script and validated numeric PID; no user-controlled command text.
    const script = force
      ? `Stop-Process -Id ${pid} -ErrorAction Stop`
      : `$p = Get-Process -Id ${pid} -ErrorAction Stop; if (-not $p.CloseMainWindow()) { throw 'Application has no closeable window' }`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  } else {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  }
}
