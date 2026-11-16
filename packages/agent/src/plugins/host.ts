/**
 * BRC plugin host: runs installed MCP servers on this device and calls their tools.
 *
 * - Lazy: a plugin process starts the first time one of its tools is listed or called,
 *   then stays running for later calls (agent start-up cost is unchanged).
 * - Self-healing: if the process exits or the connection breaks, the next call reconnects.
 * - Idle plugins are stopped after BRC_PLUGIN_IDLE_MS (default 30 min) to free memory.
 * - Tool lists are cached in plugins.json after the first start.
 */
import fs from 'node:fs';
import path from 'node:path';
// The MCP client SDK costs ~140 ms to load, so it is imported on first plugin use, not at agent start.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
const loadSdk = async () => {
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  return { Client, StdioClientTransport, StreamableHTTPClientTransport };
};
import { exeName, pluginPaths, uvEnv } from './paths.js';
import { getPlugin, patchPlugin } from './store.js';
import type { PluginRecord, PluginToolInfo } from './types.js';

const START_TIMEOUT_MS = Number(process.env.BRC_PLUGIN_START_TIMEOUT_MS) || 60_000;
const IDLE_MS = Number(process.env.BRC_PLUGIN_IDLE_MS) || 30 * 60_000;
const CALL_TIMEOUT_MS = 105_000; // below the relay's 120 s per-call timeout

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** How to start a plugin's MCP server. Throws if the source is not launchable as MCP. */
export function resolveLaunch(rec: PluginRecord): LaunchSpec {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, rec.env ?? {});
  const s = rec.source;
  switch (s.type) {
    case 'npm': {
      const bin = s.bin ?? s.package.replace(/^@[^/]+\//, '');
      const shim = path.join(pluginPaths.npmBinDir(), exeName(bin, 'npm-shim'));
      return { command: shim, args: s.args ?? [], env };
    }
    case 'pypi': {
      const cmd = s.command ?? s.package;
      const exe = path.join(pluginPaths.uvBinDir(), exeName(cmd));
      return { command: exe, args: s.args ?? [], env: { ...env, ...uvEnv() } };
    }
    case 'command':
      return { command: s.command, args: s.args ?? [], env, cwd: s.cwd };
    default:
      throw new Error(`plugin "${rec.id}" (${s.type}) is not a local MCP server`);
  }
}

interface Running {
  client: Client;
  transport: Transport;
  tools?: PluginToolInfo[];
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
}

const running = new Map<string, Running>();
const starting = new Map<string, Promise<Running>>();

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); }),
  ]);
}

function armIdle(id: string, r: Running): void {
  if (r.idleTimer) clearTimeout(r.idleTimer);
  r.idleTimer = setTimeout(() => { void stopPlugin(id); }, IDLE_MS);
  r.idleTimer.unref?.();
}

async function start(rec: PluginRecord): Promise<Running> {
  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await loadSdk();
  let transport: Transport;
  if (rec.source.type === 'remote') {
    transport = new StreamableHTTPClientTransport(new URL(rec.source.url), {
      requestInit: rec.source.headers ? { headers: rec.source.headers } : undefined,
    });
  } else {
    const spec = resolveLaunch(rec);
    if (!path.isAbsolute(spec.command) || fs.existsSync(spec.command)) {
      // ok: absolute path that exists, or a bare command resolved from PATH by the OS
    } else {
      throw new Error(`plugin "${rec.id}" is not installed (missing ${spec.command})`);
    }
    fs.mkdirSync(pluginPaths.logDir(), { recursive: true });
    const stdio = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd, stderr: 'pipe' });
    // Keep the plugin's stderr in a log file (useful for "why did it fail").
    const logStream = fs.createWriteStream(path.join(pluginPaths.logDir(), `${rec.id}.log`), { flags: 'a' });
    stdio.stderr?.pipe(logStream);
    transport = stdio;
  }
  const client = new Client({ name: 'brc-agent', version: '2' }, { capabilities: {} });
  const r: Running = { client, transport, lastUsed: Date.now(), closed: false };
  transport.onclose = () => { r.closed = true; if (running.get(rec.id) === r) running.delete(rec.id); };
  try {
    await withTimeout(client.connect(transport), START_TIMEOUT_MS, `starting plugin "${rec.id}"`);
  } catch (e) {
    try { await client.close(); } catch { /* ignore */ }
    throw e;
  }
  return r;
}

async function ensureRunning(id: string): Promise<Running> {
  const live = running.get(id);
  if (live && !live.closed) return live;
  const pending = starting.get(id);
  if (pending) return pending;
  const rec = getPlugin(id);
  if (!rec) throw new Error(`unknown plugin "${id}"`);
  if (!rec.enabled) throw new Error(`plugin "${id}" is disabled`);
  if (rec.status !== 'installed') {
    throw new Error(`plugin "${id}" is not ready (status: ${rec.status}${rec.error ? `: ${rec.error}` : ''}${rec.userAction ? `; to fix: ${rec.userAction}` : ''})`);
  }
  if (rec.source.type === 'binary') throw new Error(`plugin "${id}" is a program used by BRC tools, not an MCP server`);
  const p = start(rec).then((r) => { running.set(id, r); armIdle(id, r); return r; }).finally(() => starting.delete(id));
  starting.set(id, p);
  return p;
}

/** Tools offered by a plugin. Uses the cache unless refresh=true (or nothing is cached). */
export async function getPluginTools(id: string, refresh = false): Promise<PluginToolInfo[]> {
  const rec = getPlugin(id);
  if (!refresh && rec?.toolsCache?.length) return rec.toolsCache;
  const r = await ensureRunning(id);
  const res = await withTimeout(r.client.listTools(), START_TIMEOUT_MS, `listing tools of "${id}"`);
  const tools = res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  r.tools = tools;
  r.lastUsed = Date.now();
  armIdle(id, r);
  await patchPlugin(id, { toolsCache: tools, toolsCachedAt: new Date().toISOString() });
  return tools;
}

export interface PluginCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

/** Call one tool of a plugin. Reconnects once if the plugin process had died. */
export async function callPluginTool(id: string, tool: string, args: Record<string, unknown>): Promise<PluginCallResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ensureRunning(id);
    try {
      r.lastUsed = Date.now();
      armIdle(id, r);
      const res = await r.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      return { content: (res.content as Array<Record<string, unknown>>) ?? [], isError: !!res.isError };
    } catch (e) {
      if (r.closed && attempt === 0) continue; // process died mid-call: restart once
      throw e;
    }
  }
  throw new Error(`plugin "${id}" could not be reached`);
}

export async function stopPlugin(id: string): Promise<void> {
  const r = running.get(id);
  running.delete(id);
  if (!r) return;
  if (r.idleTimer) clearTimeout(r.idleTimer);
  try { await r.client.close(); } catch { /* ignore */ }
}

export async function stopAllPlugins(): Promise<void> {
  await Promise.all([...running.keys()].map((id) => stopPlugin(id)));
}

export function runningPluginIds(): string[] {
  return [...running.keys()];
}
