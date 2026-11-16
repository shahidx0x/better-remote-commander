/**
 * BRC default plugins, with exact pinned versions (looked up 2026-11-16):
 *
 *   playwright    npm @playwright/mcp 0.0.85 (Apache-2.0)            browser automation, all platforms
 *   computer-use  npm computer-use-mcp 1.8.0 (MIT, nut.js fork)      screen/mouse/keyboard; disabled on macOS,
 *                                                                    unsupported on Linux without a display
 *   ast-grep      binary via npm @ast-grep/cli 0.51.2 (MIT)          used by BRC's ast-grep tool
 *   rtk           binary rtk 1.2.0 from github.com/rtk-ai/rtk        used by BRC's rtk tool (MIT/Apache CLI;
 *                                                                    the bundled engine is BSL-1.1 with a free
 *                                                                    production-use grant)
 *   serena        pypi serena-agent 2.1.0 (oraios, GPL-3.0+)         symbol-level code navigation/editing
 *   markitdown    pypi markitdown-mcp 0.0.1a8 (Microsoft, MIT)       Office/PDF/HTML -> Markdown
 *
 * Playwright browser: an installed Google Chrome (--browser chrome) or else Microsoft Edge
 * (--browser msedge), so nothing is downloaded at install time. With neither, it uses Playwright's
 * Chromium, which the AI can fetch on first use with the plugin's browser_install tool; it lands
 * in $BRC_HOME/plugins/ms-playwright (PLAYWRIGHT_BROWSERS_PATH). The browser profile is kept in
 * $BRC_HOME/plugins/playwright-profile, output files in $BRC_HOME/plugins/playwright-output.
 *
 * Serena keeps its own config, logs and memories in ~/.serena (it has no home-dir override for
 * that), the one place a default plugin writes outside $BRC_HOME.
 *
 * rtk sha256 values are the GitHub release asset digests, cross-checked against the release's
 * checksums.txt and re-hashed after downloading.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginPaths } from './paths.js';
import type { PluginRecord, PluginSource, PluginStatus } from './types.js';

export type DefaultPluginDef = Omit<PluginRecord, 'status'> & { status?: PluginStatus };

export interface DefaultsContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Installed browser Playwright should drive (null: Playwright's own Chromium). */
  browser: 'chrome' | 'msedge' | null;
}

export const DEFAULT_PLUGIN_IDS = ['playwright', 'computer-use', 'ast-grep', 'rtk', 'serena', 'markitdown'] as const;

export const PINNED = {
  playwright: { package: '@playwright/mcp', version: '0.0.85', bin: 'playwright-mcp' },
  computerUse: { package: 'computer-use-mcp', version: '1.8.0', bin: 'computer-use-mcp' },
  astGrep: { package: '@ast-grep/cli', version: '0.51.2', bin: 'ast-grep' },
  serena: { package: 'serena-agent', version: '2.1.0', command: 'serena' },
  markitdown: { package: 'markitdown-mcp', version: '0.0.1a8', command: 'markitdown-mcp' },
  rtk: { version: '1.2.0' },
};

const RTK_ASSETS: Record<string, string> = {
  'win32-x64': 'rtk-x86_64-pc-windows-msvc.zip',
  'darwin-x64': 'rtk-x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'rtk-aarch64-apple-darwin.tar.gz',
  'linux-x64': 'rtk-x86_64-unknown-linux-musl.tar.gz', // static musl build (the only x64 Linux build)
  'linux-arm64': 'rtk-aarch64-unknown-linux-musl.tar.gz',
};
const RTK_SHA256: Record<string, string> = {
  'win32-x64': 'b291b4e53d37f84b7f1696bc20559207396fb0190f20ed3c949db1b7e1c0c378',
  'darwin-x64': '1484ae6fffd0da180d65434eeca32e014a86a6e21dcfc7a0004fe82b7bb0a9b9',
  'darwin-arm64': 'a2c411ffa49a8595b408c151ea47c9a812268924a76eaeecbc3a5065b02207ff',
  'linux-x64': '70fee7b4a548c43dde94c77e2335550981b0bc2fb013691d8c8109b5bd0eda37',
  'linux-arm64': 'f91a06e94e5fad7dfa87946c811a4bcbc500e6da119fd47033f2a8940bf64f93',
};

