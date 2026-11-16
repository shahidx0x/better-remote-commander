/**
 * Adapter for the official MCP Registry (https://registry.modelcontextprotocol.io, a preview
 * service). Everything that knows the registry's JSON shape lives here:
 *   - RegistryClient: search / exact lookup with a short timeout and a small TTL cache
 *   - mapServer():    registry server.json -> RegistryEntry (display + how BRC can install it)
 *   - buildDefinition(): RegistryEntry + owner-entered values -> PluginDefinition + env for the agent
 *
 * Config: BRC_MCP_REGISTRY_URL (default https://registry.modelcontextprotocol.io),
 *         BRC_MCP_REGISTRY_FIXTURE=<file.json> serves a local file instead (tests / offline),
 *         BRC_MCP_REGISTRY_TIMEOUT_MS (default 8000).
 * All registry text is untrusted: callers must escape it before rendering.
 */
import { readFileSync } from 'node:fs';
import {
  pluginIdFrom, validatePluginDefinition, validateRemoteUrl, SEMVER_RE, PEP440_RE,
  type PluginDefinition, type PluginSourceSpec,
} from 'brc-shared';

/* ---------- raw registry types (only the fields we read) ---------- */
interface RawInput { name?: string; description?: string; isRequired?: boolean; isSecret?: boolean; default?: string; value?: string; placeholder?: string; format?: string }
interface RawArg extends RawInput { type?: 'positional' | 'named'; valueHint?: string }
interface RawPackage {
  registryType?: string; identifier?: string; version?: string; runtimeHint?: string;
  transport?: { type?: string; url?: string };
  environmentVariables?: RawInput[]; packageArguments?: RawArg[]; runtimeArguments?: RawArg[];
}
interface RawRemote { type?: string; url?: string; headers?: RawInput[]; variables?: Record<string, RawInput> }
export interface RawServer {
  name?: string; title?: string; description?: string; version?: string; websiteUrl?: string;
  repository?: { url?: string; source?: string };
  packages?: RawPackage[]; remotes?: RawRemote[];
}
interface RawResponseItem { server?: RawServer; _meta?: Record<string, unknown> }
interface RawList { servers?: RawResponseItem[]; metadata?: { nextCursor?: string; count?: number } }

/* ---------- mapped types ---------- */
export type InputKind = 'env' | 'header' | 'var' | 'arg';
export interface RegistryInput {
  kind: InputKind;
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  placeholder?: string;
  /** For kind 'arg': named args are passed as [flag, value]; positional as [value]. */
  flag?: string;
}

export interface InstallOption {
  kind: 'npm' | 'pypi' | 'remote';
  label: string;
  /** Source template. Remote url may contain {variables}; filled by buildDefinition(). */
  source: PluginSourceSpec;
  inputs: RegistryInput[];
  fixedEnv: Record<string, string>;
  fixedHeaders: Record<string, string>;
}

export interface RegistryEntry {
  name: string;
  namespace: string;
  title?: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  /** Human labels for every package/remote, e.g. "npm (stdio)", "Docker (oci)". */
  kinds: string[];
  option?: InstallOption;
  /** Why BRC cannot install it (set when option is undefined). */
  unsupported?: string;
  requiredInputs: string[];
  suggestedId: string;
}

export interface SearchResult { entries: RegistryEntry[]; nextCursor?: string }

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const hasPlaceholder = (v: string) => /\{[^}]*\}/.test(v);

function input(kind: InputKind, raw: RawInput, extra: Partial<RegistryInput> = {}): RegistryInput | null {
  const name = str(raw.name, 128);
  if (!name) return null;
  return {
    kind, name,
    description: str(raw.description, 500),
    required: raw.isRequired === true,
    secret: raw.isSecret === true,
    default: str(raw.default, 500),
    placeholder: str(raw.placeholder, 200),
    ...extra,
  };
}

function kindLabel(p: RawPackage): string {
  const rt = String(p.registryType ?? '?');
  const tr = String(p.transport?.type ?? '?');
  return rt === 'oci' ? `Docker (oci, ${tr})` : `${rt} (${tr})`;
}

