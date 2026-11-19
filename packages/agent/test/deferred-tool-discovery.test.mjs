import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const previous=process.env.BRC_TOOL_PROFILE;
const previousHome=process.env.BRC_HOME;
process.env.BRC_TOOL_PROFILE='deferred';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-deferred-tools-'));
process.env.BRC_HOME=path.join(root,'home');
await fs.mkdir(process.env.BRC_HOME,{recursive:true});
const {listTools,callTool,hasTool}=await import('../dist/dispatcher.js');
const {configManager}=await import('../dist/core/config-manager.js');
after(async()=>{
 await configManager.close();
 await fs.rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:80});
 if(previous===undefined)delete process.env.BRC_TOOL_PROFILE;else process.env.BRC_TOOL_PROFILE=previous;
 if(previousHome===undefined)delete process.env.BRC_HOME;else process.env.BRC_HOME=previousHome;
});
test('deferred profile advertises exactly two small stable gateway schemas',()=>{
 const advertised=listTools();
 assert.deepEqual(advertised.map(x=>x.name),['discover_tools','invoke_tool']);
 assert.equal(advertised[0].annotations.readOnlyHint,true);
 assert.equal(advertised[1].annotations.readOnlyHint,false);
 assert.ok(Buffer.byteLength(JSON.stringify(advertised))<2600);
 assert.equal(hasTool('read_file'),true,'existing native dispatcher must remain available');
});

test('discover_tools returns exact input schemas and paginates without execution',async()=>{
 const resp=await callTool('discover_tools',{
  names:['read_multiple_files','read_code_file','write_file'],includeSchema:true,limit:2
 });
 assert.equal(resp.isError,false,JSON.stringify(resp.structuredContent?.error));
 const v=resp.structuredContent;
 assert.equal(v.mode,'deferred');
 assert.equal(v.catalogCount,82);
 assert.equal(v.tools.length,2);
 assert.ok(v.tools[0].inputSchema);
 assert.ok(v.hasMore);
 const next=await callTool(v.next.tool,v.next.args);
 assert.equal(next.isError,false);
 assert.equal(next.structuredContent.tools[0].name,'write_file');
 const missing=await callTool('discover_tools',{names:['nonexistent-tool']});
 assert.deepEqual(missing.structuredContent.missingNames,['nonexistent-tool']);
});

test('indirect native tool invocation retains validation and writes only a permitted disposable file',async()=>{
 await configManager.setValue('allowedDirectories',[root]);
 const file=path.join(root,'hello.txt');
 const written=await callTool('invoke_tool',{name:'write_file',args:{
  path:file,content:'exact verified data\n',mode:'rewrite'
 }});
 assert.notEqual(written.isError,true,JSON.stringify(written.structuredContent?.error));
 assert.equal(await fs.readFile(file,'utf8'),'exact verified data\n');
 const read=await callTool('invoke_tool',{name:'read_file',args:{path:file,offset:0,length:10}});
 assert.notEqual(read.isError,true,JSON.stringify(read.structuredContent?.error));
 assert.match(JSON.stringify(read),/exact verified data/);
 const blocked=await callTool('invoke_tool',{name:'read_file',args:{path:path.join(root,'..','never-allowed.txt')}});
 assert.equal(blocked.isError,true,'indirection must not bypass allowedDirectories');
});

test('gateway cannot call itself, invoke an excluded or unknown tool, or accept invalid args',async()=>{
 for(const name of ['invoke_tool','discover_tools','track_ui_event','not_installed']){
  const out=await callTool('invoke_tool',{name,args:{}});
  assert.equal(out.isError,true,name);
 }
 const invalid=await callTool('invoke_tool',{name:'read_file',args:[]});
 assert.equal(invalid.isError,true);
 const invalidOffset=await callTool('discover_tools',{offset:-1});
 assert.equal(invalidOffset.isError,true);
});

test('task wording routes to the expected gateway tool without seeing native schemas upfront',async()=>{
 const examples=[
  ['make a precise exact text replacement in one file','edit_block'],
  ['preview coordinated edits across several source files','workspace_batch'],
  ['read a source code declaration by name','read_symbol'],
 ];
 for(const [query,expected] of examples){
  const found=await callTool('discover_tools',{query,limit:3});
  assert.notEqual(found.isError,true,query);
  assert.equal(found.structuredContent.tools[0].name,expected,query);
 }
});
