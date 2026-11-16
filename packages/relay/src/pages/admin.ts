/** Admin dashboard pages: devices (pause/rename/delete), live activity (not saved), client edit. */
import { layout, esc } from './html.js';

export interface DeviceView { device_id: string; name: string; platform: string | null; online: boolean; paused: number; last_seen: number | null; created_at: number }
export interface AuditView { ts: number; device: string; client: string | null; tool: string; ok: number; ms: number | null; error: string | null }

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

/** `pluginHtml` = plugin requests + plugins sections (pages/plugins.ts), `flash` = escaped status line. */
export function adminPage(publicUrl: string, devices: DeviceView[], audit: AuditView[], stats: { total: number; failed: number; last24h: number }, pluginHtml = '', flash = ''): string {
  const devRows = devices.length ? devices.map((d) => `<div class="device"><form method="post" action="/admin/device">
<input type="hidden" name="device_id" value="${esc(d.device_id)}"><div class="device-top"><div><input name="name" value="${esc(d.name)}" aria-label="Device name"><p>${esc(d.platform ?? 'Unknown platform')} · seen ${ago(d.last_seen)}</p></div>${d.online ? '<span class="pill ok"><span class="dot"></span>Online</span>' : '<span class="pill muted"><span class="dot"></span>Offline</span>'}</div>
<p><code>${esc(d.device_id)}</code>${d.paused ? ' <span class="pill err">Paused</span>' : ''}</p><div class="actions"><button class="secondary" name="action" value="rename">Save name</button><button class="secondary" name="action" value="${d.paused ? 'resume' : 'pause'}">${d.paused ? 'Resume' : 'Pause'}</button><button class="secondary danger" name="action" value="delete" onclick="return confirm('Remove device and revoke its token?')">Delete</button></div></form></div>`).join('') : '<div class="panel"><p>No devices paired yet.</p></div>';

  const auditRows = audit.length ? audit.map((a) => `<tr><td>${ago(a.ts)}</td><td>${esc(a.device)}</td><td><code>${esc(a.tool)}</code></td><td>${a.ok ? '<span class="pill ok">OK</span>' : '<span class="pill err">Failed</span>'}</td><td>${a.ms ?? '—'}</td><td class="muted">${esc((a.error ?? '').slice(0, 80))}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No calls yet.</td></tr>';

  return layout('Admin', `<div class="section-head"><div><h1>Relay admin</h1><p>Manage devices, credentials, and recent MCP activity.</p></div><div class="row" style="margin-top:0"><a href="/device/verify"><button class="primary">Pair device</button></a><a href="/auth/logout"><button class="secondary">Sign out</button></a></div></div>
<div class="panel"><p class="muted">MCP endpoint</p><p><code>${esc(publicUrl)}/mcp</code></p><p>Agent tools are discoverable even when your PC is offline. If an AI client only shows <code>list_devices</code> after upgrading, refresh/reconnect that MCP connector to reload its cached tool list.</p></div>
<div class="grid section"><div class="panel stat"><span class="muted">Total calls</span><strong>${stats.total}</strong></div><div class="panel stat"><span class="muted">Last 24 hours</span><strong>${stats.last24h}</strong></div><div class="panel stat"><span class="muted">Failed calls</span><strong class="${stats.failed ? 'err' : ''}">${stats.failed}</strong></div></div>
<div class="row"><a href="/auth/links"><button class="primary">Connect without OAuth</button></a><a href="/auth/clients"><button class="secondary">OAuth clients</button></a><a href="/auth/apikeys"><button class="secondary">API keys</button></a></div>
<div class="section"><div class="section-head"><div><h2>Devices</h2><p>${devices.length} paired device${devices.length === 1 ? '' : 's'}</p></div></div><div class="device-grid">${devRows}</div></div>
${flash}${pluginHtml}
<div class="section"><div class="section-head"><div><h2>Recent MCP calls</h2><p>Latest activity across your paired devices.</p></div></div><div class="panel table-wrap" style="padding:0"><table><thead><tr><th>When</th><th>Device</th><th>Tool</th><th>Result</th><th>Latency</th><th>Error</th></tr></thead><tbody>${auditRows}</tbody></table></div></div>`, 'wide');
}

export function apiKeysPage(
  keys: { prefix: string; name: string; created_at: number; last_used: number | null }[],
  created?: { name: string; raw: string },
): string {
  const notice = created ? `<div class="credential-secret" role="status">
    <span class="brand">NEW API KEY · ONE-TIME DISPLAY</span>
    <h2>${esc(created.name)} is ready</h2>
    <p>Copy this credential now. For security, the full key will never be shown again.</p>
    <label for="new-api-key">Your API key</label>
    <input id="new-api-key" readonly value="${esc(created.raw)}" autocomplete="off" spellcheck="false" onclick="this.select()">
    <div class="row"><button class="primary" type="button" onclick="const e=document.getElementById('new-api-key');navigator.clipboard.writeText(e.value).then(()=>{this.textContent='Copied'},()=>{e.select()})">Copy key</button>
      <span class="muted" style="font-size:11px">Use in your client's Authorization: Bearer header.</span></div>
  </div>` : '';
  const cards=keys.length ? keys.map(key=>`<div class="credential-card">
    <div class="device-top"><div style="min-width:0">
      <span class="brand">ACTIVE CREDENTIAL</span><h2>${esc(key.name)}</h2><code>${esc(key.prefix)}…</code>
    </div><span class="pill ok"><span class="dot"></span>Active</span></div>
    <p style="font-size:12px;margin-top:12px">Created ${ago(key.created_at)}<br>Last used ${ago(key.last_used)}</p>
    <form method="post" action="/auth/apikeys/revoke" onsubmit="return confirm('Revoke this API key immediately?')">
      <input type="hidden" name="prefix" value="${esc(key.prefix)}">
      <div class="actions"><button type="submit" class="secondary danger">Revoke key</button></div>
    </form></div>`).join('') : '<div class="empty">No API keys yet. Create one above to connect a trusted client.</div>';
  return layout('API keys', `<div class="section-head"><div class="page-heading">
    <span class="brand">ACCESS MANAGEMENT</span><h1>API keys</h1>
    <p>Create and revoke credentials for trusted MCP clients and usage reporters.</p></div>
    <a href="/auth/clients" class="btn secondary">Manage OAuth clients</a></div>
    <div class="access-banner"><span class="symbol">!</span><div>
      <strong>Keep your keys private</strong><p>A holder of a valid API key can access your devices through this relay. Create separate keys for each client and revoke those no longer needed.</p></div></div>
    ${notice}
    <div class="admin-two-col section">
      <div class="panel panel-form"><span class="brand">CREATE A KEY</span>
        <h2>New API credential</h2><p>Name it after the service or application that will use it.</p>
        <form method="post" action="/auth/apikeys">
          <label for="key-name">Credential name</label>
          <input id="key-name" name="name" maxlength="120" placeholder="e.g. Backend model usage reporter" required>
          <div class="row"><button class="primary" type="submit">Create API key</button></div>
        </form></div>
      <div class="panel"><span class="brand">BEST PRACTICES</span><h2>Secure by design</h2>
        <div class="admin-steps">
          <div class="admin-step"><span class="num">1</span><div><strong>Create a dedicated key</strong><p>Use different keys for separate services.</p></div></div>
          <div class="admin-step"><span class="num">2</span><div><strong>Store it securely</strong><p>Only the new key is shown once after creation.</p></div></div>
          <div class="admin-step"><span class="num">3</span><div><strong>Revoke old access</strong><p>Remove credentials you no longer trust.</p></div></div>
        </div></div>
    </div>
    <section class="section"><div class="section-head"><div><span class="brand">ISSUED CREDENTIALS</span>
      <h2>Existing API keys</h2><p>${keys.length} active key${keys.length===1?'':'s'}.</p></div></div>
      <div class="credential-list">${cards}</div></section>`,'wide');
}

export interface ConnectionLinkView { id: string; name: string; mode: 'read' | 'full'; created_at: number; expires_at: number }

/** The raw capability URL is revealed only in the immediate creation response. */
export function connectionLinksPage(
  links: ConnectionLinkView[], csrf: string,
  created?: { name: string; url: string; expiresAt: number },
  error?: string,
): string {
  const createdPanel=created ? `<div class="credential-secret" role="status">
    <span class="brand">NEW CONNECTION · ONE-TIME DISPLAY</span><h2>Private URL created</h2>
    <p>Copy this URL now. It is a bearer credential and will not be displayed again.</p>
    <label for="new-connection-url">Private MCP URL</label>
    <input id="new-connection-url" class="mono" readonly value="${esc(created.url)}"
      onclick="this.select()" autocomplete="off" spellcheck="false">
    <div class="row"><button type="button" class="primary" onclick="const e=document.getElementById('new-connection-url');navigator.clipboard.writeText(e.value).then(()=>{this.textContent='Copied'},()=>{e.select()})">Copy private URL</button>
      <span class="muted" style="font-size:11px">Expires ${esc(new Date(created.expiresAt).toUTCString())}</span></div>
    <p class="err" style="font-size:12px">Anyone with this URL can access the permitted tools. Do not share it in logs, issue reports or screenshots.</p>
  </div>` : '';
  const cards=links.length ? links.map(link=>`<div class="credential-card">
    <div class="device-top"><div><span class="brand">PRIVATE CONNECTION</span><h2>${esc(link.name)}</h2>
      <p>${link.mode==='read'?'Read-only access':'Full tool access · files and terminal'}<br>
        Expires ${esc(new Date(link.expires_at).toUTCString())}</p></div>
      <span class="pill ${link.mode==='read'?'ok':'err'}"><span class="dot"></span>${link.mode==='read'?'Read only':'Full access'}</span></div>
    <form method="post" action="/auth/links/revoke" onsubmit="return confirm('Revoke this connection URL immediately?')">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="link_id" value="${esc(link.id)}">
      <div class="actions"><button type="submit" class="secondary danger">Revoke connection</button></div>
    </form></div>`).join('') : '<div class="empty">No active private URLs. Create one to connect an MCP client without OAuth.</div>';
  return layout('Connect without OAuth',`<div class="section-head"><div class="page-heading">
    <span class="brand">ACCESS MANAGEMENT</span><h1>Private MCP links</h1>
    <p>Connect without OAuth using a private Streamable HTTP URL. Control permissions and expiration for each connection.</p></div>
    <a href="/auth/clients" class="btn secondary">OAuth connections</a></div>
    <div class="access-banner"><span class="symbol">!</span><div>
      <strong>Private URLs are credentials</strong>
      <p>Use HTTPS. Anyone with a URL can use its permitted tools until it expires or is revoked. Only issue full-access links when necessary.</p></div></div>
    ${error ? `<div class="auth-alert err section" role="alert">${esc(error)}</div>`:''}
    ${createdPanel}
    <div class="admin-two-col section"><div class="panel panel-form">
      <span class="brand">NEW CONNECTION</span><h2>Create a connection URL</h2>
      <p>Give the connection a recognizable name, choose its permissions and set an expiry date.</p>
      <form method="post" action="/auth/links">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label for="link-name">Connection name</label>
        <input id="link-name" name="name" maxlength="80" placeholder="e.g. My ChatGPT connector" required>
        <label for="link-mode">Access level</label>
        <select id="link-mode" name="mode" required>
          <option value="read" selected>Read only (recommended)</option>
          <option value="full">Full access (files, terminal and other tools)</option>
        </select>
        <label for="link-expiry">Expires after</label>
        <select id="link-expiry" name="days">
          <option value="1">1 day</option><option value="7" selected>7 days</option>
          <option value="30">30 days</option><option value="90">90 days</option>
          <option value="365">1 year (365 days)</option><option value="730">2 years (730 days)</option>
        </select>
        <div class="row"><button type="submit" class="primary">Generate private MCP URL</button></div>
      </form></div>
      <div class="panel"><span class="brand">HOW IT WORKS</span><h2>Connect with confidence</h2>
        <div class="admin-steps">
          <div class="admin-step"><span class="num">1</span><div><strong>Choose the scope</strong><p>Read-only blocks changes; full access can run commands.</p></div></div>
          <div class="admin-step"><span class="num">2</span><div><strong>Copy the private URL</strong><p>It is shown once after you create the connection.</p></div></div>
          <div class="admin-step"><span class="num">3</span><div><strong>Manage the lifecycle</strong><p>Revoke access at any time or let the URL expire.</p></div></div>
        </div><div class="credential-hint" style="margin-top:20px">The OAuth-enabled <code>/mcp</code> endpoint remains available separately.</div></div></div>
    <section class="section"><div class="section-head"><div><span class="brand">ISSUED CONNECTIONS</span>
      <h2>Active connections (${links.length})</h2><p>Access can be revoked immediately.</p></div></div>
      <div class="credential-list">${cards}</div></section>`,'wide');
}
