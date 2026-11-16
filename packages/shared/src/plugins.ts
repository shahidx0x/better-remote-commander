/**
 * Plugin types and validation shared by the agent (which executes plugin_admin requests) and the
 * relay (which builds them from /admin forms and the MCP Registry). Both sides validate.
 */

export type PluginAdminAction = 'install' | 'enable' | 'disable' | 'remove' | 'set_env' | 'refresh';
export const PLUGIN_ADMIN_ACTIONS: readonly PluginAdminAction[] = ['install', 'enable', 'disable', 'remove', 'set_env', 'refresh'];

/** Plugin sources the relay may ask an agent to install (`binary` is agent-internal only). */
export type PluginSourceSpec =
  | { type: 'npm'; package: string; version: string; bin?: string; args?: string[] }
  | { type: 'pypi'; package: string; version: string; command?: string; args?: string[] }
  | { type: 'command'; command: string; args?: string[]; cwd?: string }
  | { type: 'remote'; url: string; headers?: Record<string, string> };

/** Full plugin definition sent with `plugin_admin` action `install`. */
export interface PluginDefinition {
  id: string;
  name: string;
  description?: string;
  source: PluginSourceSpec;
  /** Registry name when the definition came from the MCP Registry. */
  registryName?: string;
  origin?: 'user' | 'marketplace';
  /** Defaults to true. */
  enabled?: boolean;
}

/** Public, secret-free plugin status (agent's pluginSummary()). Env values are never included. */
export interface PluginStatusSummary {
  id: string;
  name: string;
  description?: string;
  type: string;
  package?: string;
  enabled: boolean;
  status: string;
  error?: string;
  userAction?: string;
  origin?: string;
  registryName?: string;
  installedVersion?: string;
  envKeys: string[];
  toolCount?: number;
}

export const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Exact semver (no ranges, no tags such as "latest"). */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** PEP 508 project name. */
export const PYPI_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Exact PEP 440 release (epoch, pre/post/dev and local parts allowed; no specifiers). */
export const PEP440_RE = /^(?:\d+!)?\d+(?:\.\d+)*(?:[-_.]?(?:a|b|rc|alpha|beta|c|pre|preview)\d*)?(?:[-_.]?(?:post|rev|r)\d*)?(?:[-_.]?dev\d*)?(?:\+[A-Za-z0-9.]+)?$/i;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const EXE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isStr = (v: unknown): v is string => typeof v === 'string';
const hasCtl = (s: string) => /[\0\r\n]/.test(s);

function checkArgs(args: unknown): string | null {
  if (args === undefined) return null;
  if (!Array.isArray(args) || args.length > 64) return 'args must be an array of at most 64 strings';
  for (const a of args) if (!isStr(a) || a.length > 4096 || a.includes('\0')) return 'invalid argument';
  return null;
}

/** Validate an env map (keys and values). Returns an error message or null. */
export function validateEnv(env: unknown, what = 'env'): string | null {
  if (env === undefined) return null;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return `${what} must be an object`;
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > 100) return `${what}: too many variables`;
  for (const [k, v] of entries) {
    if (!ENV_NAME_RE.test(k)) return `${what}: invalid variable name "${k.slice(0, 40)}"`;
    if (!isStr(v) || v.length > 32_768 || v.includes('\0')) return `${what}: invalid value for ${k}`;
  }
  return null;
}

/** Remote MCP URL check: https only, no credentials in the URL. */
export function validateRemoteUrl(url: unknown): string | null {
  if (!isStr(url) || url.length > 2048) return 'remote url must be a string';
  let u: URL;
  try { u = new URL(url); } catch { return 'remote url is not a valid URL'; }
  if (u.protocol !== 'https:') return 'remote url must use https';
  if (u.username || u.password) return 'remote url must not contain credentials';
  if (/[{}]/.test(url)) return 'remote url still contains {placeholders}';
  return null;
}

export function validateSource(src: unknown): string | null {
  if (!src || typeof src !== 'object') return 'source is required';
  const s = src as Record<string, unknown>;
  switch (s.type) {
    case 'npm':
      if (!isStr(s.package) || s.package.length > 214 || !NPM_NAME_RE.test(s.package)) return 'invalid npm package name';
      if (!isStr(s.version) || !SEMVER_RE.test(s.version)) return 'npm version must be an exact version such as 1.2.3';
      if (s.bin !== undefined && (!isStr(s.bin) || !EXE_NAME_RE.test(s.bin))) return 'invalid npm bin name';
      return checkArgs(s.args);
    case 'pypi':
      if (!isStr(s.package) || s.package.length > 200 || !PYPI_NAME_RE.test(s.package)) return 'invalid PyPI package name';
      if (!isStr(s.version) || s.version.length > 64 || !PEP440_RE.test(s.version)) return 'PyPI version must be an exact version such as 1.2.3';
      if (s.command !== undefined && (!isStr(s.command) || !EXE_NAME_RE.test(s.command))) return 'invalid PyPI command name';
      return checkArgs(s.args);
    case 'command':
      if (!isStr(s.command) || !s.command.trim() || s.command.length > 4096 || hasCtl(s.command)) return 'invalid command';
      if (s.cwd !== undefined && (!isStr(s.cwd) || s.cwd.length > 4096 || hasCtl(s.cwd))) return 'invalid cwd';
      return checkArgs(s.args);
    case 'remote': {
      const e = validateRemoteUrl(s.url);
      if (e) return e;
      if (s.headers === undefined) return null;
      if (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers)) return 'headers must be an object';
      const hs = Object.entries(s.headers as Record<string, unknown>);
      if (hs.length > 32) return 'too many headers';
      for (const [k, v] of hs) {
        if (!HEADER_NAME_RE.test(k)) return `invalid header name "${k.slice(0, 40)}"`;
        if (!isStr(v) || v.length > 8192 || hasCtl(v)) return `invalid value for header ${k}`;
      }
      return null;
    }
    default:
      return 'source.type must be npm, pypi, command or remote';
  }
}

