import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../dist/store/sqlite.js';
import { validateUsageReport,usageView,utcDay,formatTokens } from '../dist/features/usage.js';
import { validateSkill,skillFile,fileNames,SkillsCatalog } from '../dist/features/skills.js';
import { handleSkillRelayTool,SKILL_RELAY_TOOLS } from '../dist/mcp/skill-tools.js';
import { readOnlyToolAllowed } from '../dist/mcp/server.js';
import { dashboardLayout } from '../dist/pages/dashboard-shell.js';
import { dashboardPage } from '../dist/pages/dashboard.js';

const now=Date.UTC(2026,10,16,12);
test('real provider counts, UTC grouping, day/week/month totals, and no fabricated tokens',()=>{
 const record=validateUsageReport({event_id:'test-event_00001',timestamp:now,
  provider:'openai',model:'gpt-6',input_tokens:1450000,output_tokens:780000},'owner1',now);
 assert.equal(record.day,'2026-11-16');
 for(const [payload] of [[{...record, input_tokens:'30'}],[{...record,output_tokens:-1}],
  [{...record,event_id:'!bad!'}],[{...record,model:'../bad'}],[{...record,timestamp:now+86400000}]]){
  assert.throws(()=>validateUsageReport(payload,'owner1',now));
 }
 assert.equal(utcDay(Date.UTC(2026,10,16,23)), '2026-11-16');
 const rows=[{day:'2026-11-15',input_tokens:20,output_tokens:10,reports:1},
  {day:'2026-11-16',input_tokens:1450000,output_tokens:780000,reports:1},
  {day:'2026-10-02',input_tokens:50,output_tokens:20,reports:1}];
 const daily=usageView(rows,'day',now);
 assert.equal(daily.buckets.length,14);assert.equal(daily.totals.input,1450020);
 const weekly=usageView(rows,'week',now);
 assert.equal(weekly.buckets.length,12);assert.equal(weekly.totals.total,2230100);
 assert.ok(weekly.buckets.find(x=>x.key==='2026-11-09'));
 assert.ok(weekly.buckets.find(x=>x.key==='2026-11-16'));
 const monthly=usageView(rows,'month',now);
 assert.equal(monthly.totals.reports,3);assert.equal(monthly.totals.total,2230100);
 const empty=usageView([],'month',now);
 assert.equal(empty.totals.reports,0);assert.equal(empty.totals.total,0);
 assert.equal(formatTokens(2250000),'2.25M');assert.equal(formatTokens(1200000000),'1.2B');
});
test('SQLite saves idempotent provider token reports and isolates per account',()=>{
 const db=new SqliteStore(':memory:');
 try {
  const a=validateUsageReport({event_id:'event_a123456',timestamp:now,
   provider:'openai',model:'gpt-6',input_tokens:45,output_tokens:90},'owner1',now);
  assert.equal(db.recordTokenUsage(a),true);
  assert.equal(db.recordTokenUsage(a),false,'retry does not double-count tokens');
  assert.deepEqual(db.usageDays('owner1','2026-01-01'),[
    {day:'2026-11-16',input_tokens:45,output_tokens:90,reports:1}
  ]);
  assert.deepEqual(db.usageDays('owner2','2026-01-01'),[]);
  assert.equal(db.recordTokenUsage({...a,user_id:'owner2'}),true,'event id scoped by user');
  assert.equal(db.usageDays('owner2','2026-01-01')[0].reports,1);
  assert.equal(db.db.prepare('SELECT COUNT(*) as n FROM audit').get().n,0);
 }finally{db.close()}
});
test('skills are validated, owner scoped, and never executed or auto-approved',async()=>{
 const db=new SqliteStore(':memory:');
 try{
  const source='---\nname: Example\n---\n# Instructions\nReview work before editing.\n';
  const s=validateSkill({id:'vendor/repo/example',name:'Example',description:'Test skill',
    source:'https://skills.sh/vendor/repo/example',files:[{path:'SKILL.md',contents:source},
      {path:'references/setup.md',contents:'safe reference'}]},'owner1');
  assert.equal(skillFile(s),source);
  assert.deepEqual(fileNames(s),['SKILL.md','references/setup.md']);
  assert.throws(()=>validateSkill({...s,files:[{path:'../escape',contents:'oops'}]},'owner1'));
  assert.throws(()=>validateSkill({...s,files:[{path:'SKILL.md',contents:'x'.repeat(128*1024+1)}]},'owner1'));
  const req1=db.createSkillRequest('owner1',s.id,'chatgpt','Review skill');
  const req2=db.createSkillRequest('owner1',s.id,'chatgpt','Review again');
  assert.equal(req1.id,req2.id,'duplicate request does not flood queue');
  assert.equal(db.listSkillRequests('owner1').length,1);
  assert.equal(db.listSkills('owner1').length,0,'request is not approval');
  db.saveSkill(s);
  assert.equal(db.listSkillRequests('owner1').length,0);
  assert.equal(db.listSkills('owner1').length,1);
  assert.equal(db.getSkill('owner2',s.id),undefined);
  const catalog=new SkillsCatalog('');
  const ctx={userId:'owner1',clientId:'testclient'};
  const listed=await handleSkillRelayTool(db,catalog,ctx,'list_skills',{});
  assert.match(listed.content[0].text,/vendor\/repo\/example/);
  const contents=await handleSkillRelayTool(db,catalog,ctx,'read_skill',{id:s.id,file:'references/setup.md'});
  assert.match(contents.content[0].text,/safe reference/);
  const missing=await handleSkillRelayTool(db,catalog,{userId:'owner2',clientId:'other'},'read_skill',{id:s.id});
  assert.equal(missing.isError,true);
  const proposed=await handleSkillRelayTool(db,catalog,ctx,'request_skill_install',{id:'vendor/repo/other',reason:'Need guidance'});
  assert.match(proposed.content[0].text,/owner review/);
  assert.equal(db.getSkill('owner1','vendor/repo/other'),undefined);
  assert.equal(db.listSkillRequests('owner1').length,1);
  assert.equal(db.deleteSkill('owner2',s.id),false);
  assert.equal(db.deleteSkill('owner1',s.id),true);
  assert.equal(db.getSkill('owner1',s.id),undefined);
 }finally{db.close()}
});
test('read-only MCP access allows skill reads, prevents queue requests',()=>{
 assert.equal(SKILL_RELAY_TOOLS.length,4);
 for(const name of ['list_skills','read_skill','search_skills_catalog'])
  assert.equal(readOnlyToolAllowed(name,{}),true);
 for(const name of ['request_skill_install','run_command','write_file'])
  assert.equal(readOnlyToolAllowed(name,{}),false);
});
test('modern sidebar and usage dashboard are HTML-escaped, preserve device forms',()=>{
 const html=dashboardLayout('Admin','<span>test</span>');
 assert.match(html,/<aside class="sidebar">/);
 assert.match(html,/<nav class="nav"/);
 assert.match(html,/Private links/);
 assert.match(html,/Agent skills/);
 assert.match(html,/class="main"/);
 const view=usageView([{day:'2026-11-16',input_tokens:100,output_tokens:200,reports:1}],'day',now);
 const page=dashboardPage('https://relay.example',[{device_id:'a',name:'Device <script>alert(1)</script>',
  platform:'Windows',online:true,paused:0,last_seen:now,created_at:now}],[],{total:1,failed:0,last24h:1},view);
 assert.match(page,/input \/ output volume/i);
 assert.match(page,/name="action" value="pause"/);
 assert.match(page,/name="action" value="rename"/);
 assert.ok(!page.includes('Device <script>'));
 assert.match(page,/Device &lt;script&gt;/);
 assert.match(page,/100/);
});

test('private URL authorization performs exactly one fresh lookup per request and respects immediate revocation',async()=>{
 const {buildRelay}=await import('../dist/app.js');
 const server=await buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3000',trustProxy:false,
   dbFile:':memory:',sessionSecret:'perf-test-secret',adminUser:'private-link-test',adminPassword:'test-secret',relayVersion:'test'},()=>{});
 await new Promise(resolve=>server.http.listen(0,'127.0.0.1',resolve));
 try{
  const host='http://127.0.0.1:'+server.http.address().port;
  const u=await server.store.getUserByName('private-link-test');
  const link=await server.store.createConnectionLink(u.id,'one-db-lookup','read',1);
  const path=host+'/c/'+link.key+'/mcp';
  const get=server.store.getConnectionLink.bind(server.store);
  let hits=0;
  server.store.getConnectionLink=(key)=>{hits++;return get(key)};
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
  let r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body});
  assert.equal(r.status,200,await r.text());
  assert.equal(hits,1,'exactly one secure DB lookup for this HTTP request');
  await server.store.revokeConnectionLink(u.id,link.id);
  r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body});
  assert.equal(r.status,404);
  assert.equal(hits,2,'revocation checked freshly on next request');
 }finally{await server.close()}
});