type Downloads = Extract<PluginSource, { type: 'binary' }>['downloads'];

function rtkDownloads(version: string, sha: Record<string, string>): Downloads {
  const out: Record<string, { url: string; sha256: string }> = {};
  for (const [key, asset] of Object.entries(RTK_ASSETS)) {
    if (!sha[key]) continue;
    out[key] = { url: `https://github.com/rtk-ai/rtk/releases/download/v${version}/${asset}`, sha256: sha[key] };
  }
  return out as Downloads;
}

/** Google Chrome or Microsoft Edge at their standard install locations (fs checks only). */
export function detectBrowser(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): 'chrome' | 'msedge' | null {
  const exists = (p: string | undefined) => !!p && fs.existsSync(p);
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean) as string[];
    if (roots.some((r) => exists(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')))) return 'chrome';
    if (roots.some((r) => exists(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))) return 'msedge';
    return null;
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', path.join(os.homedir(), 'Applications')];
    if (apps.some((a) => exists(path.join(a, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')))) return 'chrome';
    if (apps.some((a) => exists(path.join(a, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')))) return 'msedge';
    return null;
  }
  if (['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].some(exists)) return 'chrome';
  if (['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'].some(exists)) return 'msedge';
  return null;
}

export function hasDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== 'linux') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function currentDefaultsContext(): DefaultsContext {
  return { platform: process.platform, env: process.env, browser: detectBrowser() };
}

export interface PinnedVersions {
  playwright: string;
  computerUse: string;
  astGrep: string;
  serena: string;
  markitdown: string;
  rtk: { version: string; sha256: Record<string, string> };
}

export function pinnedVersions(): PinnedVersions {
  return {
    playwright: PINNED.playwright.version,
    computerUse: PINNED.computerUse.version,
    astGrep: PINNED.astGrep.version,
    serena: PINNED.serena.version,
    markitdown: PINNED.markitdown.version,
    rtk: { version: PINNED.rtk.version, sha256: RTK_SHA256 },
  };
}

/** The default plugin definitions for this machine (platform rules applied). */
export function defaultPluginDefs(ctx: DefaultsContext = currentDefaultsContext(), v: PinnedVersions = pinnedVersions()): DefaultPluginDef[] {
  const display = hasDisplay(ctx.platform, ctx.env);
  const pwArgs = [
    '--browser', ctx.browser ?? 'chromium',
    '--user-data-dir', path.join(pluginPaths.root(), 'playwright-profile'),
    // Snapshots/screenshots would otherwise go to <cwd>/.playwright-mcp (System32 for a service).
    '--output-dir', path.join(pluginPaths.root(), 'playwright-output'),
  ];
  if (!display) pwArgs.push('--headless');
  const computerUse: DefaultPluginDef = {
    id: 'computer-use',
    name: 'Computer use',
    description: 'See the screen and control mouse and keyboard (screenshots, clicks, typing).',
    source: { type: 'npm', package: PINNED.computerUse.package, version: v.computerUse, bin: PINNED.computerUse.bin },
    enabled: ctx.platform !== 'darwin', // macOS needs Screen Recording + Accessibility permission first
    origin: 'default',
  };
  if (!display) {
    computerUse.status = 'unsupported';
    computerUse.error = 'no graphical display on this machine (DISPLAY / WAYLAND_DISPLAY not set)';
  }
  return [
    {
      id: 'playwright',
      name: 'Playwright browser',
      description: 'Drive a web browser: open pages, click, type, read page snapshots, screenshots.',
      source: { type: 'npm', package: PINNED.playwright.package, version: v.playwright, bin: PINNED.playwright.bin, args: pwArgs },
      enabled: true,
      origin: 'default',
      env: { PLAYWRIGHT_BROWSERS_PATH: pluginPaths.playwrightBrowsersDir() },
    },
    computerUse,
    {
      id: 'ast-grep',
      name: 'ast-grep',
      description: 'Structural code search and rewrite (used by BRC\'s ast-grep tool).',
      source: { type: 'binary', binName: 'ast-grep', version: v.astGrep, npmPackage: PINNED.astGrep.package },
      enabled: true,
      origin: 'default',
    },
    {
      id: 'rtk',
      name: 'rtk',
      description: 'Token-saving command output filter (used by BRC\'s rtk tool).',
      source: { type: 'binary', binName: 'rtk', version: v.rtk.version, downloads: rtkDownloads(v.rtk.version, v.rtk.sha256) },
      enabled: true,
      origin: 'default',
    },
    {
      id: 'serena',
      name: 'Serena',
      description: 'Semantic code navigation and editing via language servers (find symbols, references, rename).',
      source: {
        type: 'pypi', package: PINNED.serena.package, version: v.serena, command: PINNED.serena.command,
        // --agent-interface tools: one MCP tool per operation (30 tools) instead of the default
        // Python-REPL interface (3 tools); no dashboard browser tab / GUI log window on the device.
        args: ['start-mcp-server', '--transport', 'stdio', '--context', 'desktop-app', '--agent-interface', 'tools', '--open-web-dashboard', 'false', '--enable-gui-log-window', 'false'],
      },
      enabled: true,
      origin: 'default',
    },
    {
      id: 'markitdown',
      name: 'MarkItDown',
      description: 'Convert files and URLs (PDF, Word, Excel, PowerPoint, HTML, images...) to Markdown.',
      source: { type: 'pypi', package: PINNED.markitdown.package, version: v.markitdown, command: PINNED.markitdown.command },
      enabled: true,
      origin: 'default',
    },
  ];
}

export function defaultPluginDef(id: string, ctx?: DefaultsContext, v?: PinnedVersions): DefaultPluginDef | undefined {
  return defaultPluginDefs(ctx, v).find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// --update-plugins: latest versions (network)
// ---------------------------------------------------------------------------
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'brc-agent' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

const npmLatest = async (pkg: string) => String((await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`)).version);
const pypiLatest = async (pkg: string) => String((await getJson(`https://pypi.org/pypi/${pkg}/json`)).info.version);

async function rtkChecksums(version: string): Promise<Record<string, string>> {
  const sums: Record<string, string> = {};
  const res = await fetch(`https://github.com/rtk-ai/rtk/releases/download/v${version}/checksums.txt`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return sums;
  for (const line of (await res.text()).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) sums[m[2]] = m[1];
  }
  return sums;
}

/**
 * Latest rtk release with sha256 for each platform asset: the GitHub API asset digest,
 * cross-checked with the release's checksums.txt. Without API access (rate limit) the
 * release is found via the /releases/latest redirect and checksums.txt alone is used.
 */
async function rtkLatest(): Promise<PinnedVersions['rtk']> {
  let version: string;
  let digests: Record<string, string> = {};
  try {
    const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const res = await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest', { headers: { accept: 'application/json', 'user-agent': 'brc-agent', ...headers }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = (await res.json()) as { tag_name: string; assets: Array<{ name: string; digest?: string }> };
    version = String(rel.tag_name).replace(/^v/, '');
    for (const a of rel.assets) if (a.digest?.startsWith('sha256:')) digests[a.name] = a.digest.slice(7);
  } catch {
    const res = await fetch('https://github.com/rtk-ai/rtk/releases/latest', { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const tag = /\/tag\/v?([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1];
    if (!tag) throw new Error('cannot determine the latest rtk release');
    version = tag;
    digests = {};
  }
  const sums = await rtkChecksums(version);
  const sha256: Record<string, string> = {};
  for (const [key, name] of Object.entries(RTK_ASSETS)) {
    const digest = digests[name];
    const listed = sums[name];
    if (digest && listed && digest !== listed) throw new Error(`rtk ${version}: checksum mismatch for ${name} (digest ${digest}, checksums.txt ${listed})`);
    const sha = digest ?? listed;
    if (sha) sha256[key] = sha;
  }
  if (!Object.keys(sha256).length) throw new Error(`rtk ${version}: no verifiable assets`);
  return { version, sha256 };
}

/** Re-resolve the latest version of every default plugin. */
export async function resolveLatestVersions(): Promise<PinnedVersions> {
  const [playwright, computerUse, astGrep, serena, markitdown, rtk] = await Promise.all([
    npmLatest(PINNED.playwright.package),
    npmLatest(PINNED.computerUse.package),
    npmLatest(PINNED.astGrep.package),
    pypiLatest(PINNED.serena.package),
    pypiLatest(PINNED.markitdown.package),
    rtkLatest(),
  ]);
  return { playwright, computerUse, astGrep, serena, markitdown, rtk };
}
