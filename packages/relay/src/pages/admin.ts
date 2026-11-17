/** Admin dashboard pages: devices (pause/rename/delete), audit log, client edit. */
import { layout, esc } from './html.js';

export interface DeviceView { device_id: string; name: string; platform: string | null; online: boolean; paused: number; last_seen: number | null; created_at: number }
export interface AuditView { ts: number; device: string; client: string | null; tool: string; ok: number; ms: number | null; error: string | null }

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

/** `pluginHtml` = plugin requests + plugins sections (pages/plugins.ts), `flash` = escaped status line. */
export function adminPage(publicUrl: string, devices: DeviceView[], audit: AuditView[], stats: { total: number; failed: number; last24h: number }, pluginHtml = '', flash = '', extraHtml = ''): string {
  const devRows = devices.length ? devices.map((d) => `<div class="device"><form method="post" action="/admin/device">
<input type="hidden" name="device_id" value="${esc(d.device_id)}"><div class="device-top"><div><label for="dn-${esc(d.device_id)}" style="margin-top:0">Device name</label><input id="dn-${esc(d.device_id)}" name="name" value="${esc(d.name)}" maxlength="80"><p>${esc(d.platform ?? 'Unknown platform')} · seen ${ago(d.last_seen)}</p></div>${d.online ? '<span class="pill ok"><span class="dot"></span>Online</span>' : '<span class="pill muted"><span class="dot"></span>Offline</span>'}</div>
<p><code>${esc(d.device_id)}</code>${d.paused ? ' <span class="pill err">Paused</span>' : ''}</p><div class="actions"><button class="secondary" name="action" value="rename">Save name</button><button class="secondary" name="action" value="${d.paused ? 'resume' : 'pause'}">${d.paused ? 'Resume' : 'Pause'}</button><button class="secondary danger" name="action" value="delete" onclick="return confirm('Remove device and revoke its token?')">Delete</button></div></form></div>`).join('') : '<div class="empty">No devices paired yet.</div>';

  const auditRows = audit.length ? audit.map((a) => `<tr><td>${ago(a.ts)}</td><td>${esc(a.device)}</td><td><code>${esc(a.tool)}</code></td><td>${a.ok ? '<span class="pill ok">OK</span>' : '<span class="pill err">Failed</span>'}</td><td>${a.ms ?? '—'}</td><td class="muted">${esc((a.error ?? '').slice(0, 80))}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No calls yet.</td></tr>';

  return layout('Admin', `<div class="section-head"><div><h1>Relay admin</h1><p>Manage devices, credentials, and recent MCP activity.</p></div><div class="row" style="margin-top:0"><a class="btn primary" href="/device/verify">Pair device</a></div></div>
<div class="panel"><p class="muted">MCP endpoint</p><p><code>${esc(publicUrl)}/mcp</code></p></div>
<div class="grid section"><div class="panel stat"><span class="muted">Total calls</span><strong>${stats.total}</strong></div><div class="panel stat"><span class="muted">Last 24 hours</span><strong>${stats.last24h}</strong></div><div class="panel stat"><span class="muted">Failed calls</span><strong class="${stats.failed ? 'err' : ''}">${stats.failed}</strong></div></div>
${flash}${extraHtml}<div class="row"><a class="btn secondary" href="/auth/clients">OAuth clients</a><a class="btn secondary" href="/auth/apikeys">API keys</a><a class="btn secondary" href="/auth/links">Private links</a><a class="btn secondary" href="/admin/marketplace">Plugin marketplace</a></div>
<div class="section" id="devices"><div class="section-head"><div><h2>Devices</h2><p>${devices.length} paired device${devices.length === 1 ? '' : 's'}</p></div></div><div class="device-grid">${devRows}</div></div>${pluginHtml}
<div class="section" id="activity"><div class="section-head"><div><h2>Recent MCP calls</h2><p>Latest activity across your paired devices.</p></div></div><div class="panel table-wrap"><table><thead><tr><th>When</th><th>Device</th><th>Tool</th><th>Result</th><th>Latency</th><th>Error</th></tr></thead><tbody>${auditRows}</tbody></table></div></div>`, 'wide');
}

export interface ConnectionLinkView { id: string; name: string; mode: 'read' | 'full'; created_at: number; expires_at: number }
const until = (t: number) => new Date(t).toUTCString();
export function connectionLinksPage(links: ConnectionLinkView[], csrf: string, created?: { name: string; url: string; expiresAt: number }, error?: string): string {
  const banner = created ? `<div class="panel" role="status"><h2>Private URL created: ${esc(created.name)}</h2>
<p>Copy it now. It is a bearer credential and is not shown again. Expires ${esc(until(created.expiresAt))}.</p>
<label for="new-url">Private URL</label><input id="new-url" class="mono" readonly value="${esc(created.url)}" onclick="this.select()" autocomplete="off" spellcheck="false"></div>` : '';
  const rows = links.length ? links.map((l) => `<div class="panel"><strong>${esc(l.name)}</strong> <span class="pill ${l.mode === 'read' ? 'ok' : 'err'}">${l.mode === 'read' ? 'Read only' : 'Full access'}</span>
<p class="muted">Created ${ago(l.created_at)} - expires ${esc(until(l.expires_at))}</p>
<form method="post" action="/auth/links/revoke"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="link_id" value="${esc(l.id)}"><button class="secondary danger" onclick="return confirm('Revoke this URL immediately?')">Revoke</button></form></div>`).join('') : '<div class="empty">No active private URLs.</div>';
  return layout('Private MCP links', `<h1>Private MCP links</h1>
<p>Connect an MCP client without OAuth using a secret Streamable HTTP URL. Anyone holding a URL can use its permitted tools until it expires or is revoked. Use HTTPS. Read-only links can only inspect files, git and search; full links can run commands.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}${banner}
<div class="panel"><form method="post" action="/auth/links"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="link-name">Name</label><input id="link-name" name="name" maxlength="80" placeholder="e.g. My ChatGPT connector" required>
<label for="link-mode">Access</label><select id="link-mode" name="mode"><option value="read" selected>Read only (recommended)</option><option value="full">Full access (files, terminal, plugins)</option></select>
<label for="link-days">Expires after</label><select id="link-days" name="days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="90">90 days</option></select>
<div class="row"><button class="primary" type="submit">Generate private URL</button></div></form></div>
<h2 style="margin-top:26px">Active URLs</h2>${rows}<div class="row"><a class="btn secondary" href="/admin">Back</a></div>`);
}

export function apiKeysPage(keys: { prefix: string; name: string; created_at: number; last_used: number | null }[], created?: { name: string; raw: string }): string {
  const banner = created ? `<p class="ok">API key "${esc(created.name)}" created. Copy it now — it is not shown again.</p>
<label for="new-key">API key</label><input id="new-key" class="mono" readonly value="${esc(created.raw)}" onclick="this.select()" autocomplete="off" spellcheck="false">
<p>Use as <code>Authorization: Bearer ${esc(created.raw.slice(0, 18))}…</code> on <code>/mcp</code>.</p>` : '';
  const rows = keys.length ? `<div class="device-grid">${keys.map((k) => `<div class="device"><strong>${esc(k.name)}</strong> <code>${esc(k.prefix)}…</code> · created ${ago(k.created_at)} · last used ${ago(k.last_used)}
<form method="post" action="/auth/apikeys/revoke"><input type="hidden" name="prefix" value="${esc(k.prefix)}"><div class="actions"><button class="secondary danger" onclick="return confirm('Revoke this key?')">Revoke</button></div></form></div>`).join('')}</div>` : '<div class="empty">No API keys.</div>';
  return layout('API keys', `<h1>API keys</h1>${banner}
<p>Long-lived bearer tokens as an alternative to OAuth. Anyone holding a key can control your paired devices — treat it like a password.</p>
<div class="panel"><form method="post" action="/auth/apikeys"><label for="key-name" style="margin-top:0">Name</label><input id="key-name" name="name" placeholder="MCP client" required>
<div class="row"><button class="primary" type="submit">Create key</button></div></form></div>
<h2 style="margin-top:26px">Existing</h2>${rows}<div class="row"><a class="btn secondary" href="/admin">Back</a></div>`);
}
