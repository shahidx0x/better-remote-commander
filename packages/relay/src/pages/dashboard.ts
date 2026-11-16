/** Functional, accessible relay overview. No fabricated metrics or client-side polling. */
import { layout, esc } from './html.js';
import { formatTokens, type UsagePeriod, type UsageBucket, type McpEstimateDay } from '../features/usage.js';
import type { DeviceView, AuditView } from './admin.js';
import type { usageView } from '../features/usage.js';

type View = ReturnType<typeof usageView>;
const ago = (t: number | null) => {
  if (!t) return 'Never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' :
    s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago';
};
const svg = (inner: string) =>
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + inner + '</svg>';
const ICONS = {
  devices: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  calls: svg('<path d="M4 17V7m6 10V4m5 13v-7m5 7V9"/>'),
  failed: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>'),
  pc: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 21h10M12 17v4"/>'),
};
const metric = (title: string, value: string, hint: string, icon: keyof typeof ICONS) =>
  `<div class="panel stat"><span>${esc(title)}</span><span class="stat-icon">${ICONS[icon]}</span>
    <strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`;
function tokenChart(buckets: UsageBucket[], description = 'Input and output model tokens by selected period'): string {
  const max = Math.max(...buckets.map(b => b.total), 1);
  return `<div class="chart" role="img" aria-label="${esc(description)}">${buckets.map(b => {
    const input = b.input ? Math.max(2, 100 * b.input / max) : 0;
    const output = b.output ? Math.max(2, 100 * b.output / max) : 0;
    return `<div class="chart-col" title="${esc(b.label)}: input ${b.input.toLocaleString('en-US')}, output ${b.output.toLocaleString('en-US')}">
      <div class="bar input" style="height:${input}%"></div><div class="bar output" style="height:${output}%"></div>
      <span class="chart-label">${esc(b.label)}</span></div>`;
  }).join('')}</div><div class="legend"><span><i></i> Input tokens</span><span><i class="out"></i> Output tokens</span></div>`;
}
function usageSection(view: View): string {
  const period = view.period, t = view.totals, has = t.reports > 0;
  const tabs = (['day', 'week', 'month'] as UsagePeriod[]).map(p =>
    `<a href="/admin?period=${p}#provider-tokens" class="${p === period ? 'active' : ''}" ${p === period ? 'aria-current="page"' : ''}>
    ${p === 'day' ? 'Daily' : p === 'week' ? 'Weekly' : 'Monthly'}</a>`).join('');
  return `<details class="section" id="provider-tokens" ${has?'open':''}>
    <summary class="panel" style="cursor:pointer;font-size:12px;font-weight:760;color:#40646b">
      Provider-reported model tokens (optional) · ${has?formatTokens(t.total):'No reports received'} · Expand for details
    </summary>
    <section class="section">
    <div class="section-head"><div><span class="brand">MODEL INSIGHTS</span><h2>Model token analytics</h2>
      <p>Optional usage submitted by a connected model client. Not inferred from MCP tools.</p></div>
      <div class="period-tabs" aria-label="Usage period">${tabs}</div></div>
    <div class="analytics-grid">
      <div class="panel"><div class="section-head" style="margin-bottom:0"><div>
        <h3 style="margin:0">Input / output volume</h3>
        <p style="font-size:12px;margin-top:4px">${period === 'day' ? 'Last 14 days' : period === 'week' ? 'Last 12 weeks' : 'Last 12 months'}</p></div>
        <span class="pill">Reported usage</span></div>
        ${has ? tokenChart(view.buckets) : '<div class="empty" style="margin-top:20px"><strong>No model usage reported yet</strong><p>MCP does not expose ChatGPT model tokens. Connect a reporting model client to view real totals.</p></div>'}
      </div>
      <div class="panel token-summary"><span class="brand">TOKEN BREAKDOWN</span><h2>Usage overview</h2>
        <p style="font-size:12px;margin:0 0 12px">Input and output volume for the selected period</p>
        <div class="breakdown-row"><span><i class="mini-dot"></i>Input tokens</span><strong>${has ? formatTokens(t.input) : '—'}</strong></div>
        <div class="breakdown-row output"><span><i class="mini-dot"></i>Output tokens</span><strong>${has ? formatTokens(t.output) : '—'}</strong></div>
        <div class="token-total"><span>TOTAL TOKENS</span><strong>${has ? formatTokens(t.total) : '—'}</strong>
          <small>${has ? t.reports + ' provider reports received' : 'Waiting for real provider reports'}</small></div>
      </div>
    </div>
    <p style="font-size:11px;margin:12px 0 0">These provider-reported counts are separate from MCP estimates. Do not add the two totals together.</p>
  </section></details>`;
}
function formatPayloadBytes(n:number):string {
  return n >= 1e9 ? (n/1e9).toFixed(2)+' GB' : n>=1e6 ? (n/1e6).toFixed(2)+' MB'
    : n>=1e3 ? (n/1e3).toFixed(1)+' KB' : n.toLocaleString('en-US')+' B';
}
function automaticUsageSection(view: View | undefined, days: McpEstimateDay[], enabled: boolean, period: UsagePeriod): string {
  const activePeriod = view?.period ?? period;
  const totals = view?.totals ?? { input:0,output:0,total:0,reports:0 };
  const has = totals.reports > 0;
  const startKey = view?.buckets[0]?.key ?? '9999-12-31';
  const selected=days.filter(d=>d.day>=startKey);
  const partial = selected.reduce((sum,d)=>sum+d.partial_calls,0);
  const sentBytes=selected.reduce((sum,d)=>sum+(d.to_agent_bytes??0),0);
  const receivedBytes=selected.reduce((sum,d)=>sum+(d.from_agent_bytes??0),0);
  const matched=selected.reduce((sum,d)=>sum+(d.matched_calls??0),0);
  const fallback=selected.reduce((sum,d)=>sum+(d.universal_calls??0),0);
  const tabs = (['day','week','month'] as UsagePeriod[]).map(p=>
    `<a href="/admin?period=${p}#tokens" class="${p===activePeriod?'active':''}" ${p===activePeriod?'aria-current="page"':''}>
      ${p==='day'?'Daily':p==='week'?'Weekly':'Monthly'}</a>`).join('');
  return `<section class="section" id="tokens">
    <div class="section-head"><div><span class="brand">AUTOMATIC ESTIMATION</span>
      <h2>Estimated MCP token traffic</h2>
      <p>Locally counted from text passing through BRC tools. No token report needed from ChatGPT.</p></div>
      <div class="period-tabs" aria-label="Estimated MCP usage period">${tabs}</div></div>
    <div class="analytics-grid">
      <div class="panel"><div class="section-head" style="margin-bottom:0"><div>
        <h3>Tool traffic volume</h3>
        <p style="font-size:12px">${activePeriod==='day'?'Last 14 days':activePeriod==='week'?'Last 12 weeks':'Last 12 months'} · UTC</p>
        </div><span class="pill ${enabled?'ok':'err'}">${enabled?'Local BPE estimates':'Tracking disabled'}</span></div>
        ${has&&view?tokenChart(view.buckets,'Locally estimated MCP tool-result and tool-call tokens'):
          '<div class="empty" style="margin-top:20px"><strong>No MCP traffic counted yet</strong><p>Once a connected AI client calls a BRC tool, its visible text will be estimated automatically. Dashboard totals may lag by a few seconds.</p></div>'}
        <p class="muted" style="font-size:11px;margin-top:20px">Only MCP tool-call traffic is visible here. Chat messages, hidden prompts/reasoning and non-text image/audio tokens cannot be counted by this relay.</p>
      </div>
      <div class="panel token-summary"><span class="brand">ESTIMATED TOOL TOKENS</span><h2>Input / output breakdown</h2>
        <p style="font-size:12px;margin:0 0 12px">Model perspective; not complete model token usage.</p>
        <div class="breakdown-row"><span><i class="mini-dot"></i>Input · tool results</span>
          <strong>${has?formatTokens(totals.input):'—'}</strong></div>
        <div class="breakdown-row output"><span><i class="mini-dot"></i>Output · tool arguments</span>
          <strong>${has?formatTokens(totals.output):'—'}</strong></div>
        <div class="token-total"><span>TOTAL ESTIMATED MCP TOKENS</span>
          <strong>${has?formatTokens(totals.total):'—'}</strong>
          <small>${has?totals.reports.toLocaleString('en-US')+' MCP tool calls':'Waiting for BRC tool calls'}</small></div>
        <p style="font-size:11px;margin-top:16px">Tokenizer: local OpenAI encoding when identified, otherwise universal o200k_base estimate. Neither measures full chat tokens.</p>
        <div class="breakdown-row"><span>GPT encoding matched</span><strong>${matched.toLocaleString('en-US')} calls</strong></div>
        <div class="breakdown-row"><span>Universal fallback</span><strong>${fallback.toLocaleString('en-US')} calls</strong></div>
        <div class="breakdown-row"><span>Sent to agent</span><strong>${formatPayloadBytes(sentBytes)}</strong></div>
        <div class="breakdown-row"><span>Returned from agent</span><strong>${formatPayloadBytes(receivedBytes)}</strong></div>
        <p style="font-size:11px;margin-top:8px">Byte values are exact serialized tool WebSocket payload sizes, excluding protocol framing. Relay-only tools have no agent traffic. Matched encoding uses an optional client-provided model hint (not verified).</p>
        ${partial?`<p class="err" style="font-size:11px">${partial.toLocaleString('en-US')} call(s) included non-text, truncated or skipped content. Totals are incomplete.</p>`:''}
      </div>
    </div>
  </section>`;
}

