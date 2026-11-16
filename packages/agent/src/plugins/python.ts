/**
 * BRC plugins: Python for pypi plugins, without admin rights and without touching PATH.
 *
 *   1. A system Python >= 3.10 (py -3 / python3 / python; the Windows Store stub is ignored).
 *   2. Otherwise uv installs a private CPython into $BRC_HOME/plugins/uv/python.
 *   uv itself is needed in both cases: the one on PATH, else a pinned, sha256-verified release
 *   downloaded into $BRC_HOME/bin.
 *   3. Only when both fail: status needs-user. On Windows/macOS the official python.org installer
 *      is downloaded (pinned + sha256) into the downloads folder for the user to run - BRC never
 *      runs it. On Linux the user gets the package-manager command.
 *
 * The result is cached in plugins.json ("python") so later starts do not probe again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exeName, pluginPaths, uvEnv } from './paths.js';
import { loadPlugins, updatePlugins } from './store.js';
import type { InstallLog, PluginsFile } from './types.js';
import { downloadVerified, extractOne, archiveKind, runError, runProcess, whichSync } from './util.js';

const isWindows = process.platform === 'win32';
const MIN_PYTHON: [number, number] = [3, 10];
/** Version uv installs when there is no usable system Python (also the fallback for plugins needing a newer one). */
export const MANAGED_PYTHON = '3.12';

export type Asset = { url: string; sha256: string; archivePath?: string };

/**
 * uv 0.13.8 (https://github.com/astral-sh/uv/releases/tag/0.13.8). sha256 from the GitHub release
 * asset digests, cross-checked against the published <asset>.sha256 files.
 */
export const UV_VERSION = '0.13.8';
const UV_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
export const UV_DOWNLOADS: Record<string, Asset> = {
  'win32-x64': { url: `${UV_BASE}/uv-x86_64-pc-windows-msvc.zip`, sha256: '529e78a9cec6cd7e3e014f7ecd8bda0c113969d4ed0f2efeedb85c30943325b8', archivePath: 'uv.exe' },
  'win32-arm64': { url: `${UV_BASE}/uv-aarch64-pc-windows-msvc.zip`, sha256: '59e6d919bed1f72035e622a7c930058f08a8931c4c78ceaf9f56e7fb74dd2c48', archivePath: 'uv.exe' },
  'darwin-x64': { url: `${UV_BASE}/uv-x86_64-apple-darwin.tar.gz`, sha256: 'a04c2ffeac28b2003a2c13caf538ab425fcd7def3e4a41571f4a8fb370a66af3', archivePath: 'uv-x86_64-apple-darwin/uv' },
  'darwin-arm64': { url: `${UV_BASE}/uv-aarch64-apple-darwin.tar.gz`, sha256: '6b71028a6b904f2ae3340ef52e595512de807d06c0a20eaef2f692581b246558', archivePath: 'uv-aarch64-apple-darwin/uv' },
  'linux-x64': { url: `${UV_BASE}/uv-x86_64-unknown-linux-gnu.tar.gz`, sha256: '5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91', archivePath: 'uv-x86_64-unknown-linux-gnu/uv' },
  'linux-arm64': { url: `${UV_BASE}/uv-aarch64-unknown-linux-gnu.tar.gz`, sha256: '74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585', archivePath: 'uv-aarch64-unknown-linux-gnu/uv' },
  'linux-x64-musl': { url: `${UV_BASE}/uv-x86_64-unknown-linux-musl.tar.gz`, sha256: '61fb26dabc4f0cf1d050fc6c67d40e43e4fae2994af21ebc1e050b233bf2b5ed', archivePath: 'uv-x86_64-unknown-linux-musl/uv' },
  'linux-arm64-musl': { url: `${UV_BASE}/uv-aarch64-unknown-linux-musl.tar.gz`, sha256: '0c6f8593fcf1eadfc60e663b685c408267559d7c5d61c689bbb9f3a7e369ba32', archivePath: 'uv-aarch64-unknown-linux-musl/uv' },
};

/**
 * Official python.org installers, only ever downloaded for the user to run themselves.
 * Python 3.14.10; sha256 from the python.org release API (release_file.sha256_sum), the amd64
 * installer re-hashed after download.
 */
export const PYTHON_ORG_VERSION = '3.14.10';
const PY_BASE = `https://www.python.org/ftp/python/${PYTHON_ORG_VERSION}`;
export const PYTHON_ORG_INSTALLERS: Record<string, Asset> = {
  'win32-x64': { url: `${PY_BASE}/python-${PYTHON_ORG_VERSION}-amd64.exe`, sha256: '92480239264744fe0386a1bd8275786fefa126e3129e56a68e22b52c73329965' },
  'win32-arm64': { url: `${PY_BASE}/python-${PYTHON_ORG_VERSION}-arm64.exe`, sha256: '5b9547e4edae2f6fb2fbfec5e26cf91b4ea191e3b07f7727d5a2c5c2cca93ed3' },
  darwin: { url: `${PY_BASE}/python-${PYTHON_ORG_VERSION}-macos11.pkg`, sha256: '286c7018aa2730f6747ca433dccdc2b31be45f078a9ea0ffa44d5f06368fd2d7' },
};