function mapPackage(p: RawPackage): { option?: InstallOption; why?: string } {
  const rt = p.registryType;
  if (rt === 'oci' || rt === 'docker') return { why: 'not supported (Docker)' };
  if (rt !== 'npm' && rt !== 'pypi') return { why: `not supported (${String(rt ?? 'unknown').slice(0, 20)} package)` };
  if (p.transport?.type !== 'stdio') return { why: `not supported (${rt} package with ${String(p.transport?.type ?? '?').slice(0, 20)} transport)` };
  const pkg = str(p.identifier, 214);
  const version = str(p.version, 64);
  if (!pkg) return { why: 'package identifier missing' };
  if (!version || !(rt === 'npm' ? SEMVER_RE : PEP440_RE).test(version)) return { why: `no exact package version (${version ?? 'none'})` };

  const inputs: RegistryInput[] = [];
  const fixedEnv: Record<string, string> = {};
  for (const e of p.environmentVariables ?? []) {
    const name = str(e.name, 128);
    if (!name) continue;
    if (typeof e.value === 'string' && !hasPlaceholder(e.value)) { fixedEnv[name] = e.value; continue; }
    const i = input('env', e);
    if (i) inputs.push(i);
  }
  const args: string[] = [];
  for (const a of p.packageArguments ?? []) {
    const named = a.type === 'named';
    const flag = named && a.name ? (a.name.startsWith('-') ? a.name : `--${a.name}`) : undefined;
    if (typeof a.value === 'string' && !hasPlaceholder(a.value)) {
      if (flag) args.push(flag);
      args.push(a.value);
      continue;
    }
    if (!a.isRequired) continue; // optional: the server's own default applies
    const i = input('arg', { ...a, name: a.name ?? a.valueHint ?? `arg${args.length + 1}` }, { flag });
    if (i) inputs.push(i);
  }
  const source: PluginSourceSpec = rt === 'npm'
    ? { type: 'npm', package: pkg, version, ...(args.length ? { args } : {}) }
    : { type: 'pypi', package: pkg, version, ...(args.length ? { args } : {}) };
  return { option: { kind: rt, label: `${rt} ${pkg}@${version}`, source, inputs, fixedEnv, fixedHeaders: {} } };
}

function mapRemote(r: RawRemote): { option?: InstallOption; why?: string } {
  if (r.type !== 'streamable-http') return { why: `not supported (${String(r.type ?? '?').slice(0, 20)} remote)` };
  const url = str(r.url, 2048);
  if (!url) return { why: 'remote url missing' };
  let parsed: URL | null = null;
  try { parsed = new URL(url.replace(/\{[^}]*\}/g, 'x')); } catch { /* invalid */ }
  if (!parsed || parsed.protocol !== 'https:') return { why: 'not supported (remote is not https)' };
  const inputs: RegistryInput[] = [];
  for (const [name, v] of Object.entries(r.variables ?? {})) {
    const i = input('var', { ...v, name });
    if (i) inputs.push({ ...i, required: true });
  }
  for (const m of url.matchAll(/\{([^}]+)\}/g)) {
    if (!inputs.some((i) => i.kind === 'var' && i.name === m[1])) inputs.push({ kind: 'var', name: m[1].slice(0, 128), required: true, secret: false });
  }
  const fixedHeaders: Record<string, string> = {};
  for (const h of r.headers ?? []) {
    const name = str(h.name, 128);
    if (!name) continue;
    if (typeof h.value === 'string' && !hasPlaceholder(h.value)) { fixedHeaders[name] = h.value; continue; }
    const i = input('header', h);
    if (i) inputs.push(i);
  }
  return { option: { kind: 'remote', label: `remote ${url.replace(/^https:\/\//, '').slice(0, 80)}`, source: { type: 'remote', url }, inputs, fixedEnv: {}, fixedHeaders } };
}

