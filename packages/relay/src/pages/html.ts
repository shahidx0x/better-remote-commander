/** Server-rendered HTML pages for the relay (no framework, no JS needed). */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · SES-RDP</title>
<style>
:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f5f5f4;color:#1c1c1a;display:flex;min-height:100vh;align-items:center;justify-content:center}
@media(prefers-color-scheme:dark){body{background:#151513;color:#e8e6df}.card{background:#1f1f1c!important;border-color:#33332f!important}input{background:#151513;color:#e8e6df;border-color:#44443f!important}}
.card{background:#fff;border:1px solid #e2e0d8;border-radius:12px;padding:28px 32px;width:min(420px,92vw)}
h1{font-size:20px;font-weight:500;margin:0 0 4px}p{margin:8px 0;color:#6b6a64}.brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8983;margin-bottom:14px}
label{display:block;font-size:13px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d3d1c8;border-radius:8px;font:inherit}
input.code{font:22px/1 ui-monospace,monospace;letter-spacing:.2em;text-align:center;text-transform:uppercase}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:10px 14px;border-radius:8px;border:1px solid transparent;font:inherit;cursor:pointer}
.primary{background:#2a6df4;color:#fff}.secondary{background:transparent;border-color:#c9c7bf;color:inherit}.err{color:#c0392b}.ok{color:#1f8a4c}
ul{padding-left:18px}code{font-family:ui-monospace,monospace;font-size:13px}
</style></head><body><div class="card"><div class="brand">SES-RDP</div>${body}</div></body></html>`;
}

export function loginPage(returnTo: string, error?: string): string {
  return layout('Sign in', `<h1>Sign in</h1><p>Sign in to your SES-RDP relay.</p>
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
  return layout('Pair device', `<h1>Pair a device</h1><p>Enter the code shown by <code>ses-rdp-agent</code>.</p>
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
  return layout('Relay', `<h1>SES-RDP relay</h1>
<p>MCP endpoint: <code>${esc(publicUrl)}/mcp</code></p>
${loggedIn ? `<p>Devices:</p>${list}<div class="row"><a href="/device/verify"><button class="primary">Pair a device</button></a><a href="/auth/logout"><button class="secondary">Sign out</button></a></div>`
  : `<div class="row"><a href="/auth/login?returnTo=/"><button class="primary">Sign in</button></a></div>`}`);
}
