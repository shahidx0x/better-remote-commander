import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {buildRelay} from '../dist/app.js';
import {validateUsageReport,usageTotals} from '../dist/features/usage.js';
import {validateSkill,MAX_SKILL_BYTES} from '../dist/features/skills.js';

const dirs=[];
const cfg=(n)=>{const d=mkdtempSync(path.join(os.tmpdir(),'brc-su-'));dirs.push(d);return {port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3299',trustProxy:false,dbFile:path.join(d,n+'.sqlite'),sessionSecret:'s',adminUser:'admin',adminPassword:'pw',relayVersion:'t'};};
const listen=async(r)=>{await new Promise(x=>r.http.listen(0,'127.0.0.1',x));return 'http://127.0.0.1:'+r.http.address().port;};
const form=(o)=>new URLSearchParams(o).toString();

// Skills are OFF unless BRC_SKILLS=1. Build the default relay first.
delete process.env.BRC_SKILLS;
const off=buildRelay(cfg('off'),()=>{});
const offBase=await listen(off);
process.env.BRC_SKILLS='1';
const relay=buildRelay(cfg('on'),()=>{});
delete process.env.BRC_SKILLS;
const base=await listen(relay);
after(async()=>{for(const r of [off,relay]){r.http.closeAllConnections();await r.close();}for(const d of dirs)rmSync(d,{recursive:true,force:true});});

const post=(b,p,body,cookie)=>fetch(b+p,{method:'POST',redirect:'manual',headers:{...(cookie?{cookie}:{}),'content-type':'application/x-www-form-urlencoded'},body:form(body)});
async function session(b){
  const l=await post(b,'/auth/login',{username:'admin',password:'pw',returnTo:'/admin'});
  const cookie=(l.headers.get('set-cookie')??'').split(';')[0];
  const html=await (await fetch(b+'/auth/links',{headers:{cookie}})).text();
  return {cookie,csrf:html.match(/name="csrf" value="([^"]+)"/)[1]};
}
const s=await session(base);
const user=relay.store.getUserByName('admin');
const rpc=(url,method,params)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(async r=>{const t=await r.text();return {status:r.status,body:t.startsWith('event')?JSON.parse(t.split('\n').find(l=>l.startsWith('data: ')).slice(6)):JSON.parse(t)};});
async function link(mode){
  const r=await post(base,'/auth/links',{csrf:s.csrf,name:'t-'+mode,mode,days:'7'},s.cookie);
  return base+'/c/'+(await r.text()).match(/(brc_link_[A-Za-z0-9_-]{43})/)[1]+'/mcp';
}
const importSkill=(over={})=>post(base,'/admin/skills/import',{csrf:s.csrf,id:'vendor/repo/example',name:'Example',description:'d',source:'https://example.com/x',markdown:'# Hello\nDo careful work.',trust:'yes',...over},s.cookie);

test('skills routes do not exist unless BRC_SKILLS=1',async()=>{
  const o=await session(offBase);
  assert.equal((await fetch(offBase+'/admin/skills',{headers:{cookie:o.cookie},redirect:'manual'})).status,404);
  const l=await post(offBase,'/auth/links',{csrf:o.csrf,name:'x',mode:'full',days:'7'},o.cookie);
  const url=offBase+'/c/'+(await l.text()).match(/(brc_link_[A-Za-z0-9_-]{43})/)[1]+'/mcp';
  const names=(await rpc(url,'tools/list',{})).body.result.tools.map(t=>t.name);
  assert.ok(!names.includes('list_skills'));
});

test('skills management requires login and CSRF; approval stays with the owner',async()=>{
  assert.notEqual((await fetch(base+'/admin/skills',{redirect:'manual'})).status,200);
  assert.ok([302,303,401,403].includes((await post(base,'/admin/skills/import',{id:'a/b',name:'n',markdown:'x',trust:'yes'})).status),'anonymous import is refused');
  assert.equal((await post(base,'/admin/skills/import',{csrf:'bad',id:'a/b',name:'n',markdown:'x',trust:'yes'},s.cookie)).status,403);
  assert.equal((await post(base,'/admin/skills/import',{id:'a/b',name:'n',markdown:'x',trust:'yes'},s.cookie)).status,403,'missing csrf');
  assert.equal((await importSkill({trust:''})).status,400,'explicit approval is required');
  assert.equal(relay.store.listSkills(user.id).length,0);
  const ok=await importSkill();
  assert.equal(ok.status,303);
  assert.equal(relay.store.listSkills(user.id).length,1);
});

test('AI tools: list/read work on full and read-only links; install request only on full and never installs',async()=>{
  const full=await link('full'),read=await link('read');
  const call=(u,name,args)=>rpc(u,'tools/call',{name,arguments:args}).then(r=>r.body.result);
  const readNames=(await rpc(read,'tools/list',{})).body.result.tools.map(t=>t.name);
  assert.ok(readNames.includes('list_skills')&&readNames.includes('read_skill')&&!readNames.includes('request_skill_install'));
  assert.match((await call(read,'list_skills',{})).content[0].text,/vendor\/repo\/example/);
  assert.match((await call(read,'read_skill',{id:'vendor/repo/example'})).content[0].text,/Do careful work/);
  const blocked=await call(read,'request_skill_install',{id:'v/r/other',reason:'x'});
  assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/READ_ONLY_CONNECTION/);
  assert.equal(relay.store.listSkillRequests(user.id).length,0);
  const r=await call(full,'request_skill_install',{id:'vendor/repo/other',reason:'need it'});
  assert.match(r.content[0].text,/Nothing has been installed/);
  assert.equal(relay.store.getSkill(user.id,'vendor/repo/other'),undefined,'a request is not an approval');
  assert.equal(relay.store.listSkillRequests(user.id).length,1);
  const dup=await call(full,'request_skill_install',{id:'vendor/repo/other',reason:'again'});
  assert.equal(relay.store.listSkillRequests(user.id).length,1,'duplicate requests do not flood the queue');
  assert.equal((await call(full,'read_skill',{id:'vendor/repo/nope'})).isError,true);
  assert.equal((await call(full,'read_skill',{id:'vendor/repo/example',file:'../../etc/passwd'})).isError,true);
  const page=await (await fetch(base+'/admin/skills',{headers:{cookie:s.cookie}})).text();
  assert.match(page,/vendor\/repo\/other/);
});

test('skill text and metadata are HTML-escaped; forms carry CSRF',async()=>{
  const evil='<script>alert(1)</script>';
  assert.equal((await importSkill({id:'evil/repo/xss',name:evil,description:'"><img src=x onerror=alert(2)>',source:evil,markdown:'</pre><script>alert(3)</script>'})).status,303);
  relay.store.createSkillRequest(user.id,'req/rest/one','<b>client</b>','<script>alert(4)</script>');
  const page=await (await fetch(base+'/admin/skills',{headers:{cookie:s.cookie}})).text();
  assert.ok(!page.includes('<script>alert'),'no raw script tags');
  assert.ok(!page.includes('<img src=x'));
  assert.match(page,/&lt;script&gt;alert\(3\)/);
  assert.match(page,/name="csrf"/);
});

test('skill limits: size, file count, id and path validation, per-user count',async()=>{
  assert.equal((await importSkill({id:'big/repo/one',markdown:'x'.repeat(MAX_SKILL_BYTES+1)})).status,413,'global 64kb form limit applies first');
  assert.throws(()=>validateSkill({id:'a/b',name:'n',files:[{path:'SKILL.md',contents:'x'.repeat(MAX_SKILL_BYTES+1)}]},'u'),/128 KiB/);
  assert.equal((await importSkill({id:'../etc/passwd'})).status,400);
  assert.equal((await importSkill({id:'a b/c'})).status,400);
  const f=(p,c='x')=>({path:p,contents:c});
  const base1={id:'a/b',name:'n',description:'',source:''};
  assert.throws(()=>validateSkill({...base1,files:[f('SKILL.md'),f('../x')]},'u'));
  assert.throws(()=>validateSkill({...base1,files:[f('SKILL.md'),f('/abs')]},'u'));
  assert.throws(()=>validateSkill({...base1,files:[f('SKILL.md'),f('a\\b')]},'u'));
  assert.throws(()=>validateSkill({...base1,files:[f('SKILL.md'),f('SKILL.md')]},'u'));
  assert.throws(()=>validateSkill({...base1,files:[f('README.md')]},'u'),/SKILL.md/);
  assert.throws(()=>validateSkill({...base1,files:Array.from({length:33},(_,i)=>f(i?'f'+i+'.md':'SKILL.md'))},'u'));
  for(let i=0;i<110;i++){const r=await importSkill({id:'bulk/repo/s'+i});if(r.status!==303){assert.equal(r.status,400);assert.ok(i>=90);return;}}
  assert.fail('per-user skill cap was not enforced');
});

test('delete and dismiss need CSRF',async()=>{
  assert.equal((await post(base,'/admin/skills/delete',{id:'vendor/repo/example'},s.cookie)).status,403);
  assert.equal((await post(base,'/admin/skills/delete',{csrf:s.csrf,id:'vendor/repo/example'},s.cookie)).status,303);
  assert.equal(relay.store.getSkill(user.id,'vendor/repo/example'),undefined);
});

/* ---------------- usage ---------------- */
const now=Date.UTC(2026,10,16,12);
test('usage validation rejects bad input',()=>{
  const ok={event_id:'event_000001',timestamp:now,provider:'openai',model:'gpt-x',input_tokens:5,output_tokens:6};
  assert.equal(validateUsageReport(ok,'u',now).day,'2026-11-16');
  for(const bad of [{...ok,input_tokens:'3'},{...ok,output_tokens:-1},{...ok,event_id:'!!'},{...ok,model:'../x'},{...ok,timestamp:now+86_400_000},{...ok,input_tokens:0,output_tokens:0},[]])
    assert.throws(()=>validateUsageReport(bad,'u',now));
  const t=usageTotals([{day:'2026-11-16',input_tokens:1,output_tokens:2,reports:1},{day:'2026-11-12',input_tokens:10,output_tokens:0,reports:1},{day:'2026-10-01',input_tokens:100,output_tokens:0,reports:1}],now);
  assert.deepEqual([t.day.total,t.week.total,t.month.total],[3,13,13]);
});

const report=(key,body,headers={})=>fetch(base+'/api/usage/report',{method:'POST',headers:{'content-type':'application/json',...(key?{authorization:'Bearer '+key}:{}),...headers},body:JSON.stringify(body)});
test('usage endpoint accepts only an owner API key, is idempotent, and feeds the admin page',async()=>{
  const key=relay.store.createApiKey(user.id,'k1').raw;
  const body={event_id:'evt_dup_000001',provider:'openai',model:'gpt-x',input_tokens:1234,output_tokens:567};
  assert.equal((await report(null,body)).status,401);
  assert.equal((await report('nope',body)).status,401);
  // A private link, an OAuth-style token and a session cookie are not API keys.
  const l=(await link('full')).match(/brc_link_[A-Za-z0-9_-]+/)[0];
  assert.equal((await report(l,body)).status,401);
  assert.equal((await report(key,body,{cookie:s.cookie})).status,201);
  const dup=await report(key,body);
  assert.equal(dup.status,200);assert.equal((await dup.json()).duplicate,true);
  assert.equal((await report(key,{...body,event_id:'evt_bad_00001',input_tokens:-5})).status,400);
  assert.equal(relay.store.usageDays(user.id,'2000-01-01')[0].input_tokens,1234,'duplicate not double counted');
  const admin=await (await fetch(base+'/admin',{headers:{cookie:s.cookie}})).text();
  assert.match(admin,/Model usage/);assert.match(admin,/1\.2K/);
  assert.ok(!(await (await fetch(offBase+'/admin',{headers:{cookie:(await session(offBase)).cookie}})).text()).includes('Model usage'),'no data, no section');
});

test('usage endpoint is rate limited per key and revocation applies immediately',async()=>{
  const k=relay.store.createApiKey(user.id,'k2');
  let limited=0;
  for(let i=0;i<70;i++){const r=await report(k.raw,{event_id:'rate_evt_'+String(i).padStart(4,'0'),provider:'p',model:'m',input_tokens:1,output_tokens:1});if(r.status===429)limited++;}
  assert.ok(limited>=9,'61st+ report in a minute is 429, got '+limited);
  relay.store.revokeApiKey(user.id,k.prefix);
  assert.equal((await report(k.raw,{event_id:'after_revoke_1',provider:'p',model:'m',input_tokens:1,output_tokens:1})).status,401);
});
