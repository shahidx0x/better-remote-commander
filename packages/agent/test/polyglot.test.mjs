import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-polyglot-test-'));
const root=path.join(scratch,'project');await fs.mkdir(root);
process.env.BRC_HOME=path.join(scratch,'agent');process.env.BRC_LOG_LEVEL='silent';
const {configManager}=await import('../dist/core/config-manager.js');await configManager.setValue('allowedDirectories',[root]);
const {callTool,listTools}=await import('../dist/dispatcher.js');
const {parseSource,clearCodeCache}=await import('../dist/runtime/code-structure.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const {sourceFingerprint,clearHarnessSessions}=await import('../dist/runtime/harness.js');
const {withCallContext}=await import('../dist/context.js');
const {DeviceHub}=await import('../../relay/dist/device-hub.js');
const {liveTools}=await import('../../relay/dist/mcp/server.js');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const write=async(p,text)=>{const file=path.join(root,p);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);return file;};
after(async()=>{codeGraph.clear();clearCodeCache();projectIndex.close();clearHarnessSessions();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
const samples={
 'Code.cs':'// é 🚀\nusing Demo.Tools; namespace Demo.App { public class User { public int Run() { return 1; } } }',
 'lib.rs':'pub struct User {} impl User { pub fn run(&self) -> i32 { 1 } }',
 'main.py':'class User:\n    def run(self):\n        return 1\n',
 'main.go':'package demo\nfunc Run() int { return 1 }',
 'App.java':'package demo; public class App { public int run() { return 1; } }',
 'main.c':'int run(void) { return 1; }',
 'main.cpp':'namespace demo { class User { public: int run() {return 1;} }; }',
 'main.rb':'class User\n  def run\n    1\n  end\nend',
 'main.php':'<?php class User { public function run() { return 1; } }',
 'main.swift':'class User { func run() -> Int { return 1 } }',
 'main.dart':'class User { int run() { return 1; } }',
 'main.sol':'pragma solidity ^0.8.0; contract User { function run() public pure returns (uint) { return 1; } }',
 'main.css':'.user { color: red; }',
 'main.vue':'<template><div>Hello</div></template><script>export default {}</script>',
};
test('all portable grammars parse fixtures and source ranges survive Unicode',{timeout:30000},async()=>{
 for(const [name,text]of Object.entries(samples)){
  const p=await parseSource(name,text);assert.equal(p.syntaxSupported,true,name);assert.equal(p.diagnostics.length,0,name);assert.equal(p.provider,'tree-sitter',name);
  for(const s of p.symbols){assert.ok(s.end>s.start,name);assert.ok(text.slice(s.start,s.end).includes(s.name)||s.kind==='impl',name);}
  if(!name.endsWith('.vue'))assert.ok(p.symbols.length,name);
 }
});
test('C# Rust Python symbol edits preview and commit only after matching hashes',async()=>{
 for(const name of ['Code.cs','lib.rs','main.py']){
  const p=await write('edit/'+name,samples[name]);
  const outline=ok(await callTool('code_outline',{path:p}));assert.equal(outline.syntaxSupported,true);
  const s=outline.symbols.find(s=>/^(?:Run|run)$/.test(s.name));assert.ok(s,name);
  const snap=ok(await callTool('read_symbol',{path:p,name:s.qualifiedName,line:s.line}));
  const replacement=snap.text.replace('1','2');
  const args={path:p,name:s.qualifiedName,line:s.line,expected_sha256:snap.sha256,replacement};
  ok(await callTool('replace_symbol',args));assert.equal(await fs.readFile(p,'utf8'),samples[name]);
  ok(await callTool('replace_symbol',{...args,dryRun:false}));assert.ok((await fs.readFile(p,'utf8')).includes('2'));
  const stale=await callTool('replace_symbol',{...args,dryRun:false});assert.equal(stale.structuredContent.error.code,'FILE_CONFLICT');
 }
});
test('generic languages never claim syntax validation or safe symbol bodies',async()=>{
 for(const [name,text]of [['Main.fs','module Demo\nlet run x = x + 1'],['Main.vb','Public Class User\nEnd Class'],['custom.unknown','function run x whatever']]){
  const p=await write('generic/'+name,text),outline=ok(await callTool('code_outline',{path:p}));assert.equal(outline.provider,'generic');assert.equal(outline.syntaxSupported,false);
  const d=ok(await callTool('code_diagnostics',{paths:[p]}));assert.equal(d.passed,false);assert.equal(d.files[0].checked,false);
  const s=outline.symbols[0];assert.ok(s);
  const replaced=await callTool('replace_symbol',{path:p,name:s.name,expected_sha256:outline.sha256,replacement:'invalid'});assert.equal(replaced.structuredContent.error.code,'SAFE_RANGE_UNAVAILABLE');
  ok(await callTool('edit_code_ranges',{path:p,expected_sha256:outline.sha256,edits:[{startLine:1,endLine:1,text:text.split('\n')[0]}]}));
 }
});
test('unknown-language references and fingerprints are not silently excluded',async()=>{
 const p=await write('unknown.qwerty','function uniqueCrossLanguageThing\nuniqueCrossLanguageThing()\n');
 const refs=ok(await callTool('find_references',{path:root,symbol:'uniqueCrossLanguageThing'}));assert.ok(refs.matches.some(m=>m.file.endsWith('unknown.qwerty')));
 const before=await sourceFingerprint(root);await fs.appendFile(p,'changed\n');const after=await sourceFingerprint(root);assert.notEqual(before.fingerprint,after.fingerprint);
});
test('multilingual graph resolves local paths and marks namespace/module candidates',async()=>{
 const fixtures={
  'graph/js/main.ts':"import { value } from './util.js';\nexport const x=value;",'graph/js/util.ts':'export const value=1;',
  'graph/dotnet/App.cs':'using Demo.Tools; namespace Demo.App { public class App {} }','graph/dotnet/Helper.cs':'namespace Demo.Tools { public class Helper {} }',
  'graph/dotnet/App.csproj':'<Project><ItemGroup><ProjectReference Include="Helper.csproj" /></ItemGroup></Project>','graph/dotnet/Helper.csproj':'<Project />',
  'graph/src/lib.rs':'mod helper; use crate::helper::Thing;','graph/src/helper.rs':'pub struct Thing {}',
  'graph/python/main.py':'from .util import value\n','graph/python/util.py':'value=1\n',
  'graph/c/main.c':'#include "util.h"\nint main(void){return 0;}','graph/c/util.h':'int useful(void);',
  'graph/java/App.java':'package demo.app; import demo.util.Helper; class App {}','graph/java/Helper.java':'package demo.util; public class Helper {}',
  'graph/go.mod':'module example.com/app\n','graph/go/main.go':'package main\nimport "example.com/app/util"\nfunc main(){}','graph/util/util.go':'package util\nfunc Run(){}',
  'graph/extra.fictional':"include 'helper.fictional'\nfunction Example()",'graph/helper.fictional':'function Helper()',
 };
 for(const [name,text]of Object.entries(fixtures))await write(name,text);
 const g=path.join(root,'graph');
 for(const [file,target,confidence]of [['js/main.ts','js/util.ts','path'],['dotnet/App.cs','dotnet/Helper.cs','namespace-candidate'],['dotnet/App.csproj','dotnet/Helper.csproj','path'],['src/lib.rs','src/helper.rs','module-candidate'],['python/main.py','python/util.py','module-candidate'],['c/main.c','c/util.h','path'],['java/App.java','java/Helper.java','namespace-candidate'],['go/main.go','util/util.go','module-candidate'],['extra.fictional','helper.fictional','lexical-candidate']]){
  const r=ok(await callTool('related_files',{path:g,file}));assert.ok(r.edges.some(e=>e.to===target&&e.confidence===confidence),JSON.stringify({file,target,result:r}));
 }
 const reverse=ok(await callTool('related_files',{path:g,file:'dotnet/Helper.cs'}));assert.ok(reverse.importers.includes('dotnet/App.cs'));
});
test('graph reuse reparses changed files and removes deleted nodes without saving a cache',async()=>{
 const g=path.join(root,'graph');const cold=ok(await callTool('code_graph',{path:g,action:'refresh'}));const warm=ok(await callTool('code_graph',{path:g}));assert.ok(warm.cache.reused>0);assert.equal(warm.cache.reparsed,0);assert.equal(warm.cache.persistent,false);
 await write('graph/js/util.ts','export const value=777;');const changed=ok(await callTool('code_graph',{path:g}));assert.ok(changed.cache.reparsed>=1);assert.ok(changed.cache.reused>0);
 await fs.unlink(path.join(g,'js/util.ts'));const removed=ok(await callTool('code_graph',{path:g,action:'refresh'}));assert.ok(!removed.nodes.some(n=>n.file==='js/util.ts'));assert.ok(!removed.edges.some(e=>e.to==='js/util.ts'));
 assert.deepEqual(await fs.readdir(path.join(process.env.BRC_HOME,'logs')).catch(()=>[]),[]);
});
test('context pack budgets metadata and source and returns no secret files',async()=>{
 const g=path.join(root,'graph');await write('graph/AGENTS.md','Use focused edits.\n'.repeat(1000));await write('graph/.env','VERY_PRIVATE_SECRET=abc');
 const p=ok(await callTool('context_pack',{path:g,focus:'dotnet/App.cs',maxChars:6000}));assert.ok(p.files.length);assert.ok(JSON.stringify(p).length<=6100,JSON.stringify(p).length);assert.ok(!JSON.stringify(p).includes('VERY_PRIVATE_SECRET'));assert.equal(p.persistent,false);
});
test('dotnet Rust Go and Python checks come from manifests without running toolchains',async()=>{
 const cases=[['net','App.fsproj','<Project Sdk="Microsoft.NET.Sdk" />','dotnet:build'],['rust','Cargo.toml','[package]\nname="demo"\nversion="0.1.0"','cargo:check'],['go','go.mod','module example.com/demo\n','go:test'],['python','pytest.ini','[pytest]\n','python:test']];
 for(const[dir,file,text,check]of cases){await write('checks/'+dir+'/'+file,text);const p=path.join(root,'checks',dir),discovered=ok(await callTool('discover_checks',{path:p}));assert.ok(discovered.candidates.some(c=>c.name===check));const preview=ok(await callTool('run_project_checks',{path:p,scripts:[check]}));assert.equal(preview.execute,false);assert.ok(preview.commands[0].program);}
});
test('program arguments are literal, exit codes real and no shell executes appended text',async()=>{
 const p=await write('args.cjs','console.log(process.argv[2]);');
 const value='x & echo NOT_EXECUTED';
 const r=ok(await callTool('verify_project',{cwd:root,commands:[{name:'literal',program:process.execPath,args:[p,value]}]}));assert.equal(r.passed,true);assert.equal(r.steps[0].exitCode,0);assert.equal(r.steps[0].stdout.trim(),value);
 const bad=await callTool('verify_project',{cwd:root,commands:[{name:'invalid',program:process.execPath,command:'echo bad'}]});assert.equal(bad.isError,true);
});
test('parser cancellation leaves the event loop usable',async()=>{
 const c=new AbortController();c.abort(new DOMException('cancel','AbortError'));
 await assert.rejects(withCallContext({id:'abort-parser',client:null,remote:false,signal:c.signal},()=>parseSource('cancel.cs',samples['Code.cs'])),/cancel/i);
 const p=await parseSource('okay.rs','pub fn okay() {}');assert.ok(p.symbols.some(s=>s.name==='okay'));
});
class Sock extends EventEmitter{OPEN=1;readyState=1;bufferedAmount=0;sent=[];send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;this.emit('close');}terminate(){this.close();}}
const hello=(id,tool='read_file')=>Buffer.from(JSON.stringify({type:'hello',protocol:1,device:{deviceId:id,name:id,platform:'test'},tools:[{name:tool,description:'test',inputSchema:{type:'object'}}]}));
test('relay schema cache preserves stable discovery while device pause and reconnect remain fresh',async()=>{
 const h=new DeviceHub('test',()=>{}),s=new Sock();h.attach(s,'u','pc');s.emit('message',hello('pc'));
 let paused=false;const store={getDevice:()=>({paused:paused?1:0})};
 const first=await liveTools(h,store,'u'),second=await liveTools(h,store,'u');assert.equal(first.tools,second.tools);
 const stable=first.tools.map(t=>t.name);assert.ok(stable.length>=60);
 assert.equal(first.online,1);
 paused=true;
 const duringPause=await liveTools(h,store,'u');
 assert.equal(duringPause.online,0,'paused agent must not appear online');
 assert.deepEqual(duringPause.tools.map(t=>t.name),stable,'pausing must not remove discoverable tool schemas');
 paused=false;
 const resumed=await liveTools(h,store,'u');assert.equal(resumed.online,1);
 assert.deepEqual(resumed.tools.map(t=>t.name),stable);
 const next=new Sock();h.attach(next,'u','pc');next.emit('message',hello('pc','read_code_file'));
 const reconnected=await liveTools(h,store,'u');assert.equal(reconnected.online,1);
 assert.deepEqual(reconnected.tools.map(t=>t.name),stable);
 const selected=reconnected.tools.find(t=>t.name==='read_code_file');
 assert.match(selected.description,/^USE WHEN: /,'reviewed tool-choice guidance must survive an older agent reconnecting');
 assert.notEqual(selected.description,'test','do not let stale agent descriptions override reviewed choices');
 assert.equal(selected.inputSchema.type,'object','live agent schema remains authoritative');
 assert.ok(selected.inputSchema.properties.deviceId,'device targeting remains available');
 const other=await liveTools(h,store,'other');assert.equal(other.online,0);
 assert.deepEqual(other.tools.map(t=>t.name),stable,'static catalog is public schema; device ownership is still enforced by invocation');
 h.close();
});
test('relay overload rejects before dispatch and per-device limits do not block other devices',async()=>{
 const h=new DeviceHub('test',()=>{}),a=new Sock(),b=new Sock();h.attach(a,'u','a');h.attach(b,'u','b');a.emit('message',hello('a'));b.emit('message',hello('b'));
 a.bufferedAmount=9*1024*1024;const sent=a.sent.length;await assert.rejects(h.call('a','read_file',{}),/BACKPRESSURE/);assert.equal(a.sent.length,sent);a.bufferedAmount=0;
 const calls=Array.from({length:64},()=>h.call('a','read_file',{}).catch(e=>e.message));await assert.rejects(h.call('a','read_file',{}),/DEVICE_BUSY/);
 const other=h.call('b','read_file',{});const id=b.sent.find(m=>m.type==='call').id;b.emit('message',Buffer.from(JSON.stringify({type:'result',id,result:{content:[]}})));assert.deepEqual(await other,{content:[]});h.close();await Promise.all(calls);
});
test('malformed device tool catalogs fail closed rather than throwing',()=>{
 const h=new DeviceHub('test',()=>{}),s=new Sock();h.attach(s,'u','pc');s.emit('message',Buffer.from(JSON.stringify({type:'hello',protocol:1,device:{deviceId:'pc'},tools:'not-an-array'})));assert.equal(s.readyState,3);assert.equal(h.list().length,0);h.close();
});

test('Codex overrides and Claude rules are scoped without loading hooks',async()=>{
 const base='guidance';const target=await write(base+'/src/App.cs','public class App {}');
 await write(base+'/AGENTS.md','root default should be shadowed');await write(base+'/AGENTS.override.md','root override applies');
 await write(base+'/src/AGENTS.md','nested code guidance');await write(base+'/src/CLAUDE.md','nested Claude guidance');
 await write(base+'/.claude/rules/csharp.md','---\npaths:\n  - "src/**/*.cs"\n---\nUse C# conventions.');
 await write(base+'/.claude/rules/python.md','---\npaths: ["**/*.py"]\n---\nPython-only instructions.');
 await write(base+'/.claude/settings.json','{"hooks":{"danger":"DO_NOT_LOAD_HOOK_SETTINGS_82a7"}}');
 const c=ok(await callTool('project_context',{path:path.join(root,base),focus:target}));
 const names=c.instructions.map(i=>i.path);assert.ok(names.includes('AGENTS.override.md'));assert.ok(!names.includes('AGENTS.md'));assert.ok(names.includes('src/CLAUDE.md'));assert.ok(names.includes('.claude/rules/csharp.md'));assert.ok(!names.includes('.claude/rules/python.md'));assert.equal(c.instructionPolicy.automaticHooks,false);assert.ok(!JSON.stringify(c).includes('DO_NOT_LOAD_HOOK_SETTINGS_82a7'));
});
test('Rust src/bin is source; dotnet bin/Debug and obj remain generated exclusions',async()=>{
 const base='rust-layout',file=await write(base+'/src/bin/cli.rs','fn main() {}');await write(base+'/bin/Debug/generated.cs','class Generated {}');await write(base+'/obj/generated.cs','class Generated {}');
 const g=ok(await callTool('code_graph',{path:path.join(root,base)}));assert.ok(g.nodes.some(n=>n.file==='src/bin/cli.rs'));assert.ok(!g.nodes.some(n=>n.file.includes('generated.cs')));codeGraph.clear(path.join(root,base));
});
test('solution and solution-XML references resolve project files',async()=>{
 const base='solution';await write(base+'/App.csproj','<Project />');await write(base+'/app.sln','Project("{TYPE}") = "App", "App.csproj", "{ID}"\nEndProject');await write(base+'/app.slnx','<Solution><Project Path="App.csproj" /></Solution>');
 for(const file of ['app.sln','app.slnx']){const r=ok(await callTool('related_files',{path:path.join(root,base),file}));assert.ok(r.edges.some(e=>e.to==='App.csproj'));}codeGraph.clear(path.join(root,base));
});
test('last-seen write coalescing never caches auth or revoked device tokens',async()=>{
 const {SqliteStore}=await import('../../relay/dist/store/sqlite.js');const store=new SqliteStore(':memory:');const u=store.upsertUser('u','test'),token=store.issueDeviceToken('pc',u.id,'PC','test');
 const now=Date.now;let clock=now();Date.now=()=>clock;
 try{store.touchDevice('pc');const first=store.getDevice('pc').last_seen;clock+=100;store.touchDevice('pc');assert.equal(store.getDevice('pc').last_seen,first);clock+=6000;store.touchDevice('pc');assert.equal(store.getDevice('pc').last_seen,clock);store.deleteDevice('pc');assert.equal(store.getDeviceByToken(token),undefined);}finally{Date.now=now;store.close();}
});
