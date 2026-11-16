/**
 * Admin pages for plugins: per-device plugin lists (in /admin), pending AI install requests,
 * the MCP Registry marketplace and the install form. Server-rendered, no JS needed.
 * Every value that came from an agent, the registry or an AI client is passed through esc().
 */
import type { PluginStatusSummary } from 'brc-shared';
import type { RegistryEntry, RegistryInput } from '../plugins/registry.js';
import type { PluginRequestRow } from '../store/sqlite.js';
import { layout, esc } from './html.js';

export interface PluginDeviceView {
  device_id: string;
  name: string;
  online: boolean;
  /** Agent supports plugin admin (sent a `plugins` report on this connection). */
  supported: boolean;
  plugins: PluginStatusSummary[];
  /** True when the list is the last-known copy from sqlite (device offline). */
  stale: boolean;
  updatedAt?: number;
}

export interface TargetDevice { device_id: string; name: string; online: boolean; supported: boolean }

const ago = (t: number | null | undefined) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

/** Only http(s) links from untrusted data (no javascript: etc.). */
const safeLink = (url: string | undefined, label: string) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  } catch { return ''; }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(label)}</a>`;
};

function statusPill(p: PluginStatusSummary): string {
  const cls = p.status === 'installed' ? 'ok' : p.status === 'failed' || p.status === 'unsupported' ? 'err' : 'muted';
  return `<span class="pill ${cls}">${esc(p.status)}</span>${p.enabled ? '' : ' <span class="pill muted">disabled</span>'}`;
}

export function flashBanner(msg?: string, ok = true): string {
  return msg ? `<div class="panel" role="status"><p class="${ok ? 'ok' : 'err'}" style="margin:0">${esc(msg)}</p></div>` : '';
}

function envForm(d: PluginDeviceView, p: PluginStatusSummary, csrf: string): string {
  const keys = p.envKeys.map((k) => `<div class="kv"><label>${esc(k)}</label><input type="password" name="set_${esc(k)}" autocomplete="off" placeholder="unchanged">
<label class="inline"><input type="checkbox" name="unset_${esc(k)}" value="1"> remove</label></div>`).join('');
  return `<details><summary>Environment (${p.envKeys.length})</summary>
<form method="post" action="/admin/plugins/env">${csrfField(csrf)}<input type="hidden" name="device_id" value="${esc(d.device_id)}"><input type="hidden" name="plugin_id" value="${esc(p.id)}">
<p class="muted">Values go straight to the device and are never stored on the relay. Leave a field empty to keep its value.</p>
${keys}${extraEnvRows(2)}<div class="actions"><button class="secondary" type="submit">Save environment</button></div></form></details>`;
}

function pluginRow(d: PluginDeviceView, p: PluginStatusSummary, csrf: string): string {
  const canAct = d.online && d.supported;
  const problem = p.userAction ? `<p class="err">Needs you: ${esc(p.userAction)}</p>` : p.error ? `<p class="err">${esc(p.error)}</p>` : '';
  // confirm() text is static: never interpolate agent-supplied data into inline JS.
  const act = (action: string, label: string, cls = 'secondary', confirm = false) =>
    `<button class="${cls}" name="action" value="${action}"${canAct ? '' : ' disabled'}${confirm ? ` onclick="return confirm('Remove this plugin from the device?')"` : ''}>${label}</button>`;
  const binary = p.type === 'binary';
  return `<div class="plugin" data-plugin="${esc(p.id)}"><div class="device-top"><div><strong>${esc(p.name)}</strong> <code>${esc(p.id)}</code>
<p>${esc(p.type)}${p.package ? ` · <code>${esc(p.package)}</code>` : ''}${p.registryName ? ` · registry <code>${esc(p.registryName)}</code>` : ''}${p.toolCount !== undefined ? ` · ${p.toolCount} tools` : ''}${p.origin ? ` · ${esc(p.origin)}` : ''}</p></div><div>${statusPill(p)}</div></div>
${problem}<form method="post" action="/admin/plugins/action">${csrfField(csrf)}<input type="hidden" name="device_id" value="${esc(d.device_id)}"><input type="hidden" name="plugin_id" value="${esc(p.id)}">
<div class="actions">${p.enabled ? act('disable', 'Disable') : act('enable', 'Enable')}${binary ? '' : act('refresh', 'Refresh tools')}${act('remove', 'Remove', 'secondary danger', true)}</div></form>
${binary || !canAct ? '' : envForm(d, p, csrf)}</div>`;
}

/** "Plugins" section of /admin. */
export function pluginsSection(devices: PluginDeviceView[], csrf: string): string {
  const blocks = devices.map((d) => {
    const head = `<div class="section-head"><div><h2>${esc(d.name)}</h2><p>${d.online ? (d.supported ? `${d.plugins.length} plugin(s)` : 'agent does not report plugins (update brc-agent)') : `offline${d.updatedAt ? ` · last known ${ago(d.updatedAt)}` : ''}`}</p></div>
