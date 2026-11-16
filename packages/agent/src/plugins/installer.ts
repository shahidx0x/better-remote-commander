/**
 * BRC plugin installer: puts a plugin's files under $BRC_HOME and takes them away again.
 * Registered with the manager by registerInstaller() (cli.ts calls it at start-up).
 *
 *   npm     npm install --prefix $BRC_HOME/plugins/node <pkg>@<exact version> (no global installs)
 *   pypi    uv tool install <pkg>==<version> --python <system or uv-managed Python> (see python.ts)
 *   binary  from npm (npmPackage, e.g. @ast-grep/cli) or a pinned download whose sha256 MUST match,
 *           extracted (zip / tar.gz, pure JS) into $BRC_HOME/bin
 *   command / remote  nothing to install
 *
 * No admin rights, no PATH/registry/profile changes. Every child process is hidden, time-limited,
 * and its stderr ends up (trimmed) in the error message.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { npmNativeBinary, npmPackageDir } from './locate.js';
import { setPluginInstaller } from './manager.js';
import { exeName, pluginPaths, uvEnv } from './paths.js';
import { MANAGED_PYTHON, resolvePython, ensureUv } from './python.js';
import type { InstallLog, InstallResult, PluginInstaller, PluginRecord, PluginSource, PluginUninstaller } from './types.js';
import { archiveKind, downloadVerified, extractOne, runError, runProcess, withLock, writeExecutable } from './util.js';

const isWindows = process.platform === 'win32';
const NPM_TIMEOUT_MS = 15 * 60_000;
const UV_TIMEOUT_MS = 20 * 60_000;

type NpmSource = Extract<PluginSource, { type: 'npm' }>;
type PypiSource = Extract<PluginSource, { type: 'pypi' }>;
type BinarySource = Extract<PluginSource, { type: 'binary' }>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Validation (arguments end up on a command line)
// ---------------------------------------------------------------------------
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?$/;
const PYPI_VERSION = /^[0-9][0-9A-Za-z.!+_-]*$/;
const GIT_URL = /^git\+https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;

export function validateNpm(pkg: string, version: string): void {
  if (!NPM_NAME.test(pkg)) throw new Error(`invalid npm package name "${pkg}"`);
  if (!EXACT_VERSION.test(version)) throw new Error(`npm version must be exact (e.g. 1.2.3), got "${version}"`);
}

/** Requirement string for uv: "name==version", or a git URL ("git+https://...@rev") as-is. */
export function pypiSpec(s: PypiSource): string {
  if (GIT_URL.test(s.package)) return s.package;
  if (!PYPI_NAME.test(s.package)) throw new Error(`invalid PyPI package name "${s.package}"`);
  if (!PYPI_VERSION.test(s.version)) throw new Error(`PyPI version must be exact (e.g. 1.2.3), got "${s.version}"`);
  return `${s.package}==${s.version}`;
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------
/** npm next to the running node (no shell needed), else npm from PATH. */
function npmCommand(): { cmd: string; pre: string[]; shell: boolean } {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const ep = process.env.npm_execpath;
  if (ep && path.basename(ep) === 'npm-cli.js') candidates.push(ep);
  for (const c of candidates) if (fs.existsSync(c)) return { cmd: process.execPath, pre: [c], shell: false };
  // npm.cmd can only be started through a shell on Windows; arguments are validated above.
  return isWindows ? { cmd: 'npm.cmd', pre: [], shell: true } : { cmd: 'npm', pre: [], shell: false };
}

/** Arguments for npm; quoted only for the shell fallback (npm.cmd), where the shell splits them. */
function npmArgs(npm: { pre: string[]; shell: boolean }, args: string[]): string[] {
  const all = [...npm.pre, ...args];
  return npm.shell ? all.map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)) : all;
}

function npmEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || /^npm_config_/i.test(k)) continue; // ignore settings inherited from a parent npm
    env[k] = v;
  }
  return {
    ...env,
    npm_config_cache: pluginPaths.npmCacheDir(),
    npm_config_global: 'false',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
}

