import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scratch=mkdtempSync(path.join(os.tmpdir(),'brc-io-regressions-'));
process.env.BRC_HOME=path.join(scratch,'home');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {callTool}=await import(pathToFileURL(path.join(repo,'packages/agent/dist/index.js')).href);
const root=path.join(scratch,'project');
await fs.mkdir(path.join(root,'src'),{recursive:true});
await fs.writeFile(path.join(root,'package.json'),JSON.stringify({
  name:'brc-io-test',private:true,packageManager:'pnpm@11.24.0',
  scripts:{check:'node -e "console.log(42)"',fail:'node -e "process.exit(7)"'}
}));
await fs.writeFile(path.join(root,'AGENTS.md'),'## Repo guidance\nUse safe bounded edits.');
const expectOk = out => {assert.equal(out.isError,false,JSON.stringify(out.structuredContent?.error??out.content));return out.structuredContent};
const expectError = (out,code) => {assert.equal(out.isError,true);assert.equal(out.structuredContent?.error?.code,code,JSON.stringify(out.structuredContent??out.content));};
after(async()=>{
  // Close the non-persistent Windows config watcher BEFORE deleting its watched
  // directory; otherwise Win32 may emit repeated rename events indefinitely.
  const { configManager }=await import('../dist/core/config-manager.js');
  await configManager.close();
  const { clearCodeCache }=await import('../dist/runtime/code-structure.js');
  const { codeGraph }=await import('../dist/runtime/code-graph.js');
  clearCodeCache();
  codeGraph.clear();
  await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:80});
});

test('project_context supports planned missing files and parents with no raw ENOENT',async()=>{
  const future='src/features/new-section/new-view.ts';
  const before=await fs.stat(path.join(root,future)).catch(()=>null);assert.equal(before,null);
  const out=expectOk(await callTool('project_context',{path:root,focus:future}));
  assert.ok(out.instructions.some(i=>i.path==='AGENTS.md'));
  assert.ok(out.warnings.some(v=>v.includes('does not exist yet')));
  assert.equal(await fs.stat(path.join(root,'src/features')).catch(()=>null),null);
  expectError(await callTool('project_context',{path:path.join(scratch,'does-not-exist')}),'PROJECT_NOT_FOUND');
});

test('run_project_checks reports actual failure and bounded output instead of TOOL_FAILED',async()=>{
  const preview=expectOk(await callTool('run_project_checks',{path:root,scripts:['fail']}));
  assert.equal(preview.execute,false);
  const failure=await callTool('run_project_checks',{path:root,scripts:['fail'],execute:true});
  expectError(failure,'CHECK_FAILED');
  assert.equal(failure.structuredContent.passed,false);
  assert.equal(failure.structuredContent.steps[0].exitCode,7);
  assert.ok(failure.structuredContent.steps[0].output.length<=8000);
  const ok=expectOk(await callTool('run_project_checks',{path:root,scripts:['check'],execute:true}));
  assert.equal(ok.passed,true);
  assert.equal(ok.steps[0].exitCode,0);
});

test('direct write limits are enforced BEFORE mutation; intentional large chunks remain writable',async()=>{
  const file=path.join(root,'src','target.ts');
  const short='export const version = 1;\n';
  expectOkOrText(await callTool('write_file',{path:file,content:short,mode:'rewrite'}));
  const noMode=await callTool('write_file',{path:file,content:'bad\n'});
  expectError(noMode,'WRITE_MODE_REQUIRED');
  assert.equal(await fs.readFile(file,'utf8'),short);
  const tooMany=Array.from({length:2500},(_,i)=>'line '+i).join('\n')+'\n';
  expectError(await callTool('write_file',{path:file,content:tooMany,mode:'rewrite'}),'WRITE_LINE_LIMIT');
  assert.equal(await fs.readFile(file,'utf8'),short);
  expectError(await callTool('write_file',{path:file,content:'x'.repeat(1024*1024+1),mode:'rewrite'}),'WRITE_SIZE_LIMIT');
  assert.equal(await fs.readFile(file,'utf8'),short);
  // A moderately sized generated page now fits the new default (1000 lines).
  const valid=Array.from({length:550},(_,i)=>'const line'+i+' = '+i+';').join('\n')+'\n';
  expectOkOrText(await callTool('write_file',{path:file,content:valid,mode:'rewrite'}));
  expectOkOrText(await callTool('write_file',{path:file,content:'// another safe chunk\n',mode:'append'}));
  assert.ok((await fs.readFile(file,'utf8')).includes('const line549 = 549;'));
  assert.ok((await fs.readFile(file,'utf8')).endsWith('// another safe chunk\n'));
});
function expectOkOrText(r){assert.ok(!r.isError,JSON.stringify(r.structuredContent?.error??r.content));}