${d.online && d.supported ? `<a href="/admin/marketplace?device=${encodeURIComponent(d.device_id)}"><button class="secondary">Add plugin</button></a>` : ''}</div>`;
    const list = d.plugins.length ? d.plugins.map((p) => pluginRow(d, p, csrf)).join('') : '<p class="muted">No plugins.</p>';
    return `<div class="panel" id="plugins-${esc(d.device_id)}" style="margin-bottom:12px">${head}${list}</div>`;
  }).join('');
  return `<div class="section" id="plugins"><div class="section-head"><div><h2>Plugins</h2><p>Extra MCP servers on your devices, reachable by the AI through list_plugin_tools / call_plugin_tool.</p></div><a href="/admin/marketplace"><button class="primary">Marketplace</button></a></div>
${blocks || '<div class="panel"><p>No devices.</p></div>'}</div>`;
}

function requestWhat(r: PluginRequestRow): string {
  return r.registry_name ? `registry <code>${esc(r.registry_name)}</code>` : `custom ${esc(r.custom_type ?? '?')} <code>${esc(r.custom_spec ?? '')}</code>`;
}

/** Pending AI requests (and the latest decided ones) for /admin. */
export function requestsSection(requests: PluginRequestRow[], deviceNames: Map<string, string>, csrf: string): string {
  if (!requests.length) return '';
  const rows = requests.map((r) => {
    const dev = r.device_id ? esc(deviceNames.get(r.device_id) ?? r.device_id) : 'any device';
    const actions = r.status === 'pending'
      ? `<div class="actions"><a href="/admin/plugins/request?id=${encodeURIComponent(r.id)}"><button class="primary" type="button">Review &amp; approve</button></a>
<form method="post" action="/admin/plugins/request/reject" style="display:inline">${csrfField(csrf)}<input type="hidden" name="id" value="${esc(r.id)}"><button class="secondary danger">Reject</button></form></div>`
      : `<p class="muted">${esc(r.status)} ${ago(r.decided_at)}${r.result ? ` · ${esc(r.result)}` : ''}</p>`;
    return `<div class="plugin" data-request="${esc(r.id)}" data-status="${esc(r.status)}"><p><strong>${requestWhat(r)}</strong> for ${dev}</p>
<p>Requested by <code>${esc(r.client ?? '?')}</code> ${ago(r.created_at)}. Reason: ${esc(r.reason)}</p>${actions}</div>`;
  }).join('');
  const n = requests.filter((r) => r.status === 'pending').length;
  return `<div class="section" id="plugin-requests"><div class="section-head"><div><h2>Plugin requests</h2><p>${n} waiting for your approval. AI clients can only ask; nothing is installed until you approve.</p></div></div><div class="panel">${rows}</div></div>`;
}

function deviceChoices(devices: TargetDevice[], selected: Set<string>): string {
  if (!devices.length) return '<p class="err">No paired devices.</p>';
  return devices.map((d) => {
    const usable = d.online && d.supported;
    const why = !d.online ? ' (offline)' : !d.supported ? ' (agent too old for plugins)' : '';
    return `<label class="inline"><input type="checkbox" name="device_id" value="${esc(d.device_id)}"${usable ? '' : ' disabled'}${usable && (selected.has(d.device_id) || (selected.size === 0 && devices.filter((x) => x.online && x.supported).length === 1)) ? ' checked' : ''}> ${esc(d.name)}${why}</label>`;
  }).join('');
}

function extraEnvRows(n: number): string {
  let out = '';
  for (let i = 1; i <= n; i++) out += `<div class="kv"><input name="xenv_name_${i}" placeholder="NEW_VARIABLE" autocomplete="off" aria-label="Variable name"><input type="password" name="xenv_value_${i}" placeholder="value" autocomplete="off" aria-label="Variable value"></div>`;
  return out;
}

const STYLE = `<style>.plugin{border-top:1px solid var(--line);padding:12px 0}.plugin:first-of-type{border-top:0}.kv{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:center;margin:6px 0}.kv label{margin:0}label.inline{display:inline-flex;gap:6px;align-items:center;margin:4px 14px 4px 0;font-weight:500;color:inherit}label.inline input{width:auto}details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:12px}select{padding:9px 10px;border:1px solid var(--line);border-radius:10px;font:inherit;background:inherit;color:inherit}button[disabled]{opacity:.45;cursor:not-allowed;transform:none}.results{display:grid;gap:12px}.entry h3{margin:0;font-size:15px}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}@media(max-width:760px){.kv{grid-template-columns:1fr}}</style>`;
export const pluginStyles = STYLE;

export interface MarketplaceView {
  q: string;
  entries: RegistryEntry[];
  nextCursor?: string;
  error?: string;
  registrySource: string;
  devices: TargetDevice[];
  selectedDevice?: string;
  csrf: string;
}

export function marketplacePage(v: MarketplaceView): string {
  const dq = v.selectedDevice ? `&device=${encodeURIComponent(v.selectedDevice)}` : '';
  const results = v.entries.map((e) => {
    const install = e.option
      ? `<a href="/admin/marketplace/install?name=${encodeURIComponent(e.name)}${dq}"><button class="primary" type="button">Install…</button></a>`
      : `<span class="pill err">${esc(e.unsupported ?? 'not supported')}</span>`;
    return `<div class="panel entry" data-name="${esc(e.name)}"><div class="device-top"><div><h3>${esc(e.title || e.name)}</h3>
