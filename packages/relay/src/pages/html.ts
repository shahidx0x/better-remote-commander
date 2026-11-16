/** Server-rendered pages: public/authentication and signed-in workspace.
 * Single theme across login, OAuth, pairing, home and every admin route.
 */
import { dashboardLayout } from './dashboard-shell.js';
import { authLayout } from './auth-shell.js';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));

export function layout(title: string, body: string, width: 'narrow' | 'wide' = 'narrow'): string {
  return width === 'wide' ? dashboardLayout(title, body) : authLayout(title, body);
}

export function loginPage(returnTo: string, error?: string): string {
  return layout('Sign in', `<span class="eyebrow">SECURE WORKSPACE</span>
    <h1>Welcome back.</h1><p class="auth-intro">Sign in to your relay console to manage trusted devices, connected apps and secure access.</p>
    ${error ? `<div class="auth-alert" role="alert"><span aria-hidden="true">!</span><span>${esc(error)}</span></div>` : ''}
    <form method="post" action="/auth/login" class="auth-form">
      <input type="hidden" name="returnTo" value="${esc(returnTo)}">
      <div class="form-field"><label for="login-username">Username</label>
        <input id="login-username" name="username" autocomplete="username" placeholder="Enter your username" required autofocus></div>
      <div class="form-field"><label for="login-password">Password</label><div class="input-wrap">
        <input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required>
        <button class="show-password" type="button" aria-controls="login-password"
          onclick="const p=document.getElementById('login-password');const visible=p.type==='password';p.type=visible?'text':'password';this.textContent=visible?'Hide':'Show';this.setAttribute('aria-label',visible?'Hide password':'Show password')"
          aria-label="Show password">Show</button></div></div>
      <button class="primary full" type="submit">Sign in to workspace <span aria-hidden="true">→</span></button>
    </form>
    <p class="auth-inline-note"><span class="check" aria-hidden="true">●</span>Protected by your relay credentials. Never share your password or private MCP URLs.</p>`);
}

export function consentPage(pendingId: string, clientName: string, redirectUri: string, scopes: string[]): string {
  return layout('Authorize', `<span class="eyebrow">CONNECTION AUTHORIZATION</span>
    <h1>Review access request.</h1><p class="auth-intro">An AI client wants permission to access your paired devices. Approve only requests you recognize.</p>
    <div class="panel"><span class="brand">REQUESTING APPLICATION</span>
      <h2>${esc(clientName)}</h2>
      <label>Callback destination</label><code>${esc(redirectUri)}</code>
      <label>Requested scopes</label><p>${scopes.map(s=>`<code style="display:inline-block;margin:0 5px 5px 0">${esc(s)}</code>`).join('') || '<span class="muted">No scopes specified</span>'}</p>
    </div>
    <div class="auth-alert"><span aria-hidden="true">!</span><span>Only approve this application if you trust its callback URL and intended access.</span></div>
    <form method="post" action="/auth/consent"><input type="hidden" name="pending" value="${esc(pendingId)}">
      <div class="row"><button class="secondary" name="decision" value="deny" type="submit">Deny access</button>
      <button class="primary" name="decision" value="allow" type="submit">Authorize application</button></div>
    </form>`);
}

export function deviceVerifyPage(prefill: string, error?: string): string {
  return layout('Pair device', `<div class="section-head"><div><span class="brand">DEVICE PAIRING</span>
    <h1>Connect a new device.</h1><p>Enter the one-time pairing code shown by your local <code>brc-agent</code> terminal.</p></div>
    <a class="btn secondary" href="/admin">Return to overview</a></div>
    <div class="panel" style="max-width:680px">
      ${error ? `<div class="auth-alert" role="alert">${esc(error)}</div>` : ''}
      <form method="post" action="/device/verify"><label for="pairing-code">Pairing code</label>
      <input id="pairing-code" class="code" name="user_code" value="${esc(prefill)}" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" required autofocus>
      <p style="font-size:12px;margin-top:10px">Check the device name and requested access carefully before approving.</p>
      <div class="row"><button class="primary" type="submit">Continue to review</button></div></form>
    </div>`, 'wide');
}

export function deviceApprovePage(userCode: string, clientName: string): string {
  return layout('Approve device', `<div class="section-head"><div><span class="brand">DEVICE PAIRING</span>
    <h1>Approve this device?</h1><p>Confirm that you initiated the connection before giving it access to your relay.</p></div></div>
    <div class="panel" style="max-width:700px">
      <span class="brand">REQUESTING DEVICE</span><h2 style="font-size:21px">${esc(clientName)}</h2>
      <p>Pairing code: <code>${esc(userCode)}</code></p>
      <div class="panel" style="background:#fff8ef;border-color:#f2e2c8">
        <strong>Access warning</strong><p>Once approved, this device can accept tool calls on your behalf. Only approve devices you control.</p>
      </div>
      <form method="post" action="/device/approve"><input type="hidden" name="user_code" value="${esc(userCode)}">
        <div class="row"><button class="secondary" name="decision" value="deny" type="submit">Deny device</button>
        <button class="primary" name="decision" value="allow" type="submit">Approve device</button></div></form>
    </div>`, 'wide');
}

