// End-to-end deferred schema flow over real MCP -> relay -> WebSocket -> agent.
// Uses only disposable agent/relay state and filesystem paths. No live restart.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {buildRelay} from '../../relay/dist/app.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=10000){const start=Date.now();
 while(Date.now()-start<ms){if(await fn())return;await sleep(40);}
 throw new Error('Timed out waiting for disposable deferred agent');
}
test('deferred two-gateway mode executes authorized native tools through unmodified MCP relay',{timeout:30000},async()=>{
 const previous=process.env.BRC_MCP_TOOL_PROFILE;
 process.env.BRC_MCP_TOOL_PROFILE='full';
 const scratch=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-deferred-mcp-'));
 const project=path.join(scratch,'project'),home=path.join(scratch,'home');
 await fs.mkdir(project);
 const relay=await buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3210',
  trustProxy:false,dbFile:path.join(scratch,'relay.sqlite'),sessionSecret:'test',
  adminUser:'admin',adminPassword:'test',relayVersion:'test'},()=>{});
 await new Promise(resolve=>relay.http.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+relay.http.address().port;
 const owner=relay.store.getUserByName('admin');
 const token=relay.store.issueDeviceToken('deferred-pc',owner.id,'Deferred Test PC','win32');
 const apiKey=relay.store.createApiKey(owner.id,'deferred');
 const child=spawn(process.execPath,[path.resolve('packages/agent/dist/cli.js'),'--relay',url,
   '--device-id','deferred-pc','--name','Deferred Test PC','--no-browser','--allow-dir',project],
   {windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,BRC_HOME:home,BRC_TOKEN:token,
     BRC_TOOL_PROFILE:'deferred',BRC_PLUGINS:'none',
     BRC_LOG_FILE:'0',BRC_ERROR_LOG:'0'}});
 let seq=0,logs='';
 for(const stream of [child.stdout,child.stderr])
  stream.on('data',b=>{logs=(logs+b.toString()).slice(-3000);});
 async function rpc(method,params){
  const r=await fetch(url+'/mcp',{method:'POST',headers:{
   authorization:'Bearer '+apiKey.raw,'content-type':'application/json',
   accept:'application/json, text/event-stream'},
   body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params}),
   signal:AbortSignal.timeout(15000)});
  const body=await r.text();
  assert.equal(r.status,200,body);
  const events=body.trim().startsWith('{')?[JSON.parse(body)]:
   body.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  const msg=events.find(v=>v.result!==undefined||v.error!==undefined);
  assert.ok(msg,body);
  assert.equal(msg.error,undefined,JSON.stringify(msg));
  return msg.result;
 }
 const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
 try{
  await until(()=>relay.hub.list().length===1,12000);
  await rpc('initialize',{protocolVersion:'2024-11-05',
   capabilities:{},clientInfo:{name:'deferred-integration',version:'1'}});
  const listed=await rpc('tools/list',{});
  const names=listed.tools.map(t=>t.name);
  console.log('DEFERRED_RELAY_CATALOG='+JSON.stringify({toolCount:names.length,
    bytes:Buffer.byteLength(JSON.stringify(listed.tools),'utf8'),
    note:'Actual unmodified relay MCP tools/list, not just the agent hello.'}));
  assert.ok(names.includes('discover_tools')&&names.includes('invoke_tool'));
  // The current relay merges its FIXED built-in 67-tool catalog on tools/list.
  // Agent-only deferred mode cannot make the actual MCP host see just 2 tools.
  // This regression makes that limitation explicit instead of claiming parity.
  assert.ok(names.includes('read_file')&&names.length>60,
   'relay now behaves differently; re-evaluate true deferred schema support');
  const discovered=await call('discover_tools',{names:['read_file','write_file'],includeSchema:true});
  assert.equal(discovered.isError,false,JSON.stringify(discovered.structuredContent));
  assert.ok(discovered.structuredContent.tools[0].inputSchema);
  const file=path.join(project,'new.txt');
  const write=await call('invoke_tool',{name:'write_file',args:{path:file,mode:'rewrite',content:'hello\n'}});
  assert.equal(write.isError,false,JSON.stringify(write.structuredContent));
  assert.equal(await fs.readFile(file,'utf8'),'hello\n');
  const read=await call('invoke_tool',{name:'read_file',args:{path:file,offset:0,length:10}});
  assert.equal(read.isError,false,JSON.stringify(read.structuredContent));
  assert.match(JSON.stringify(read),/hello/);
  const denied=await call('invoke_tool',{name:'invoke_tool',args:{name:'read_file',args:{path:file}}});
  assert.equal(denied.isError,true);
 }finally{
  child.kill('SIGKILL');
  await new Promise(resolve=>child.once('close',resolve));
  await new Promise(resolve=>relay.http.close(resolve));
  await relay.close?.();
  await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  if(previous===undefined)delete process.env.BRC_MCP_TOOL_PROFILE;
  else process.env.BRC_MCP_TOOL_PROFILE=previous;
 }
});
