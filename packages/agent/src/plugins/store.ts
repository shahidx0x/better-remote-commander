/**
 * BRC plugins: persistent state in $BRC_HOME/plugins.json (mode 0600; may hold plugin secrets).
 * Reads are cached in memory; writes are atomic (temp file + rename) and serialised.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pluginPaths } from './paths.js';
import type { PluginRecord, PluginsFile } from './types.js';

let cache: PluginsFile | null = null;
let writeChain: Promise<void> = Promise.resolve();

function empty(): PluginsFile {
  return { version: 1, plugins: {} };
}

/** Synchronous load (fast; called on startup and by tools). */
export function loadPlugins(): PluginsFile {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(pluginPaths.stateFile(), 'utf8')) as PluginsFile;
    cache = data && data.version === 1 && data.plugins ? data : empty();
  } catch {
    cache = empty();
  }
  return cache;
}

/** For tests: forget the in-memory copy. */
export function resetPluginsCache(): void {
  cache = null;
}

export function getPlugin(id: string): PluginRecord | undefined {
  return loadPlugins().plugins[id];
}

export function listPluginRecords(): PluginRecord[] {
  return Object.values(loadPlugins().plugins).sort((a, b) => a.id.localeCompare(b.id));
}

/** Apply a change and persist it. Returns the updated state. */
export async function updatePlugins(mutate: (state: PluginsFile) => void): Promise<PluginsFile> {
  const state = loadPlugins();
  mutate(state);
  const snapshot = JSON.stringify(state, null, 2);
  writeChain = writeChain.then(() => writeAtomic(snapshot)).catch(() => writeAtomic(snapshot));
  await writeChain;
  return state;
}

export async function upsertPlugin(record: PluginRecord): Promise<PluginRecord> {
  await updatePlugins((s) => { s.plugins[record.id] = record; });
  return record;
}

export async function patchPlugin(id: string, patch: Partial<PluginRecord>): Promise<PluginRecord | undefined> {
  let out: PluginRecord | undefined;
  await updatePlugins((s) => {
    const cur = s.plugins[id];
    if (!cur) return;
    out = s.plugins[id] = { ...cur, ...patch };
  });
  return out;
}

export async function deletePlugin(id: string): Promise<boolean> {
  let existed = false;
  await updatePlugins((s) => { existed = !!s.plugins[id]; delete s.plugins[id]; });
  return existed;
}

async function writeAtomic(text: string): Promise<void> {
  const file = pluginPaths.stateFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, 0o600); } catch { /* windows */ }
}