export function messagePage(title: string, text: string, ok = true): string {
  return layout(title, `<span class="eyebrow">${ok ? 'REQUEST COMPLETE' : 'REQUEST STATUS'}</span>
    <h1>${esc(title)}</h1><div class="auth-alert ${ok ? 'ok' : ''}" role="status">
      <span aria-hidden="true">${ok ? '✓' : '!'}</span><span>${esc(text)}</span></div>
    <p>You can return to your workspace or close this browser tab.</p>
    <div class="row"><a href="/admin" class="btn primary">Go to dashboard</a><a href="/" class="btn secondary">Home</a></div>`);
}

export function homePage(publicUrl: string, loggedIn: boolean,
  devices: { device_id: string; name: string; platform: string | null; online: boolean; paused: number }[]): string {
  if (!loggedIn) return layout('Relay', `<span class="eyebrow">RELAY WORKSPACE</span>
    <h1>Your devices.<br>Your control.</h1>
    <p class="auth-intro">Use the secure relay dashboard to connect your devices and manage AI tool access from a single workspace.</p>
    <div class="panel"><span class="brand">YOUR RELAY ENDPOINT</span>
      <code>${esc(publicUrl)}/mcp</code><p style="font-size:11px;margin:10px 0 0">Sign in to view device status and manage access.</p></div>
    <div class="row"><a class="btn primary" href="/auth/login?returnTo=%2Fadmin">Sign in to dashboard</a></div>`);

  const online = devices.filter(d => d.online && !d.paused).length;
  const active = devices.length ? devices.map(d => `<div class="device">
      <div class="device-top"><div style="min-width:0"><span class="brand">${esc(d.platform ?? 'DEVICE')}</span>
        <h2>${esc(d.name)}</h2><code>${esc(d.device_id)}</code></div>
        <span class="pill ${d.paused ? 'err' : d.online ? 'ok' : ''}">
          <span class="dot"></span>${d.paused ? 'Paused' : d.online ? 'Online' : 'Offline'}</span></div>
    </div>`).join('') : '<div class="empty">No paired devices yet. Pair one to get started.</div>';
  return layout('Relay', `<section class="hero">
      <span class="tag">YOUR RELAY WORKSPACE</span>
      <h1>Welcome to your workspace.</h1><p>Everything you need to connect devices, authorize clients, and manage tools in one place.</p>
      <div class="row"><a class="btn primary" href="/admin">Open full dashboard</a>
        <a class="btn secondary" href="/device/verify">+ Pair a device</a></div>
      <div class="hero-foot"><span class="pill ok"><span class="dot"></span>Workspace available</span>
        <span class="muted">MCP endpoint</span><code>${esc(publicUrl)}/mcp</code></div>
    </section>
    <div class="grid section">
      <div class="panel stat"><span>Paired devices</span><strong>${devices.length}</strong><small>Connected to your workspace</small></div>
      <div class="panel stat"><span>Available devices</span><strong>${online}</strong><small>Online and not paused</small></div>
      <div class="panel stat"><span>Offline or paused</span><strong>${devices.length-online}</strong><small>Not currently accepting calls</small></div>
    </div>
    <section class="section"><div class="section-head"><div><span class="brand">YOUR WORKSPACE</span><h2>Paired devices</h2>
      <p>View current availability. For controls and activity, open the dashboard.</p></div>
      <a class="btn secondary" href="/admin#devices">Manage devices</a></div>
      <div class="device-grid">${active}</div></section>
    <section class="section"><div class="section-head"><div><span class="brand">GET STARTED</span><h2>Explore your tools</h2></div></div>
      <div class="device-grid">
        <div class="panel"><h3>MCP marketplace</h3><p>Discover and install optional tools for trusted devices.</p>
          <a href="/admin/marketplace" class="btn secondary">Browse marketplace</a></div>
        <div class="panel"><h3>Private connections</h3><p>Create or revoke a private access URL for an MCP client.</p>
          <a href="/auth/links" class="btn secondary">Manage connections</a></div>
      </div></section>`, 'wide');
}

