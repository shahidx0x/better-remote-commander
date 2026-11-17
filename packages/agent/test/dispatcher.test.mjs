import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
process.env.BRC_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'brc-home-'));
const {callTool} = await import('../dist/dispatcher.js');
const sha=s=>createHash('sha256').update(s).digest('hex');
const txt=r=>r.content.map(c=>c.text??'').join('');
test('dispatcher: unknown tool -> structured error with call id',async()=>{
  const r=await callTool('nope',{});
  assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'UNKNOWN_TOOL');assert.ok(r._meta.callId);
});
test('write_file/edit_block honour expected_sha256',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-disp-'));const f=path.join(d,'a.txt');
  const w=await callTool('write_file',{path:f,content:'one\n',mode:'rewrite'});
  assert.ok(!w.isError,txt(w));
  const bad=await callTool('edit_block',{file_path:f,old_string:'one',new_string:'two',expected_sha256:sha('zzz')});
  assert.equal(bad.isError,true);assert.equal(bad.structuredContent.error.code,'FILE_CONFLICT');
  assert.equal(await fs.readFile(f,'utf8'),'one\n');
  const ok=await callTool('edit_block',{file_path:f,old_string:'one',new_string:'two',expected_sha256:sha('one\n')});
  assert.ok(!ok.isError,txt(ok));assert.equal(await fs.readFile(f,'utf8'),'two\n');
});
test('concurrent edits to one file are serialized, none lost',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-disp-'));const f=path.join(d,'a.txt');
  await fs.writeFile(f,'A0\nB0\nC0\n');
  const rs=await Promise.all([['A0','A1'],['B0','B1'],['C0','C1']].map(([o,n])=>callTool('edit_block',{file_path:f,old_string:o,new_string:n})));
  for(const r of rs)assert.ok(!r.isError,txt(r));
  assert.equal(await fs.readFile(f,'utf8'),'A1\nB1\nC1\n');
});
test('write_file over 1 MiB is refused without changing the file',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-disp-'));const f=path.join(d,'a.txt');await fs.writeFile(f,'keep');
  const r=await callTool('write_file',{path:f,content:'x'.repeat(1024*1024+1),mode:'rewrite'});
  assert.equal(r.structuredContent.error.code,'WRITE_SIZE_LIMIT');assert.equal(await fs.readFile(f,'utf8'),'keep');
});
test('write_file follows a symlink instead of replacing it',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-disp-'));const real=path.join(d,'real.txt'),link=path.join(d,'link.txt');
  await fs.writeFile(real,'old');
  try{await fs.symlink(real,link);}catch{return;}
  const r=await callTool('write_file',{path:link,content:'new',mode:'rewrite'});
  assert.ok(!r.isError,txt(r));assert.equal(await fs.readFile(real,'utf8'),'new');assert.ok((await fs.lstat(link)).isSymbolicLink());
});
test('read_file returns continuation metadata and bounds huge lines',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-disp-'));const f=path.join(d,'b.txt');
  await fs.writeFile(f,Array.from({length:50},(_,i)=>'line'+i).join('\n'));
  const r=await callTool('read_file',{path:f,length:10});
  assert.equal(r.structuredContent.read.hasMoreLines,true);assert.equal(r.structuredContent.read.next.args.offset,10);
  const g=path.join(d,'c.txt');await fs.writeFile(g,'y'.repeat(300000));
  const big=await callTool('read_file',{path:g});
  assert.ok(txt(big).length<140000);assert.equal(big.structuredContent.read.characterTruncated,true);
});
