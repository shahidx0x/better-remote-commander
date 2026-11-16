import {layout,esc} from './html.js';
import {fileNames,skillFile,type SkillRow,type SkillRequest,type CatalogSkill} from '../features/skills.js';

export function skillsPage(v:{skills:SkillRow[];requests:SkillRequest[];results:CatalogSkill[];
  configured:boolean;csrf:string;q:string;error?:string;notice?:string}):string{
 const head=`<div class="section-head"><div><span class="brand">AGENT CAPABILITIES</span><h1>Skill library</h1><p>Curate trusted SKILL.md instructions for your AI clients. Review sources before importing; nothing executes automatically.</p></div><a class="btn secondary" href="https://skills.sh" target="_blank" rel="noopener noreferrer">Browse skills.sh ↗</a></div>`;
 const message=v.error?`<div class="panel section err" role="alert">${esc(v.error)}</div>`:v.notice?`<div class="panel section ok" role="status">${esc(v.notice)}</div>`:'';
 const cards=v.skills.map(s=>`<div class="device"><div class="device-top"><div><span class="brand">APPROVED</span><h2>${esc(s.name)}</h2><p>${esc(s.description)}</p></div><span class="pill ok">Available</span></div>
 <p style="font-size:11px">${esc(s.id)} · ${fileNames(s).length} file(s)</p><details><summary>View SKILL.md and supporting files</summary><p class="muted">${fileNames(s).map(esc).join(' · ')}</p><pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:340px;overflow:auto;color:#c9d8ef">${esc(skillFile(s))}</pre></details>
 <form method="post" action="/admin/skills/delete" onsubmit="return confirm('Delete approved skill?')"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="id" value="${esc(s.id)}"><div class="actions"><button class="secondary danger">Remove skill</button></div></form></div>`).join('');
 const pending=v.requests.map(r=>`<div class="device"><div class="device-top"><div><strong>${esc(r.skill_id)}</strong><p>Requested by ${esc(r.client)} · ${new Date(r.created_at).toUTCString()}</p><p>${esc(r.reason)}</p></div><span class="pill">Review needed</span></div>
 <div class="actions"><a class="btn secondary" href="https://skills.sh/${encodeURI(r.skill_id)}" target="_blank" rel="noopener noreferrer">Review source ↗</a>
 ${v.configured?`<form method="post" action="/admin/skills/import" style="display:inline"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="id" value="${esc(r.skill_id)}"><input type="hidden" name="action" value="catalog"><input type="hidden" name="trust" value="yes"><button class="primary" onclick="return confirm('Have you reviewed this third-party skill and approved its instructions?')">Approve &amp; import</button></form>`:''}
 <form method="post" action="/admin/skills/reject" style="display:inline"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="id" value="${esc(r.id)}"><button class="secondary danger">Dismiss</button></form></div></div>`).join('');
 const searchResults=v.results.map(s=>`<div class="device"><div class="device-top"><div><strong>${esc(s.name)}</strong><p>${esc(s.id)} · ${s.installs.toLocaleString('en-US')} installs</p></div><span class="pill">skills.sh</span></div><div class="actions">
 <a class="btn secondary" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Review on skills.sh ↗</a><form method="post" action="/admin/skills/import" style="display:inline">
 <input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="id" value="${esc(s.id)}"><input type="hidden" name="action" value="catalog"><input type="hidden" name="trust" value="yes">
 <button class="primary" onclick="return confirm('Have you reviewed this skill and its contents?')">Approve &amp; import</button></form></div></div>`).join('');
 const search=`<section class="section"><div class="section-head"><div><h2>Discover skills</h2><p>Search skills.sh's catalog or add any SKILL.md manually.</p></div></div>
 <div class="panel"><form method="get" action="/admin/skills" class="row" style="margin-top:0"><input name="q" placeholder="Search design, testing, Next.js..." value="${esc(v.q)}" maxlength="100" style="flex:1;min-width:220px"><button class="primary">Search skills.sh</button></form>
 ${v.configured?'<p class="muted" style="font-size:12px">Catalog search is configured with a short-lived Vercel OIDC token.</p>':'<p class="muted" style="font-size:12px">skills.sh API requires Vercel OIDC. Search may be unavailable on a self-hosted relay; browse skills.sh and manually import reviewed SKILL.md content below. Your existing skills still work offline.</p>'}
 </div>${searchResults?'<div class="device-grid section">'+searchResults+'</div>':''}</section>`;
 const manual=`<section class="section" id="import"><div class="section-head"><div><h2>Import a reviewed skill</h2><p>Paste SKILL.md instructions from a trusted source. Only text is saved; no scripts are installed or run.</p></div></div>
 <div class="panel"><form method="post" action="/admin/skills/import"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="action" value="manual">
 <div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div><label>Skill ID</label><input name="id" placeholder="owner/repository/skill-name" maxlength="160" required></div><div><label>Display name</label><input name="name" placeholder="Frontend design" maxlength="100" required></div></div>
 <label>Source URL or attribution</label><input name="source" placeholder="https://skills.sh/owner/repo/skill" maxlength="400">
 <label>Short description</label><input name="description" maxlength="600" placeholder="What this skill helps with">
 <label>SKILL.md content</label><textarea name="markdown" required maxlength="100000" rows="12" placeholder="---&#10;name: ...&#10;description: ...&#10;---&#10;Skill instructions..."></textarea>
 <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="trust" value="yes" required> I reviewed and approve these instructions for my AI clients.</label>
 <div class="row"><button class="primary">Import skill</button></div></form></div></section>`;
 return layout('Skills',head+message+`<div class="section"><div class="section-head"><div><h2>Approved skills</h2><p>${v.skills.length} available to connected MCP clients.</p></div></div><div class="device-grid">${cards||'<div class="empty">No approved skills yet. Import one below.</div>'}</div></div>`+
 (pending?`<section class="section"><div class="section-head"><div><h2>Requests awaiting review</h2><p>Only you can approve a requested skill.</p></div></div><div class="device-grid">${pending}</div></section>`:'')+
 search+manual,'wide');
}
