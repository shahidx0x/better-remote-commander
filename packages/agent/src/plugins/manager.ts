/**
 * BRC plugin manager: the one API the CLI, the AI tools and the relay integration use.
 * Installation itself is delegated to the installer registered with setPluginInstaller()
 * (implemented in installer.ts), so this module has no network or package-manager code.
 */
import { stopPlugin } from './host.js';
import { deletePlugin, getPlugin, listPluginRecords, patchPlugin, upsertPlugin } from './store.js';
import type { InstallLog, PluginInstaller, PluginRecord, PluginUninstaller } from './types.js';

let installer: PluginInstaller | null = null;
let uninstaller: PluginUninstaller | null = null;
const inFlight = new Map<string, Promise<PluginRecord>>();
const listeners = new Set<(records: PluginRecord[]) => void>();

export function setPluginInstaller(fn: PluginInstaller, undo?: PluginUninstaller): void {
  installer = fn;
  uninstaller = undo ?? null;
}

/** Subscribe to plugin state changes (used to report status to the relay). */
export function onPluginsChanged(fn: (records: PluginRecord[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  const all = listPluginRecords();
  for (const fn of listeners) { try { fn(all); } catch { /* ignore */ } }
}

export function listPlugins(): PluginRecord[] {
  return listPluginRecords();
}

/** Register (or replace) a plugin definition without installing it. */
export async function definePlugin(rec: Omit<PluginRecord, 'status'> & { status?: PluginRecord['status'] }): Promise<PluginRecord> {
  const prev = getPlugin(rec.id);
  const out = await upsertPlugin({ ...prev, ...rec, status: rec.status ?? prev?.status ?? 'pending' } as PluginRecord);
  emit();
  return out;
}

/** Install (or repair) one plugin. Concurrent calls for the same id share one install. */
export function installPlugin(id: string, log: InstallLog = () => {}): Promise<PluginRecord> {
  const running = inFlight.get(id);
  if (running) return running;
  const p = (async () => {
    const rec = getPlugin(id);
    if (!rec) throw new Error(`unknown plugin "${id}"`);
    // Nothing to download for hosted servers, nor for owner-configured local commands when no
    // installer is registered (the installer, when present, may still verify the command).
    if (rec.source.type === 'remote' || (rec.source.type === 'command' && !installer)) {
      await stopPlugin(id); // a running old definition must not keep serving
      const done = (await patchPlugin(id, { status: 'installed', error: undefined, userAction: undefined, installedAt: new Date().toISOString() }))!;
      emit();
      return done;
    }
    if (!installer) throw new Error('plugin installer not available');
    await patchPlugin(id, { status: 'installing', error: undefined });
    emit();
    let result;
    try {
      result = await installer(rec, log);
    } catch (e) {
      result = { status: 'failed' as const, error: e instanceof Error ? e.message : String(e) };
    }
    await stopPlugin(id); // a running old version must not keep serving
    const done = (await patchPlugin(id, {
      status: result.status,
      error: result.error,
      userAction: result.userAction,
      installedVersion: result.installedVersion ?? rec.installedVersion,
      ...(result.source ? { source: result.source } : {}),
      installedAt: result.status === 'installed' ? new Date().toISOString() : rec.installedAt,
      toolsCache: result.status === 'installed' ? undefined : rec.toolsCache,
    }))!;
    log(result.status === 'installed' ? 'info' : 'warn', `plugin ${id}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
    emit();
    return done;
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<PluginRecord> {
  const rec = await patchPlugin(id, { enabled });
  if (!rec) throw new Error(`unknown plugin "${id}"`);
  if (!enabled) await stopPlugin(id);
  emit();
  return rec;
}

export async function removePlugin(id: string, log: InstallLog = () => {}): Promise<boolean> {
  const rec = getPlugin(id);
  if (!rec) return false;
  await stopPlugin(id);
  if (uninstaller) {
    try { await uninstaller(rec, log); } catch (e) { log('warn', `uninstall ${id}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const ok = await deletePlugin(id);
  emit();
  return ok;
}

export async function setPluginEnv(id: string, env: Record<string, string>): Promise<PluginRecord> {
  await stopPlugin(id);
  const rec = await patchPlugin(id, { env });
  if (!rec) throw new Error(`unknown plugin "${id}"`);
  emit();
  return rec;
}

/** Public view for the relay/admin (secrets masked). */
export function pluginSummary(rec: PluginRecord) {
  const src = rec.source;
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    type: src.type,
    package: 'package' in src ? `${src.package}@${src.version}` : src.type === 'remote' ? src.url : src.type === 'command' ? src.command : src.type === 'binary' ? `${src.binName}@${src.version}` : undefined,
    enabled: rec.enabled,
    status: rec.status,
    error: rec.error,
    userAction: rec.userAction,
    origin: rec.origin,
    registryName: rec.registryName,
    installedVersion: rec.installedVersion,
    envKeys: Object.keys(rec.env ?? {}),
    toolCount: rec.toolsCache?.length,
  };
}
export type PluginSummary = ReturnType<typeof pluginSummary>;