async function ensureNpmPrefix(): Promise<string> {
  const prefix = pluginPaths.npmPrefix();
  await fsp.mkdir(prefix, { recursive: true });
  const pj = path.join(prefix, 'package.json');
  if (!fs.existsSync(pj)) {
    await fsp.writeFile(pj, `${JSON.stringify({ name: 'brc-plugins', private: true, description: 'Plugins installed by the BRC agent' }, null, 2)}\n`);
  }
  return prefix;
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

/** Install one npm package (exact version) into the shared plugin prefix. Serialised. */
export function npmInstall(pkg: string, version: string, log: InstallLog): Promise<Record<string, unknown>> {
  validateNpm(pkg, version);
  return withLock('npm', async () => {
    const prefix = await ensureNpmPrefix();
    const npm = npmCommand();
    log('info', `npm install ${pkg}@${version}`);
    const args = npmArgs(npm, ['install', '--prefix', prefix, `${pkg}@${version}`, '--no-audit', '--no-fund', '--omit=dev', '--save-exact', '--loglevel=error']);
    const r = await runProcess(npm.cmd, args, { env: npmEnv(), cwd: prefix, timeoutMs: NPM_TIMEOUT_MS, shell: npm.shell, log });
    if (r.code !== 0) throw new Error(runError(`npm install ${pkg}@${version}`, r));
    const pj = readJson(path.join(npmPackageDir(pkg), 'package.json'));
    if (!pj) throw new Error(`npm install ${pkg}@${version} finished but the package is missing`);
    if (pj.version !== version) throw new Error(`npm installed ${pkg}@${String(pj.version)}, expected ${version}`);
    return pj;
  });
}

export function npmUninstall(pkg: string, log: InstallLog): Promise<void> {
  if (!NPM_NAME.test(pkg)) return Promise.resolve();
  return withLock('npm', async () => {
    const prefix = pluginPaths.npmPrefix();
    if (!fs.existsSync(path.join(prefix, 'package.json'))) return;
    const npm = npmCommand();
    log('info', `npm uninstall ${pkg}`);
    const r = await runProcess(npm.cmd, npmArgs(npm, ['uninstall', '--prefix', prefix, pkg, '--no-audit', '--no-fund', '--loglevel=error']), { env: npmEnv(), cwd: prefix, timeoutMs: NPM_TIMEOUT_MS, shell: npm.shell, log });
    if (r.code !== 0) throw new Error(runError(`npm uninstall ${pkg}`, r));
  });
}

/** The executable name a package exposes ("bin" may be a string or an object). */
export function pickNpmBin(pj: Record<string, unknown>, pkg: string, preferred?: string): string | undefined {
  const unscoped = pkg.replace(/^@[^/]+\//, '');
  const bin = pj.bin;
  if (typeof bin === 'string') return unscoped;
  if (!bin || typeof bin !== 'object') return undefined;
  const names = Object.keys(bin as Record<string, unknown>);
  if (preferred && names.includes(preferred)) return preferred;
  if (names.includes(unscoped)) return unscoped;
  return names.find((n) => /mcp/i.test(n)) ?? names[0];
}

async function installNpm(s: NpmSource, log: InstallLog): Promise<InstallResult> {
  const pj = await npmInstall(s.package, s.version, log);
  const bin = pickNpmBin(pj, s.package, s.bin);
  if (!bin) return { status: 'failed', error: `${s.package} has no executable ("bin" in package.json)` };
  const shim = path.join(pluginPaths.npmBinDir(), exeName(bin, 'npm-shim'));
  if (!fs.existsSync(shim)) return { status: 'failed', error: `${s.package} installed but ${shim} is missing` };
  return { status: 'installed', installedVersion: String(pj.version), source: { ...s, bin } };
}

// ---------------------------------------------------------------------------
// pypi (uv tool)
// ---------------------------------------------------------------------------
function uvToolEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return { ...env, ...uvEnv() };
}

/** uv's normalised tool directory name for a package ("Serena_Agent[x]" -> "serena-agent"). */
export function uvToolName(pkg: string): string {
  return pkg.replace(/\[.*\]$/, '').toLowerCase().replace(/[-_.]+/g, '-');
}

/** Console scripts uv installed for a tool, from its uv-receipt.toml. */
export function uvToolEntrypoints(toolName: string): string[] {
  try {
    const receipt = fs.readFileSync(path.join(pluginPaths.uvToolDir(), toolName, 'uv-receipt.toml'), 'utf8');
    return [...receipt.matchAll(/\{\s*name\s*=\s*"([^"]+)"\s*,\s*install-path/g)].map((m) => m[1]);
  } catch { return []; }
}

function pickCommand(found: string[], s: PypiSource): string | undefined {
  if (s.command && found.includes(s.command)) return s.command;
  const base = uvToolName(s.package);
  return found.find((n) => n === base) ?? found.find((n) => /mcp/i.test(n)) ?? found[0];
}

const PYTHON_MISMATCH = /requires-python|Requires-Python|python_version|requires Python|not compatible with|incompatible with the (?:current|requested) Python|No interpreter found/i;

async function installPypi(s: PypiSource, log: InstallLog): Promise<InstallResult> {
  const spec = pypiSpec(s);
  const py = await resolvePython(log);
  if (!py.ok) return { status: 'needs-user', error: py.error, userAction: py.userAction };
  const run = (python: string) => withLock(`uv:${spec}`, () => runProcess(py.uv, ['tool', 'install', spec, '--python', python, '--force'], { env: uvToolEnv(), timeoutMs: UV_TIMEOUT_MS, log }));
  log('info', `uv tool install ${spec} (Python ${py.version ?? '?'} ${py.kind})`);
  let r = await run(py.python);
  if (r.code !== 0 && PYTHON_MISMATCH.test(r.stderr)) {
    // e.g. the package needs Python >= 3.11 but the system has 3.10: let uv fetch a private one.
    log('info', `${spec} does not support Python ${py.version}; retrying with a uv-managed Python ${MANAGED_PYTHON}`);
    r = await run(MANAGED_PYTHON);
  }
  if (r.code !== 0) return { status: 'failed', error: runError(`uv tool install ${spec}`, r) };

  let found = GIT_URL.test(s.package) ? [] : uvToolEntrypoints(uvToolName(s.package));
  if (!found.length) {
    const m = /Installed \d+ executables?: ([^\r\n]+)/.exec(`${r.stderr}\n${r.stdout}`);
    found = m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
  }
  const command = pickCommand(found, s);
  if (!command) return { status: 'failed', error: `${spec} installed but provides no console script` };
  const exe = path.join(pluginPaths.uvBinDir(), exeName(command));
  if (!fs.existsSync(exe)) return { status: 'failed', error: `${spec} installed but ${exe} is missing` };
  return { status: 'installed', installedVersion: s.version || undefined, source: { ...s, command } };
}

async function uninstallPypi(s: PypiSource, log: InstallLog): Promise<void> {
  const name = GIT_URL.test(s.package) ? (s.command ?? '') : uvToolName(s.package);
  if (!name || !/^[a-z0-9-]+$/.test(name)) return;
  const entry = uvToolEntrypoints(name);
  try {
    const uv = await ensureUv(log);
    const r = await runProcess(uv, ['tool', 'uninstall', name], { env: uvToolEnv(), timeoutMs: 120_000, log });
    if (r.code === 0) return;
    log('warn', runError(`uv tool uninstall ${name}`, r));
  } catch (e) {
    log('warn', `uv unavailable for uninstall: ${errMsg(e)}`);
  }
  // Fallback: remove the tool environment and its executables directly.
  await fsp.rm(path.join(pluginPaths.uvToolDir(), name), { recursive: true, force: true });
  for (const n of entry.length ? entry : s.command ? [s.command] : []) {
    await fsp.rm(path.join(pluginPaths.uvBinDir(), exeName(n)), { force: true });
  }
}

// ---------------------------------------------------------------------------
// binary
// ---------------------------------------------------------------------------
function binaryAsset(s: BinarySource) {
  const d = s.downloads ?? {};
  const key = `${process.platform}-${process.arch}` as keyof typeof d;
  return { key: String(key), asset: d[key] ?? (process.platform === 'linux' ? d[`${key}-musl` as keyof typeof d] : undefined) };
}

async function verifyRuns(exe: string, log: InstallLog): Promise<string | null> {
  const r = await runProcess(exe, ['--version'], { timeoutMs: 20_000 });
  if (r.code === 0) { log('debug', `${exe}: ${r.stdout.trim()}`); return null; }
  return runError(`${path.basename(exe)} --version`, r);
}

async function installBinary(rec: PluginRecord, s: BinarySource, log: InstallLog): Promise<InstallResult> {
  if (s.npmPackage) {
    await npmInstall(s.npmPackage, s.version, log);
    const exe = npmNativeBinary(s.npmPackage, s.binName);
    if (!exe || !fs.existsSync(exe)) return { status: 'failed', error: `${s.npmPackage} installed but no ${s.binName} executable for ${process.platform}-${process.arch}` };
    const bad = await verifyRuns(exe, log);
    if (bad) return { status: 'failed', error: bad };
    return { status: 'installed', installedVersion: s.version };
  }
  const { key, asset } = binaryAsset(s);
  if (!asset) return { status: 'unsupported', error: `no ${s.binName} ${s.version} build for ${key}` };
  const fileName = path.posix.basename(new URL(asset.url).pathname);
  const file = path.join(pluginPaths.downloadDir(), `${rec.id}-${s.version}-${fileName}`);
  const dest = path.join(pluginPaths.binDir(), exeName(s.binName));
  await downloadVerified(asset.url, asset.sha256, file, log);
  try {
    const kind = archiveKind(fileName);
    if (kind) await extractOne(file, kind, { archivePath: asset.archivePath, baseName: exeName(s.binName) }, dest);
    else await writeExecutable(dest, await fsp.readFile(file));
  } finally {
    await fsp.rm(file, { force: true });
  }
  const bad = await verifyRuns(dest, log);
  if (bad) return { status: 'failed', error: bad };
  log('info', `${s.binName} ${s.version} installed to ${dest}`);
  return { status: 'installed', installedVersion: s.version };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
/** Let BRC's ast-grep / rtk tools pick up a newly installed (or removed) binary immediately. */
async function resetBinaryToolCaches(): Promise<void> {
  await Promise.allSettled([
    import('../tools/ast-grep.js').then((m) => m.resetAstGrepCache()),
    import('../tools/rtk.js').then((m) => m.resetRtkCache()),
  ]);
}

export const installPluginFiles: PluginInstaller = async (rec, log) => {
  const s = rec.source;
  try {
    switch (s.type) {
      case 'npm': return await installNpm(s, log);
      case 'pypi': return await installPypi(s, log);
      case 'binary': {
        const r = await installBinary(rec, s, log);
        await resetBinaryToolCaches();
        return r;
      }
      case 'command':
      case 'remote':
        return { status: 'installed' };
    }
  } catch (e) {
    return { status: 'failed', error: errMsg(e) };
  }
};

export const uninstallPluginFiles: PluginUninstaller = async (rec, log) => {
  const s = rec.source;
  switch (s.type) {
    case 'npm':
      await npmUninstall(s.package, log);
      return;
    case 'pypi':
      await uninstallPypi(s, log);
      return;
    case 'binary':
      if (s.npmPackage) await npmUninstall(s.npmPackage, log);
      else await fsp.rm(path.join(pluginPaths.binDir(), exeName(s.binName)), { force: true });
      await resetBinaryToolCaches();
      return;
    default:
      return; // command / remote: nothing on disk
  }
};

/** Register this installer with the plugin manager (called once at agent start). */
export function registerInstaller(): void {
  setPluginInstaller(installPluginFiles, uninstallPluginFiles);
}