<p><code>${esc(e.name)}</code> · publisher <code>${esc(e.namespace)}</code> · v${esc(e.version)}</p></div>${install}</div>
<p>${esc(e.description)}</p><div class="tags">${e.kinds.map((k) => `<span class="pill">${esc(k)}</span>`).join('')}${e.option ? `<span class="pill ok">${esc(e.option.label)}</span>` : ''}</div>
${e.requiredInputs.length ? `<p>Requires: ${e.requiredInputs.map((n) => `<code>${esc(n)}</code>`).join(' ')}</p>` : ''}
<p>${safeLink(e.repositoryUrl, 'Source')} ${safeLink(e.websiteUrl, 'Website')}</p></div>`;
  }).join('');
  const more = v.nextCursor ? `<div class="row"><a href="/admin/marketplace?q=${encodeURIComponent(v.q)}&cursor=${encodeURIComponent(v.nextCursor)}${dq}"><button class="secondary">More results</button></a></div>` : '';
  const selected = new Set(v.selectedDevice ? [v.selectedDevice] : []);
  return layout('Marketplace', `${STYLE}<div class="section-head"><div><h1>Plugin marketplace</h1><p>Search the official MCP Registry and install MCP servers on your devices. Entries are published by third parties: review the source before installing.</p></div><a href="/admin"><button class="secondary">Back to admin</button></a></div>
<form method="get" action="/admin/marketplace" class="row" style="margin-top:0">${v.selectedDevice ? `<input type="hidden" name="device" value="${esc(v.selectedDevice)}">` : ''}<input name="q" value="${esc(v.q)}" placeholder="Search servers, e.g. playwright, github, filesystem" style="flex:1;min-width:200px" maxlength="100"><button class="primary" type="submit">Search</button></form>
<p class="muted" style="font-size:12px">Source: ${esc(v.registrySource)}</p>
${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}
<div class="results section">${results || (v.q && !v.error ? '<p>No matching servers.</p>' : '')}</div>${more}
<div class="section panel" id="custom"><h2>Custom plugin</h2><p>Install something that is not in the registry. npm: <code>package@1.2.3</code> · PyPI: <code>package==1.2.3</code> · command line: <code>node C:\\tools\\server.mjs --flag</code> · remote: <code>https://host/mcp</code></p>
<form method="post" action="/admin/plugins/install">${csrfField(v.csrf)}<input type="hidden" name="source" value="custom">
<label>Type</label><select name="custom_type"><option value="npm">npm package</option><option value="pypi">PyPI package</option><option value="command">Command line</option><option value="remote">Remote (https)</option></select>
<label>Spec</label><input name="custom_spec" required maxlength="4096" autocomplete="off">
<div class="kv"><div><label>Plugin id (a-z, 0-9, -)</label><input name="plugin_id" pattern="[a-z0-9][a-z0-9-]{0,62}" maxlength="64" placeholder="derived from spec"></div><div><label>Display name</label><input name="name" maxlength="120"></div></div>
<label>Environment variables (sent to the device only)</label>${extraEnvRows(4)}
<label>Devices</label>${deviceChoices(v.devices, selected)}
<div class="row"><button class="primary" type="submit">Install</button></div></form></div>`, 'wide');
}

function inputField(i: RegistryInput): string {
  const field = `in_${i.kind}_${i.name}`;
  const kindLabel = i.kind === 'env' ? 'environment variable' : i.kind === 'header' ? 'HTTP header' : i.kind === 'var' ? 'URL variable' : 'argument';
  return `<label>${esc(i.name)} <span class="muted">(${kindLabel}${i.required ? ', required' : ''}${i.secret ? ', secret' : ''})</span></label>
