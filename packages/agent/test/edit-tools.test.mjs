import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
process.env.BRC_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'brc-home-'));
const {callTool,listTools} = await import('../dist/dispatcher.js');
const sha=s=>createHash('sha256').update(s).digest('hex');
const mk=async()=>fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'brc-et-')));
const b=r=>r.structuredContent;
const code=r=>b(r)?.error?.code;
const sym=async(a,t)=>{try{await fs.symlink(a,t,t.endsWith('.lnk')?'file':'junction');return true;}catch{return false;}};

test('tools are advertised and descriptions only mention existing tools',()=>{
  const names=new Set(listTools().map(t=>t.name));
  for(const n of ['read_code_ranges','read_code_context','edit_files','replace_symbol','edit_code_ranges']){
    const t=listTools().find(x=>x.name===n);assert.ok(t,n);
    for(const m of t.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g)??[]) if(/^(read|edit|replace|code|write|workspace|find|project)_/.test(m)) assert.ok(names.has(m),`${n} mentions missing ${m}`);
  }
});
test('read_code_ranges returns ranges, hash and honours budget',async()=>{
  const d=await mk();const t='a\nb\nc\nd\n';await fs.writeFile(path.join(d,'x.txt'),t);await fs.writeFile(path.join(d,'y.txt'),'z'.repeat(5000));
  const r=await callTool('read_code_ranges',{path:d,files:[{path:'x.txt',ranges:[{startLine:2,endLine:3}]}]});
  assert.ok(!r.isError,JSON.stringify(r.content));assert.equal(b(r).files[0].sha256,sha(t));assert.equal(b(r).files[0].ranges[0].text,'b\nc');
  const s=await callTool('read_code_ranges',{path:d,maxChars:1000,files:[{path:'y.txt',ranges:[{startLine:1,endLine:1}]}]});
  assert.equal(b(s).files[0].ranges[0].text.length,1000);assert.equal(b(s).files[0].ranges[0].truncated,true);
  const bad=await callTool('read_code_ranges',{path:d,files:[{path:'x.txt',ranges:[{startLine:3,endLine:2}]}]});
  assert.equal(code(bad),'INVALID_RANGE');
});
test('read_code_ranges refuses outside-root and escaping junction',async()=>{
  const d=await mk(),o=await mk();await fs.writeFile(path.join(o,'s.txt'),'secret');
  assert.equal(code(await callTool('read_code_ranges',{path:d,files:[{path:path.join(o,'s.txt'),ranges:[{startLine:1,endLine:1}]}]})),'OUTSIDE_PROJECT');
  assert.equal(code(await callTool('read_code_ranges',{path:d,files:[{path:'../x',ranges:[{startLine:1,endLine:1}]}]})),'OUTSIDE_PROJECT');
  if(await sym(o,path.join(d,'link'))) assert.equal(code(await callTool('read_code_ranges',{path:d,files:[{path:'link/s.txt',ranges:[{startLine:1,endLine:1}]}]})),'OUTSIDE_PROJECT');
});
test('read_code_context finds snippets with fresh hashes and skips secrets',async()=>{
  const d=await mk();const t='one\ntwo needle\nthree\n';await fs.writeFile(path.join(d,'a.txt'),t);await fs.writeFile(path.join(d,'.env'),'needle=1\n');
  const r=await callTool('read_code_context',{path:d,pattern:'needle',contextLines:1});
  assert.ok(!r.isError,JSON.stringify(r.content));
  const f=b(r).files.find(x=>x.path.endsWith('a.txt'));assert.ok(f);assert.equal(f.sha256,sha(t));assert.match(f.snippets[0].text,/two needle/);
  assert.ok(!b(r).files.some(x=>x.path.endsWith('.env')));
});
test('edit_files: happy path, CRLF, hash verified',async()=>{
  const d=await mk();const a=path.join(d,'a.txt'),c=path.join(d,'c.txt');
  const ta='hello world\n',tc='x\r\ny\r\n';await fs.writeFile(a,ta);await fs.writeFile(c,tc);
  const dry=await callTool('edit_files',{path:d,dryRun:true,files:[{path:'a.txt',expected_sha256:sha(ta),edits:[{old_string:'world',new_string:'there'}]}]});
  assert.ok(!dry.isError);assert.equal(await fs.readFile(a,'utf8'),ta);
  const r=await callTool('edit_files',{path:d,files:[{path:'a.txt',expected_sha256:sha(ta),edits:[{old_string:'world',new_string:'there'}]},{path:'c.txt',expected_sha256:sha(tc),edits:[{old_string:'x\ny',new_string:'p\nq\nr'}]}]});
  assert.ok(!r.isError,JSON.stringify(r.content));
  assert.equal(await fs.readFile(a,'utf8'),'hello there\n');assert.equal(await fs.readFile(c,'utf8'),'p\r\nq\r\nr\r\n');
  assert.equal(b(r).files[0].afterSha256,sha('hello there\n'));assert.equal(b(r).files[1].verifiedOnDisk,true);
});
test('edit_files: stale hash / bad count writes nothing (all-or-nothing)',async()=>{
  const d=await mk();const a=path.join(d,'a.txt'),c=path.join(d,'c.txt');await fs.writeFile(a,'A\n');await fs.writeFile(c,'C\n');
  let r=await callTool('edit_files',{path:d,files:[{path:'a.txt',expected_sha256:sha('A\n'),edits:[{old_string:'A',new_string:'A2'}]},{path:'c.txt',expected_sha256:sha('stale'),edits:[{old_string:'C',new_string:'C2'}]}]});
  assert.equal(r.isError,true);assert.equal(code(r),'FILE_CONFLICT');
  r=await callTool('edit_files',{path:d,files:[{path:'a.txt',expected_sha256:sha('A\n'),edits:[{old_string:'A',new_string:'A2'}]},{path:'c.txt',expected_sha256:sha('other\n'),edits:[{old_string:'C',new_string:'C2'}]}]});
  assert.equal(code(r),'FILE_CONFLICT');
  r=await callTool('edit_files',{path:d,files:[{path:'a.txt',expected_sha256:sha('A\n'),edits:[{old_string:'A',new_string:'A2'}]},{path:'c.txt',expected_sha256:sha('C\n'),edits:[{old_string:'nope',new_string:'x'}]}]});
  assert.equal(code(r),'EDIT_MISMATCH');
  assert.equal(await fs.readFile(a,'utf8'),'A\n');assert.equal(await fs.readFile(c,'utf8'),'C\n');
});
test('edit_files: outside root, symlink, duplicates refused; no stray temp files',async()=>{
  const d=await mk(),o=await mk();const out=path.join(o,'o.txt');await fs.writeFile(out,'O\n');await fs.writeFile(path.join(d,'a.txt'),'A\n');
  const e=[{old_string:'A',new_string:'B'}],eo=[{old_string:'O',new_string:'B'}];
  assert.equal(code(await callTool('edit_files',{path:d,files:[{path:out,expected_sha256:sha('O\n'),edits:eo}]})),'OUTSIDE_PROJECT');
  assert.equal(code(await callTool('edit_files',{path:d,files:[{path:'../'+path.basename(o)+'/o.txt',expected_sha256:sha('O\n'),edits:eo}]})),'OUTSIDE_PROJECT');
  if(await sym(o,path.join(d,'dirlink'))) assert.equal(code(await callTool('edit_files',{path:d,files:[{path:'dirlink/o.txt',expected_sha256:sha('O\n'),edits:eo}]})),'OUTSIDE_PROJECT');
  if(await sym(path.join(d,'a.txt'),path.join(d,'in.lnk'))) assert.equal(code(await callTool('edit_files',{path:d,files:[{path:'in.lnk',expected_sha256:sha('A\n'),edits:e}]})),'UNSAFE_TARGET');
  assert.equal(code(await callTool('edit_files',{path:d,files:[{path:'a.txt',expected_sha256:sha('A\n'),edits:e},{path:'./a.txt',expected_sha256:sha('A\n'),edits:e}]})),'DUPLICATE_TARGET');
  assert.equal(await fs.readFile(out,'utf8'),'O\n');assert.equal(await fs.readFile(path.join(d,'a.txt'),'utf8'),'A\n');
  assert.deepEqual((await fs.readdir(d)).filter(n=>n.includes('.tmp')),[]);
});
test('edit_code_ranges: dryRun default, CRLF, BOM, stale hash = range drift refused',async()=>{
  const d=await mk(),f=path.join(d,'r.txt');const t='\ufeffl1\r\nl2\r\nl3\r\n';await fs.writeFile(f,t);
  const args={path:d,file:'r.txt',expected_sha256:sha(t),edits:[{startLine:2,endLine:2,text:'new\nmore'}]};
  const dry=await callTool('edit_code_ranges',args);assert.ok(!dry.isError,JSON.stringify(dry.content));assert.equal(b(dry).dryRun,true);assert.equal(await fs.readFile(f,'utf8'),t);
  const r=await callTool('edit_code_ranges',{...args,dryRun:false});assert.ok(!r.isError,JSON.stringify(r.content));
  const want='\ufeffl1\r\nnew\r\nmore\r\nl3\r\n';assert.equal(await fs.readFile(f,'utf8'),want);assert.equal(b(r).afterSha256,sha(want));assert.equal(b(r).verifiedOnDisk,true);
  // file changed (lines shifted): old hash must be refused
  assert.equal(code(await callTool('edit_code_ranges',{...args,dryRun:false})),'FILE_CONFLICT');
  assert.equal(await fs.readFile(f,'utf8'),want);
  // invalid / overlapping / out-of-range
  const cur=sha(want);
  for(const edits of [[{startLine:1,endLine:2,text:'a'},{startLine:2,endLine:3,text:'b'}],[{startLine:9,endLine:9,text:'a'}],[{startLine:3,endLine:2,text:'a'}]])
    assert.equal(code(await callTool('edit_code_ranges',{path:d,file:'r.txt',expected_sha256:cur,edits,dryRun:false})),'INVALID_RANGE');
});
test('edit_code_ranges refuses symlink/outside root',async()=>{
  const d=await mk(),o=await mk();await fs.writeFile(path.join(o,'o.txt'),'O\n');
  assert.equal(code(await callTool('edit_code_ranges',{path:d,file:path.join(o,'o.txt'),expected_sha256:sha('O\n'),edits:[{startLine:1,endLine:1,text:'x'}],dryRun:false})),'OUTSIDE_PROJECT');
  if(await sym(o,path.join(d,'dl'))) assert.equal(code(await callTool('edit_code_ranges',{path:d,file:'dl/o.txt',expected_sha256:sha('O\n'),edits:[{startLine:1,endLine:1,text:'x'}],dryRun:false})),'OUTSIDE_PROJECT');
  assert.equal(await fs.readFile(path.join(o,'o.txt'),'utf8'),'O\n');
});
test('replace_symbol: verified TS works, syntax errors and stale hash refused',async()=>{
  const d=await mk(),f=path.join(d,'m.ts');const t='export function a(){\r\n  return 1;\r\n}\r\nexport const k = 2;\r\n';await fs.writeFile(f,t);
  const args={path:d,file:'m.ts',name:'a',expected_sha256:sha(t),replacement:'export function a(){\n  return 42;\n}'};
  const dry=await callTool('replace_symbol',args);assert.ok(!dry.isError,JSON.stringify(dry.content));assert.equal(await fs.readFile(f,'utf8'),t);
  assert.equal(code(await callTool('replace_symbol',{...args,replacement:'export function a({',dryRun:false})),'SYNTAX_ERROR');
  const r=await callTool('replace_symbol',{...args,dryRun:false});assert.ok(!r.isError,JSON.stringify(r.content));
  const want='export function a(){\r\n  return 42;\r\n}\r\nexport const k = 2;\r\n';assert.equal(await fs.readFile(f,'utf8'),want);assert.equal(b(r).afterSha256,sha(want));
  assert.equal(code(await callTool('replace_symbol',{...args,dryRun:false})),'FILE_CONFLICT');
});
test('replace_symbol refuses unverified (lexical) languages and outside root',async()=>{
  const d=await mk(),o=await mk();const t='def foo():\n    return 1\n';await fs.writeFile(path.join(d,'m.py'),t);await fs.writeFile(path.join(o,'m.ts'),'export const z=1;\n');
  const r=await callTool('replace_symbol',{path:d,file:'m.py',name:'foo',expected_sha256:sha(t),replacement:'def foo():\n    return 2\n',dryRun:false});
  assert.equal(r.isError,true);assert.equal(code(r),'SAFE_RANGE_UNAVAILABLE');assert.equal(await fs.readFile(path.join(d,'m.py'),'utf8'),t);
  assert.equal(code(await callTool('replace_symbol',{path:d,file:path.join(o,'m.ts'),name:'z',expected_sha256:sha('export const z=1;\n'),replacement:'export const z=2;',dryRun:false})),'OUTSIDE_PROJECT');
});
test('edits invalidate navigation caches',async()=>{
  const d=await mk(),f=path.join(d,'n.txt');await fs.writeFile(f,'a\n');
  const nav=await import('../dist/runtime/nav-cache.js');assert.equal(typeof nav.invalidateNavCaches,'function');
  const r=await callTool('edit_files',{path:d,files:[{path:'n.txt',expected_sha256:sha('a\n'),edits:[{old_string:'a',new_string:'b'}]}]});assert.ok(!r.isError);
});
test('edit_files: mid-commit failure rolls back already written files',async()=>{
  const d=await mk();const a=path.join(d,'a.txt'),c=path.join(d,'c.txt');await fs.writeFile(a,'A\n');await fs.writeFile(c,'C\n');await fs.chmod(c,0o444);
  const r=await callTool('edit_files',{path:d,files:[{path:'a.txt',expected_sha256:sha('A\n'),edits:[{old_string:'A',new_string:'A2'}]},{path:'c.txt',expected_sha256:sha('C\n'),edits:[{old_string:'C',new_string:'C2'}]}]});
  await fs.chmod(c,0o644);
  if(r.isError){assert.equal(await fs.readFile(a,'utf8'),'A\n');assert.equal(await fs.readFile(c,'utf8'),'C\n');assert.equal(b(r).rolledBack,1);}
  else assert.equal(await fs.readFile(c,'utf8'),'C2\n'); // platforms where rename over a read-only file succeeds
});
