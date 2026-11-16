/**
 * BRC plugins: shared types. This file is the contract between the plugin host, the installer,
 * the built-in tool wrappers (ast-grep, rtk) and the relay/admin integration.
 *
 * State lives in $BRC_HOME/plugins.json (see store.ts). Everything a plugin installs goes under
 * $BRC_HOME (see paths.ts): no Docker, no admin rights, nothing outside the user's home.
 */

/** Where a plugin comes from and how it is launched. */
export type PluginSource =
  /** npm package installed into paths.npmPrefix; launched via node_modules/.bin/<bin>. */
  | { type: 'npm'; package: string; version: string; bin?: string; args?: string[] }
  /** PyPI package installed with `uv tool install` into paths.uvToolDir; launched via paths.uvBinDir/<command>. */
  | { type: 'pypi'; package: string; version: string; command?: string; args?: string[] }
  /** Any local command the owner configured (custom plugin). */
  | { type: 'command'; command: string; args?: string[]; cwd?: string }
  /** Hosted MCP server (Streamable HTTP). Nothing to install. */
  | { type: 'remote'; url: string; headers?: Record<string, string> }
  /**
   * Single native program, not an MCP server (ast-grep, rtk, uv). Used by BRC's own tools.
   * Installed either from npm (npmPackage) or downloaded from a pinned URL with a sha256 check.
   */
  | {
      type: 'binary';
      binName: string;
      version: string;
      npmPackage?: string;
      downloads?: Partial<Record<`${NodeJS.Platform}-${string}`, { url: string; sha256: string; archivePath?: string }>>;
    };

export type PluginStatus =
  | 'pending'      // known, not installed yet
  | 'installing'
  | 'installed'
  | 'failed'       // install failed; error says why; retried on next start
  | 'needs-user'   // waiting for the user (e.g. install Python); userAction says what to do
  | 'unsupported'; // cannot run on this machine (e.g. no display); reason in error

export interface PluginToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface PluginRecord {
  /** Short stable id, e.g. "playwright", "computer-use", "ast-grep". */
  id: string;
  name: string;
  description?: string;
  source: PluginSource;
  /** Whether the AI may use it. Installing and enabling are separate. */
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  /** Human instruction when status is needs-user (shown in CLI, /admin and to the AI). */
  userAction?: string;
  /** Environment variables for the plugin process (may contain secrets; file is 0600). */
  env?: Record<string, string>;
  origin: 'default' | 'user' | 'marketplace';
  /** Registry name when installed from the MCP Registry, e.g. "com.microsoft/playwright-mcp". */
  registryName?: string;
  installedVersion?: string;
  installedAt?: string;
  /** Tool list cached after the first successful start, so listing does not start the server. */
  toolsCache?: PluginToolInfo[];
  toolsCachedAt?: string;
}

export interface PluginsFile {
  version: 1;
  /** Set once the first-run install pass has completed (successfully or not). */
  firstRunAt?: string;
  plugins: Record<string, PluginRecord>;
  /** Python resolution for pypi plugins: which interpreter/uv was found or installed. */
  python?: { kind: 'system' | 'uv-managed'; path?: string; version?: string; checkedAt: string };
}

/** Result of installing one plugin. */
export interface InstallResult {
  status: Extract<PluginStatus, 'installed' | 'failed' | 'needs-user' | 'unsupported'>;
  installedVersion?: string;
  error?: string;
  userAction?: string;
  /**
   * Updated source after install, e.g. the npm package's real bin name or the console script
   * uv installed. The manager stores it so later launches use it.
   */
  source?: PluginSource;
}

export type InstallLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

/** Implemented by the installer module and registered with setPluginInstaller(). */
export type PluginInstaller = (record: PluginRecord, log: InstallLog) => Promise<InstallResult>;
/** Implemented by the installer module: undo an install (delete installed files). */
export type PluginUninstaller = (record: PluginRecord, log: InstallLog) => Promise<void>;
