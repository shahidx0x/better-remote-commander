/**
 * Server-rendered HTML pages for the relay (no framework, no client JS, no external assets).
 * Every dynamic value goes through esc(); POST forms must start with `<form method="post"` so
 * app.ts can add the session `csrf` hidden field.
 */
import { CSS, sidebar } from './theme.js';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** 'auth' = centred card (sign-in, consent, pairing, messages); 'narrow'/'wide' = admin shell with sidebar. */
export type PageKind = 'auth' | 'narrow' | 'wide';

export function layout(title: string, body: string, kind: PageKind = 'narrow'): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)} · Better Remote Commander (BRC)</title><style>${CSS}</style></head><body><a class="skip" href="#main">Skip to content</a>`;
  if (kind === 'auth') {
    return `${head}<main class="auth" id="main"><div class="auth-card"><div class="brand">Better Remote Commander (BRC)</div>${body}</div></main></body></html>`;
  }
  return `${head}<div class="shell">${sidebar(title)}<div class="main"><header class="topbar"><div class="crumb">Workspace / <strong>${esc(title)}</strong></div>
<div class="top-right"><a class="btn secondary optional" href="/device/verify">Pair device</a><a class="btn secondary" href="/auth/logout">Sign out</a></div></header>
<main class="content ${kind}" id="main">${body}</main></div></div></body></html>`;
}

export function loginPage(returnTo: string, error?: string): string {
  return layout('Sign in', `<h1>Sign in</h1><p>Sign in to your BRC relay.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/login"><input type="hidden" name="returnTo" value="${esc(returnTo)}">
<label for="login-user">Username</label><input id="login-user" name="username" autocomplete="username" required autofocus>
<label for="login-pass">Password</label><input id="login-pass" name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="primary" type="submit">Sign in</button></div></form>`, 'auth');
}

export function consentPage(pendingId: string, clientName: string, redirectUri: string, scopes: string[]): string {
  return layout('Authorize', `<h1>Authorize ${esc(clientName)}</h1>
