import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import WebSocket from 'ws';
import {BRC_PROTOCOL_VERSION} from 'brc-shared';
import {buildRelay} from '../dist/app.js';
import {SqliteStore} from '../dist/store/sqlite.js';
import {McpTrafficEstimator} from '../dist/features/mcp-estimates.js';
import {selectTextEncoding,countMcpTextWith,countMcpText} from '../dist/features/mcp-tokenizer.js';

const SECRET='WIRE-SECRET-77c1-do-not-store';
async function run({env,model,observer}){
  if(env===undefined)delete process.env.BRC_MCP_TOKEN_ESTIMATES;else process.env.BRC_MCP_TOKEN_ESTIMATES=env;
  const dir=mkdtempSync(path.join(os.tmpdir(),'brc-wire-'));const dbFile=path.join(dir,'r.sqlite');
  const relay=buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3299',trustProxy:false,dbFile,sessionSecret:'s',adminUser:'admin',adminPassword:'pw',relayVersion:'t'},()=>{});
  delete process.env.BRC_MCP_TOKEN_ESTIMATES;
  if(observer)relay.hub.onWireTraffic=observer;
  await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+relay.http.address().port;
  const user=relay.store.getUserByName('admin');
  const token=relay.store.issueDeviceToken('pc1',user.id,'PC','linux');
  const agent=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Authorization:'Bearer '+token}});
  await new Promise(r=>agent.on('open',r));
  agent.send(JSON.stringify({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:{deviceId:'pc1',name:'PC',platform:'linux',arch:'x64',hostname:'h',agentVersion:'1',coreVersion:'1'},tools:[{name:'read_file',description:'r',inputSchema:{type:'object',properties:{}}}]}));
  let callBytes=0,resultBytes=0;
  agent.on('message',(d)=>{const m=JSON.parse(d);if(m.type==='call'){callBytes+=Buffer.byteLength(d.toString());const out=JSON.stringify({type:'result',id:m.id,result:{content:[{type:'text',text:'contents é✓ '+SECRET}]}});resultBytes+=Buffer.byteLength(out);agent.send(out);}});
  await new Promise(r=>setTimeout(r,200));
  const login=await fetch(base+'/auth/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'pw',returnTo:'/admin'})});
  const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
  const links=await (await fetch(base+'/auth/links',{headers:{cookie}})).text();
  const csrf=links.match(/name="csrf" value="([^"]+)"/)[1];
  const mint=await fetch(base+'/auth/links',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,name:'n',mode:'full',days:'1'})});
  const url=base+'/c/'+(await mint.text()).match(/(brc_link_[A-Za-z0-9_-]{43})/)[1]+'/mcp';
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(model?{'x-brc-model':model}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_file',arguments:{path:SECRET}}})});
  const text=await r.text();
  agent.terminate();relay.http.closeAllConnections();await relay.close();
  const s=new SqliteStore(dbFile);const rows=s.mcpEstimateDays(user.id,'2000-01-01');
  const rawRows=s.db.prepare('SELECT COUNT(*) n FROM mcp_estimate_daily').get().n;s.close();
  const leaked=readFileSync(dbFile).includes('WIRE-SECRET');
  rmSync(dir,{recursive:true,force:true});
  return {rows,rawRows,text,callBytes,resultBytes,leaked};
}

test('estimates OFF: hook not installed, nothing recorded, call unaffected',async()=>{
  const o=await run({});
  assert.match(o.text,/contents/);assert.equal(o.rawRows,0);assert.deepEqual(o.rows,[]);assert.equal(o.leaked,false);
});

test('estimates ON: exact UTF-8 frame byte counts recorded, no content stored',async()=>{
  const o=await run({env:'1'});
  assert.equal(o.rows.length,1);
  assert.equal(o.rows[0].to_agent_bytes,o.callBytes);
  assert.equal(o.rows[0].from_agent_bytes,o.resultBytes);
  assert.ok(o.rows[0].reports>=1);assert.equal(o.leaked,false);
  assert.equal(o.rows[0].universal_calls,1);assert.equal(o.rows[0].matched_calls,0);
});

test('X-BRC-Model hint selects a matched encoding (counter only; header never stored)',async()=>{
  const o=await run({env:'1',model:'gpt-4o'});
  assert.equal(o.rows[0].matched_calls,1);assert.equal(o.rows[0].universal_calls,0);
});

test('a throwing wire observer cannot break a tool call',async()=>{
  let n=0;
  const o=await run({observer:()=>{n++;throw new Error('boom');}});
  assert.match(o.text,/contents/);assert.ok(!/isError":true/.test(o.text));
  assert.ok(n>=2,'observer saw both frames');
});

test('trackWireBytes is a no-op when disabled and ignores bad input',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'brc-wire-'));const store=new SqliteStore(path.join(dir,'a.sqlite'));
  try{
    const off=new McpTrafficEstimator(store,()=>{},false);off.trackWireBytes('u','to-agent',100);off.flush();
    assert.deepEqual(store.mcpEstimateDays('u','2000-01-01'),[]);
    const on=new McpTrafficEstimator(store,()=>{},true);
    on.trackWireBytes('u','to-agent',-1);on.trackWireBytes('u','to-agent',NaN);on.trackWireBytes('u','from-agent',1.5);
    on.trackWireBytes('u','to-agent',10);on.trackWireBytes('u','to-agent',5);on.trackWireBytes('u','from-agent',7);
    on.flush();
    const [d]=store.mcpEstimateDays('u','2000-01-01');
    assert.equal(d.to_agent_bytes,15);assert.equal(d.from_agent_bytes,7);assert.equal(d.reports,0);
    return on.close();
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('model hint tokenizer selection is strict and falls back to universal',()=>{
  assert.deepEqual(selectTextEncoding(undefined),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('gpt-4o-mini'),{encoding:'o200k_base',matched:true});
  assert.deepEqual(selectTextEncoding('gpt-4'),{encoding:'cl100k_base',matched:true});
  assert.deepEqual(selectTextEncoding('gpt-oss-20b'),{encoding:'o200k_harmony',matched:true});
  assert.equal(selectTextEncoding('claude-sonnet').matched,false);
  assert.equal(selectTextEncoding('x'.repeat(500)).matched,false);
  assert.equal(selectTextEncoding('gpt-4o\n<script>').matched,false);
  assert.equal(countMcpText(''),0);
  assert.equal(countMcpText('hello world'),countMcpTextWith('hello world',undefined).tokens);
});
