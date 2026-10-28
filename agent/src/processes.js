import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function listProcesses() {
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress'], { maxBuffer: 4 * 1024 * 1024 });
    const rows = JSON.parse(stdout || '[]');
    return [rows].flat().map(p => ({ pid: p.Id, name: p.ProcessName }));
  }
  const { stdout } = await exec('ps', ['-u', String(process.getuid()), '-o', 'pid=,comm='], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [, pid, name] = line.match(/^\s*(\d+)\s+(.+)$/);
    return { pid: Number(pid), name: name.split('/').pop() };
  });
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
