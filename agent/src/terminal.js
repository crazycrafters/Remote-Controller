import { spawn, execFile } from 'node:child_process';

export function runShell(command, cwd, { timeout = 15_000, maxBytes = 256 * 1024 } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 3000 || command.includes('\0')) throw Object.assign(new Error('Enter a command of 1–3000 characters'), { status: 400 });
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command], { cwd, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, truncated = false, timedOut = false, settled = false;
    const stdout = [], stderr = [];
    function terminate() {
      if (windows) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    function collect(target, chunk) {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxBytes && !truncated) { truncated = true; terminate(); }
    }
    child.stdout.on('data', chunk => collect(stdout, chunk)); child.stderr.on('data', chunk => collect(stderr, chunk));
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(Object.assign(new Error(error.code === 'ENOENT' ? 'The terminal shell is unavailable on this PC' : 'Cannot start terminal in the selected folder'), { status: 502 })); });
    child.once('close', (exitCode, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ cwd, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal, timedOut, truncated });
    });
  });
}
