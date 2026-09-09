/** Admin dashboard pages: devices (pause/rename/delete), audit log, client edit. */
import { layout, esc } from './html.js';

export interface DeviceView { device_id: string; name: string; platform: string | null; online: boolean; paused: number; last_seen: number | null; created_at: number }
export interface AuditView { ts: number; device: string; client: string | null; tool: string; ok: number; ms: number | null; error: string | null }

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

export function adminPage(publicUrl: string, devices: DeviceView[], audit: AuditView[], stats: { total: number; failed: number; last24h: number }): string {
  const devRows = devices.length ? devices.map((d) => `<li style="margin-bottom:12px">
<form method="post" action="/admin/device" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
<input type="hidden" name="device_id" value="${esc(d.device_id)}">
<input name="name" value="${esc(d.name)}" style="width:160px;padding:6px 8px">
<span>${esc(d.platform ?? '')} · ${d.online ? '<span class="ok">online</span>' : 'offline'} · seen ${ago(d.last_seen)}${d.paused ? ' · <span class="err">paused</span>' : ''}</span>
<button class="secondary" name="action" value="rename" style="flex:0;padding:6px 10px">Rename</button>
<button class="secondary" name="action" value="${d.paused ? 'resume' : 'pause'}" style="flex:0;padding:6px 10px">${d.paused ? 'Resume' : 'Pause'}</button>
<button class="secondary" name="action" value="delete" style="flex:0;padding:6px 10px" onclick="return confirm('Remove device and revoke its token?')">Delete</button>
</form><small><code>${esc(d.device_id)}</code></small></li>`).join('') : '<li>No devices paired.</li>';

  const auditRows = audit.length ? audit.map((a) => `<tr><td>${ago(a.ts)}</td><td>${esc(a.device)}</td><td><code>${esc(a.tool)}</code></td><td>${a.ok ? '<span class="ok">ok</span>' : `<span class="err">fail</span>`}</td><td>${a.ms ?? ''}</td><td><small>${esc((a.error ?? '').slice(0, 60))}</small></td></tr>`).join('') : '<tr><td colspan="6">No calls yet.</td></tr>';

  return layout('Admin', `<h1>Admin</h1>
<p>MCP <code>${esc(publicUrl)}/mcp</code> · OpenAPI <code>${esc(publicUrl)}/openapi.json</code></p>
<p>${stats.total} calls total · ${stats.last24h} in 24h · ${stats.failed} failed</p>
<div class="row"><a href="/device/verify"><button class="primary">Pair a device</button></a><a href="/auth/clients"><button class="secondary">OAuth clients</button></a><a href="/auth/logout"><button class="secondary">Sign out</button></a></div>
<h1 style="margin-top:22px">Devices</h1><ul style="list-style:none;padding:0">${devRows}</ul>
<h1 style="margin-top:22px">Recent calls</h1>
<table style="width:100%;font-size:13px;border-collapse:collapse"><tr><th align="left">when</th><th align="left">device</th><th align="left">tool</th><th align="left">result</th><th align="left">ms</th><th align="left">error</th></tr>${auditRows}</table>`, 'wide');
}

export function clientEditPage(c: { client_id: string; name: string; redirect_uris: string[]; redirect_base?: string }): string {
  return layout('Edit client', `<h1>Edit ${esc(c.name)}</h1><p><code>${esc(c.client_id)}</code></p>
<form method="post" action="/auth/clients/edit"><input type="hidden" name="client_id" value="${esc(c.client_id)}">
<label>Name</label><input name="name" value="${esc(c.name)}" required>
<label>Redirect URI(s), one per line</label><textarea name="redirect_uris" rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d3d1c8;border-radius:8px;font:inherit">${esc(c.redirect_uris.join('\n'))}</textarea>
<label>After-consent redirect base (optional)</label><input name="redirect_base" value="${esc(c.redirect_base ?? '')}" placeholder="https://chatgpt.example.com">
<div class="row"><a href="/auth/clients"><button type="button" class="secondary">Cancel</button></a><button class="primary" type="submit">Save</button></div></form>`);
}
