/**
 * BRC plugins: where an installed plugin's main executable lives. Pure filesystem, no spawning,
 * no network - cheap enough for every agent start and for BRC's own tools (ast-grep, rtk) to
 * find their program:
 *
 *   import { binaryPluginPath } from '../plugins/locate.js';
 *   const exe = binaryPluginPath('ast-grep');   // absolute path, or null if not installed
 */
import fs from 'node:fs';
import path from 'node:path';
import { exeName, pluginPaths } from './paths.js';
import { getPlugin } from './store.js';
import type { PluginRecord } from './types.js';

const isWindows = process.platform === 'win32';

/** "@scope/name" -> ["@scope", "name"]; "name" -> [undefined, "name"]. */
function splitPackage(pkg: string): [string | undefined, string] {
  const m = /^(@[^/]+)\/(.+)$/.exec(pkg);
  return m ? [m[1], m[2]] : [undefined, pkg];
}

/** Directory of an npm package installed under the plugin npm prefix. */
export function npmPackageDir(pkg: string): string {
  return path.join(pluginPaths.npmPrefix(), 'node_modules', ...pkg.split('/'));
}

function isNativeFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (isWindows) return file.toLowerCase().endsWith('.exe');
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      return head[0] !== 0x23 || head[1] !== 0x21; // not a "#!" script
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/**
 * Native executable shipped by an npm package that uses per-platform optional dependencies
 * (e.g. @ast-grep/cli + @ast-grep/cli-win32-x64-msvc). Prefers the real binary over the JS shim
 * so callers avoid a node start-up per call.
 */
export function npmNativeBinary(pkg: string, binName: string): string | null {
  const exe = exeName(binName);
  const main = npmPackageDir(pkg);
  const direct = path.join(main, exe);
  if (isNativeFile(direct)) return direct;
  const [scope, name] = splitPackage(pkg);
  const parent = scope ? path.join(pluginPaths.npmPrefix(), 'node_modules', scope) : path.join(pluginPaths.npmPrefix(), 'node_modules');
  try {
    for (const d of fs.readdirSync(parent)) {
      if (!d.startsWith(`${name}-`) || !d.includes(process.platform)) continue;
      for (const candidate of [path.join(parent, d, exe), path.join(parent, d, 'bin', exe)]) {
        if (isNativeFile(candidate)) return candidate;
      }
    }
  } catch { /* not installed */ }
  const shim = path.join(pluginPaths.npmBinDir(), exeName(binName, 'npm-shim'));
  return fs.existsSync(shim) ? shim : null;
}

/** Expected path of a plugin's main executable (whether or not it exists). Null: nothing on disk. */
export function pluginExecutable(rec: PluginRecord): string | null {
  const s = rec.source;
  switch (s.type) {
    case 'npm':
      return path.join(pluginPaths.npmBinDir(), exeName(s.bin ?? splitPackage(s.package)[1], 'npm-shim'));
    case 'pypi':
      return path.join(pluginPaths.uvBinDir(), exeName(s.command ?? s.package));
    case 'binary':
      if (s.npmPackage) return npmNativeBinary(s.npmPackage, s.binName) ?? path.join(pluginPaths.npmBinDir(), exeName(s.binName, 'npm-shim'));
      return path.join(pluginPaths.binDir(), exeName(s.binName));
    default:
      return null; // command / remote: nothing installed by BRC
  }
}

/** True when the plugin's installed files are present (always true for command/remote). */
export function pluginFilesPresent(rec: PluginRecord): boolean {
  const exe = pluginExecutable(rec);
  return exe === null || fs.existsSync(exe);
}

/** Absolute path of an installed binary plugin (e.g. "ast-grep", "rtk"), or null. */
export function binaryPluginPath(id: string): string | null {
  const rec = getPlugin(id);
  if (!rec || rec.source.type !== 'binary' || rec.status !== 'installed') return null;
  const exe = pluginExecutable(rec);
  return exe && fs.existsSync(exe) ? exe : null;
}
