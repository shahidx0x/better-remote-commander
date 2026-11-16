/** BRC plugins: filesystem layout. Everything lives under $BRC_HOME (default ~/.brc). */
import path from 'node:path';
import { homeDir } from '../transport/pairing.js';

const isWindows = process.platform === 'win32';

export const pluginPaths = {
  /** plugins.json state file */
  stateFile: () => path.join(homeDir(), 'plugins.json'),
  /** Root for installed plugin files */
  root: () => path.join(homeDir(), 'plugins'),
  /** npm prefix: `npm install --prefix <npmPrefix> pkg@ver` */
  npmPrefix: () => path.join(homeDir(), 'plugins', 'node'),
  /** Directory with npm-installed executables */
  npmBinDir: () => path.join(homeDir(), 'plugins', 'node', 'node_modules', '.bin'),
  /** uv tool environments (UV_TOOL_DIR) */
  uvToolDir: () => path.join(homeDir(), 'plugins', 'uv', 'tools'),
  /** uv tool executables (UV_TOOL_BIN_DIR) */
  uvBinDir: () => path.join(homeDir(), 'plugins', 'uv', 'bin'),
  /** uv-managed Python installs (UV_PYTHON_INSTALL_DIR) */
  uvPythonDir: () => path.join(homeDir(), 'plugins', 'uv', 'python'),
  /** uv cache (UV_CACHE_DIR) */
  uvCacheDir: () => path.join(homeDir(), 'plugins', 'uv', 'cache'),
  /** Downloaded single binaries (rtk, uv, ...) */
  binDir: () => path.join(homeDir(), 'bin'),
  /** Plugin process logs (stderr) */
  logDir: () => path.join(homeDir(), 'plugins', 'logs'),
  /** Downloads in progress */
  downloadDir: () => path.join(homeDir(), 'plugins', 'downloads'),
  /** npm cache for plugin installs (keeps npm's cache inside $BRC_HOME too) */
  npmCacheDir: () => path.join(homeDir(), 'plugins', 'npm-cache'),
  /** Browsers downloaded by Playwright (PLAYWRIGHT_BROWSERS_PATH) */
  playwrightBrowsersDir: () => path.join(homeDir(), 'plugins', 'ms-playwright'),
};

/** Executable file name for this platform (adds .exe / .cmd as appropriate). */
export function exeName(base: string, kind: 'native' | 'npm-shim' = 'native'): string {
  if (!isWindows) return base;
  return kind === 'npm-shim' ? `${base}.cmd` : `${base}.exe`;
}

/** Environment for uv so that tools, Pythons and caches stay inside $BRC_HOME. */
export function uvEnv(): Record<string, string> {
  return {
    UV_TOOL_DIR: pluginPaths.uvToolDir(),
    UV_TOOL_BIN_DIR: pluginPaths.uvBinDir(),
    UV_PYTHON_INSTALL_DIR: pluginPaths.uvPythonDir(),
    UV_CACHE_DIR: pluginPaths.uvCacheDir(),
    UV_NO_MODIFY_PATH: '1',
  };
}
