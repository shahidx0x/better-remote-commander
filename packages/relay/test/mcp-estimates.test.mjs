import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import WebSocket from 'ws';
import {BRC_PROTOCOL_VERSION} from 'brc-shared';
import {buildRelay} from '../dist/app.js';
import {SqliteStore} from '../dist/store/sqlite.js';
import {McpTrafficEstimator,visibleMcpText,mcpEstimatesEnabled} from '../dist/features/mcp-estimates.js';
import {countMcpText} from '../dist/features/mcp-tokenizer.js';

const SECRET='SECRET-MARKER-9f3a1c-do-not-store';
const tmp=()=>mkdtempSync(path.join(os.tmpdir(),'brc-est-'));

test('estimates are OFF by default and only BRC_MCP_TOKEN_ESTIMATES=1 enables them',()=>{
  assert.equal(mcpEstimatesEnabled({}),false);
  assert.equal(mcpEstimatesEnabled({BRC_MCP_TOKEN_ESTIMATES:'0'}),false);
  assert.equal(mcpEstimatesEnabled({BRC_MCP_TOKEN_ESTIMATES:'true'}),false);
  assert.equal(mcpEstimatesEnabled({BRC_MCP_TOKEN_ESTIMATES:'1'}),true);
});

test('disabled estimator spawns no worker, does nothing, writes nothing',async()=>{
  const dir=tmp();const store=new SqliteStore(path.join(dir,'a.sqlite'));
  try{
    const e=new McpTrafficEstimator(store,()=>{},false);
    assert.equal(e.enabled,false);assert.equal(e.active,false);
    e.track('u1','read_file',{path:SECRET},{content:[{type:'text',text:SECRET}]});
    e.flush();await e.close();
    assert.deepEqual(store.mcpEstimateDays('u1','2000-01-01'),[]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('token counting is local and gives positive integer approximations',()=>{
  assert.equal(countMcpText(''),0);
  const n=countMcpText('hello world, this is a test');
  assert.ok(Number.isSafeInteger(n)&&n>0);
});

test('visible text extraction caps size, skips binary content and marks partial',()=>{
  const big=visibleMcpText('t',{a:'x'.repeat(2_000_000)},{content:[{type:'text',text:'y'.repeat(2_000_000)}]});
  assert.ok(big.modelInputText.length<=262_144&&big.modelOutputText.length<=262_144);assert.equal(big.partial,true);
  const img=visibleMcpText('t',{},{content:[{type:'image',data:'AAAA',mimeType:'image/png'}]});
  assert.equal(img.partial,true);assert.equal(img.modelInputText,'');
  const circ={};circ.self=circ;
  assert.doesNotThrow(()=>visibleMcpText('t',circ,null));
});

test('enabled estimator aggregates counts per user/day in a worker, batches writes, stores no content',async()=>{
  const dir=tmp();const file=path.join(dir,'b.sqlite');const store=new SqliteStore(file);
  try{
    const e=new McpTrafficEstimator(store,()=>{},true);
    assert.equal(e.active,true);
    const t0=Date.now();
    for(let i=0;i<5;i++)e.track('u1','read_file',{path:SECRET+i},{content:[{type:'text',text:'file contents '+SECRET}]});
    e.track('u2','run_command',{command:'echo '+SECRET},{content:[{type:'text',text:'ok'}]});
    assert.ok(Date.now()-t0<50,'track() returns immediately');
    assert.deepEqual(store.mcpEstimateDays('u1','2000-01-01'),[],'nothing written synchronously');
    // garbage input must never throw
    assert.doesNotThrow(()=>{e.track('u1',undefined,undefined,undefined);e.track('u1','x',()=>1,{content:5});});
    await e.close();
    const [d]=store.mcpEstimateDays('u1','2000-01-01');
    assert.equal(d.reports,7);assert.ok(d.input_tokens>0&&d.output_tokens>0);
    assert.equal(store.mcpEstimateDays('u2','2000-01-01')[0].reports,1);
    const cols=store.db.prepare('PRAGMA table_info(mcp_estimate_daily)').all().map(c=>c.name).sort();
    assert.deepEqual(cols,['calls','day','input_tokens','output_tokens','partial_calls','user_id']);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM mcp_estimate_daily').get().n,2,'one row per user/day');
  }finally{store.close();}
  for(const f of readdirSync(dir))assert.ok(!readFileSync(path.join(dir,f)).includes(SECRET),'no tool content on disk ('+f+')');
  rmSync(dir,{recursive:true,force:true});
});

test('a failing store or dead worker never throws into tool execution',async()=>{
  const logs=[];
  const bad={recordMcpEstimates(){throw new Error('db down');}};
  const e=new McpTrafficEstimator(bad,(l,m)=>logs.push(m),true);
  e.worker?.terminate();
  assert.doesNotThrow(()=>{e.track('u','t',{},{content:[]});});
  await assert.doesNotReject(()=>e.close());
  assert.ok(logs.length>=1);
});

test('relay: off by default (no data, no usage section); enabled via env records aggregates on tool calls',async()=>{
  const run=async(envVal)=>{
    if(envVal===undefined)delete process.env.BRC_MCP_TOKEN_ESTIMATES;else process.env.BRC_MCP_TOKEN_ESTIMATES=envVal;
    const dir=tmp();const dbFile=path.join(dir,'r.sqlite');
    const relay=buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3299',trustProxy:false,dbFile,sessionSecret:'s',adminUser:'admin',adminPassword:'pw',relayVersion:'t'},()=>{});
    delete process.env.BRC_MCP_TOKEN_ESTIMATES;
    await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+relay.http.address().port;
    const user=relay.store.getUserByName('admin');
    const token=relay.store.issueDeviceToken('pc1',user.id,'PC','linux');
    const agent=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Authorization:'Bearer '+token}});
    await new Promise(r=>agent.on('open',r));
    agent.send(JSON.stringify({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:{deviceId:'pc1',name:'PC',platform:'linux',arch:'x64',hostname:'h',agentVersion:'1',coreVersion:'1'},tools:[{name:'read_file',description:'r',inputSchema:{type:'object',properties:{}}}]}));
    agent.on('message',d=>{const m=JSON.parse(d);if(m.type==='call')agent.send(JSON.stringify({type:'result',id:m.id,result:{content:[{type:'text',text:'contents '+SECRET}]}}));});
    await new Promise(r=>setTimeout(r,200));
    const login=await fetch(base+'/auth/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'pw',returnTo:'/admin'})});
    const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
    const links=await (await fetch(base+'/auth/links',{headers:{cookie}})).text();
    const csrf=links.match(/name="csrf" value="([^"]+)"/)[1];
    const mint=await fetch(base+'/auth/links',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,name:'n',mode:'full',days:'1'})});
    const url=base+'/c/'+(await mint.text()).match(/(brc_link_[A-Za-z0-9_-]{43})/)[1]+'/mcp';
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_file',arguments:{path:SECRET}}})});
    assert.match(await r.text(),/contents SECRET-MARKER/,'tool result is delivered unchanged');
    agent.terminate();relay.http.closeAllConnections();await relay.close();
    const s=new SqliteStore(dbFile);const rows=s.mcpEstimateDays(user.id,'2000-01-01');s.close();
    const raw=readFileSync(dbFile);assert.ok(!raw.includes('SECRET-MARKER-9f3a1c'),'no content persisted');
    rmSync(dir,{recursive:true,force:true});
    return rows;
  };
  assert.deepEqual(await run(undefined),[],'default: nothing recorded');
  const on=await run('1');
  assert.equal(on.length,1);assert.equal(on[0].reports,1);assert.ok(on[0].input_tokens>0);
});
