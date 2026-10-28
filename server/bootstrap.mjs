import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const same = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
export async function dependencyContext(directory) {
  const manifest = await json(path.join(directory, 'package.json'));
  let root = directory;
  for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    try {
      const candidate = await json(path.join(parent, 'package.json'));
      if (Array.isArray(candidate.workspaces) && candidate.workspaces.includes(path.relative(parent, directory).split(path.sep).join('/'))) { root = parent; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let lock;
  try { lock = await json(path.join(root, 'package-lock.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { directory, root, manifest, lock };
}
export async function dependenciesReady(context) {
  const { directory, root, manifest, lock } = context;
  if (!Object.keys(manifest.dependencies || {}).length) return true;
  if (!lock?.packages) return false;
  const relative = path.relative(root, directory).split(path.sep).join('/');
  if (!same(manifest.dependencies, lock.packages[relative]?.dependencies)) return false;
  const visited = new Set();
  async function check(name, parent) {
    const require = createRequire(path.join(parent, 'package.json'));
    let entry;
    try { entry = require.resolve(name); } catch { return false; }
    let folder = path.dirname(entry), info;
    while (folder !== path.dirname(folder)) {
      try { const candidate = await json(path.join(folder, 'package.json')); if (candidate.name === name) { info = candidate; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      folder = path.dirname(folder);
    }
    if (!info) return false;
    if (visited.has(folder)) return true;
    visited.add(folder);
    const key = path.relative(root, folder).split(path.sep).join('/');
    if (lock.packages[key]?.version !== info.version) return false;
    for (const child of Object.keys(info.dependencies || {})) if (!await check(child, folder)) return false;
    return true;
  }
  for (const name of Object.keys(manifest.dependencies || {})) if (!await check(name, directory)) return false;
  return true;
}
export function installDependencies(context) {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run npm start (or npm run dev) so the dependency installer can locate npm.');
  const args = [npm, context.lock ? 'ci' : 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  // Launch npm via Node on Windows too; no .cmd shell quoting or nested lifecycle hooks.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: context.root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Dependency installation failed (${signal || `exit ${code}`}). Check the npm error above, network access, and directory permissions. The agent/server was not started.`)));
  });
}
export async function ensureDependencies(directory, install = installDependencies) {
  let context = await dependencyContext(directory);
  if (await dependenciesReady(context)) return false;
  console.log('Installing missing or outdated runtime dependencies…');
  await install(context);
  context = await dependencyContext(directory);
  if (!await dependenciesReady(context)) throw new Error('Runtime dependencies are still missing or differ from package-lock.json after installation. Startup stopped.');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(directory, process.argv[2] || 'src/index.js');
    await access(entry);
    await ensureDependencies(directory);
    process.argv = [process.execPath, entry, ...process.argv.slice(3)];
    await import(pathToFileURL(entry).href);
  } catch (error) { console.error(`Startup failed: ${error.message}`); process.exitCode = 1; }
}