/** Map one registry server to what BRC shows and can install. Never throws. */
export function mapServer(raw: RawServer): RegistryEntry | null {
  const name = str(raw?.name, 200);
  if (!name) return null;
  const kinds: string[] = [];
  let option: InstallOption | undefined;
  const reasons: string[] = [];
  // Preference: npm stdio, pypi stdio, then streamable-http remotes.
  const pkgs = [...(raw.packages ?? [])].filter((p) => p && typeof p === 'object');
  pkgs.sort((a, b) => (a.registryType === 'npm' ? 0 : a.registryType === 'pypi' ? 1 : 2) - (b.registryType === 'npm' ? 0 : b.registryType === 'pypi' ? 1 : 2));
  for (const p of pkgs) {
    kinds.push(kindLabel(p));
    const m = mapPackage(p);
    if (m.option && !option) option = m.option;
    else if (m.why) reasons.push(m.why);
  }
  for (const r of raw.remotes ?? []) {
    if (!r || typeof r !== 'object') continue;
    kinds.push(`remote (${String(r.type ?? '?').slice(0, 20)})`);
    const m = mapRemote(r);
    if (m.option && !option) option = m.option;
    else if (m.why) reasons.push(m.why);
  }
  if (!kinds.length) reasons.push('no packages or remotes listed');
  return {
    name,
    namespace: name.includes('/') ? name.slice(0, name.indexOf('/')) : name,
    title: str(raw.title, 200),
    description: str(raw.description, 2000) ?? '',
    version: str(raw.version, 64) ?? '?',
    repositoryUrl: str(raw.repository?.url, 500),
    websiteUrl: str(raw.websiteUrl, 500),
    kinds: [...new Set(kinds)],
    option,
    unsupported: option ? undefined : (reasons.find((r) => /Docker/.test(r)) ?? reasons[0] ?? 'not supported'),
    requiredInputs: option ? option.inputs.filter((i) => i.required).map((i) => i.name) : [],
    suggestedId: pluginIdFrom(name),
  };
}

export interface InstallValues {
  pluginId?: string;
  name?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  vars?: Record<string, string>;
  args?: Record<string, string>;
}

/**
 * Build the definition the agent receives. Secret values (env/headers) end up only in the returned
 * objects, which the caller sends straight to the agent. Throws with a user-facing message.
 */