export interface PythonReady {
  ok: true;
  uv: string;
  python: string;
  kind: 'system' | 'uv-managed';
  version?: string;
}
export interface PythonMissing {
  ok: false;
  error: string;
  userAction: string;
}

function platformKey(): string {
  if (process.platform !== 'linux') return `${process.platform}-${process.arch}`;
  const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  return `linux-${process.arch}${glibc ? '' : '-musl'}`;
}

function versionOk(v: string, min: [number, number] = MIN_PYTHON): boolean {
  const [maj, minr] = v.split('.').map(Number);
  return maj > min[0] || (maj === min[0] && minr >= min[1]);
}

function uvRunEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return { ...env, ...uvEnv() };
}

// ---------------------------------------------------------------------------
// uv
// ---------------------------------------------------------------------------
let uvPromise: Promise<string> | null = null;

/** Path of a usable uv: BRC's own copy, else uv on PATH, else download the pinned release. */
export function ensureUv(log: InstallLog = () => {}): Promise<string> {
  const own = path.join(pluginPaths.binDir(), exeName('uv'));
  if (fs.existsSync(own)) return Promise.resolve(own);
  const sys = whichSync(isWindows ? 'uv.exe' : 'uv');
  if (sys) return Promise.resolve(sys);
  uvPromise ??= (async () => {
    const asset = UV_DOWNLOADS[platformKey()];
    if (!asset) throw new Error(`no uv download for ${platformKey()}`);
    const file = path.join(pluginPaths.downloadDir(), path.posix.basename(new URL(asset.url).pathname));
    await downloadVerified(asset.url, asset.sha256, file, log);
    await extractOne(file, archiveKind(file)!, { archivePath: asset.archivePath, baseName: exeName('uv') }, own);
    fs.rmSync(file, { force: true });
    log('info', `uv ${UV_VERSION} installed to ${own}`);
    return own;
  })().finally(() => { uvPromise = null; });
  return uvPromise;
}

// ---------------------------------------------------------------------------
// System Python
// ---------------------------------------------------------------------------
const PROBE = 'import sys;print(sys.executable);print("%d.%d.%d" % sys.version_info[:3])';

/** A real system Python >= 3.10, or null. Spawns at most a few short-lived probes. */
export async function findSystemPython(): Promise<{ path: string; version: string } | null> {
  const candidates: Array<[string, string[]]> = isWindows
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const exe = whichSync(isWindows ? `${cmd}.exe` : cmd);
    if (!exe) continue;
    const r = await runProcess(exe, [...pre, '-c', PROBE], { timeoutMs: 15_000 });
    if (r.code !== 0) continue; // e.g. the Windows Store stub: exit 9009, prints to stderr
    const [where, version] = r.stdout.trim().split(/\r?\n/).map((s) => s.trim());
    if (!where || !version || !versionOk(version) || !fs.existsSync(where)) continue;
    return { path: where, version };
  }
  return null;
}

// ---------------------------------------------------------------------------
// uv-managed Python
// ---------------------------------------------------------------------------
export async function installManagedPython(uv: string, version = MANAGED_PYTHON, log: InstallLog = () => {}): Promise<{ path: string; version: string }> {
  const env = uvRunEnv();
  log('info', `installing Python ${version} with uv into ${pluginPaths.uvPythonDir()}`);
  const inst = await runProcess(uv, ['python', 'install', version, '--no-bin', '--no-registry'], { env, timeoutMs: 10 * 60_000, log });
  if (inst.code !== 0) throw new Error(runError(`uv python install ${version}`, inst));
  const find = await runProcess(uv, ['python', 'find', '--managed-python', version], { env, timeoutMs: 60_000 });
  const where = find.stdout.trim().split(/\r?\n/).pop()?.trim();
  if (find.code !== 0 || !where) throw new Error(runError(`uv python find ${version}`, find));
  const ver = await runProcess(where, ['-c', PROBE], { timeoutMs: 15_000 });
  return { path: where, version: ver.stdout.trim().split(/\r?\n/)[1]?.trim() || version };
}

