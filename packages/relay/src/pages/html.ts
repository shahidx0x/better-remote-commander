/** Server-rendered HTML pages for the relay (no framework, no JS needed). */

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function layout(title: string, body: string, width: 'narrow' | 'wide' = 'narrow'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Better Remote Commander (BRC)</title>
<style>
:root{color-scheme:light dark;--bg:#f3f5f7;--panel:#fff;--panel2:#f8fafc;--text:#121826;--muted:#687386;--line:#e4e8ef;--brand:#2563eb;--brand2:#1d4ed8;--ok:#15803d;--err:#dc2626;--shadow:0 18px 50px rgba(15,23,42,.08)}*{box-sizing:border-box}body{font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:radial-gradient(circle at top left,#eef4ff 0,transparent 32%),var(--bg);color:var(--text);display:flex;min-height:100vh;align-items:flex-start;justify-content:center;padding:38px 18px}a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
@media(prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#111827;--panel2:#172033;--text:#eef2ff;--muted:#9aa6ba;--line:#263247;--brand:#60a5fa;--brand2:#3b82f6;--shadow:0 18px 50px rgba(0,0,0,.32)}body{background:radial-gradient(circle at top left,#16223d 0,transparent 34%),var(--bg)}input,textarea{background:#0d1424;color:var(--text)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px 30px;width:min(${width === 'wide' ? '1120px' : '480px'},96vw);box-shadow:var(--shadow)}h1{font-size:22px;line-height:1.2;font-weight:700;margin:0 0 6px;letter-spacing:-.02em}h2{font-size:15px;margin:0 0 10px}p{margin:8px 0;color:var(--muted)}.brand{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin-bottom:16px}.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
label{display:block;font-size:12px;font-weight:600;margin:13px 0 5px;color:var(--muted)}input,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;outline:none}input:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 14%,transparent)}input.code{font:22px/1 ui-monospace,monospace;letter-spacing:.2em;text-align:center;text-transform:uppercase}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.row>a{display:flex}button{padding:9px 13px;border-radius:10px;border:1px solid transparent;font:600 13px/1.2 inherit;cursor:pointer;transition:.15s ease}button:hover{transform:translateY(-1px)}.primary{background:var(--brand);color:#fff}.primary:hover{background:var(--brand2)}.secondary{background:var(--panel2);border-color:var(--line);color:inherit}.danger{color:var(--err)}.err{color:var(--err)}.ok{color:var(--ok)}.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 8px;background:var(--panel2);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}ul{padding-left:18px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:1px 5px}table{width:100%;border-collapse:separate;border-spacing:0}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.panel{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:16px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.stat strong{display:block;font-size:24px;letter-spacing:-.03em}.section{margin-top:24px}.section-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.device{padding:15px;border:1px solid var(--line);border-radius:14px;background:var(--panel2)}.device-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.actions button{padding:7px 10px}@media(max-width:760px){body{padding:16px 10px}.card{padding:20px}.grid,.device-grid{grid-template-columns:1fr}.table-wrap{overflow:auto}.section-head{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="card"><div class="brand">Better Remote Commander (BRC)</div>${body}</div></body></html>`;
}

export function loginPage(returnTo: string, error?: string): string {
  return layout('Sign in', `<h1>Sign in</h1><p>Sign in to your BRC relay.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/auth/login"><input type="hidden" name="returnTo" value="${esc(returnTo)}">
<label>Username</label><input name="username" autocomplete="username" required autofocus>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="primary" type="submit">Sign in</button></div></form>`);
}

export function consentPage(pendingId: string, clientName: string, redirectUri: string, scopes: string[]): string {
  return layout('Authorize', `<h1>Authorize ${esc(clientName)}</h1>
<p><strong>${esc(clientName)}</strong> wants to control your paired devices through this relay.</p>
<p>Redirect: <code>${esc(redirectUri)}</code></p><p>Scopes: ${scopes.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>
<form method="post" action="/auth/consent"><input type="hidden" name="pending" value="${esc(pendingId)}">
<div class="row"><button class="secondary" name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div></form>`);
}

export function deviceVerifyPage(prefill: string, error?: string): string {
  return layout('Pair device', `<h1>Pair a device</h1><p>Enter the code shown by <code>brc-agent</code>.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/device/verify"><label>Pairing code</label>
<input class="code" name="user_code" value="${esc(prefill)}" placeholder="XXXX-XXXX" maxlength="9" required autofocus>
<div class="row"><button class="primary" type="submit">Continue</button></div></form>`);
}

export function deviceApprovePage(userCode: string, clientName: string): string {
  return layout('Approve device', `<h1>Approve device</h1>
<p>Device <strong>${esc(clientName)}</strong> asks to join your relay with code <code>${esc(userCode)}</code>.</p>
<p>Once approved it can run tools on that machine on your behalf.</p>
<form method="post" action="/device/approve"><input type="hidden" name="user_code" value="${esc(userCode)}">
<div class="row"><button class="secondary" name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Approve</button></div></form>`);
}

export function messagePage(title: string, text: string, ok = true): string {
  return layout(title, `<h1>${esc(title)}</h1><p class="${ok ? 'ok' : 'err'}">${esc(text)}</p><p>You can close this window.</p>`);
}

