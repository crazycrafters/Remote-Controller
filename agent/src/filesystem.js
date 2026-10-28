import { realpath, readdir, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const invalid = message => Object.assign(new Error(message), { status: 400 });

export function validateSystemPath(value, platform = process.platform) {
  if (typeof value !== 'string' || value.includes('\0')) throw invalid('Invalid path');
  // Drive-relative paths, UNC shares, and Windows device namespaces are not filesystem roots.
  if (platform === 'win32' ? !/^[a-z]:[\\/]/i.test(value) : !path.posix.isAbsolute(value)) {
    throw invalid('Choose an absolute path on an available drive');
  }
  return value;
}

export async function discoverRoots(platform = process.platform, inspect = stat) {
  if (platform !== 'win32') return [{ name: 'Filesystem', path: '/' }];
  const drives = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    const drive = `${String.fromCharCode(65 + index)}:\\`;
    try { return (await inspect(drive)).isDirectory() ? { name: drive, path: drive } : null; }
    catch { return null; } // Absent, disconnected, and inaccessible drives are not navigable.
  }));
  return drives.filter(Boolean);
}

export async function createFilesystem({ root, fileMode = root ? 'folder' : 'system' }) {
  if (!['folder', 'system'].includes(fileMode)) throw invalid('RC_FILE_MODE must be folder or system');
  if (fileMode === 'folder' && !root) throw invalid('RC_ROOT is required in folder mode');
  const base = fileMode === 'folder' ? await realpath(root) : null;
  if (base && !(await stat(base)).isDirectory()) throw invalid('RC_ROOT must be a directory');
  const system = fileMode === 'system';
  async function resolve(value) {
    if (typeof value !== 'string' || value.includes('\0')) throw invalid('Invalid path');
    if (system) return realpath(validateSystemPath(value));
    if (path.isAbsolute(value)) throw invalid('Invalid relative path');
    const target = await realpath(path.resolve(base, value));
    const rel = path.relative(base, target);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw Object.assign(new Error('Path is outside the permitted folder'), { status: 403 });
    }
    return target;
  }
  return {
    async directory(value) {
      const folder = await resolve(value);
      if (!(await stat(folder)).isDirectory()) throw invalid('Terminal location must be a folder');
      return folder;
    },
    async roots() {
      return { mode: fileMode, roots: system ? await discoverRoots() : [{ name: 'Shared folder', path: '' }] };
    },
    async browse(value = '') {
      if (system && !value) return { mode: fileMode, cwd: null, path: '', parent: null, entries: (await discoverRoots()).map(r => ({ ...r, directory: true })) };
      const folder = await resolve(value);
      const current = system ? folder : path.relative(base, folder);
      const parent = system ? (path.dirname(folder) === folder ? '' : path.dirname(folder)) : (current ? path.dirname(current) === '.' ? '' : path.dirname(current) : null);
      const entries = [];
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        let directory = entry.isDirectory();
        if (system && entry.isSymbolicLink()) {
          try {
            const info = await stat(path.join(folder, entry.name));
            if (!info.isDirectory() && !info.isFile()) continue;
            directory = info.isDirectory();
          } catch { continue; }
        } else if (!directory && !entry.isFile()) continue;
        entries.push({ name: entry.name, directory, path: path.join(current, entry.name) });
      }
      entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return { mode: fileMode, cwd: folder, path: current, parent, entries };
    },
    async download(value) {
      const target = await resolve(value);
      if (!(await stat(target)).isFile()) throw invalid('Not a regular file');
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const info = await file.stat();
        if (!info.isFile()) throw invalid('Not a regular file');
        return { file, size: info.size, name: path.basename(target) };
      } catch (error) { await file.close(); throw error; }
    }
  };
}
