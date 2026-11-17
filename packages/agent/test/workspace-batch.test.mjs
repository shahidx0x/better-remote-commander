import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
process.env.BRC_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'brc-home-'));
const {callTool,listTools} = await import('../dist/dispatcher.js');
const sha=s=>createHash('sha256').update(s).digest('hex');
const mk=async()=>{const d=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'brc-wb-')));return d;};
const body=r=>r.structuredContent;

test('workspace_batch is advertised with a schema',()=>{
  const t=listTools().find(x=>x.name==='workspace_batch');
  assert.ok(t);assert.equal(t.inputSchema.type,'object');
});
test('dryRun (default) validates but writes nothing',async()=>{
  const d=await mk();const f=path.join(d,'a.txt');await fs.writeFile(f,'one\n');
  const r=await callTool('workspace_batch',{path:d,changes:[{path:'a.txt',expected_sha256:sha('one\n'),content:'two\n'}]});
  assert.ok(!r.isError,JSON.stringify(r.content));assert.equal(body(r).dryRun,true);
  assert.equal(await fs.readFile(f,'utf8'),'one\n');assert.equal(body(r).changes[0].changed,true);
});
test('commit applies edits, creates files, and reads back hashes',async()=>{
  const d=await mk();const a=path.join(d,'a.txt');await fs.writeFile(a,'hello world\n');
  const r=await callTool('workspace_batch',{path:d,dryRun:false,
    changes:[{path:'a.txt',expected_sha256:sha('hello world\n'),edits:[{old_string:'world',new_string:'there'}]},
             {path:'new.txt',expected_sha256:null,content:'fresh\n'}],
    reads:[{path:'a.txt'},{path:'new.txt'}]});
  assert.ok(!r.isError,JSON.stringify(r.content));
  assert.equal(await fs.readFile(a,'utf8'),'hello there\n');assert.equal(await fs.readFile(path.join(d,'new.txt'),'utf8'),'fresh\n');
  const reads=body(r).reads;assert.equal(reads[0].sha256,sha('hello there\n'));assert.match(reads[0].text,/hello there/);
  // known_sha256 avoids resending unchanged content
  const again=await callTool('workspace_batch',{path:d,reads:[{path:'a.txt',known_sha256:sha('hello there\n')}]});
  assert.equal(body(again).reads[0].unchanged,true);
});
test('one stale hash or bad edit count aborts the whole batch before any write',async()=>{
  const d=await mk();const a=path.join(d,'a.txt'),b=path.join(d,'b.txt');await fs.writeFile(a,'A\n');await fs.writeFile(b,'B\n');
  let r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[
    {path:'a.txt',expected_sha256:sha('A\n'),content:'A2\n'},{path:'b.txt',expected_sha256:sha('stale'),content:'B2\n'}]});
  assert.equal(r.isError,true);assert.equal(body(r).error.code,'FILE_CONFLICT');
  assert.equal(await fs.readFile(a,'utf8'),'A\n');assert.equal(await fs.readFile(b,'utf8'),'B\n');
  r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[
    {path:'a.txt',expected_sha256:sha('A\n'),content:'A2\n'},{path:'b.txt',expected_sha256:sha('B\n'),edits:[{old_string:'nope',new_string:'x'}]}]});
  assert.equal(body(r).error.code,'EDIT_MISMATCH');assert.equal(await fs.readFile(a,'utf8'),'A\n');
});
test('a failure while committing rolls back files already written',async()=>{
  const d=await mk();const a=path.join(d,'a.txt');await fs.writeFile(a,'keep\n');
  const r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[
    {path:'a.txt',expected_sha256:sha('keep\n'),content:'changed\n'},
    {path:'missing-dir/new.txt',expected_sha256:null,content:'x'}]});
  assert.equal(r.isError,true);
  assert.equal(await fs.readFile(a,'utf8'),'keep\n','first file restored');
  assert.equal(body(r).requiresReview,false);
});
test('paths cannot escape the project, and duplicates are refused',async()=>{
  const d=await mk();const outside=await mk();await fs.writeFile(path.join(outside,'x.txt'),'x');
  let r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[{path:'../'+path.basename(outside)+'/x.txt',expected_sha256:sha('x'),content:'pwn'}]});
  assert.equal(body(r).error.code,'OUTSIDE_PROJECT');assert.equal(await fs.readFile(path.join(outside,'x.txt'),'utf8'),'x');
  await fs.writeFile(path.join(d,'a.txt'),'a');
  r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[{path:'a.txt',expected_sha256:sha('a'),content:'1'},{path:'./a.txt',expected_sha256:sha('a'),content:'2'}]});
  assert.equal(body(r).error.code,'DUPLICATE_TARGET');
  try{await fs.symlink(path.join(outside,'x.txt'),path.join(d,'link.txt'));}catch{return;}
  r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[{path:'link.txt',expected_sha256:sha('x'),content:'pwn'}]});
  assert.equal(r.isError,true);assert.equal(await fs.readFile(path.join(outside,'x.txt'),'utf8'),'x');
});
test('CRLF files keep their line endings when edited',async()=>{
  const d=await mk();const f=path.join(d,'w.txt');await fs.writeFile(f,'a\r\nb\r\n');
  const r=await callTool('workspace_batch',{path:d,dryRun:false,changes:[{path:'w.txt',expected_sha256:sha('a\r\nb\r\n'),edits:[{old_string:'a\nb',new_string:'a\nc'}]}]});
  assert.ok(!r.isError,JSON.stringify(r.content));assert.equal(await fs.readFile(f,'utf8'),'a\r\nc\r\n');
});
