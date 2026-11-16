/**
 * /admin plugin routes (all behind the admin session; every POST also needs the session-bound CSRF
 * token rendered into the forms):
 *   GET  /admin/marketplace              search the MCP Registry, custom install form
 *   GET  /admin/marketplace/install      install form for one registry server
 *   POST /admin/plugins/install          install (registry or custom) on selected devices; approves a request
 *   POST /admin/plugins/action           enable | disable | remove | refresh
 *   POST /admin/plugins/env              set / remove env vars (values go to the agent only)
 *   GET  /admin/plugins/request          review a pending AI request (install form, prefilled)
 *   POST /admin/plugins/request/reject   reject a pending AI request
 * Env and header values are forwarded to the agent and never stored, logged or audited.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import {
  ENV_NAME_RE, PLUGIN_ID_RE, parseCustomSpec, pluginIdForSource, validateEnv, validatePluginDefinition,
  type PluginAdminAction, type PluginDefinition, type PluginStatusSummary,
} from 'brc-shared';
import type { DeviceHub, PluginAdminOutcome } from '../device-hub.js';
import type { SqliteStore, PluginRequestRow } from '../store/sqlite.js';
import type { Sessions } from '../auth/sessions.js';
import { buildDefinition, type RegistryClient, type RegistryEntry, type InputKind } from './registry.js';
import * as pages from '../pages/html.js';
import * as pp from '../pages/plugins.js';

export interface PluginRouteDeps {
  app: Express;
  hub: DeviceHub;
  store: SqliteStore;
  sessions: Sessions;
  registry: RegistryClient;
  requireLogin: (req: Request, res: Response, next: NextFunction) => void;
  log: (level: string, msg: string) => void;
}

/** How long the browser waits for an install; the install keeps running on the device after that. */
const INSTALL_PAGE_WAIT_MS = Number(process.env.BRC_PLUGIN_INSTALL_WAIT_MS) || 25_000;
const INSTALL_MAX_MS = 15 * 60_000;
const ACTION_WAIT_MS = 30_000;

type Body = Record<string, string | string[] | undefined>;
const one = (b: Body, k: string): string => { const v = b[k]; return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : ''; };
const many = (b: Body, k: string): string[] => { const v = b[k]; return typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : []; };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Friendly text for DeviceHub errors. */
export function adminErrorText(e: unknown): string {
  const m = errMsg(e);
  if (m.startsWith('DEVICE_OFFLINE')) return 'device is offline';
  if (m.startsWith('PLUGINS_UNSUPPORTED')) return 'this agent version does not support plugins; update brc-agent';
  if (m.startsWith('ADMIN_TIMEOUT')) return 'still running on the device; the status in /admin will update';
  return m;
}