test('read_file provides next line offset, giant lines can be resumed with character windows',async()=>{
  const normal=path.join(root,'src','paged.txt');
  await fs.writeFile(normal,Array.from({length:620},(_,i)=>'page-'+i).join('\n'));
  const first=await callTool('read_file',{path:normal,length:100,offset:0});
  assert.equal(first.isError,undefined);
  assert.equal(first.structuredContent.read.hasMoreLines,true);
  assert.equal(first.structuredContent.read.next.tool,'read_file');
  assert.equal(first.structuredContent.read.next.args.offset,100);
  const next=await callTool(first.structuredContent.read.next.tool,first.structuredContent.read.next.args);
  assert.match(next.content[0].text,/page-100/);
  const huge=path.join(root,'src','huge-line.txt'),expected='Z'.repeat(260000);
  await fs.writeFile(huge,expected);
  const r=await callTool('read_file',{path:huge,length:1});
  assert.equal(r.structuredContent.read.characterTruncated,true);
  const initial=await callTool('read_code_file',r.structuredContent.read.next.args);
  const blocks=[initial.structuredContent.text];
  let pos=initial.structuredContent.nextCharOffset;
  while(pos!==null){
    const part=await callTool('read_code_file',{path:huge,charOffset:pos,charLength:50000});
    assert.ok(!part.isError);
    blocks.push(part.structuredContent.text);pos=part.structuredContent.nextCharOffset;
    assert.ok(blocks.length<=10);
  }
  assert.equal(blocks.join(''),expected);
});
test('read_multiple_files preflights oversized media without decoding',async()=>{
  const huge=path.join(root,'src','oversize.png');
  await fs.writeFile(huge,Buffer.alloc(3*1024*1024,3));
  const r=await callTool('read_multiple_files',{paths:[huge]});
  assert.equal(r.isError,undefined);
  assert.equal(r.structuredContent.batch.truncated,true);
  assert.equal(r.structuredContent.batch.omitted[0].path,huge);
  assert.match(r.content[0].text,/Media omitted before decoding/);
});

test('single-file and batched reads cap giant lines, with explicit truncation and valid range checks',async()=>{
  const a=path.join(root,'src','very-long.txt'),b=path.join(root,'src','very-long-2.txt');
  await fs.writeFile(a,'X'.repeat(250000));
  await fs.writeFile(b,'Y'.repeat(250000));
  let r=await callTool('read_file',{path:a,length:1});
  assert.ok(!r.isError);
  assert.ok(r.content[0].text.length<140000);
  assert.match(r.content[0].text,/OUTPUT TRUNCATED/);
  expectError(await callTool('read_file',{path:a,length:2001}),'INVALID_ARGUMENT');
  r=await callTool('read_multiple_files',{paths:[a,b]});
  assert.ok(!r.isError);
  assert.ok(r.content.filter(c=>c.type==='text').reduce((n,c)=>n+c.text.length,0)<160000);
  assert.ok(r.content.some(c=>c.type==='text'&&c.text.includes('TRUNCATED')));
  expectError(await callTool('read_multiple_files',{files:[{path:a,length:2001}]}),'INVALID_ARGUMENT');
});
