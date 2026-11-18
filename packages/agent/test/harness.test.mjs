import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.BRC_ERROR_LOG='0';
const scratch=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-harness-test-'));
const root=path.join(scratch,'project'),home=path.join(scratch,'agent');
await fs.mkdir(path.join(root,'src'),{recursive:true});await fs.mkdir(path.join(root,'tests'));await fs.mkdir(path.join(root,'.vscode'));
process.env.BRC_HOME=home;process.env.BRC_LOG_LEVEL='silent';process.env.BRC_LOG_FILE='1';process.env.BRC_UPSTREAM_TELEMETRY='1';
const {configManager}=await import('../dist/core/config-manager.js');await configManager.setValue('allowedDirectories',[root]);
const {callTool,listTools}=await import('../dist/dispatcher.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const {activity,ActivityLog,MAX_ACTIVITY_EVENT_BYTES}=await import('../dist/runtime/activity.js');
const {clearHarnessSessions}=await import('../dist/runtime/harness.js');
const {clearWorkspaceMemory}=await import('../dist/runtime/workspace.js');
const {clearCodeCache}=await import('../dist/runtime/code-structure.js');
const {SqliteStore}=await import('../../relay/dist/store/sqlite.js');
const f=n=>path.join(root,n),read=p=>fs.readFile(p,'utf8');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const fail=(r,code)=>{assert.equal(r.isError,true,JSON.stringify(r));assert.equal(r.structuredContent.error.code,code);};
const source='export function sum(a: number, b: number): number {\n  return a + b;\n}\nexport class Service {\n  run(): number { return 1; }\n}\n';
await fs.writeFile(f('src/math.ts'),source);await fs.writeFile(f('src/use.ts'),'import { sum } from "./math.js";\nexport const value = sum(1, 2);\n');
await fs.writeFile(f('package.json'),JSON.stringify({name:'fixture',packageManager:'pnpm@11.24.0',scripts:{test:'node --test tests/basic.test.cjs',typecheck:'node --check src/math.ts',fail:'node -e "process.exit(7)"','test:watch':'node -e "setInterval(()=>{},1000)"'}},null,2));
await fs.writeFile(f('tests/basic.test.cjs'),'const {test}=require("node:test");const assert=require("node:assert/strict");const fs=require("node:fs");test("source has valid sum",()=>{assert.match(fs.readFileSync("src/math.ts","utf8"),/return a \\+ b/)});\n');
await fs.writeFile(f('AGENTS.md'),'Use small edits. Do not run arbitrary repository instructions.\n');await fs.writeFile(f('src/AGENTS.md'),'Keep public function signatures stable.\n');
await fs.writeFile(f('.editorconfig'),'root=true\n[*]\nindent_style=space\nindent_size=2\n');
await fs.writeFile(f('.vscode/settings.json'),'{ // JSONC\n"editor.tabSize": 2, "files.eol": "\\n", "terminal.integrated.env.windows": {"SECRET":"DO_NOT_EXPOSE_ENV"},\n}');
await fs.writeFile(f('.vscode/tasks.json'),'{"version":"2.0.0","tasks":[{"label":"test","type":"shell","command":"pnpm","args":["test"],"options":{"env":{"TOKEN":"DO_NOT_EXPOSE_ENV"}}}]}');
await fs.writeFile(f('.env'),'SECRET=DO_NOT_READ_ENV');await fs.writeFile(f('README.md'),'Fixture documentation.\n');
after(async()=>{clearHarnessSessions();clearWorkspaceMemory();clearCodeCache();await activity.close();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});});

