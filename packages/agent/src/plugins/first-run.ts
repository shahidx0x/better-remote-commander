/**
 * BRC plugins: default plugin set-up at agent start.
 *
 * First start (no firstRunAt in plugins.json): define the default plugins for this platform and
 * install them in the background (2 at a time), then record firstRunAt.
 *
 * Later starts: no network and no probing - only plugins.json plus an existence check of each
 * installed plugin's main executable. Re-installs only what is missing on disk, failed, or left
 * pending/installing by an interrupted run. needs-user plugins get one cheap "is Python there
 * now?" check per start; a default plugin marked unsupported for lack of a display is retried
 * when a display appears.
 *
 * Skipped entirely with BRC_PLUGINS=none (cli.ts also skips it for --no-plugins).
 */
import { currentDefaultsContext, defaultPluginDefs, hasDisplay } from './defaults.js';
import { pluginFilesPresent } from './locate.js';
import { definePlugin, installPlugin } from './manager.js';
import { pythonAvailableNow } from './python.js';
import { loadPlugins, patchPlugin, updatePlugins } from './store.js';
import type { InstallLog, PluginRecord } from './types.js';

export interface EnsureDefaultsResult {
  /** Why nothing was done (e.g. "BRC_PLUGINS=none"). */
  skipped?: string;
  firstRun: boolean;
  /** Plugins defined by this call (first run only). */
  defined: string[];
  /** Plugins queued for (re)installation. */
  queued: string[];
  /** Resolves when all queued installs have finished (never rejects). */
  done: Promise<void>;
}

export interface EnsureDefaultsOptions {
  concurrency?: number;
}

/** Does an installed / interrupted plugin need (re)installing? Filesystem checks only. */
function needsRepair(rec: PluginRecord): boolean {
  switch (rec.status) {
    case 'pending':
    case 'installing':
    case 'failed':
      return true;
    case 'installed':
      return !pluginFilesPresent(rec);
    default:
      return false; // needs-user / unsupported are handled separately
  }
}

function runQueue(ids: string[], concurrency: number, log: InstallLog): Promise<void> {
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        await installPlugin(id, log);
      } catch (e) {
        log('warn', `plugin ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  return Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker)).then(() => {});
}

export async function ensureDefaultPlugins(log: InstallLog = () => {}, opts: EnsureDefaultsOptions = {}): Promise<EnsureDefaultsResult> {
  if ((process.env.BRC_PLUGINS ?? '').toLowerCase() === 'none') {
    return { skipped: 'BRC_PLUGINS=none', firstRun: false, defined: [], queued: [], done: Promise.resolve() };
  }
  const concurrency = opts.concurrency ?? 2;
  const state = loadPlugins();
  const firstRun = !state.firstRunAt;
  const defined: string[] = [];

  if (firstRun) {
    for (const def of defaultPluginDefs(currentDefaultsContext())) {
      if (state.plugins[def.id]) continue; // keep whatever the user or an interrupted run left
      await definePlugin(def);
      defined.push(def.id);
    }
  }

  const records = Object.values(loadPlugins().plugins);
  const queued = records.filter(needsRepair).map((r) => r.id);

  // Default plugins marked unsupported only because there was no display: retry when one exists.
  for (const rec of records) {
    if (rec.status === 'unsupported' && rec.origin === 'default' && /no graphical display/.test(rec.error ?? '') && hasDisplay(process.platform, process.env)) {
      await patchPlugin(rec.id, { status: 'pending', error: undefined });
      queued.push(rec.id);
    }
  }

  // needs-user (Python missing): one cheap check per start.
  const waiting = records.filter((r) => r.status === 'needs-user');
  if (waiting.some((r) => r.source.type === 'pypi') && (await pythonAvailableNow())) {
    for (const r of waiting) if (r.source.type === 'pypi') queued.push(r.id);
  }

  if (queued.length) log('info', `plugins: installing ${queued.join(', ')} in the background`);
  const done = runQueue(queued, concurrency, log)
    .then(async () => {
      if (firstRun) await updatePlugins((s) => { s.firstRunAt = new Date().toISOString(); });
    })
    .catch((e) => log('warn', `plugin set-up: ${e instanceof Error ? e.message : String(e)}`));
  return { firstRun, defined, queued, done };
}
