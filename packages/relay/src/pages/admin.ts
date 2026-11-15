/** Admin dashboard pages: devices (pause/rename/delete), live activity (not saved), client edit. */
import { layout, esc } from './html.js';

export interface DeviceView { device_id: string; name: string; platform: string | null; online: boolean; paused: number; last_seen: number | null; created_at: number }
export interface AuditView { ts: number; device: string; client: string | null; tool: string; ok: number; ms: number | null; error: string | null }

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

export function adminPage(publicUrl: string, devices: DeviceView[], audit: AuditView[], stats: { total: number; failed: number; last24h: number }): string {
  const devRows = devices.length ? devices.map((d) => `<div class="device"><form method="post" action="/admin/device">
<input type="hidden" name="device_id" value="${esc(d.device_id)}"><div class="device-top"><div><input name="name" value="${esc(d.name)}" aria-label="Device name"><p>${esc(d.platform ?? 'Unknown platform')} · seen ${ago(d.last_seen)}</p></div>${d.online ? '<span class="pill ok"><span class="dot"></span>Online</span>' : '<span class="pill muted"><span class="dot"></span>Offline</span>'}</div>
<p><code>${esc(d.device_id)}</code>${d.paused ? ' <span class="pill err">Paused</span>' : ''}</p><div class="actions"><button class="secondary" name="action" value="rename">Save name</button><button class="secondary" name="action" value="${d.paused ? 'resume' : 'pause'}">${d.paused ? 'Resume' : 'Pause'}</button><button class="secondary danger" name="action" value="delete" onclick="return confirm('Remove device and revoke its token?')">Delete</button></div></form></div>`).join('') : '<div class="panel"><p>No devices paired yet.</p></div>';

  const auditRows = audit.length ? audit.map((a) => `<tr><td>${ago(a.ts)}</td><td>${esc(a.device)}</td><td><code>${esc(a.tool)}</code></td><td>${a.ok ? '<span class="pill ok">OK</span>' : '<span class="pill err">Failed</span>'}</td><td>${a.ms ?? '—'}</td><td class="muted">${esc((a.error ?? '').slice(0, 80))}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No calls yet.</td></tr>';

  return layout('Admin', `<div class="section-head"><div><h1>Relay admin</h1><p>Manage devices, credentials, and recent MCP activity.</p></div><div class="row" style="margin-top:0"><a href="/device/verify"><button class="primary">Pair device</button></a><a href="/auth/logout"><button class="secondary">Sign out</button></a></div></div>
<div class="panel"><p class="muted">MCP endpoint</p><p><code>${esc(publicUrl)}/mcp</code></p></div>
<div class="grid section"><div class="panel stat"><span class="muted">Total calls</span><strong>${stats.total}</strong></div><div class="panel stat"><span class="muted">Last 24 hours</span><strong>${stats.last24h}</strong></div><div class="panel stat"><span class="muted">Failed calls</span><strong class="${stats.failed ? 'err' : ''}">${stats.failed}</strong></div></div>
<div class="row"><a href="/auth/links"><button class="primary">Connect without OAuth</button></a><a href="/auth/clients"><button class="secondary">OAuth clients</button></a><a href="/auth/apikeys"><button class="secondary">API keys</button></a></div>
<div class="section"><div class="section-head"><div><h2>Devices</h2><p>${devices.length} paired device${devices.length === 1 ? '' : 's'}</p></div></div><div class="device-grid">${devRows}</div></div>
<div class="section"><div class="section-head"><div><h2>Recent MCP calls</h2><p>Latest activity across your paired devices.</p></div></div><div class="panel table-wrap" style="padding:0"><table><thead><tr><th>When</th><th>Device</th><th>Tool</th><th>Result</th><th>Latency</th><th>Error</th></tr></thead><tbody>${auditRows}</tbody></table></div></div>`, 'wide');
}

export function apiKeysPage(keys: { prefix: string; name: string; created_at: number; last_used: number | null }[], created?: { name: string; raw: string }): string {
  const banner = created ? `<p class="ok">API key "${esc(created.name)}" created. Copy it now — it is not shown again.</p>
<label>API key</label><input readonly value="${esc(created.raw)}" onclick="this.select()">
<p style="font-size:12px">Use as <code>Authorization: Bearer ${esc(created.raw.slice(0, 18))}…</code> on <code>/mcp</code>.</p>` : '';
  const rows = keys.length ? `<ul>${keys.map((k) => `<li><strong>${esc(k.name)}</strong> <code>${esc(k.prefix)}…</code> · created ${ago(k.created_at)} · last used ${ago(k.last_used)}
<form method="post" action="/auth/apikeys/revoke" style="display:inline"><input type="hidden" name="prefix" value="${esc(k.prefix)}"><button class="secondary" style="padding:4px 10px" onclick="return confirm('Revoke this key?')">Revoke</button></form></li>`).join('')}</ul>` : '<p>No API keys.</p>';
  return layout('API keys', `<h1>API keys</h1>${banner}
<p>Long-lived bearer tokens as an alternative to OAuth. Anyone holding a key can control your paired devices — treat it like a password.</p>
<form method="post" action="/auth/apikeys"><label>Name</label><input name="name" placeholder="MCP client" required>
<div class="row"><button class="primary" type="submit">Create key</button></div></form>
<h1 style="margin-top:22px">Existing</h1>${rows}<p><a href="/admin">Back</a></p>`);
}

export interface ConnectionLinkView { id: string; name: string; mode: 'read' | 'full'; created_at: number; expires_at: number }

/** The raw capability URL is revealed only in the immediate creation response. */
export function connectionLinksPage(
  links: ConnectionLinkView[],
  csrf: string,
  created?: { name: string; url: string; expiresAt: number },
  error?: string,
): string {
  const banner = created ? `<div class="panel section">
<h2 class="ok">Connection URL created</h2><p>Copy this URL now. It will not be displayed again.</p>
<label>Private MCP URL</label><input id="new-connection-url" class="mono" readonly value="${esc(created.url)}" onclick="this.select()" autocomplete="off" spellcheck="false">
<div class="row"><button type="button" class="primary" onclick="navigator.clipboard.writeText(document.getElementById('new-connection-url').value).then(()=>{this.textContent='Copied!'},()=>{document.getElementById('new-connection-url').select()})">Copy URL</button></div>
<p class="err"><strong>Anyone with this URL can access the tools allowed by this connection.</strong> Do not share it or paste it into public issue reports.</p>
<p>Expires ${esc(new Date(created.expiresAt).toUTCString())}.</p></div>` : '';
  const rows = links.length ? links.map(l => `<div class="device"><div class="device-top"><div>
<strong>${esc(l.name)}</strong><p>${l.mode === 'read' ? 'Read only' : '<span class="err">Full access — can edit files and run commands</span>'}</p>
<p class="muted">Expires ${esc(new Date(l.expires_at).toUTCString())}</p></div><span class="pill ok">Active</span></div>
<form method="post" action="/auth/links/revoke" onsubmit="return confirm('Revoke this connection URL immediately?')">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="link_id" value="${esc(l.id)}">
<button type="submit" class="secondary danger">Revoke URL</button></form></div>`).join('') : '<p>No active connection URLs. Create one below.</p>';
  return layout('Connect without OAuth', `<h1>Connect without OAuth</h1>
<p>Create a private URL once and paste it into any MCP client that supports a custom Streamable HTTP URL and no-auth connections. No OAuth callback or headers to configure.</p>
<p><strong>Security:</strong> the randomly generated URL is a secret credential. Use HTTPS and revoke URLs you no longer need. The ordinary <code>/mcp</code> OAuth endpoint remains unchanged.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}${banner}
<div class="section panel"><h2>Create a connection URL</h2>
<form method="post" action="/auth/links">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Connection name</label><input name="name" maxlength="80" placeholder="My MCP client" required>
<label>Access level</label><select name="mode" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);color:var(--text)" required>
<option value="read" selected>Read only (safer)</option>
<option value="full">Full access (files + terminal + other tools)</option></select>
<label>Expires after</label><select name="days" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);color:var(--text)">
<option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="90">90 days</option></select>
<div class="row"><button type="submit" class="primary">Generate private MCP URL</button></div></form></div>
<div class="section"><h2>Active connections (${links.length})</h2><div class="device-grid">${rows}</div></div>
<p class="section"><a href="/admin">Back to admin</a></p>`, 'wide');
}
