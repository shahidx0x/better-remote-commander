import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
process.env.BRC_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'brc-home-'));
const {callTool,listTools} = await import('../dist/dispatcher.js');
const ex = await import('../dist/tools/dev-extras.js');
const mk=async()=>fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'brc-dx-')));
const body=r=>r.structuredContent;
const NAMES=['session_handoff','code_diagnostics','review_changes','test_impact','vscode_tasks','coding_session','docker_inventory','docker_inspect'];

test('tools are advertised with object schemas and correct read-only hints',()=>{
  const tools=listTools();
  for(const n of NAMES){const t=tools.find(x=>x.name===n);assert.ok(t,n);assert.equal(t.inputSchema.type,'object');
    assert.equal(t.annotations.readOnlyHint,n!=='coding_session',n);}
});
test('code_diagnostics: valid passes, syntax error fails, unknown language is unchecked',async()=>{
  const d=await mk();
  await fs.writeFile(path.join(d,'ok.ts'),'export const a: number = 1;\n');
  await fs.writeFile(path.join(d,'bad.ts'),'export const = ;\n');
  await fs.writeFile(path.join(d,'x.zzzunknown'),'whatever\n');
  const ok=await callTool('code_diagnostics',{paths:[path.join(d,'ok.ts')]});
  assert.ok(!ok.isError,JSON.stringify(ok.content));assert.equal(body(ok).passed,true);
  const bad=await callTool('code_diagnostics',{paths:[path.join(d,'bad.ts')]});
  assert.equal(bad.isError,true);assert.equal(body(bad).passed,false);
  const unk=await callTool('code_diagnostics',{paths:[path.join(d,'x.zzzunknown')]});
  assert.equal(body(unk).files[0].checked,false);assert.equal(body(unk).passed,false);
});
test('vscode_tasks parses JSONC, omits env, tolerates missing/odd files',async()=>{
  const d=await mk();
  const none=await callTool('vscode_tasks',{path:d});
  assert.ok(!none.isError);assert.equal(body(none).found,false);assert.deepEqual(body(none).tasks,[]);
  await fs.mkdir(path.join(d,'.vscode'));
  await fs.writeFile(path.join(d,'.vscode','tasks.json'),`{
  // comment
  "version": "2.0.0",
  "tasks": [
    { "label": "build", "type": "shell", "command": "npm", "args": ["run", {"value":"build x","quoting":"strong"}], "group": {"kind":"build","isDefault":true},
      "options": {"env": {"SECRET":"hunter2"}}, },
  ],
}`);
  const r=await callTool('vscode_tasks',{path:d});
  assert.ok(!r.isError,JSON.stringify(r.content));
  const t=body(r).tasks[0];
  assert.equal(t.label,'build');assert.deepEqual(t.args,['run','build x']);assert.equal(body(r).execution,false);
  assert.ok(!JSON.stringify(r).includes('hunter2'));
  await fs.writeFile(path.join(d,'.vscode','tasks.json'),'null');
  const n=await callTool('vscode_tasks',{path:d});assert.ok(!n.isError);assert.deepEqual(body(n).tasks,[]);
});
test('test_impact matches by file stem, exact first',async()=>{
  const d=await mk();
  await fs.writeFile(path.join(d,'package.json'),JSON.stringify({name:'p',scripts:{test:'node -e 0'}}));
  await fs.mkdir(path.join(d,'src'));await fs.mkdir(path.join(d,'test'));
  await fs.writeFile(path.join(d,'src','widget.ts'),'export {}\n');
  await fs.writeFile(path.join(d,'test','widget.test.ts'),'\n');
  await fs.writeFile(path.join(d,'test','other.test.ts'),'\n');
  const r=await callTool('test_impact',{path:d,files:['src/widget.ts']});
  assert.ok(!r.isError,JSON.stringify(r.content));
  const rec=body(r).recommendations[0];
  assert.deepEqual(rec.candidateTests,['test/widget.test.ts']);assert.equal(body(r).heuristic,true);
  const out=await callTool('test_impact',{path:d,files:['../escape.ts']});assert.equal(out.isError,true);
});
test('review_changes reports git status read-only',async()=>{
  const d=await mk();
  try{execFileSync('git',['init','-q'],{cwd:d});}catch{return;}
  await fs.writeFile(path.join(d,'a.txt'),'x\n');
  const r=await callTool('review_changes',{path:d});
  assert.ok(!r.isError,JSON.stringify(r.content));assert.match(body(r).status,/a\.txt/);
  const nogit=await callTool('review_changes',{path:await mk()});
  assert.equal(nogit.isError,true);
});
test('coding_session lifecycle: finish needs fresh verification and scope; handoff is bounded',async()=>{
  const d=await mk();
  await fs.writeFile(path.join(d,'package.json'),JSON.stringify({name:'p',scripts:{test:'node -e "process.exit(0)"'}}));
  await fs.mkdir(path.join(d,'src'));await fs.writeFile(path.join(d,'src','a.js'),'1\n');await fs.writeFile(path.join(d,'other.js'),'1\n');
  const bad=await callTool('coding_session',{action:'start',path:d,goal:'g',scope:['../x']});
  assert.equal(bad.isError,true);
  const unk=await callTool('coding_session',{action:'start',path:d,goal:'g',requiredChecks:['nope']});
  assert.match(unk.content[0].text,/UNKNOWN_CHECK/);
  const s=await callTool('coding_session',{action:'start',path:d,goal:'change a',scope:['src'],requiredChecks:['test']});
  assert.ok(!s.isError,JSON.stringify(s.content));const id=body(s).sessionId;
  const early=await callTool('coding_session',{action:'finish',sessionId:id});
  assert.match(early.content[0].text,/VERIFICATION_REQUIRED/);
  await fs.writeFile(path.join(d,'src','a.js'),'2\n');
  const v=await callTool('coding_session',{action:'verify',sessionId:id});
  assert.ok(!v.isError,JSON.stringify(v.content));assert.equal(body(v).verifiedCurrentSource,true);
  const h=await callTool('session_handoff',{sessionId:id,maxChanges:1});
  assert.equal(body(h).persistent,false);assert.deepEqual(body(h).changes.map(c=>c.file),['src/a.js']);
  // out-of-scope edit after verification invalidates evidence
  await fs.writeFile(path.join(d,'other.js'),'2\n');
  assert.match((await callTool('coding_session',{action:'finish',sessionId:id})).content[0].text,/VERIFICATION_REQUIRED/);
  const v2=await callTool('coding_session',{action:'verify',sessionId:id});assert.ok(!v2.isError);
  assert.match((await callTool('coding_session',{action:'finish',sessionId:id})).content[0].text,/SCOPE_VIOLATION/);
  await callTool('coding_session',{action:'abandon',sessionId:id});
  assert.match((await callTool('session_handoff',{sessionId:id})).content[0].text,/SESSION_NOT_FOUND/);
});
test('coding_session caps concurrent sessions at 8',async()=>{
  const d=await mk();
  await fs.writeFile(path.join(d,'package.json'),JSON.stringify({name:'p',scripts:{test:'node -e 0'}}));
  const ids=[];let last;
  for(let i=0;i<9;i++){last=await callTool('coding_session',{action:'start',path:d,goal:'g'+i});if(!last.isError)ids.push(body(last).sessionId);}
  assert.equal(last.isError,true);assert.match(last.content[0].text,/SESSION_LIMIT|At most/);
  for(const id of ids)await callTool('coding_session',{action:'abandon',sessionId:id});
});
test('docker_inventory reports unavailable (null) instead of empty, using injected query',async()=>{
  const d=await mk();
  const down=async()=>({ok:false,rows:[],truncated:false,error:'Cannot connect to the Docker daemon'});
  const r=await ex.dockerInventory({path:d},down);
  assert.equal(r.isError,true);assert.equal(r.structuredContent.available,false);
  assert.equal(r.structuredContent.containers,null);assert.equal(r.structuredContent.images,null);assert.equal(r.structuredContent.counts.containers,null);
  const up=async a=>a[0]==='container'?{ok:true,rows:[{ID:'abc',Names:'web',Image:'nginx',State:'running',Status:'Up',Ports:'80/tcp'}],truncated:false}:{ok:true,rows:[],truncated:false};
  const ok=await ex.dockerInventory({path:d,limit:5},up);
  assert.ok(!ok.isError);assert.equal(ok.structuredContent.containers[0].names,'web');assert.deepEqual(ok.structuredContent.images,[]);
  const noimg=await ex.dockerInventory({path:d,includeImages:false},up);assert.equal(noimg.structuredContent.images,null);
});
test('docker_inspect validates targets and surfaces unavailability',async()=>{
  const d=await mk();
  await assert.rejects(ex.dockerInspect({path:d,kind:'image',targets:['--privileged']}));
  await assert.rejects(ex.dockerInspect({path:d,kind:'image',targets:['a b']}));
  const down=async()=>({ok:false,rows:[],truncated:false,error:'no daemon'});
  await assert.rejects(ex.dockerInspect({path:d,kind:'container',targets:['web']},down),/no daemon/);
  const seen=[];
  const up=async a=>{seen.push(a);return {ok:true,rows:[{id:'sha256:1',name:'/web',imageId:'sha256:2',imageName:'nginx',state:'running',running:true,exitCode:0,health:null,ports:{},mounts:[]}],truncated:false};};
  const r=await ex.dockerInspect({path:d,kind:'container',targets:['web']},up);
  assert.equal(r.structuredContent.items[0].name,'/web');assert.equal(r.structuredContent.environmentValuesOmitted,true);
  assert.ok(seen[0].includes('--'));assert.ok(!seen[0].join(' ').includes('.Config.Env'));
});
