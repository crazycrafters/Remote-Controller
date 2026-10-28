import { lstat, readdir, mkdir, copyFile, unlink, rmdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';

const within = relative => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
const fail = (status, message) => Object.assign(new Error(message), { status });
export function fileActions({ resolve }) {
  async function plan(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(p => typeof p !== 'string')) throw fail(400, 'Select between 1 and 100 files or folders');
    const sources = await Promise.all(paths.map(resolve));
    const names = new Set();
    for (const source of sources) {
      const name = path.basename(source);
      if (!name || names.has(name.toLowerCase())) throw fail(400, 'Selections must have distinct names; select folders rather than an entire drive');
      names.add(name.toLowerCase());
      if (sources.some(other => other !== source && path.relative(other, source) && within(path.relative(other, source)))) throw fail(400, 'Do not select a folder and its children together');
    }
    let bytes = 0; const entries = [];
    async function walk(source, name) {
      const info = await lstat(source);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw fail(400, 'Copy and ZIP support regular files/folders only, without symbolic links');
      bytes += info.isFile() ? info.size : 0;
      if (bytes > 1024 ** 3 || entries.length >= 10000) throw fail(413, 'Selection limit: 1 GiB of source files and 10,000 entries');
      entries.push({ source, name, directory: info.isDirectory(), size: info.size });
      if (info.isDirectory()) for (const child of await readdir(source)) await walk(path.join(source, child), path.join(name, child));
    }
    for (const source of sources) await walk(source, path.basename(source));
    return { sources, entries };
  }
  return {
    async copy(paths, destination) {
      const { sources, entries } = await plan(paths);
      const target = await resolve(destination);
      if (!(await stat(target)).isDirectory()) throw fail(400, 'Paste destination must be a folder');
      for (const source of sources) {
        const relative = path.relative(source, target);
        if (relative === '' || within(relative)) throw fail(400, 'Cannot copy a folder into itself or its descendants');
        try { await lstat(path.join(target, path.basename(source))); throw fail(409, 'A selected name already exists in the destination; nothing was copied'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const created = [];
      try {
        for (const entry of entries) {
          // Recheck links immediately before copying; no dereferencing of new symlinks.
          if ((await lstat(entry.source)).isSymbolicLink()) throw fail(409, 'Source changed during copy');
          const output = path.join(target, entry.name);
          if (entry.directory) await mkdir(output);
          else await copyFile(entry.source, output, constants.COPYFILE_EXCL);
          created.push({ output, directory: entry.directory });
        }
      } catch (error) {
        for (const item of created.reverse()) {
          if (item.directory) await rmdir(item.output).catch(() => {});
          else await unlink(item.output).catch(() => {});
        }
        if (error.code === 'EEXIST') throw fail(409, 'Destination changed during copy; existing items were preserved');
        throw error;
      }
      return { copied: sources.length, entries: entries.length };
    },
    async archive(paths) {
      const { entries } = await plan(paths);
      const temporary = await mkdtemp(path.join(tmpdir(), 'remote-controller-zip-'));
      const filename = path.join(temporary, 'selection.zip');
      const zip = new yazl.ZipFile();
      const cleanup = () => rm(temporary, { recursive: true, force: true });
      let writing;
      try {
        writing = pipeline(zip.outputStream, createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
        zip.on('error', error => zip.outputStream.destroy(error));
        for (const entry of entries) {
          const name = entry.name.split(path.sep).join('/');
          if (entry.directory) zip.addEmptyDirectory(name);
          else zip.addFile(entry.source, name);
        }
        zip.end(); await writing;
        const { size } = await stat(filename);
        if (size > 256 * 1024 ** 2) throw fail(413, 'Compressed archive limit is 256 MiB');
        return { filename, name: 'selection.zip', size, cleanup };
      } catch (error) { zip.outputStream.destroy(); if (writing) await writing.catch(() => {}); await cleanup(); throw error; }
    }
  };
}
