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
import { pluginEnvironment } from './plugin-environment.js';
import { cappedPluginStderr } from './capped-stderr.js';
import {attachManagedStdio,type StdioOwnership} from './managed-stdio.js';
import {managedLaunchSpec} from '../runtime/managed-spawn.js';
import {pluginStartupAdmission} from '../runtime/resource-admission.js';
import {getCallContext,checkCancelled} from '../context.js';
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
  // Never inherit the agent's relay credentials or unrelated API keys.
  const env=pluginEnvironment(process.env,rec.env ?? {});
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
  managedStdio?:StdioOwnership;
}

const running = new Map<string, Running>();
const starting = new Map<string, Promise<Running>>();
const startingCancels=new Map<string,AbortController>();

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); }),
  ]);
}

function withStartAbort<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(signal.reason??new Error('PLUGIN_START_CANCELLED'));
  return new Promise<T>((resolve,reject)=>{
    const cleanup=()=>signal.removeEventListener('abort',abort);
    const abort=()=>{cleanup();reject(signal.reason??new Error('PLUGIN_START_CANCELLED'));};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});
    if(signal.aborted)abort();
  });
}

function armIdle(id: string, r: Running): void {
  if (r.idleTimer) clearTimeout(r.idleTimer);
  r.idleTimer = setTimeout(() => { if(running.get(id) === r)void stopPlugin(id); }, IDLE_MS);
  r.idleTimer.unref?.();
}

async function start(rec: PluginRecord,stopSignal?:AbortSignal): Promise<Running> {
  const callerSignal=getCallContext()?.signal;
  const signal=callerSignal&&stopSignal?AbortSignal.any([callerSignal,stopSignal]):callerSignal??stopSignal;
  const checkStartup=()=>{if(signal?.aborted)throw signal.reason??new Error('PLUGIN_START_CANCELLED');};
  // Local plugin startup can spawn external processes. Limit simultaneous
  // startups without holding permits for persistent plugin lifetimes.
  // Network-connected remote plugins are unaffected.
  const releaseStartup=rec.source.type==='remote'?()=>{}:
    await pluginStartupAdmission.acquire(signal,Math.min(10000,START_TIMEOUT_MS));
  try{
  checkCancelled();checkStartup();
  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await loadSdk();
  checkStartup();
  let transport: Transport;
  let managedStdio:StdioOwnership|undefined;
  let stderrSink: import('node:stream').Writable | undefined;
  if (rec.source.type === 'remote') {
    transport = new StreamableHTTPClientTransport(new URL(rec.source.url), {
      requestInit: rec.source.headers ? { headers: rec.source.headers } : undefined,
    });
  } else {
    checkStartup();
    const spec = resolveLaunch(rec);
    if (!path.isAbsolute(spec.command) || fs.existsSync(spec.command)) {
      // ok: absolute path that exists, or a bare command resolved from PATH by the OS
    } else {
      throw new Error(`plugin "${rec.id}" is not installed (missing ${spec.command})`);
    }
    fs.mkdirSync(pluginPaths.logDir(), { recursive: true });
    // The SDK still owns the stdio transport, but BRC chooses a native
    // suspended-create Job owner BEFORE the target can execute when possible.
    const selected=managedLaunchSpec(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true});
    const stdio = new StdioClientTransport({ command: selected.command, args: selected.args, env: spec.env, cwd: spec.cwd, stderr: 'pipe' });
    managedStdio=attachManagedStdio(stdio,selected.nativeJob);
    // Keep the plugin's stderr in a log file (useful for "why did it fail").
    stderrSink = cappedPluginStderr(path.join(pluginPaths.logDir(), `${rec.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.log`));
    stdio.stderr?.pipe(stderrSink);
    transport = stdio;
  }
  const client = new Client({ name: 'brc-agent', version: '2' }, { capabilities: {} });
  const r: Running = { client, transport, managedStdio, lastUsed: Date.now(), closed: false };
  transport.onclose = () => { r.closed = true; if(r.idleTimer)clearTimeout(r.idleTimer); stderrSink?.end(); if (running.get(rec.id) === r) running.delete(rec.id); };
  try {
    checkStartup();
    await withStartAbort(withTimeout(client.connect(transport), START_TIMEOUT_MS, `starting plugin "${rec.id}"`),signal);
  } catch (e) {
    // A rejected/aborted MCP handshake may still have spawned a process.
    // Mark stop even before the SDK reports the pid; the adapter applies it
    // if the asynchronous spawn completes after the caller gave up.
    managedStdio?.stop();
    try { await client.close(); } catch { /* ignore */ }
    stderrSink?.end();
    throw e;
  }
  return r;
  }finally{releaseStartup();}
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
  const controller=new AbortController();
  startingCancels.set(id,controller);
  const p = start(rec,controller.signal).then((r) => { running.set(id, r); armIdle(id, r); return r; }).finally(() => {
    starting.delete(id);startingCancels.delete(id);
  });
  starting.set(id, p);
  return p;
}

/** Tools offered by a plugin. Uses the cache unless refresh=true (or nothing is cached). */
export async function getPluginTools(id: string, refresh = false): Promise<PluginToolInfo[]> {
  const rec = getPlugin(id);
  if (!refresh && rec?.enabled && rec.status === 'installed' && rec.toolsCache?.length) return rec.toolsCache;
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

/** Safe startup recovery is allowed, but NEVER replay a call dispatched to a
 * plugin: after a connection break a write may have already taken effect. */
export async function callPluginTool(id: string, tool: string, args: Record<string, unknown>): Promise<PluginCallResult> {
  const r = await ensureRunning(id); // may reconnect before dispatch
  r.lastUsed=Date.now();
  armIdle(id,r);
  try {
    const res=await r.client.callTool({name:tool,arguments:args},undefined,{timeout:CALL_TIMEOUT_MS});
    return {content:(res.content as Array<Record<string,unknown>>)??[],isError:!!res.isError};
  } catch (e) {
    const cause=e instanceof Error ? e.message : String(e);
    throw new Error('PLUGIN_CALL_OUTCOME_UNCERTAIN: The plugin operation may have completed. '+
      'Inspect external side effects before attempting another call. '+cause.slice(0,300));
  }
}

export async function stopPlugin(id: string): Promise<void> {
  const controller=startingCancels.get(id);
  if(controller && !controller.signal.aborted)controller.abort(new Error('PLUGIN_START_CANCELLED'));
  // A shutdown must also stop a plugin whose MCP handshake is still pending.
  // Never let the previous start register as running AFTER a stop request.
  await starting.get(id)?.catch(()=>{});
  const r = running.get(id);
  running.delete(id);
  if (!r) return;
  if (r.idleTimer) clearTimeout(r.idleTimer);
  // The SDK only owns its root process. Request our existing tree-stop while
  // the original child handle is still live to avoid abandoned descendants.
  // Stop is explicit/idle-only; never replay a plugin call after this point.
  r.managedStdio?.stop();
  try { await r.client.close(); } catch { /* ignore */ }
}

export async function stopAllPlugins(): Promise<void> {
  await Promise.all([...new Set([...running.keys(),...starting.keys()])].map(id=>stopPlugin(id)));
}

export function runningPluginIds(): string[] {
  return [...running.keys()];
}