/** Collect the extra env rows (xenv_name_N / xenv_value_N). Throws on invalid names. */
export function extraEnv(b: Body): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 1; i <= 8; i++) {
    const name = one(b, `xenv_name_${i}`).trim();
    if (!name) continue;
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name "${name.slice(0, 40)}"`);
    env[name] = one(b, `xenv_value_${i}`);
  }
  return env;
}

/** Collect registry inputs (in_<kind>_<NAME>). */
export function registryValues(b: Body): Record<InputKind, Record<string, string>> {
  const out: Record<InputKind, Record<string, string>> = { env: {}, header: {}, var: {}, arg: {} };
  for (const key of Object.keys(b)) {
    const m = key.match(/^in_(env|header|var|arg)_(.{1,128})$/);
    if (m) out[m[1] as InputKind][m[2]] = one(b, key);
  }
  return out;
}

export function registerPluginRoutes(d: PluginRouteDeps) {
  const { app, hub, store, sessions, registry, requireLogin, log } = d;
  hub.onPlugins = (deviceId, plugins) => { try { store.saveDevicePlugins(deviceId, plugins); } catch (e) { log('warn', `saving plugin list failed: ${errMsg(e)}`); } };

  const userOf = (req: Request) => sessions.userId(req)!;

  const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('sec-fetch-site') === 'cross-site' || !sessions.verifyCsrf(req, (req.body as Body | undefined)?.csrf)) {
      log('warn', `admin: CSRF check failed for ${req.path} from ${req.ip}`);
      res.status(403).type('html').send(pages.messagePage('Forbidden', 'The form has expired or did not come from this relay. Reload the page and try again.', false));
      return;
    }
    next();
  };

  const audit = (userId: string, deviceId: string | null, tool: string, ok: boolean, ms: number, error: string | null, ref: string | null = null) =>
    store.audit({ ts: Date.now() - ms, user_id: userId, device_id: deviceId, client: 'admin', tool, args_hash: ref, ok: ok ? 1 : 0, ms, error: error ? error.slice(0, 500) : null });

  const targetDevices = (userId: string): pp.TargetDevice[] => store.listDevices(userId).map((dev) => {
    const live = hub.get(dev.device_id);
    const online = !!live && live.ownerId === userId;
    return { device_id: dev.device_id, name: dev.name, online, supported: online && !!live!.plugins };
  });

  const ownedOnline = (userId: string, deviceId: string) => {
    const dev = store.getDevice(deviceId);
    if (!dev || dev.user_id !== userId) return { error: 'Unknown device.' } as const;
    const live = hub.get(deviceId);
    if (!live || live.ownerId !== userId) return { error: `${dev.name} is offline.` } as const;
    return { dev } as const;
  };

  /** HTML for /admin: pending requests + per-device plugin lists. */
  function adminSections(req: Request, userId: string): string {
    const csrf = sessions.csrfToken(req);
    const devices = store.listDevices(userId);
    const views: pp.PluginDeviceView[] = devices.map((dev) => {
      const live = hub.get(dev.device_id);
      const online = !!live && live.ownerId === userId;
      if (online && live!.plugins) return { device_id: dev.device_id, name: dev.name, online, supported: true, plugins: live!.plugins, stale: false, updatedAt: live!.pluginsAt };
      const last = store.getDevicePlugins(dev.device_id);
      return { device_id: dev.device_id, name: dev.name, online, supported: false, plugins: (last?.plugins ?? []) as PluginStatusSummary[], stale: true, updatedAt: last?.updated_at };
    });
    const requests = store.listPluginRequests(userId, { limit: 20 });
    const shown = [...requests.filter((r) => r.status === 'pending'), ...requests.filter((r) => r.status !== 'pending').slice(0, 5)];
    return pp.pluginStyles + pp.requestsSection(shown, new Map(devices.map((x) => [x.device_id, x.name])), csrf) + pp.pluginsSection(views, csrf);
  }

  function flash(req: Request): string {
    const msg = typeof req.query.pmsg === 'string' ? req.query.pmsg.slice(0, 300) : '';
    return pp.flashBanner(msg, req.query.pok !== '0');
  }

  const back = (res: Response, deviceId: string | null, msg: string, ok: boolean) =>
    res.redirect(`/admin?pmsg=${encodeURIComponent(msg.slice(0, 300))}&pok=${ok ? 1 : 0}${deviceId ? `#plugins-${encodeURIComponent(deviceId)}` : '#plugins'}`);

  /* ---------- marketplace ---------- */
  app.get('/admin/marketplace', requireLogin, async (req, res) => {
    const userId = userOf(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 300) : undefined;
    const device = typeof req.query.device === 'string' ? req.query.device.slice(0, 200) : undefined;
    let entries: RegistryEntry[] = [];
    let nextCursor: string | undefined;
    let error: string | undefined;
    try {
      const r = await registry.search(q, 20, cursor);
      entries = r.entries;
      nextCursor = r.nextCursor;
    } catch (e) {
      error = `Registry search failed: ${errMsg(e)}`;
    }
    res.type('html').send(pp.marketplacePage({ q, entries, nextCursor, error, registrySource: registry.source, devices: targetDevices(userId), selectedDevice: device, csrf: sessions.csrfToken(req) }));
  });

  app.get('/admin/marketplace/install', requireLogin, async (req, res) => {
    const userId = userOf(req);
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const device = typeof req.query.device === 'string' ? req.query.device.slice(0, 200) : undefined;
    let entry: RegistryEntry | null = null;
    let error: string | undefined;
    try { entry = await registry.get(name); } catch (e) { error = `Registry lookup failed: ${errMsg(e)}`; }
    if (!entry && !error) error = 'Server not found in the MCP Registry.';
    res.status(entry ? 200 : 404).type('html').send(pp.installPage({ csrf: sessions.csrfToken(req), devices: targetDevices(userId), selectedDevice: device, entry: entry ?? undefined, error }));
  });

  /* ---------- AI requests ---------- */
  app.get('/admin/plugins/request', requireLogin, async (req, res) => {
    const userId = userOf(req);
    const r = store.getPluginRequest(typeof req.query.id === 'string' ? req.query.id : '');
    if (!r || r.user_id !== userId) return res.status(404).type('html').send(pages.messagePage('Not found', 'Unknown plugin request.', false));
    if (r.status !== 'pending') return res.status(409).type('html').send(pages.messagePage('Already decided', `This request is ${r.status}.`, false));
    const base = { csrf: sessions.csrfToken(req), devices: targetDevices(userId), selectedDevice: r.device_id ?? undefined, request: r };
    if (r.registry_name) {
      let entry: RegistryEntry | null = null;
      let error: string | undefined;
      try { entry = await registry.get(r.registry_name); } catch (e) { error = `Registry lookup failed: ${errMsg(e)}`; }
      if (!entry && !error) error = `${r.registry_name} is no longer in the MCP Registry.`;
      return res.type('html').send(pp.installPage({ ...base, entry: entry ?? undefined, error }));
    }
    res.type('html').send(pp.installPage({ ...base, custom: { type: r.custom_type ?? 'npm', spec: r.custom_spec ?? '', pluginId: r.plugin_id ?? undefined } }));
  });

  app.post('/admin/plugins/request/reject', requireLogin, requireCsrf, (req, res) => {
    const userId = userOf(req);
    const id = one(req.body as Body, 'id');
    const r = store.getPluginRequest(id);
    if (!r || r.user_id !== userId) return res.status(404).type('html').send(pages.messagePage('Not found', 'Unknown plugin request.', false));
    const ok = store.setPluginRequestStatus(id, 'rejected', 'rejected by owner', ['pending']);
    if (ok) {
      audit(userId, r.device_id, `plugin.reject(${(r.plugin_id ?? r.registry_name ?? r.custom_type ?? '?').slice(0, 60)})`, true, 0, null, id);
      log('info', `admin: rejected plugin request ${id}`);
    }
    back(res, null, ok ? 'Plugin request rejected.' : `Request is already ${r.status}.`, ok);
  });

  /* ---------- install ---------- */
  app.post('/admin/plugins/install', requireLogin, requireCsrf, async (req, res) => {
    const userId = userOf(req);
    const b = req.body as Body;
    const fail = (status: number, msg: string) => res.status(status).type('html').send(pp.installResultPage('Not installed', [], `${msg} Go back to correct it.`));

    let request: PluginRequestRow | undefined;
    const requestId = one(b, 'request_id');
    if (requestId) {
      request = store.getPluginRequest(requestId);
      if (!request || request.user_id !== userId) return fail(404, 'Unknown plugin request.');
      if (request.status !== 'pending') return fail(409, `This request is already ${request.status}.`);
    }

    const deviceIds = [...new Set(many(b, 'device_id'))].slice(0, 20);
    if (!deviceIds.length) return fail(400, 'Select at least one online device.');
    const targets: { id: string; name: string }[] = [];
    for (const id of deviceIds) {
      const t = ownedOnline(userId, id);
      if ('error' in t) return fail(400, t.error ?? 'Unknown device.');
      targets.push({ id, name: t.dev.name });
    }

    let definition: PluginDefinition;
    let env: Record<string, string>;
    try {
      const source = one(b, 'source');
      if (source === 'registry') {
        const entry = await registry.get(one(b, 'registry_name'));
        if (!entry) throw new Error('Server not found in the MCP Registry.');
        const v = registryValues(b);
        ({ definition, env } = buildDefinition(entry, { pluginId: one(b, 'plugin_id').trim(), name: one(b, 'name').trim(), env: v.env, headers: v.header, vars: v.var, args: v.arg }));
      } else if (source === 'custom') {
        const src = parseCustomSpec(one(b, 'custom_type'), one(b, 'custom_spec'));
        const id = one(b, 'plugin_id').trim() || pluginIdForSource(src);
        definition = { id, name: one(b, 'name').trim() || id, source: src, origin: 'user', enabled: true };
        env = {};
      } else {
        throw new Error('Unknown plugin source.');
      }
      if (!PLUGIN_ID_RE.test(definition.id)) throw new Error('Plugin id must be 1-64 chars of a-z, 0-9 and "-".');
      env = { ...env, ...extraEnv(b) };
      const bad = validatePluginDefinition(definition) ?? validateEnv(env);
      if (bad) throw new Error(bad);
    } catch (e) {
      return fail(400, `${errMsg(e)}.`);
    }

    if (request) {
      if (!store.setPluginRequestStatus(request.id, 'approved', null, ['pending'])) return fail(409, 'This request was decided meanwhile.');
      audit(userId, request.device_id, `plugin.approve(${definition.id})`, true, 0, null, request.id);
    }
    log('info', `admin: install plugin ${definition.id} (${definition.source.type}) on ${targets.map((t) => t.id).join(', ')}${request ? ` for request ${request.id}` : ''}`);

    const tool = `plugin.install(${definition.id})`;
    const runs = targets.map((t) => {
      const t0 = Date.now();
      const p = hub.pluginAdmin(t.id, { action: 'install', plugin: definition, env }, INSTALL_MAX_MS)
        .then((r) => { audit(userId, t.id, tool, r.ok, Date.now() - t0, r.ok ? null : r.error ?? 'failed', request?.id ?? null); return r; })
        .catch((e): PluginAdminOutcome => { audit(userId, t.id, tool, false, Date.now() - t0, adminErrorText(e), request?.id ?? null); return { ok: false, error: adminErrorText(e) }; });
      return { t, p };
    });
    // The request's final status is recorded when every device finished, even after the page returned.
    if (request) {
      const rid = request.id;
      void Promise.all(runs.map((r) => r.p)).then((outs) => {
        const failed = outs.map((o, i) => (o.ok ? null : `${targets[i].name}: ${o.error ?? 'failed'}`)).filter(Boolean);
        store.setPluginRequestStatus(rid, failed.length ? 'failed' : 'installed', failed.length ? failed.join('; ') : `installed as ${definition.id}`, ['approved']);
      });
    }
    const waited = await Promise.all(runs.map(({ t, p }) => Promise.race([
      p.then((o) => ({ device: t.name, ok: o.ok, message: o.ok ? `installed${o.plugin?.status && o.plugin.status !== 'installed' ? ` (${o.plugin.status})` : ''}` : o.error ?? 'failed' })),
      new Promise<pp.InstallOutcomeView>((r) => { const tm = setTimeout(() => r({ device: t.name, ok: true, message: 'install is still running on the device; its status in /admin will update' }), INSTALL_PAGE_WAIT_MS); tm.unref?.(); }),
    ])));
    res.type('html').send(pp.installResultPage(`${definition.name} (${definition.id})`, waited));
  });

  /* ---------- enable / disable / remove / refresh ---------- */
  app.post('/admin/plugins/action', requireLogin, requireCsrf, async (req, res) => {
    const userId = userOf(req);
    const b = req.body as Body;
    const deviceId = one(b, 'device_id');
    const pluginId = one(b, 'plugin_id');
    const action = one(b, 'action') as PluginAdminAction;
    if (!['enable', 'disable', 'remove', 'refresh'].includes(action)) return back(res, deviceId, 'Unknown action.', false);
    if (!PLUGIN_ID_RE.test(pluginId)) return back(res, deviceId, 'Invalid plugin id.', false);
    const t = ownedOnline(userId, deviceId);
    if ('error' in t) return back(res, null, t.error ?? 'Unknown device.', false);
    const t0 = Date.now();
    try {
      const r = await hub.pluginAdmin(deviceId, { action, pluginId }, action === 'refresh' ? 90_000 : ACTION_WAIT_MS);
      audit(userId, deviceId, `plugin.${action}(${pluginId})`, r.ok, Date.now() - t0, r.ok ? null : r.error ?? 'failed');
      log('info', `admin: ${action} plugin ${pluginId} on ${deviceId}: ${r.ok ? 'ok' : 'failed'}`);
      back(res, deviceId, r.ok ? `${pluginId}: ${action} done${action === 'refresh' && r.plugin?.toolCount !== undefined ? ` (${r.plugin.toolCount} tools)` : ''}.` : `${pluginId}: ${r.error ?? 'failed'}`, r.ok);
    } catch (e) {
      audit(userId, deviceId, `plugin.${action}(${pluginId})`, false, Date.now() - t0, adminErrorText(e));
      back(res, deviceId, `${pluginId}: ${adminErrorText(e)}`, false);
    }
  });

  /* ---------- env ---------- */
  app.post('/admin/plugins/env', requireLogin, requireCsrf, async (req, res) => {
    const userId = userOf(req);
    const b = req.body as Body;
    const deviceId = one(b, 'device_id');
    const pluginId = one(b, 'plugin_id');
    if (!PLUGIN_ID_RE.test(pluginId)) return back(res, deviceId, 'Invalid plugin id.', false);
    const t = ownedOnline(userId, deviceId);
    if ('error' in t) return back(res, null, t.error ?? 'Unknown device.', false);
    let env: Record<string, string>;
    const unsetEnv: string[] = [];
    try {
      env = extraEnv(b);
      for (const key of Object.keys(b)) {
        let m = key.match(/^set_(.+)$/);
        if (m && ENV_NAME_RE.test(m[1]) && one(b, key) !== '') env[m[1]] = one(b, key);
        m = key.match(/^unset_(.+)$/);
        if (m && ENV_NAME_RE.test(m[1])) unsetEnv.push(m[1]);
      }
      for (const k of unsetEnv) delete env[k];
      const bad = validateEnv(env);
      if (bad) throw new Error(bad);
    } catch (e) {
      return back(res, deviceId, errMsg(e), false);
    }
    if (!Object.keys(env).length && !unsetEnv.length) return back(res, deviceId, 'Nothing to change.', true);
    const t0 = Date.now();
    try {
      const r = await hub.pluginAdmin(deviceId, { action: 'set_env', pluginId, env, unsetEnv }, ACTION_WAIT_MS);
      // Audit only the variable names, never values.
      audit(userId, deviceId, `plugin.set_env(${pluginId})`, r.ok, Date.now() - t0, r.ok ? null : r.error ?? 'failed');
      log('info', `admin: set_env plugin ${pluginId} on ${deviceId} keys=[${Object.keys(env).join(',')}] unset=[${unsetEnv.join(',')}]`);
      back(res, deviceId, r.ok ? `${pluginId}: environment updated (${Object.keys(env).length} set, ${unsetEnv.length} removed).` : `${pluginId}: ${r.error ?? 'failed'}`, r.ok);
    } catch (e) {
      audit(userId, deviceId, `plugin.set_env(${pluginId})`, false, Date.now() - t0, adminErrorText(e));
      back(res, deviceId, `${pluginId}: ${adminErrorText(e)}`, false);
    }
  });

  return { adminSections, flash };
}