<p><strong>${esc(clientName)}</strong> wants to control your paired devices through this relay.</p>
<p>Redirect: <code>${esc(redirectUri)}</code></p><p>Scopes: ${scopes.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>
<form method="post" action="/auth/consent"><input type="hidden" name="pending" value="${esc(pendingId)}">
<div class="row"><button class="secondary" name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div></form>`, 'auth');
}

export function deviceVerifyPage(prefill: string, error?: string): string {
  return layout('Pair device', `<h1>Pair a device</h1><p>Enter the code shown by <code>brc-agent</code>.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/device/verify"><label for="pair-code">Pairing code</label>
<input id="pair-code" class="code" name="user_code" value="${esc(prefill)}" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" required autofocus>
<div class="row"><button class="primary" type="submit">Continue</button><a class="btn secondary" href="/admin">Back to admin</a></div></form>`, 'auth');
}

export function deviceApprovePage(userCode: string, clientName: string): string {
  return layout('Approve device', `<h1>Approve device</h1>
<p>Device <strong>${esc(clientName)}</strong> asks to join your relay with code <code>${esc(userCode)}</code>.</p>
<p>Once approved it can run tools on that machine on your behalf.</p>
<form method="post" action="/device/approve"><input type="hidden" name="user_code" value="${esc(userCode)}">
<div class="row"><button class="secondary" name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Approve</button></div></form>`, 'auth');
}

export function messagePage(title: string, text: string, ok = true): string {
  return layout(title, `<h1>${esc(title)}</h1><p class="${ok ? 'ok' : 'err'}" role="status">${esc(text)}</p><p>You can close this window.</p>`, 'auth');
}

export function homePage(publicUrl: string, loggedIn: boolean, devices: { device_id: string; name: string; platform: string | null; online: boolean; paused: number }[]): string {
  if (!loggedIn) {
    return layout('Relay', `<h1>BRC relay</h1><p>MCP: <code>${esc(publicUrl)}/mcp</code></p>
<div class="row"><a class="btn primary" href="/auth/login?returnTo=/">Sign in</a></div>`, 'auth');
  }
  const cards = devices.length
    ? `<div class="device-grid">${devices.map((d) => `<div class="device"><div class="device-top"><div><h3><code>${esc(d.name)}</code></h3><p>${esc(d.platform ?? 'Unknown platform')}</p></div>${d.online ? '<span class="pill ok"><span class="dot"></span>online</span>' : '<span class="pill muted"><span class="dot"></span>offline</span>'}</div>${d.paused ? '<p><span class="pill err">paused</span></p>' : ''}</div>`).join('')}</div>`
    : '<div class="empty">No devices paired yet.</div>';
  return layout('Relay', `<h1>BRC relay</h1>
<div class="panel"><p class="muted" style="margin-top:0">MCP endpoint</p><p><code>${esc(publicUrl)}/mcp</code></p></div>
<div class="section"><div class="section-head"><div><h2>Devices</h2><p>${devices.length} paired device${devices.length === 1 ? '' : 's'}</p></div></div>${cards}</div>
<div class="row"><a class="btn primary" href="/admin">Admin</a><a class="btn secondary" href="/device/verify">Pair a device</a><a class="btn secondary" href="/auth/clients">OAuth clients</a><a class="btn secondary" href="/auth/logout">Sign out</a></div>`);
}

/** Shown to an unauthenticated visitor whose OAuth client or callback is not registered. Nothing is registered here. */
export function oauthClientRecoveryPage(clientId: string, redirectUri: string, recoveryPath: string, missing: boolean): string {
  let host = redirectUri;
  try { host = new URL(redirectUri).host; } catch { /* shown raw */ }
  return layout('Approve OAuth callback', `<h1>${missing ? 'Unregistered OAuth client' : 'Callback not approved'}</h1>
<p>An application asked to connect to your relay, but this client or callback address is not registered. Nothing has been approved.</p>
<p>Callback host: <strong>${esc(host)}</strong></p><p>Client ID: <code>${esc(clientId)}</code><br>Full callback: <code>${esc(redirectUri)}</code></p>
<p class="err">Only approve a website you trust to receive authorization codes for your devices.</p>
<div class="row"><a class="btn primary" href="${esc(recoveryPath)}">Review request as admin</a></div>`, 'auth');
}

export function clientsPage(clients: { client_id: string; name: string; redirect_uris: string[]; hasSecret: boolean; created_at: number }[], recovery?: { authorizeUrl: string; clientId: string; redirectUri: string }, feedback?: { ok: boolean; message: string }): string {
  let recoveryHost = '';
  if (recovery) { try { recoveryHost = new URL(recovery.redirectUri).host; } catch { recoveryHost = recovery.redirectUri; } }
  const review = recovery ? `<div class="panel" role="status"><h2>Approve this callback?</h2>
<p>Callback host: <strong>${esc(recoveryHost)}</strong></p><p>Client ID: <code>${esc(recovery.clientId)}</code><br>Full callback: <code>${esc(recovery.redirectUri)}</code></p>
<p class="err">Only approve if you trust this address to receive authorization codes. Consent is still required afterwards.</p>
<form method="post" action="/auth/clients/import"><input type="hidden" name="authorization_url" value="${esc(recovery.authorizeUrl)}">
<label for="rc-name">Display name (optional)</label><input id="rc-name" name="client_name" maxlength="80" placeholder="ChatGPT">
<label for="rc-pw">Confirm your admin password</label><input id="rc-pw" name="password" type="password" autocomplete="current-password" required>
<label for="rc-trust"><input id="rc-trust" type="checkbox" name="trust" value="yes" required> I recognize and trust <strong>${esc(recoveryHost)}</strong></label>
<div class="row"><button class="primary" type="submit">Approve callback</button></div></form></div>` : '';
  const note = feedback ? `<div class="panel" role="status"><p class="${feedback.ok ? 'ok' : 'err'}" style="margin:0">${esc(feedback.message)}</p></div>` : '';
  const rows = clients.length
    ? `<div class="device-grid">${clients.map((c) => `<div class="device"><div class="device-top"><div><h3>${esc(c.name)}</h3><p><code>${esc(c.client_id)}</code></p></div><span class="pill">${c.hasSecret ? 'Confidential' : 'Public (PKCE)'}</span></div>
<p><small>${c.redirect_uris.map(esc).join('<br>')}</small></p>
<form method="post" action="/auth/clients/delete"><input type="hidden" name="client_id" value="${esc(c.client_id)}"><div class="actions"><button class="secondary danger" onclick="return confirm('Delete client and revoke its tokens?')">Delete</button></div></form></div>`).join('')}</div>`
    : '<div class="empty">No OAuth clients yet. ChatGPT and Claude register automatically when you connect the MCP endpoint.</div>';
  return layout('OAuth clients', `<div class="section-head"><div><h1>OAuth clients</h1>
<p>These clients are created automatically through OAuth Dynamic Client Registration. No custom callback URL is required here.</p></div><a class="btn secondary" href="/admin">Back</a></div>
${note}${review}${rows}`);
}