export function dashboardPage(
  publicUrl: string, devices: DeviceView[], audit: AuditView[],
  stats: { total: number; failed: number; last24h: number },
  usage: View, pluginHtml = '', flash = '', estimate?: View, estimateDays: McpEstimateDay[] = [], estimateEnabled = true,
): string {
  const online = devices.filter(device => device.online && !device.paused).length;
  const percent = devices.length ? Math.round(online / devices.length * 100) : 0;
  const hero = `<section class="hero" aria-label="Relay control center">
    <div class="tag"><span class="online-dot"></span>RELAY CONTROL CENTER</div>
    <h1>Everything connected.<br>Everything in control.</h1>
    <p>Your command center for devices, access, MCP tools and model usage. Secure, organized and always in your hands.</p>
    <div class="row"><a class="btn primary" href="/device/verify">+ Pair new device</a>
      <a class="btn secondary" href="/auth/links">Private MCP link ↗</a></div>
    <div class="hero-foot"><span class="pill ok"><span class="dot"></span>Control plane available</span>
      <span class="muted">MCP endpoint</span><code>${esc(publicUrl)}/mcp</code></div>
    <div class="hero-side" aria-label="Device connection overview">
      <div class="overview-top"><span>CONNECTED DEVICES</span><span class="online-dot"></span></div>
      <div class="overview-number">${online} <small>/ ${devices.length}</small></div>
      <small>Active and accepting calls</small>
      <div class="mini-rail"><span style="width:${percent}%"></span></div>
      <small>${percent}% available</small>
    </div>
  </section>`;
  const statsBlock = `<div class="grid section">
    ${metric('Online devices', String(online), devices.length + ' paired in total', 'devices')}
    ${metric('Tool calls · last 24h', stats.last24h.toLocaleString('en-US'), 'Live session activity', 'calls')}
    ${metric('Failed tool calls', stats.failed.toLocaleString('en-US'), 'Live session · ' + stats.total.toLocaleString('en-US') + ' total', 'failed')}
  </div>`;
  const cards = devices.map(device => {
    const state = device.paused ? 'Paused' : device.online ? 'Online' : 'Offline';
    const stateClass = device.paused ? 'err' : device.online ? 'ok' : 'muted';
    return `<div class="device"><form method="post" action="/admin/device">
      <input type="hidden" name="device_id" value="${esc(device.device_id)}">
      <div class="device-top"><div style="flex:1;min-width:0">
        <span class="device-avatar">${ICONS.pc}</span>
        <span class="brand" style="margin-bottom:5px">${esc(device.platform ?? 'DEVICE')}</span>
        <label class="device-name-label" for="dev-${esc(device.device_id)}">DEVICE NAME</label>
        <input id="dev-${esc(device.device_id)}" name="name" value="${esc(device.name)}" maxlength="80" aria-label="Device name">
        <div class="device-id">${esc(device.device_id)} · seen ${ago(device.last_seen)}</div>
      </div><span class="pill ${stateClass}"><span class="dot"></span>${state}</span></div>
      <div class="actions">
        <button class="secondary" name="action" value="rename">Save name</button>
        <button class="secondary" name="action" value="${device.paused ? 'resume' : 'pause'}">${device.paused ? 'Resume' : 'Pause'}</button>
        <button class="secondary danger" name="action" value="delete"
          onclick="return confirm('Remove this device and revoke its token?')">Remove</button>
      </div></form></div>`;
  }).join('');
  const activityRows = audit.length ? audit.slice(0, 20).map(item =>
    `<tr><td>${ago(item.ts)}</td><td>${esc(item.device)}</td><td><code>${esc(item.tool)}</code></td>
      <td><span class="pill ${item.ok ? 'ok' : 'err'}"><span class="dot"></span>${item.ok ? 'Success' : 'Failed'}</span></td>
      <td>${item.ms === null ? '—' : item.ms + ' ms'}</td></tr>`).join('') :
    '<tr><td colspan="5" class="muted">No tool calls have been recorded in this relay process.</td></tr>';
  const deviceSection = `<section class="section" id="devices"><div class="section-head"><div>
    <span class="brand">DEVICE MANAGEMENT</span><h2>Connected devices</h2>
    <p>Manage names, device permissions and availability across your workspace.</p></div>
    <a class="btn secondary" href="/device/verify">+ Pair device</a></div>
    <div class="device-grid">${cards || '<div class="empty">No devices paired yet. Pair a device to get started.</div>'}</div></section>`;
  const activitySection = `<section class="section" id="activity"><div class="section-head"><div>
    <span class="brand">RECENT OPERATIONS</span><h2>Recent activity</h2>
    <p>Lightweight diagnostics for this relay process · no stored transcripts.</p></div>
    <span class="pill">Last 20 calls</span></div>
    <div class="panel table-wrap" style="padding:0"><table><thead><tr>
      <th>Time</th><th>Device</th><th>Tool</th><th>Status</th><th>Duration</th>
    </tr></thead><tbody>${activityRows}</tbody></table></div></section>`;
  return layout('Admin', hero + statsBlock + automaticUsageSection(estimate, estimateDays, estimateEnabled,usage.period) + usageSection(usage) + deviceSection + flash + pluginHtml + activitySection, 'wide');
}
