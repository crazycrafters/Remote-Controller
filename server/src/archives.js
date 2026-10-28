import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createArchiveStore(directory) {
  const root = path.join(directory, 'uploads');
  const active = new Set();
  return {
    async save(id, deviceId, input) {
      if (!validId(id)) throw fail(400, 'Invalid archive ID');
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (active.has(id)) throw fail(409, 'Archive upload is already in progress');
      active.add(id);
      const partial = path.join(root, `${id}.${randomUUID()}.partial`), filename = path.join(root, `${id}.zip`);
      let size = 0, published = false;
      const metadataTemporary = path.join(root, `${id}.${randomUUID()}.metadata-partial`);
      const limit = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > 256 * 1024 ** 2 ? fail(413, 'Archive upload limit is 256 MiB') : null, chunk); } });
      try {
        try { await stat(filename); throw fail(409, 'This archive has already been uploaded'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await pipeline(input, limit, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
        const signature = await import('node:fs/promises').then(async ({ open }) => { const file = await open(partial); try { const data = Buffer.alloc(4); await file.read(data, 0, 4, 0); return data; } finally { await file.close(); } });
        if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && !signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) throw fail(400, 'Upload must be a ZIP archive');
        const metadata = { id, deviceId, name: `${deviceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`, size, createdAt: Date.now() };
        await rename(partial, filename); published = true;
        await writeFile(metadataTemporary, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
        await rename(metadataTemporary, path.join(root, `${id}.json`));
        return metadata;
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        await rm(metadataTemporary, { force: true }).catch(() => {});
        if (published) await rm(filename, { force: true }).catch(() => {});
        throw error;
      } finally { active.delete(id); }
    },
    async list(deviceId) {
      let files; try { files = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const archives = [];
      for (const file of files.filter(file => file.endsWith('.json'))) {
        const metadata = JSON.parse(await readFile(path.join(root, file), 'utf8'));
        if (!deviceId || metadata.deviceId === deviceId) archives.push(metadata);
      }
      return archives.sort((a, b) => b.createdAt - a.createdAt);
    },
    async download(id) {
      if (!validId(id)) throw fail(400, 'Invalid archive ID');
      const metadata = JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8'));
      const filename = path.join(root, `${id}.zip`); const info = await stat(filename);
      return { metadata, size: info.size, stream: createReadStream(filename) };
    }
  };
}