<input name="${esc(field)}" ${i.secret ? 'type="password" autocomplete="off"' : 'autocomplete="off"'}${i.required && !i.default ? ' required' : ''}${i.default && !i.secret ? ` value="${esc(i.default)}"` : ''}${i.placeholder ? ` placeholder="${esc(i.placeholder)}"` : ''}>
${i.description ? `<p style="font-size:12px;margin-top:4px">${esc(i.description)}</p>` : ''}`;
}

export interface InstallView {
  csrf: string;
  devices: TargetDevice[];
  selectedDevice?: string;
  entry?: RegistryEntry;
  custom?: { type: string; spec: string; pluginId?: string };
  request?: PluginRequestRow;
  error?: string;
}

export function installPage(v: InstallView): string {
  const selected = new Set(v.selectedDevice ? [v.selectedDevice] : []);
  const req = v.request ? `<div class="panel"><p><strong>Approving request</strong> <code>${esc(v.request.id)}</code> from <code>${esc(v.request.client ?? '?')}</code></p><p>Reason given: ${esc(v.request.reason)}</p></div>
<input type="hidden" name="request_id" value="${esc(v.request.id)}">` : '';
  let body: string;
  if (v.entry) {
    const e = v.entry;
    const opt = e.option;
    body = `<h1>Install ${esc(e.title || e.name)}</h1><p><code>${esc(e.name)}</code> · publisher <code>${esc(e.namespace)}</code> · v${esc(e.version)}</p><p>${esc(e.description)}</p>
<p>${safeLink(e.repositoryUrl, 'Source')} ${safeLink(e.websiteUrl, 'Website')}</p>
${opt ? `<form method="post" action="/admin/plugins/install">${csrfField(v.csrf)}${req}<input type="hidden" name="source" value="registry"><input type="hidden" name="registry_name" value="${esc(e.name)}">
<p>Installs <span class="pill ok">${esc(opt.label)}</span></p>
<div class="kv"><div><label>Plugin id (a-z, 0-9, -)</label><input name="plugin_id" value="${esc(v.request?.plugin_id ?? e.suggestedId)}" pattern="[a-z0-9][a-z0-9-]{0,62}" maxlength="64" required></div><div><label>Display name</label><input name="name" value="${esc(e.title ?? '')}" maxlength="120"></div></div>
${opt.inputs.map(inputField).join('')}
<details><summary>More environment variables</summary>${extraEnvRows(3)}</details>
<label>Devices</label>${deviceChoices(v.devices, selected)}
<p class="muted">Secrets are sent to the selected devices only; the relay does not store them.</p>
<div class="row"><button class="primary" type="submit">${v.request ? 'Approve and install' : 'Install'}</button><a href="${v.request ? '/admin#plugin-requests' : '/admin/marketplace'}"><button class="secondary" type="button">Cancel</button></a></div></form>`
      : `<p class="err">Cannot be installed by BRC: ${esc(e.unsupported ?? 'not supported')}</p>`}`;
  } else if (v.custom) {
    const c = v.custom;
    body = `<h1>Install custom plugin</h1><form method="post" action="/admin/plugins/install">${csrfField(v.csrf)}${req}<input type="hidden" name="source" value="custom">
<label>Type</label><select name="custom_type">${['npm', 'pypi', 'command', 'remote'].map((t) => `<option value="${t}"${t === c.type ? ' selected' : ''}>${t}</option>`).join('')}</select>
<label>Spec</label><input name="custom_spec" value="${esc(c.spec)}" required maxlength="4096" autocomplete="off">
<div class="kv"><div><label>Plugin id</label><input name="plugin_id" value="${esc(c.pluginId ?? '')}" pattern="[a-z0-9][a-z0-9-]{0,62}" maxlength="64" placeholder="derived from spec"></div><div><label>Display name</label><input name="name" maxlength="120"></div></div>
<label>Environment variables (sent to the device only)</label>${extraEnvRows(4)}
<label>Devices</label>${deviceChoices(v.devices, selected)}
<div class="row"><button class="primary" type="submit">${v.request ? 'Approve and install' : 'Install'}</button><a href="/admin"><button class="secondary" type="button">Cancel</button></a></div></form>`;
  } else {
    body = '<h1>Install plugin</h1>';
  }
  return layout('Install plugin', `${STYLE}${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}${body}`, 'wide');
}

export interface InstallOutcomeView { device: string; ok: boolean; message: string }

export function installResultPage(title: string, outcomes: InstallOutcomeView[], error?: string): string {
  const rows = outcomes.map((o) => `<li><strong>${esc(o.device)}</strong>: <span class="${o.ok ? 'ok' : 'err'}">${esc(o.message)}</span></li>`).join('');
  return layout('Plugin install', `${STYLE}<h1>${esc(title)}</h1>${error ? `<p class="err">${esc(error)}</p>` : ''}${rows ? `<ul>${rows}</ul>` : ''}
<div class="row"><a href="/admin#plugins"><button class="primary">Back to admin</button></a><a href="/admin/marketplace"><button class="secondary">Marketplace</button></a></div>`, 'wide');
}
