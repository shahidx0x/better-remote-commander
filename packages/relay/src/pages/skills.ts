import { layout, esc } from './html.js';
import { fileNames, skillFile, type SkillRow, type SkillRequest } from '../features/skills.js';

/** Every dynamic value goes through esc(). POST forms get their CSRF field from app.ts (withCsrfFields). */
export function skillsPage(v: { skills: SkillRow[]; requests: SkillRequest[]; prefill: string; error?: string; notice?: string }): string {
  const head = `<div class="section-head"><div><h1>Skill library</h1><p>Approved SKILL.md instructions for your AI clients. Skills are plain text: nothing is executed or installed automatically. Only you can approve one.</p></div><a href="/admin"><button class="secondary">Back</button></a></div>`;
  const message = v.error ? `<div class="panel err" role="alert">${esc(v.error)}</div>` : v.notice ? `<div class="panel" role="status">${esc(v.notice)}</div>` : '';
  const cards = v.skills.map((s) => `<div class="device"><div class="device-top"><div><h2>${esc(s.name)}</h2><p>${esc(s.description)}</p></div><span class="pill ok">Approved</span></div>
<p><code>${esc(s.id)}</code> - ${fileNames(s).length} file(s)${s.source ? ' - ' + esc(s.source) : ''}</p>
<details><summary>View SKILL.md</summary><pre style="white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto">${esc(skillFile(s))}</pre></details>
<form method="post" action="/admin/skills/delete"><input type="hidden" name="id" value="${esc(s.id)}"><div class="actions"><button class="secondary danger" onclick="return confirm('Remove this skill?')">Remove</button></div></form></div>`).join('');
  const pending = v.requests.map((r) => `<div class="device"><div class="device-top"><div><strong><code>${esc(r.skill_id)}</code></strong><p>Requested by ${esc(r.client)} - ${esc(new Date(r.created_at).toUTCString())}</p><p>${esc(r.reason)}</p></div><span class="pill">Review needed</span></div>
<div class="actions"><a href="/admin/skills?id=${encodeURIComponent(r.skill_id)}#import"><button class="secondary" type="button">Review and import</button></a>
<form method="post" action="/admin/skills/reject" style="display:inline"><input type="hidden" name="id" value="${esc(r.id)}"><button class="secondary danger">Dismiss</button></form></div></div>`).join('');
  const manual = `<div class="section" id="import"><div class="section-head"><div><h2>Import a reviewed skill</h2><p>Paste SKILL.md from a source you trust. Only text is saved.</p></div></div>
<div class="panel"><form method="post" action="/admin/skills/import">
<label>Skill ID</label><input name="id" value="${esc(v.prefill)}" placeholder="owner/repository/skill-name" maxlength="160" required>
<label>Display name</label><input name="name" maxlength="100" required>
<label>Source URL or attribution</label><input name="source" maxlength="400">
<label>Short description</label><input name="description" maxlength="600">
<label>SKILL.md content</label><textarea name="markdown" required maxlength="60000" rows="12"></textarea>
<label><input type="checkbox" name="trust" value="yes" required> I reviewed and approve these instructions for my AI clients.</label>
<div class="row"><button class="primary">Import skill</button></div></form></div></div>`;
  return layout('Skills', head + message
    + `<div class="section"><div class="section-head"><div><h2>Approved skills</h2><p>${v.skills.length} available to connected MCP clients.</p></div></div><div class="device-grid">${cards || '<div class="panel"><p class="muted">No approved skills yet.</p></div>'}</div></div>`
    + (pending ? `<div class="section"><div class="section-head"><div><h2>Requests awaiting review</h2></div></div><div class="device-grid">${pending}</div></div>` : '')
    + manual, 'wide');
}