/** Validate a full plugin definition. Returns an error message or null when valid. */
export function validatePluginDefinition(def: unknown): string | null {
  if (!def || typeof def !== 'object') return 'plugin definition is required';
  const d = def as Record<string, unknown>;
  if (!isStr(d.id) || !PLUGIN_ID_RE.test(d.id)) return 'plugin id must be 1-64 chars of a-z, 0-9 and "-"';
  if (!isStr(d.name) || !d.name.trim() || d.name.length > 120 || hasCtl(d.name)) return 'plugin name must be 1-120 characters';
  if (d.description !== undefined && (!isStr(d.description) || d.description.length > 2000)) return 'description too long';
  if (d.registryName !== undefined && (!isStr(d.registryName) || d.registryName.length > 200 || hasCtl(d.registryName))) return 'invalid registryName';
  if (d.origin !== undefined && d.origin !== 'user' && d.origin !== 'marketplace') return 'invalid origin';
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') return 'enabled must be boolean';
  return validateSource(d.source);
}

/** Make a valid plugin id from any name ("io.github.x/Foo_Bar MCP" -> "foo-bar-mcp"). */
export function pluginIdFrom(name: string): string {
  const last = name.split('/').pop() ?? name;
  const id = last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return id || 'plugin';
}

/**
 * Split a command line into argv, honouring "double" and 'single' quotes (no escapes inside single
 * quotes; backslash only escapes a quote inside double quotes so Windows paths survive).
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inTok = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === '\\' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inTok = true; continue; }
    if (/\s/.test(c)) { if (inTok) { out.push(cur); cur = ''; inTok = false; } continue; }
    cur += c; inTok = true;
  }
  if (quote) throw new Error('unterminated quote in command line');
  if (inTok) out.push(cur);
  return out;
}

export type CustomSpecType = 'npm' | 'pypi' | 'command' | 'remote';

/**
 * Parse an owner/AI "custom" plugin spec:
 *   npm      "pkg@1.2.3" or "@scope/pkg@1.2.3"
 *   pypi     "pkg==1.2.3"
 *   command  a command line, e.g. "node C:\\tools\\server.mjs --flag"
 *   remote   "https://host/mcp"
 */
export function parseCustomSpec(type: string, spec: string): PluginSourceSpec {
  const v = String(spec ?? '').trim();
  if (!v) throw new Error('spec is empty');
  if (v.length > 4096) throw new Error('spec too long');
  let src: PluginSourceSpec;
  switch (type) {
    case 'npm': {
      const m = v.match(/^((?:@[^@/\s]+\/)?[^@\s]+)@([^@\s]+)$/);
      if (!m) throw new Error('npm spec must look like package@1.2.3');
      src = { type: 'npm', package: m[1], version: m[2] };
      break;
    }
    case 'pypi': {
      const m = v.match(/^([^=\s]+)==([^=\s]+)$/);
      if (!m) throw new Error('PyPI spec must look like package==1.2.3');
      src = { type: 'pypi', package: m[1], version: m[2] };
      break;
    }
    case 'command': {
      const argv = splitCommandLine(v);
      if (!argv.length) throw new Error('command line is empty');
      src = { type: 'command', command: argv[0], args: argv.slice(1) };
      break;
    }
    case 'remote':
      src = { type: 'remote', url: v };
      break;
    default:
      throw new Error('type must be npm, pypi, command or remote');
  }
  const err = validateSource(src);
  if (err) throw new Error(err);
  return src;
}

/** Suggested plugin id for a custom source. */
export function pluginIdForSource(src: PluginSourceSpec): string {
  switch (src.type) {
    case 'npm': case 'pypi': return pluginIdFrom(src.package);
    case 'remote': { try { return pluginIdFrom(new URL(src.url).hostname.split('.').slice(0, -1).join('-') || 'remote'); } catch { return 'remote'; } }
    case 'command': return pluginIdFrom((src.args?.find((a) => !a.startsWith('-')) ?? src.command).split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, ''));
  }
}

/** Defensive copy of an agent-reported summary (the relay must not trust field types/sizes). */
export function sanitizePluginSummary(p: unknown): PluginStatusSummary | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const s = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const id = s(o.id, 64);
  if (!id) return null;
  return {
    id,
    name: s(o.name, 120) ?? id,
    description: s(o.description, 1000),
    type: s(o.type, 20) ?? '?',
    package: s(o.package, 300),
    enabled: o.enabled === true,
    status: s(o.status, 20) ?? '?',
    error: s(o.error, 1000),
    userAction: s(o.userAction, 1000),
    origin: s(o.origin, 20),
    registryName: s(o.registryName, 200),
    installedVersion: s(o.installedVersion, 64),
    envKeys: Array.isArray(o.envKeys) ? o.envKeys.filter((k): k is string => typeof k === 'string').slice(0, 100).map((k) => k.slice(0, 128)) : [],
    toolCount: typeof o.toolCount === 'number' && Number.isFinite(o.toolCount) ? o.toolCount : undefined,
  };
}
