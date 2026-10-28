import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function chromeOptions(commandLine = '') {
  const option = name => commandLine.match(new RegExp(`--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`))?.slice(1).find(value => value !== undefined);
  return { directory: option('profile-directory'), userData: option('user-data-dir') };
}
export async function profileLabel(name, commandLine, read = readFile) {
  if (!/chrome|chromium/i.test(name)) return undefined;
  const { directory, userData } = chromeOptions(commandLine);
  // Renderer/service processes do not reliably identify their browser profile.
  if (!directory) return undefined;
  const defaults = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data') : process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome') : path.join(homedir(), '.config', /chromium/i.test(name) ? 'chromium' : 'google-chrome');
  try {
    const content = await read(path.join(userData || defaults, 'Local State'), 'utf8');
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) return directory;
    const label = JSON.parse(content)?.profile?.info_cache?.[directory]?.name;
    return typeof label === 'string' && label.length <= 200 ? label : directory;
  } catch { return directory; }
}
