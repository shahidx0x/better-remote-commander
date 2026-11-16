/**
 * Relay-driven plugin administration on the agent.
 *
 * - Reports plugin status to the relay (`plugins` frame) after `welcome` and, debounced, whenever
 *   plugin state changes (manager.onPluginsChanged).
 * - Executes `plugin_admin` requests (install / enable / disable / remove / set_env / refresh) that
 *   the relay sends on behalf of the device owner, and answers with `plugin_admin_result`.
 *
 * Everything coming from the relay is validated again here. Env values are never logged and never
 * reported back (only their names, via pluginSummary()).
 * Set BRC_PLUGIN_REMOTE_ADMIN=0 on the device to refuse remote plugin changes (status is still reported).
 */
import {
  validateEnv, validatePluginDefinition, ENV_NAME_RE, PLUGIN_ID_RE, PLUGIN_ADMIN_ACTIONS,
  type AgentMessage, type PluginAdminMessage, type PluginStatusSummary,
} from 'brc-shared';
import {
  definePlugin, installPlugin, listPlugins, onPluginsChanged, pluginSummary, removePlugin, setPluginEnabled, setPluginEnv,
} from '../plugins/manager.js';
import { getPluginTools } from '../plugins/host.js';
import { getPlugin } from '../plugins/store.js';
import type { PluginRecord } from '../plugins/types.js';

type Log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

const STATUS_DEBOUNCE_MS = 250;
const MAX_REPORTED = 500;

export function remotePluginAdminEnabled(): boolean {
  const v = (process.env.BRC_PLUGIN_REMOTE_ADMIN ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export function summarize(rec: PluginRecord): PluginStatusSummary {
  return pluginSummary(rec) as PluginStatusSummary;
}

export class PluginAdmin {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly send: (msg: AgentMessage) => void, private readonly log: Log = () => {}) {}

  /** Start watching plugin state (idempotent). */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onPluginsChanged(() => this.scheduleStatus());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  scheduleStatus(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.sendStatus(); }, STATUS_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  sendStatus(): void {
    let plugins: PluginStatusSummary[];
    try {
      plugins = listPlugins().slice(0, MAX_REPORTED).map(summarize);
    } catch (e) {
      this.log('warn', `plugin status unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.send({ type: 'plugins', plugins });
  }

  /** Execute one plugin_admin request and always answer with plugin_admin_result. */
  async handle(msg: PluginAdminMessage): Promise<void> {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 100) : '';
    if (!id) return;
    const reply = (ok: boolean, error?: string, rec?: PluginRecord) =>
      this.send({ type: 'plugin_admin_result', id, ok, ...(error ? { error: error.slice(0, 2000) } : {}), ...(rec ? { plugin: summarize(rec) } : {}) });
    try {
      const out = await this.execute(msg);
      reply(out.ok, out.error, out.rec);
    } catch (e) {
      reply(false, e instanceof Error ? e.message : String(e));
    }
  }

  private async execute(msg: PluginAdminMessage): Promise<{ ok: boolean; error?: string; rec?: PluginRecord }> {
    if (!PLUGIN_ADMIN_ACTIONS.includes(msg.action)) return { ok: false, error: `unknown action "${String(msg.action).slice(0, 20)}"` };
    if (msg.action === 'refresh' && !msg.pluginId) {
      this.sendStatus();
      return { ok: true };
    }
    if (!remotePluginAdminEnabled()) return { ok: false, error: 'remote plugin administration is disabled on this device (BRC_PLUGIN_REMOTE_ADMIN=0)' };

    if (msg.action === 'install') {
      const def = msg.plugin;
      const bad = validatePluginDefinition(def) ?? validateEnv(msg.env);
      if (bad || !def) return { ok: false, error: `invalid plugin definition: ${bad ?? 'missing'}` };
      const prev = getPlugin(def.id);
      if (prev?.source.type === 'binary') return { ok: false, error: `"${def.id}" is used by a built-in BRC program; choose another id` };
      this.log('info', `plugin admin: install ${def.id} (${def.source.type})`);
      await definePlugin({
        id: def.id,
        name: def.name.trim(),
        description: def.description,
        source: def.source,
        enabled: def.enabled ?? prev?.enabled ?? true,
        origin: def.origin ?? 'user',
        registryName: def.registryName,
        env: { ...(prev?.env ?? {}), ...(msg.env ?? {}) },
        status: 'pending',
        error: undefined,
        userAction: undefined,
        toolsCache: undefined,
        toolsCachedAt: undefined,
      });
      const rec = await installPlugin(def.id, this.log);
      if (rec.status === 'installed') return { ok: true, rec };
      const why = rec.status === 'needs-user' ? `needs user action: ${rec.userAction ?? rec.error ?? 'see device'}` : `${rec.status}: ${rec.error ?? 'install did not complete'}`;
      return { ok: false, error: why, rec };
    }

    const pluginId = msg.pluginId;
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) return { ok: false, error: 'invalid plugin id' };
    if (!getPlugin(pluginId)) return { ok: false, error: `unknown plugin "${pluginId}"` };
    this.log('info', `plugin admin: ${msg.action} ${pluginId}`);

    switch (msg.action) {
      case 'enable':
      case 'disable':
        return { ok: true, rec: await setPluginEnabled(pluginId, msg.action === 'enable') };
      case 'remove': {
        const ok = await removePlugin(pluginId, this.log);
        return ok ? { ok: true } : { ok: false, error: `unknown plugin "${pluginId}"` };
      }
      case 'set_env': {
        const bad = validateEnv(msg.env ?? {});
        if (bad) return { ok: false, error: bad };
        const unset = Array.isArray(msg.unsetEnv) ? msg.unsetEnv : [];
        if (unset.length > 100 || unset.some((k) => typeof k !== 'string' || !ENV_NAME_RE.test(k))) return { ok: false, error: 'invalid unsetEnv' };
        const env: Record<string, string> = { ...(getPlugin(pluginId)?.env ?? {}), ...(msg.env ?? {}) };
        for (const k of unset) delete env[k];
        return { ok: true, rec: await setPluginEnv(pluginId, env) };
      }
      case 'refresh': {
        const tools = await getPluginTools(pluginId, true);
        this.scheduleStatus();
        const rec = getPlugin(pluginId);
        this.log('info', `plugin ${pluginId}: ${tools.length} tools`);
        return { ok: true, rec };
      }
      default:
        return { ok: false, error: 'unsupported action' };
    }
  }
}