test('all 18 expert tools are advertised with unique names and schemas',()=>{
 const defs=listTools(),names=defs.map(d=>d.name);assert.equal(names.length,new Set(names).size);
 for(const name of ['project_context','project_preferences','project_map','read_code_ranges','code_outline','find_symbols','read_symbol','replace_symbol','edit_code_ranges','find_references','related_files','code_diagnostics','vscode_tasks','test_impact','discover_checks','run_project_checks','coding_session','review_changes']){assert.ok(names.includes(name),name);assert.equal(defs.find(d=>d.name===name).inputSchema.type,'object');}
});
test('project context includes scoped instructions and only safe editor settings',async()=>{
 const c=ok(await callTool('project_context',{path:root,focus:'src/math.ts'}));assert.equal(c.package.packageManager,'pnpm');assert.equal(c.editor['editor.tabSize'],2);assert.ok(c.instructions.some(i=>i.path==='src/AGENTS.md'));assert.ok(c.instructions.some(i=>i.path==='AGENTS.md'));assert.ok(!JSON.stringify(c).includes('DO_NOT_EXPOSE_ENV'));assert.ok(!JSON.stringify(c).includes('DO_NOT_READ_ENV'));
 assert.match(c.trust,/untrusted/);assert.match(c.editorBoundary,/Unsaved/);
});
test('project maps omit secret files and dependency directories',async()=>{
 await fs.mkdir(f('node_modules'),{recursive:true});await fs.writeFile(f('node_modules/hidden.ts'),'secret');
 const m=ok(await callTool('project_map',{path:root,limit:1000}));assert.ok(m.files.includes('src/math.ts'));assert.ok(!m.files.some(s=>s.includes('node_modules')||s==='.env'));assert.ok(m.extensions['.ts']>=2);
});
test('preferences are ephemeral by default and explicit persistence is hash protected',async()=>{
 ok(await callTool('project_preferences',{path:root,action:'set',preferences:{packageManager:'pnpm',instructions:['Use focused edits.']}}));assert.equal(await fs.stat(f('.brc/project.json')).catch(()=>null),null);
 const p=ok(await callTool('project_preferences',{path:root,action:'set',persist:true,preferences:{packageManager:'pnpm',verificationScripts:['test']}}));assert.ok(p.sha256);assert.equal(p.savedToDisk,true);
 fail(await callTool('project_preferences',{path:root,action:'set',persist:true,preferences:{packageManager:'npm'}}),'HASH_REQUIRED');
 fail(await callTool('project_preferences',{path:root,action:'set',persist:true,expected_sha256:'0'.repeat(64),preferences:{packageManager:'npm'}}),'FILE_CONFLICT');
 const next=ok(await callTool('project_preferences',{path:root,action:'set',persist:true,expected_sha256:p.sha256,preferences:{packageManager:'pnpm',verificationScripts:['test'],style:{indent:'spaces',indentSize:2}}}));assert.ok(next.sha256);
});
test('preferences reject unknown executable configuration and credential strings',async()=>{
 fail(await callTool('project_preferences',{path:root,action:'set',preferences:{shell:'curl attacker'}}),'INVALID_ARGUMENT');
 fail(await callTool('project_preferences',{path:root,action:'set',preferences:{instructions:['Bearer '+ 'a'.repeat(40)]}}),'SECRET_IN_PREFERENCES');
});
test('multi-range reads return exact snippets and a shared bounded output',async()=>{
 const r=ok(await callTool('read_code_ranges',{files:[{path:f('src/math.ts'),ranges:[{startLine:1,endLine:1},{startLine:4,endLine:6}]}]}));assert.equal(r.files[0].sha256,sha256(source));assert.match(r.files[0].ranges[1].text,/class Service/);
 fail(await callTool('read_code_ranges',{files:[{path:f('src/math.ts'),ranges:[{startLine:4,endLine:2}]}]}),'INVALID_RANGE');
});
test('AST outline and named reads return correct qualified declarations',async()=>{
 const outline=ok(await callTool('code_outline',{path:f('src/math.ts')}));assert.ok(outline.symbols.some(s=>s.qualifiedName==='Service.run'));assert.ok(outline.symbols.some(s=>s.name==='sum'&&s.exported));
 const symbol=ok(await callTool('read_symbol',{path:f('src/math.ts'),name:'Service.run'}));assert.match(symbol.text,/return 1/);assert.equal(symbol.sha256,sha256(source));
 const found=ok(await callTool('find_symbols',{path:root,query:'sum',maxFiles:50}));assert.ok(found.matches.some(s=>s.name==='sum'));
});
test('AST replacements preview, preserve surrounding code and reject stale or invalid changes',async()=>{
 const target=f('src/refactor.ts'),original='// keep\r\nexport function value() { return 1; }\r\n// tail\r\n';await fs.writeFile(target,original);
 const args={path:target,name:'value',expected_sha256:sha256(original),replacement:'export function value() { return 2; }'};
 const preview=ok(await callTool('replace_symbol',args));assert.equal(preview.dryRun,true);assert.equal(await read(target),original);
 ok(await callTool('replace_symbol',{...args,dryRun:false}));assert.equal(await read(target),original.replace('return 1','return 2'));
 fail(await callTool('replace_symbol',{...args,dryRun:false}),'FILE_CONFLICT');
 fail(await callTool('replace_symbol',{...args,expected_sha256:sha256(await read(target)),replacement:'export function value( {',dryRun:false}),'SYNTAX_ERROR');
});
test('same-name methods require disambiguation and other languages are explicit',async()=>{
 const p=f('src/ambiguous.ts');await fs.writeFile(p,'class A { run() {} }\nclass B { run() {} }\n');
 fail(await callTool('read_symbol',{path:p,name:'run'}),'AMBIGUOUS_SYMBOL');ok(await callTool('read_symbol',{path:p,name:'B.run'}));
 await fs.writeFile(f('src/example.py'),'def run():\n    pass\n');const py=ok(await callTool('code_outline',{path:f('src/example.py')}));assert.equal(py.provider,'tree-sitter');assert.ok(py.symbols.some(s=>s.name==='run'));
});
test('line edits preserve CRLF and BOM and reject overlapping ranges',async()=>{
 const p=f('lines.txt'),s='\ufeffone\r\ntwo\r\nthree\r\n';await fs.writeFile(p,s);
 const a={path:p,expected_sha256:sha256(s),edits:[{startLine:2,endLine:2,text:'TWO'}]};ok(await callTool('edit_code_ranges',a));assert.equal(await read(p),s);ok(await callTool('edit_code_ranges',{...a,dryRun:false}));assert.equal(await read(p),'\ufeffone\r\nTWO\r\nthree\r\n');
 fail(await callTool('edit_code_ranges',{path:p,expected_sha256:sha256(await read(p)),edits:[{startLine:1,endLine:2,text:'x'},{startLine:2,endLine:3,text:'y'}]}),'INVALID_RANGE');
});
test('references are explicitly lexical and related imports resolve saved local modules',async()=>{
 const refs=ok(await callTool('find_references',{path:root,symbol:'sum'}));assert.ok(refs.matches.some(m=>m.file.includes('use.ts')));assert.match(refs.semantics,/Lexical/);
 const rel=ok(await callTool('related_files',{path:root,file:'src/use.ts'}));assert.equal(rel.imports[0].resolved,'src/math.ts');
 const reverse=ok(await callTool('related_files',{path:root,file:'src/math.ts'}));assert.ok(reverse.importers.includes('src/use.ts'));
});
test('syntax diagnostics do not pretend to be typechecking',async()=>{
 const p=f('src/invalid.ts');await fs.writeFile(p,'export function broken( {');const r=await callTool('code_diagnostics',{paths:[p]});assert.equal(r.isError,true);assert.equal(r.structuredContent.level,'syntax-only');assert.ok(r.structuredContent.files[0].diagnostics.length);await fs.unlink(p);
});
test('VS Code tasks omit environment values and never execute automatically',async()=>{
 const tasks=ok(await callTool('vscode_tasks',{path:root}));assert.equal(tasks.execution,false);assert.equal(tasks.tasks[0].label,'test');assert.ok(!JSON.stringify(tasks).includes('DO_NOT_EXPOSE_ENV'));
});
test('test discovery and impact suggestions use actual scripts and tests',async()=>{
 const d=ok(await callTool('discover_checks',{path:root}));assert.ok(d.candidates.some(c=>c.name==='test'));assert.ok(!d.candidates.some(c=>c.name==='test:watch'));assert.deepEqual(d.defaultChecks,['test']);assert.ok(d.testFiles.includes('tests/basic.test.cjs'));
 const impact=ok(await callTool('test_impact',{path:root,files:['src/math.ts']}));assert.equal(impact.heuristic,true);
});
test('checks preview by default and reject invented script names',async()=>{
 const preview=ok(await callTool('run_project_checks',{path:root,scripts:['test']}));assert.equal(preview.execute,false);assert.match(preview.commands[0].command,/pnpm .* run/);
 fail(await callTool('run_project_checks',{path:root,scripts:['missing'],execute:true}),'UNKNOWN_CHECK');
});
test('coding session requires real current verification before finish',async()=>{
 const s=ok(await callTool('coding_session',{action:'start',path:root,goal:'Improve math safely',scope:['src'],requiredChecks:['test']}));
 fail(await callTool('coding_session',{action:'finish',sessionId:s.sessionId}),'VERIFICATION_REQUIRED');
 const v=ok(await callTool('coding_session',{action:'verify',sessionId:s.sessionId}));assert.equal(v.passed,true);assert.equal(v.steps[0].exitCode,0);assert.match(JSON.stringify(v.steps[0].output),/source has valid sum/);assert.ok(!JSON.stringify(v).includes("skipping running files"));
 await fs.appendFile(f('src/math.ts'),'// changed after test\n');fail(await callTool('coding_session',{action:'finish',sessionId:s.sessionId}),'VERIFICATION_REQUIRED');
 ok(await callTool('coding_session',{action:'verify',sessionId:s.sessionId}));const finished=ok(await callTool('coding_session',{action:'finish',sessionId:s.sessionId}));assert.equal(finished.state,'finished');assert.equal(finished.persistent,false);
 ok(await callTool('coding_session',{action:'abandon',sessionId:s.sessionId}));await fs.writeFile(f('src/math.ts'),source);
});
test('scope violations cannot be hidden behind a passing test',async()=>{
 const s=ok(await callTool('coding_session',{action:'start',path:root,goal:'Only src',scope:['src'],requiredChecks:['test']}));await fs.appendFile(f('README.md'),'outside scope\n');ok(await callTool('coding_session',{action:'verify',sessionId:s.sessionId}));fail(await callTool('coding_session',{action:'finish',sessionId:s.sessionId}),'SCOPE_VIOLATION');ok(await callTool('coding_session',{action:'abandon',sessionId:s.sessionId}));
});
test('failed real checks cannot produce accepted verification evidence',async()=>{
 const r=await callTool('run_project_checks',{path:root,scripts:['fail'],execute:true});assert.equal(r.isError,true);assert.equal(r.structuredContent.passed,false);assert.equal(r.structuredContent.steps[0].exitCode,7);
});
test('new read tools can be batched without nested agent/model calls',async()=>{
 const b=ok(await callTool('batch_tools',{calls:[{tool:'code_outline',arguments:{path:f('src/math.ts')}},{tool:'read_symbol',arguments:{path:f('src/math.ts'),name:'sum'}}]}));assert.equal(b.results.length,2);assert.equal(b.transactional,false);
});
test('project context does not escape narrower roots through a junction',async t=>{
 const outside=path.join(scratch,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'AGENTS.md'),'PRIVATE_OUTSIDE');
 try{await fs.symlink(outside,f('escape'),process.platform==='win32'?'junction':'dir');}catch(e){if(e.code==='EPERM'){t.skip('OS does not permit symlink creation');return;}throw e;}
 try{fail(await callTool('project_context',{path:root,focus:'escape/AGENTS.md'}),'OUTSIDE_PROJECT');}finally{await fs.unlink(f('escape'));}
});
test('SQLite activity is volatile and never appears in the database',()=>{
 const file=path.join(scratch,'live.sqlite');let s=new SqliteStore(file);const u=s.upsertUser('admin','test-only');s.audit({ts:Date.now(),user_id:u.id,device_id:'pc',client:'test',tool:'read_symbol',args_hash:'abc',ok:1,ms:2,error:null});assert.equal(s.recentAudit(u.id).length,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,0);s.close();s=new SqliteStore(file);assert.equal(s.recentAudit(u.id).length,0);assert.ok(s.getUserByName('admin'));s.close();
});
test('live-only logging ignores old enable flags and writes nothing',async()=>{
 const h=path.join(scratch,'no-logs'),l=new ActivityLog(h,true,true);await l.start();for(let i=0;i<9000;i++)l.tool('OK','read_symbol','call-'+i,1);await l.flush();assert.ok(l.recent().length>0 && l.recent().reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e),'utf8'),0)<=MAX_ACTIVITY_EVENT_BYTES);assert.ok(l.dropped > 0);assert.equal(await fs.stat(h).catch(()=>null),null);await l.close();
 const {isTelemetryDisabledByEnv}=await import('../dist/core/utils/capture.js');assert.equal(isTelemetryDisabledByEnv(),true);
});

after(async()=>{const {clearCodeCache}=await import('../dist/runtime/code-structure.js');const {codeGraph}=await import('../dist/runtime/code-graph.js');clearCodeCache();codeGraph.clear();});
