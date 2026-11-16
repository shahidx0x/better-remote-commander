// End-to-end: authenticated owner dashboard, owner-approved skill library,
// model-reported usage, idempotent accounting, private MCP read access.
import assert from 'node:assert/strict';
const [base,username,password]=process.argv.slice(2);
const step=(name,ok)=>{console.log((ok?'PASS':'FAIL')+'  '+name);assert.ok(ok,name)};
const form=(obj)=>new URLSearchParams(obj);
const fetchHtml=async(path,cookie)=> (await fetch(base+path,{headers:{cookie}})).text();
const login=await fetch(base+'/auth/login',{method:'POST',redirect:'manual',
 headers:{'content-type':'application/x-www-form-urlencoded'},
 body:form({username,password,returnTo:'/admin'})});
const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
step('owner session login',login.status===302&&cookie.startsWith('brc_session='));
let html=await fetchHtml('/admin',cookie);
step('responsive sidebar and model usage sections render',html.includes('class="sidebar"')&&html.includes('Model token analytics')&&html.includes('Daily')&&html.includes('Weekly')&&html.includes('Monthly'));
step('dashboard contains device and private link navigation',html.includes('Pair new device')&&html.includes('/auth/links')&&html.includes('Agent skills'));
html=await fetchHtml('/admin/skills',cookie);
const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];
step('skill library is authenticated and csrf-protected',!!csrf&&html.includes('Skill library'));
const importBody=form({csrf,action:'manual',id:'testskills/e2e-demo',name:'E2E example',
  description:'An owner-approved example for remote assistants',source:'https://example.invalid/e2e',
  markdown:'---\nname: E2E\n---\n# E2E Skill\nOnly read test data.',trust:'yes'});
let r=await fetch(base+'/admin/skills/import',{method:'POST',redirect:'manual',
 headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:importBody});
step('owner can approve skill through admin',r.status===303&&r.headers.get('location')?.includes('imported'));
html=await fetchHtml('/admin/skills',cookie);
step('approved skill becomes visible',html.includes('E2E example')&&html.includes('testskills/e2e-demo'));
r=await fetch(base+'/admin/skills/delete',{method:'POST',redirect:'manual',headers:{cookie,
 'content-type':'application/x-www-form-urlencoded'},body:form({id:'testskills/e2e-demo',csrf:'invalid'})});
step('skill deletion without valid csrf is forbidden',r.status===403);
const keys=await fetchHtml('/auth/apikeys',cookie);
const keyCsrf=keys.match(/name="csrf" value="([^"]+)"/)?.[1];
step('owner can open API key management',!!keyCsrf);
r=await fetch(base+'/auth/apikeys',{method:'POST',headers:{cookie,
 'content-type':'application/x-www-form-urlencoded'},body:form({name:'usage-e2e',csrf:keyCsrf})});
const keyPage=await r.text();
const apiKey=keyPage.match(/brc_ak_[A-Za-z0-9_-]{43}/)?.[0];
step('owner creates a token reporting API key',!!apiKey);
const event_id='e2e_'+Date.now().toString(36)+'_sample';
const report={event_id,provider:'openai',model:'gpt-6',input_tokens:1420000,output_tokens:312000};
r=await fetch(base+'/api/usage/report',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify(report)});
const a=await r.json();
step('report accepted and storage-backed',r.status===201&&a.recorded===true);
r=await fetch(base+'/api/usage/report',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify(report)});
const duplicate=await r.json();
step('duplicate event does not inflate totals',r.status===200&&duplicate.duplicate===true);
r=await fetch(base+'/api/usage/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...report,event_id:'unauthorized_123'})});
step('usage reporting cannot be sent without an API key',r.status===401);
for(const period of ['day','week','month']){
  html=await fetchHtml('/admin?period='+period,cookie);
  step(period+' model analytics shows actual input/output tokens',html.includes('1.42M')&&html.includes('312K')&&html.includes('1.73M'));
}
const linkManager=await fetchHtml('/auth/links',cookie);
const csrfLink=linkManager.match(/name="csrf" value="([^"]+)"/)?.[1];
r=await fetch(base+'/auth/links',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},
 body:form({csrf:csrfLink,name:'skills-e2e-read',mode:'read',days:'1'})});
const linkHtml=await r.text();
const url=linkHtml.match(/id="new-connection-url"[^>]+value="([^"]+)"/)?.[1];
step('original private no-oauth link creation still works',!!url);
async function callMcp(name,args){
 const response=await fetch(url,{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:Math.ceil(Math.random()*100000),method:'tools/call',params:{name,arguments:args}})});
 const raw=await response.text();const m=raw.trim().startsWith('{')?JSON.parse(raw):
  raw.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6))).find(x=>x.result||x.error);
 return {response,m};
}
let reply=await callMcp('list_skills',{});
step('AI reads owner-approved skill library via private read-only MCP URL',reply.response.status===200&&reply.m?.result?.content?.[0]?.text.includes('E2E example'));
reply=await callMcp('request_skill_install',{id:'vendor/repo/new',reason:'test'});
step('read-only link cannot queue/install skills',reply.m?.result?.isError===true);
r=await fetch(base+'/admin/skills/delete',{method:'POST',redirect:'manual',headers:{cookie,
 'content-type':'application/x-www-form-urlencoded'},body:form({id:'testskills/e2e-demo',csrf})});
step('owner can remove skill',r.status===303);
html=await fetchHtml('/admin/skills',cookie);
step('removed skill no longer in approved library',!html.includes('E2E example'));