export function buildDefinition(entry: RegistryEntry, values: InstallValues): { definition: PluginDefinition; env: Record<string, string> } {
  const opt = entry.option;
  if (!opt) throw new Error(`${entry.name} cannot be installed: ${entry.unsupported ?? 'not supported'}`);
  const pick = (kind: InputKind) => (kind === 'env' ? values.env : kind === 'header' ? values.headers : kind === 'var' ? values.vars : values.args) ?? {};
  const val = (i: RegistryInput) => {
    const v = pick(i.kind)[i.name];
    return typeof v === 'string' && v !== '' ? v : i.default;
  };
  const missing = opt.inputs.filter((i) => i.required && !val(i));
  if (missing.length) throw new Error(`missing required value(s): ${missing.map((i) => i.name).join(', ')}`);

  const env: Record<string, string> = { ...opt.fixedEnv };
  for (const i of opt.inputs.filter((x) => x.kind === 'env')) { const v = val(i); if (v) env[i.name] = v; }

  let source: PluginSourceSpec;
  if (opt.source.type === 'remote') {
    let url = opt.source.url;
    for (const i of opt.inputs.filter((x) => x.kind === 'var')) url = url.split(`{${i.name}}`).join(encodeURIComponent(val(i) ?? ''));
    const urlErr = validateRemoteUrl(url);
    if (urlErr) throw new Error(urlErr);
    const headers: Record<string, string> = { ...opt.fixedHeaders };
    for (const i of opt.inputs.filter((x) => x.kind === 'header')) { const v = val(i); if (v) headers[i.name] = v; }
    source = { type: 'remote', url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const args = [...(opt.source.args ?? [])];
    for (const i of opt.inputs.filter((x) => x.kind === 'arg')) {
      const v = val(i);
      if (!v) continue;
      if (i.flag) args.push(i.flag);
      args.push(v);
    }
    source = { ...opt.source, ...(args.length ? { args } : {}) } as PluginSourceSpec;
  }
  const definition: PluginDefinition = {
    id: values.pluginId || entry.suggestedId,
    name: (values.name || entry.title || entry.name).slice(0, 120),
    description: entry.description.slice(0, 2000) || undefined,
    source,
    registryName: entry.name,
    origin: 'marketplace',
    enabled: true,
  };
  const err = validatePluginDefinition(definition);
  if (err) throw new Error(err);
  return { definition, env };
}

/* ---------- client ---------- */
export interface RegistryClientOptions {
  baseUrl?: string;
  fixtureFile?: string;
  timeoutMs?: number;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}

export class RegistryError extends Error {}

export class RegistryClient {
  private readonly baseUrl: string;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RegistryClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://registry.modelcontextprotocol.io').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RegistryClient {
    return new RegistryClient({
      baseUrl: env.BRC_MCP_REGISTRY_URL || undefined,
      fixtureFile: env.BRC_MCP_REGISTRY_FIXTURE || undefined,
      timeoutMs: Number(env.BRC_MCP_REGISTRY_TIMEOUT_MS) || undefined,
    });
  }

  get source(): string { return this.opts.fixtureFile ? `fixture ${this.opts.fixtureFile}` : this.baseUrl; }

  private fixture(): RawResponseItem[] {
    try {
      const data = JSON.parse(readFileSync(this.opts.fixtureFile!, 'utf8')) as RawList;
      return Array.isArray(data.servers) ? data.servers : [];
    } catch (e) {
      throw new RegistryError(`registry fixture unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'brc-relay' }, redirect: 'error' });
    } catch (e) {
      throw new RegistryError(ctl.signal.aborted ? `MCP Registry did not answer within ${this.timeoutMs} ms` : `MCP Registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) { this.put(path, null); return null; }
    if (!res.ok) throw new RegistryError(`MCP Registry returned HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new RegistryError('MCP Registry response too large');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new RegistryError('MCP Registry returned invalid JSON'); }
    this.put(path, value);
    return value;
  }

  private put(path: string, value: unknown): void {
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(path, { at: Date.now(), value });
  }

  /** Search by name substring (registry semantics). limit 1..50. */
  async search(query: string, limit = 20, cursor?: string): Promise<SearchResult> {
    const q = String(query ?? '').trim().slice(0, 100);
    const n = Math.min(50, Math.max(1, Math.floor(limit) || 20));
    if (this.opts.fixtureFile) {
      const all = this.fixture().map((i) => i.server).filter((s): s is RawServer => !!s);
      const ql = q.toLowerCase();
      const hits = all.filter((s) => !ql || `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''}`.toLowerCase().includes(ql));
      const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
      const page = hits.slice(start, start + n);
      return { entries: page.map(mapServer).filter((e): e is RegistryEntry => !!e), nextCursor: start + n < hits.length ? String(start + n) : undefined };
    }
    const params = new URLSearchParams({ limit: String(n), version: 'latest' });
    if (q) params.set('search', q);
    if (cursor) params.set('cursor', cursor.slice(0, 300));
    const data = (await this.getJson(`/v0/servers?${params}`)) as RawList | null;
    const items = Array.isArray(data?.servers) ? data!.servers : [];
    return {
      entries: items.map((i) => (i?.server ? mapServer(i.server) : null)).filter((e): e is RegistryEntry => !!e),
      nextCursor: typeof data?.metadata?.nextCursor === 'string' ? data.metadata.nextCursor.slice(0, 300) : undefined,
    };
  }

  /** Exact lookup of the latest version of one server; null when unknown. */
  async get(name: string): Promise<RegistryEntry | null> {
    const n = String(name ?? '').trim();
    if (!n || n.length > 200 || /[\0\r\n]/.test(n)) return null;
    if (this.opts.fixtureFile) {
      const s = this.fixture().map((i) => i.server).find((x) => x?.name === n);
      return s ? mapServer(s) : null;
    }
    const data = (await this.getJson(`/v0/servers/${encodeURIComponent(n)}/versions/latest`)) as RawResponseItem | null;
    return data?.server && data.server.name === n ? mapServer(data.server) : null;
  }
}
