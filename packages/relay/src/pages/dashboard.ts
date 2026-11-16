import { layout, esc } from './html.js';
import { formatTokens, type UsagePeriod, type UsageBucket } from '../features/usage.js';
import type { DeviceView, AuditView } from './admin.js';
import type { usageView } from '../features/usage.js';

type View = ReturnType<typeof usageView>;
const ago=(t:number|null)=>{
 if(!t)return 'Never';
 const s=Math.max(0,Math.round((Date.now()-t)/1000));
 return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':s<86400?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago';
};
const metric=(title:string,value:string,hint:string)=>`<div class="panel stat"><span>${esc(title)}</span><strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`;
function tokenChart(buckets:UsageBucket[]):string{
 const max=Math.max(...buckets.map(b=>b.total),1);
 const bars=buckets.map(b=>{
    const hIn=b.input?Math.max(2,100*b.input/max):0;
    const hOut=b.output?Math.max(2,100*b.output/max):0;
    return `<div class="chart-col" title="${esc(b.label)}: input ${b.input.toLocaleString('en-US')}, output ${b.output.toLocaleString('en-US')}">
      <div class="bar input" style="height:${hIn}%"></div><div class="bar output" style="height:${hOut}%"></div>
      <span class="chart-label">${esc(b.label)}</span></div>`;
 }).join('');
 return `<div class="chart" role="img" aria-label="Input and output model tokens by selected period">${bars}</div><div class="legend"><span><i></i> Input tokens</span><span><i class="out"></i> Output tokens</span></div>`;
}
function usageSection(v:View):string{
 const period=v.period, t=v.totals,has=t.reports>0;
 const tabs=(['day','week','month'] as UsagePeriod[]).map(p=>
 `<a href="/admin?period=${p}#tokens" class="${p===period?'active':''}" ${p===period?'aria-current="page"':''}>${p==='day'?'Daily':p==='week'?'Weekly':'Monthly'}</a>`).join('');
 return `<section class="section" id="tokens">
   <div class="section-head"><div><h2>Model token analytics</h2><p>Provider-reported tokens · UTC · no prompt or response content stored</p></div><div class="period-tabs">${tabs}</div></div>
   <div class="analytics-grid">
    <div class="panel"><div class="section-head" style="margin-bottom:5px"><div><strong>Input / output volume</strong><p style="font-size:12px">${period==='day'?'Last 14 days':period==='week'?'Last 12 weeks':'Last 12 months'}</p></div><span class="pill">Reported usage</span></div>
      ${has?tokenChart(v.buckets):'<div class="empty"><strong>No model usage reported yet</strong><p>MCP transport does not expose ChatGPT model tokens. Connect a usage-reporting model client to display real totals.</p></div>'}
    </div>
    <div class="panel"><span class="brand">TOKEN BREAKDOWN</span>
      ${metric('Input tokens',has?formatTokens(t.input):'—','Provider-reported input')}
      ${metric('Output tokens',has?formatTokens(t.output):'—','Provider-reported output')}
      <div class="panel" style="padding:16px;background:#202c40;margin-top:12px"><span class="muted" style="font-size:12px">Total tokens (selected period)</span><strong style="display:block;font-size:30px;margin-top:5px">${has?formatTokens(t.total):'—'}</strong><p style="font-size:11px;margin:0">${has?t.reports+' usage reports received':'Waiting for provider usage reports'}</p></div>
    </div>
   </div><p style="font-size:11px;margin-top:11px">Only actual token usage sent by an instrumented model client is counted. This is not inferred from terminal activity, and does not affect MCP tool execution time.</p>
  </section>`;
}
export function dashboardPage(publicUrl:string,devices:DeviceView[],audit:AuditView[],
 stats:{total:number;failed:number;last24h:number},usage:View,pluginHtml='',flash=''):string{
 const online=devices.filter(d=>d.online&&!d.paused).length;
 const hero=`<div class="hero"><div class="tag">RELAY CONTROL CENTER</div><h1>Your workspace, in control.</h1>
 <p>Pair devices, manage secure connections, discover MCP tools and review your reported model usage from a single dashboard.</p>
 <div class="row"><a class="btn primary" href="/device/verify">＋ Pair new device</a><a class="btn secondary" href="/auth/links">↗ Private MCP link</a></div>
 <div class="hero-foot"><span class="pill ok"><span class="dot"></span> Relay ready</span><span class="muted" style="font-size:11px">Endpoint:</span><code>${esc(publicUrl)}/mcp</code></div></div>`;
 const statsBlock=`<div class="grid section">${metric('Online devices',String(online),devices.length+' paired in total')}
  ${metric('Tool calls · last 24h',stats.last24h.toLocaleString('en-US'),'Live session activity')}
  ${metric('Failed tool calls',stats.failed.toLocaleString('en-US'),'Live session · '+stats.total.toLocaleString('en-US')+' total')}</div>`;
 const cards=devices.map(d=>`<div class="device"><form method="post" action="/admin/device"><input type="hidden" name="device_id" value="${esc(d.device_id)}">
 <div class="device-top"><div style="min-width:0;flex:1"><span class="brand">${esc(d.platform??'DEVICE')}</span>
 <label style="margin:8px 0 3px" for="dev-${esc(d.device_id)}">Device name</label><input id="dev-${esc(d.device_id)}" name="name" value="${esc(d.name)}" maxlength="80">
 <p style="font-size:11px;margin-top:8px">${esc(d.device_id)} · seen ${ago(d.last_seen)}</p></div>
 <span class="pill ${d.online&&!d.paused?'ok':d.paused?'err':'muted'}"><span class="dot"></span>${d.paused?'Paused':d.online?'Online':'Offline'}</span></div>
 <div class="actions"><button class="secondary" name="action" value="rename">Save name</button>
 <button class="secondary" name="action" value="${d.paused?'resume':'pause'}">${d.paused?'Resume':'Pause'}</button>
 <button class="secondary danger" name="action" value="delete" onclick="return confirm('Remove this device and revoke its token?')">Remove</button></div></form></div>`).join('');
 const activityRows=audit.length?audit.slice(0,20).map(a=>`<tr><td>${ago(a.ts)}</td><td>${esc(a.device)}</td><td><code>${esc(a.tool)}</code></td><td><span class="pill ${a.ok?'ok':'err'}">${a.ok?'Success':'Failed'}</span></td><td>${a.ms??'—'} ms</td></tr>`).join(''):'<tr><td colspan="5" class="muted">No tool calls have been recorded in this relay process.</td></tr>';
 const deviceSection=`<section class="section" id="devices"><div class="section-head"><div><h2>Connected devices</h2><p>Manage paired device names, access and live availability.</p></div><a class="btn secondary" href="/device/verify">＋ Pair device</a></div><div class="device-grid">${cards||'<div class="empty">No devices paired yet.</div>'}</div></section>`;
 const activitySection=`<section class="section" id="activity"><div class="section-head"><div><h2>Recent activity</h2><p>Lightweight, live-only diagnostic metadata · not stored as transcripts.</p></div><span class="pill">Last 20 calls</span></div>
 <div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Time</th><th>Device</th><th>Tool</th><th>Status</th><th>Duration</th></tr></thead><tbody>${activityRows}</tbody></table></div></section>`;
 return layout('Admin',hero+statsBlock+usageSection(usage)+deviceSection+flash+pluginHtml+activitySection,'wide');
}