export function clientsPage(
  clients: { client_id: string; name: string; redirect_uris: string[]; hasSecret: boolean; created_at: number }[],
  csrf = '',
  recovery?: { authorizeUrl: string; clientId: string; redirectUri: string },
  feedback?: { ok: boolean; message: string },
): string {
  const cards = clients.length ? clients.map(client => `<div class="device"><div class="device-top">
      <div style="min-width:0"><span class="brand">REGISTERED CLIENT</span><h2>${esc(client.name)}</h2>
        <code>${esc(client.client_id)}</code>
        <p style="font-size:12px;margin-top:10px">${client.hasSecret ? 'Confidential client' : 'Public client · PKCE'}</p>
        <span class="brand">APPROVED CALLBACKS</span>
        ${client.redirect_uris.map(url=>`<p><code>${esc(url)}</code></p>`).join('')}
      </div><span class="pill ok">Registered</span></div>
      <form method="post" action="/auth/clients/delete" onsubmit="return confirm('Delete client and revoke its tokens?')">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="client_id" value="${esc(client.client_id)}">
        <div class="actions"><button class="secondary danger" type="submit">Delete &amp; revoke tokens</button></div>
      </form></div>`).join('') : '<div class="empty">No OAuth clients registered yet.</div>';
  const detected = recovery ? `<div class="panel section" role="status" style="background:#fff9ee;border-color:#f0e1c6">
    <span class="brand">PENDING CALLBACK REVIEW</span><h2>Authorization request detected</h2>
    <p>Client ID: <code>${esc(recovery.clientId)}</code></p>
    <p>Callback: <code>${esc(recovery.redirectUri)}</code></p>
    <p class="err">Only approve this address if you trust it to receive authorization codes.</p>
  </div>` : '';
  return layout('OAuth clients', `<div class="section-head"><div><span class="brand">ACCESS MANAGEMENT</span>
    <h1>OAuth clients</h1>
    <p>Register callback destinations, review existing applications and control which clients can authorize.</p></div>
    <a href="/auth/links" class="btn secondary">Manage private links</a></div>
    ${feedback ? `<div class="panel section ${feedback.ok?'ok':'err'}" role="status">${esc(feedback.message)}</div>` : ''}
    ${detected}
    <div class="section-head section"><div><h2>Register a client</h2>
      <p>Choose the method supported by your AI application. Callback destinations must be explicitly trusted.</p></div></div>
    <div class="admin-register-grid">
      <div class="panel"><span class="brand">OPTION 01 · FAST SETUP</span><h2>Paste authorization URL</h2>
        <p>Use the complete authorization URL from your AI client, beginning with this relay's <code>/authorize?</code> endpoint.</p>
        <form action="/auth/clients/import" method="post">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <label for="auth-url">Authorization URL</label>
          <textarea id="auth-url" name="authorization_url" rows="4" maxlength="8192" placeholder="https://relay.example/authorize?response_type=code&amp;client_id=..." required>${esc(recovery?.authorizeUrl ?? '')}</textarea>
          <label for="auth-client-name">Display name (optional)</label>
          <input id="auth-client-name" name="client_name" maxlength="80" placeholder="ChatGPT integration">
          <label class="trust-label"><input type="checkbox" name="trust" value="yes" required> I recognize and trust the callback destination.</label>
          <div class="row"><button class="primary" type="submit">Review &amp; approve callback</button></div>
        </form>
      </div>
      <div class="panel"><span class="brand">OPTION 02 · MANUAL SETUP</span><h2>Register manually</h2>
        <p>Use the client's existing ID and trusted HTTPS callback. Authorization still requires PKCE S256.</p>
        <form action="/auth/clients/import" method="post">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <label for="manual-client-id">Client ID</label><input id="manual-client-id" name="client_id" maxlength="128" placeholder="cl_..." required>
          <label for="manual-redirect">Callback URL</label><input id="manual-redirect" name="redirect_uri" maxlength="2048" placeholder="https://app.example.com/oauth/callback" required>
          <label for="manual-name">Display name (optional)</label><input id="manual-name" name="client_name" maxlength="80" placeholder="My AI application">
          <label class="trust-label"><input type="checkbox" name="trust" value="yes" required> I recognize and trust the callback destination.</label>
          <div class="row"><button class="primary" type="submit">Register client</button></div>
        </form>
      </div>
    </div>
    <section class="section"><div class="section-head"><div><span class="brand">TRUSTED APPLICATIONS</span>
      <h2>Approved OAuth clients</h2><p>${clients.length} registered client${clients.length===1?'':'s'}.</p></div></div>
      <div class="device-grid">${cards}</div></section>`, 'wide');
}

export function oauthClientRecoveryPage(
  clientId: string, redirectUri: string, recoveryPath: string, missing: boolean,
): string {
  return layout('Approve OAuth callback', `<span class="eyebrow">CONNECTION RECOVERY</span>
    <h1>${missing ? 'Unregistered OAuth client' : 'Callback not approved'}</h1>
    <p class="auth-intro">An application is requesting an OAuth connection and needs your explicit approval.</p>
    <div class="panel"><span class="brand">REQUEST DETAILS</span>
      <p><strong>Reason</strong><br>${missing ? 'Unknown OAuth client' : 'Callback not approved'}</p>
      <label>Client ID</label><code>${esc(clientId)}</code>
      <label>Requested callback</label><code>${esc(redirectUri)}</code>
    </div>
    <div class="auth-alert" role="alert">Only approve a website you trust to receive authorization codes and connect to your devices.</div>
    <p>Sign in to your BRC admin dashboard to review and explicitly approve this destination.</p>
    <div class="row"><a href="${esc(recoveryPath)}" class="btn primary">Review callback request</a></div>`);
}