export function homePage(publicUrl: string, loggedIn: boolean, devices: { device_id: string; name: string; platform: string | null; online: boolean; paused: number }[]): string {
  const list = devices.length
    ? `<ul>${devices.map((d) => `<li><code>${esc(d.name)}</code> ${esc(d.platform ?? '')} — ${d.online ? '<span class="ok">online</span>' : 'offline'}${d.paused ? ' (paused)' : ''}</li>`).join('')}</ul>`
    : '<p>No devices paired yet.</p>';
  return layout('Relay', `<h1>BRC relay</h1>
<p>MCP: <code>${esc(publicUrl)}/mcp</code></p>
${loggedIn ? `<p>Devices:</p>${list}<div class="row"><a href="/admin"><button class="primary">Admin</button></a><a href="/device/verify"><button class="secondary">Pair a device</button></a><a href="/auth/clients"><button class="secondary">OAuth clients</button></a><a href="/auth/logout"><button class="secondary">Sign out</button></a></div>`
  : `<div class="row"><a href="/auth/login?returnTo=/"><button class="primary">Sign in</button></a></div>`}`);
}

export function clientsPage(
  clients: { client_id: string; name: string; redirect_uris: string[]; hasSecret: boolean; created_at: number }[],
  csrf = '',
  recovery?: { authorizeUrl: string; clientId: string; redirectUri: string },
  feedback?: { ok: boolean; message: string },
): string {
  const rows = clients.length
    ? `<ul>${clients.map((c) => `<li style="margin-bottom:16px"><strong>${esc(c.name)}</strong><br><code>${esc(c.client_id)}</code>${c.hasSecret ? ' · confidential' : ' · public (PKCE)'}<br><small>${c.redirect_uris.map(esc).join('<br>')}</small>
<form method="post" action="/auth/clients/delete" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="client_id" value="${esc(c.client_id)}"><button class="secondary danger" style="padding:4px 10px;margin-top:6px" onclick="return confirm('Delete client and revoke its tokens?')">Delete</button></form></li>`).join('')}</ul>`
    : '<p>No OAuth clients yet. A client must be registered before its saved client ID can authorize.</p>';
  const recoveryPanel = recovery ? `<div class="panel section"><h2>Authorization request detected</h2>
<p>Client ID: <code>${esc(recovery.clientId)}</code></p><p>Callback: <code>${esc(recovery.redirectUri)}</code></p>
<p class="err"><strong>Only approve this site if you trust it to receive authorization codes.</strong></p></div>` : '';
  return layout('OAuth clients', `<h1>OAuth clients</h1>
<p>OAuth clients with dynamic registration work automatically. For wrappers that keep a client ID after redeployments, approve their callback explicitly here.</p>
${feedback ? `<p class="${feedback.ok ? 'ok' : 'err'}">${esc(feedback.message)}</p>` : ''}
${recoveryPanel}
<div class="panel section"><h2>Option A — paste an authorization URL</h2>
<p>Copy the complete URL beginning with your relay's <code>/authorize?</code> address from the failing login. This preserves the wrapper's existing client ID.</p>
<form action="/auth/clients/import" method="post">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Authorization URL</label><textarea name="authorization_url" rows="4" maxlength="8192" placeholder="https://your-relay.example/authorize?response_type=code&amp;client_id=..." required>${esc(recovery?.authorizeUrl ?? '')}</textarea>
<label>Display name (optional)</label><input name="client_name" maxlength="80" placeholder="My ChatGPT wrapper">
<label style="margin-top:18px"><input type="checkbox" name="trust" value="yes" required style="width:auto;margin-right:8px">I recognize and trust the callback destination.</label>
<div class="row"><button class="primary" type="submit">Approve callback and continue</button></div></form></div>
<div class="panel section"><h2>Option B — register a client manually</h2>
<p>If your application only provides a client ID and callback URL, register them here. Its OAuth authorization request must still use PKCE S256.</p>
<form action="/auth/clients/import" method="post">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Client ID</label><input name="client_id" maxlength="128" placeholder="cl_..." required>
<label>Callback URL (any HTTPS website you approve)</label><input name="redirect_uri" maxlength="2048" placeholder="https://app.example.com/oauth/callback" required>
<label>Display name (optional)</label><input name="client_name" maxlength="80" placeholder="My AI application">
<label style="margin-top:18px"><input type="checkbox" name="trust" value="yes" required style="width:auto;margin-right:8px">I recognize and trust this callback destination.</label>
<div class="row"><button class="primary" type="submit">Register client and callback</button></div></form></div>
<div class="section"><h2>Approved OAuth clients</h2>${rows}</div>
<p><a href="/auth/links">Connect without OAuth using a private URL</a> · <a href="/admin">Back to admin</a></p>`, 'wide');
}

export function oauthClientRecoveryPage(
  clientId: string, redirectUri: string, recoveryPath: string, missing: boolean,
): string {
  return layout('Approve OAuth callback', `<h1>${missing ? 'Unregistered OAuth client' : 'Callback not approved'}</h1>
<p>BRC received an authorization request from an AI application that needs your approval.</p>
<p>Client ID: <code>${esc(clientId)}</code></p>
<p>Requested callback: <code>${esc(redirectUri)}</code></p>
<p>To allow this application, sign in to your BRC admin dashboard and explicitly approve the callback destination. You can use any HTTPS website you trust.</p>
<div class="row"><a href="${esc(recoveryPath)}" class="primary" style="padding:10px 14px;border-radius:10px;color:white">Review and approve callback</a></div>
<p class="err">Only approve a website you trust to receive authorization codes and connect to your devices.</p>`);
}
