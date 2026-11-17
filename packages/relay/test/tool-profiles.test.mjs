import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import WebSocket from 'ws';
import {buildRelay} from '../dist/app.js';
import {CORE_TOOLS,FOCUSED_EXTRAS,resolveToolProfile,profileAdvertises} from '../dist/mcp/tool-profiles.js';
import {BRC_PROTOCOL_VERSION} from 'brc-shared';

const dir=mkdtempSync(path.join(os.tmpdir(),'brc-prof-'));
const ALL=['get_config','read_file','write_file','run_command','git_status','list_processes','call_plugin_tool','worker_tasks','project_map','get_usage_stats','write_pdf','send_file_transfer','spawn_job','read_images'];
const cleanup=[];
after(async()=>{for(const f of cleanup)await f();rmSync(dir,{recursive:true,force:true});delete process.env.BRC_MCP_TOOL_PROFILE;});

async function start(profile,n){
  if(profile===undefined)delete process.env.BRC_MCP_TOOL_PROFILE;else process.env.BRC_MCP_TOOL_PROFILE=profile;
  const relay=buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3299',trustProxy:false,dbFile:path.join(dir,n+'.sqlite'),sessionSecret:'s',adminUser:'admin',adminPassword:'pw',relayVersion:'t'},()=>{});
  await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+relay.http.address().port;
  const form=(o)=>new URLSearchParams(o).toString();
  const post=(p,body,cookie)=>fetch(base+p,{method:'POST',redirect:'manual',headers:{...(cookie?{cookie}:{}),'content-type':'application/x-www-form-urlencoded'},body:form(body)});
  const login=await post('/auth/login',{username:'admin',password:'pw',returnTo:'/admin'});
  const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
  const page=await (await fetch(base+'/auth/links',{headers:{cookie}})).text();
  const csrf=page.match(/name="csrf" value="([^"]+)"/)[1];
  const user=relay.store.getUserByName('admin');
  const token=relay.store.issueDeviceToken('pc1',user.id,'PC','linux');
  const agent=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Authorization:'Bearer '+token}});
  await new Promise(r=>agent.on('open',r));
  agent.send(JSON.stringify({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:{deviceId:'pc1',name:'PC',platform:'linux',arch:'x64',hostname:'h',agentVersion:'1',coreVersion:'1'},tools:ALL.map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))}));
  const calls=[];
  agent.on('message',d=>{const m=JSON.parse(d);if(m.type==='call'){calls.push(m.tool);agent.send(JSON.stringify({type:'result',id:m.id,result:{content:[{type:'text',text:'ok:'+m.tool}]}}));}});
  await new Promise(r=>setTimeout(r,200));
  cleanup.push(async()=>{agent.terminate();relay.http.closeAllConnections();await relay.close();});
  const mint=async(mode)=>{const r=await post('/auth/links',{csrf,name:'t-'+mode,mode,days:'7'},cookie);const m=(await r.text()).match(/\/c\/(brc_link_[A-Za-z0-9_-]{43})\/mcp/);return base+m[0];};
  const rpc=(url,method,params)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(async r=>{const t=await r.text();return JSON.parse(t.startsWith('event')?t.split('data: ')[1]:t);});
  const names=async(url)=>(await rpc(url,'tools/list',{})).result.tools.map(t=>t.name);
  return {base,calls,mint,rpc,names};
}

test('resolveToolProfile defaults to full and rejects junk',()=>{
  assert.equal(resolveToolProfile({}),'full');
  assert.equal(resolveToolProfile({BRC_MCP_TOOL_PROFILE:'weird'}),'full');
  assert.equal(resolveToolProfile({BRC_MCP_TOOL_PROFILE:' Core '}),'core');
  assert.equal(resolveToolProfile({BRC_MCP_TOOL_PROFILE:'focused'}),'focused');
  assert.equal(new Set(CORE_TOOLS).size,CORE_TOOLS.length);
  assert.ok(FOCUSED_EXTRAS.every(t=>!CORE_TOOLS.includes(t)));
  assert.ok(profileAdvertises('core','list_devices'));
});

test('full (default) advertises everything, exactly as before',async()=>{
  const r=await start(undefined,'full');
  const url=await r.mint('full');
  const names=await r.names(url);
  for(const t of ALL)assert.ok(names.includes(t),t);
  assert.ok(names.includes('list_devices')&&names.includes('search_mcp_registry')&&names.includes('request_plugin_install'));
  const h=await (await fetch(r.base+'/health')).json();
  assert.equal(h.mcpToolProfile,'full');assert.equal(h.mcpTools,ALL.length);
});

test('core filters tools/list, keeps list_devices, hidden tools stay callable by name',async()=>{
  const r=await start('core','core');
  const url=await r.mint('full');
  const names=await r.names(url);
  for(const t of ['get_config','read_file','write_file','run_command','git_status','spawn_job','read_images','list_devices'])assert.ok(names.includes(t),t);
  for(const t of ['list_processes','call_plugin_tool','worker_tasks','project_map','get_usage_stats','write_pdf','send_file_transfer','search_mcp_registry','request_plugin_install'])assert.ok(!names.includes(t),t);
  const h=await (await fetch(r.base+'/health')).json();
  assert.equal(h.mcpToolProfile,'core');assert.equal(h.mcpTools,names.length-1); // device tools only (names also has list_devices)
  const before=r.calls.length;
  const out=await r.rpc(url,'tools/call',{name:'get_usage_stats',arguments:{}});
  assert.equal(out.result.content[0].text,'ok:get_usage_stats');
  assert.equal(r.calls.length,before+1);
});

test('focused = core + extras (plugins, workers, nav)',async()=>{
  const r=await start('focused','focused');
  const url=await r.mint('full');
  const names=await r.names(url);
  for(const t of ['read_file','list_processes','call_plugin_tool','worker_tasks','project_map','search_mcp_registry','request_plugin_install'])assert.ok(names.includes(t),t);
  for(const t of ['get_usage_stats','write_pdf','send_file_transfer'])assert.ok(!names.includes(t),t);
  assert.equal((await r.rpc(url,'tools/call',{name:'write_pdf',arguments:{}})).result.content[0].text,'ok:write_pdf');
});

test('read-only link advertises the intersection of profile and read-only list; hiding does not authorise',async()=>{
  const r=await start('core','corero');
  const url=await r.mint('read');
  const names=await r.names(url);
  assert.ok(names.includes('read_file')&&names.includes('git_status')&&names.includes('read_images'));
  for(const t of ['write_file','run_command','spawn_job','project_map','get_usage_stats','call_plugin_tool'])assert.ok(!names.includes(t),t);
  const before=r.calls.length;
  for(const t of ['write_file','get_usage_stats']){
    const o=await r.rpc(url,'tools/call',{name:t,arguments:{}});
    assert.match(o.result.content[0].text,/READ_ONLY_CONNECTION/);
  }
  assert.equal(r.calls.length,before);
  // a read tool outside the profile is hidden but still callable (same as pre-profile behaviour)
  assert.equal((await r.rpc(url,'tools/call',{name:'project_map',arguments:{}})).result.content[0].text,'ok:project_map');
});