// ---------------------------------------------------------------------------
// Needs-user fallback
// ---------------------------------------------------------------------------
function linuxInstallHint(): string {
  const pm: Array<[string, string]> = [
    ['apt-get', 'sudo apt install python3 python3-venv'],
    ['dnf', 'sudo dnf install python3'],
    ['yum', 'sudo yum install python3'],
    ['pacman', 'sudo pacman -S python'],
    ['zypper', 'sudo zypper install python3'],
    ['apk', 'sudo apk add python3'],
  ];
  for (const [bin, cmd] of pm) if (whichSync(bin)) return cmd;
  return 'install Python 3.10 or newer with your package manager (e.g. "sudo apt install python3 python3-venv")';
}

/** Build the needs-user result. Downloads (never runs) the python.org installer on Windows/macOS. */
export async function pythonNeedsUser(reason: string, log: InstallLog = () => {}, installer?: Asset | null): Promise<PythonMissing> {
  const tail = 'Then restart the BRC agent (or run brc-agent --add-plugin <id>) and the plugin installs automatically.';
  if (process.platform === 'linux' && installer === undefined) {
    return { ok: false, error: reason, userAction: `Python 3.10+ is needed. Run: ${linuxInstallHint()}. ${tail}` };
  }
  const asset = installer !== undefined ? installer : PYTHON_ORG_INSTALLERS[process.platform === 'darwin' ? 'darwin' : `${process.platform}-${process.arch}`];
  if (!asset) return { ok: false, error: reason, userAction: `Install Python 3.10+ from https://www.python.org/downloads/. ${tail}` };
  const file = path.join(pluginPaths.downloadDir(), path.posix.basename(new URL(asset.url).pathname));
  try {
    await downloadVerified(asset.url, asset.sha256, file, log);
    const how = isWindows
      ? 'Double-click it and install "for me" (no admin needed; tick "Add python.exe to PATH")'
      : 'Double-click it and follow the installer';
    return { ok: false, error: reason, userAction: `Python 3.10+ is needed. The official Python ${PYTHON_ORG_VERSION} installer was downloaded to ${file} (sha256 verified). ${how}. ${tail}` };
  } catch (e) {
    log('warn', `could not download the Python installer: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: reason, userAction: `Install Python 3.10+ from https://www.python.org/downloads/ (${asset.url}). ${tail}` };
  }
}

// ---------------------------------------------------------------------------
// Resolution (cached in plugins.json)
// ---------------------------------------------------------------------------
let resolving: Promise<PythonReady | PythonMissing> | null = null;

async function cache(py: NonNullable<PluginsFile['python']>): Promise<void> {
  await updatePlugins((s) => { s.python = py; });
}

/**
 * Python + uv for pypi plugins. Uses the cached decision when its interpreter still exists;
 * otherwise probes (system Python, then uv-managed). Concurrent callers share one resolution.
 */
export function resolvePython(log: InstallLog = () => {}): Promise<PythonReady | PythonMissing> {
  resolving ??= (async (): Promise<PythonReady | PythonMissing> => {
    let uv: string | null = null;
    let uvError = '';
    try { uv = await ensureUv(log); } catch (e) { uvError = e instanceof Error ? e.message : String(e); }

    const cached = loadPlugins().python;
    if (uv && cached?.path && fs.existsSync(cached.path)) {
      return { ok: true, uv, python: cached.path, kind: cached.kind, version: cached.version };
    }

    const sys = await findSystemPython();
    if (sys) {
      if (!uv) return { ok: false, error: `uv is not available: ${uvError}`, userAction: 'Check the internet connection (BRC downloads uv from github.com), then restart the agent.' };
      await cache({ kind: 'system', path: sys.path, version: sys.version, checkedAt: new Date().toISOString() });
      log('info', `using system Python ${sys.version} (${sys.path})`);
      return { ok: true, uv, python: sys.path, kind: 'system', version: sys.version };
    }

    let managedError = uvError ? `uv is not available: ${uvError}` : '';
    if (uv) {
      try {
        const m = await installManagedPython(uv, MANAGED_PYTHON, log);
        await cache({ kind: 'uv-managed', path: m.path, version: m.version, checkedAt: new Date().toISOString() });
        return { ok: true, uv, python: m.path, kind: 'uv-managed', version: m.version };
      } catch (e) {
        managedError = e instanceof Error ? e.message : String(e);
      }
    }
    return pythonNeedsUser(`no Python 3.10+ found and a private Python could not be installed (${managedError})`, log);
  })().finally(() => { resolving = null; });
  return resolving;
}

let availableNow: Promise<boolean> | null = null;
/** Cheap "is Python usable now?" check for needs-user plugins; runs at most once per process. */
export function pythonAvailableNow(): Promise<boolean> {
  availableNow ??= (async () => {
    const cached = loadPlugins().python;
    if (cached?.path && fs.existsSync(cached.path)) return true;
    return (await findSystemPython()) !== null;
  })();
  return availableNow;
}

/** For tests. */
export function resetPythonState(): void {
  availableNow = null;
}
