import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket,WebSocketServer} from 'ws';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DeviceHub} from '../dist/device-hub.js';
import {SqliteStore} from '../dist/store/sqlite.js';
import {McpTrafficEstimator} from '../dist/features/mcp-estimates.js';
import {selectTextEncoding,countMcpText} from '../dist/features/mcp-tokenizer.js';
import {countTokens as countCl} from 'gpt-tokenizer/encoding/cl100k_base';
import {countTokens as countO} from 'gpt-tokenizer';
import {countTokens as countHarmony} from 'gpt-tokenizer/encoding/o200k_harmony';

const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn,why,timeout=7000) {
  const until=Date.now()+timeout;
  while(Date.now()<until) {
    const value=await fn();
    if(value)return value;
    await sleep(25);
  }
  throw Error('Timed out: '+why);
}
test('one offline package selects GPT encodings only from explicit hints; everything else falls back',()=>{
  assert.deepEqual(selectTextEncoding(),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('claude-sonnet-4-5'),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('gemini-3-pro'),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('deepseek-chat'),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('llama-3.1'),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('../../file'),{encoding:'o200k_base',matched:false});
  assert.deepEqual(selectTextEncoding('gpt-4-turbo'),{encoding:'cl100k_base',matched:true});
  assert.deepEqual(selectTextEncoding('gpt-4.1'),{encoding:'o200k_base',matched:true});
  assert.deepEqual(selectTextEncoding('gpt-5.4'),{encoding:'o200k_base',matched:true});
  assert.deepEqual(selectTextEncoding('gpt-oss-120b'),{encoding:'o200k_harmony',matched:true});
  const sample="Hello 世界! Here is some TypeScript: const data = {a: 1};\n";
  assert.equal(countMcpText(sample,'gpt-4-turbo').tokens,countCl(sample));
  assert.equal(countMcpText(sample,'gpt-5.4').tokens,countO(sample));
  assert.equal(countMcpText(sample,'gpt-oss-120b').tokens,countHarmony(sample));
  assert.equal(countMcpText(sample,'claude-sonnet-4-5').tokens,countO(sample));
});

test('SQLite schema migrates without erasing pre-existing MCP usage',async()=>{
  const folder=mkdtempSync(path.join(os.tmpdir(),'brc-mcp-migration-'));
  const filename=path.join(folder,'old.sqlite');
  try{
    const old=new DatabaseSync(filename);
    old.exec('CREATE TABLE mcp_estimate_daily (user_id TEXT NOT NULL,day TEXT NOT NULL,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,partial_calls INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,day))');
    old.prepare('INSERT INTO mcp_estimate_daily VALUES (?,?,?,?,?,?)').run('owner','2026-11-15',30,12,2,0);
    old.close();
    const db=new SqliteStore(filename);
    try {
      const rows=db.mcpEstimateDays('owner','2026-11-15');
      assert.equal(rows[0].input_tokens,30);
      assert.equal(rows[0].output_tokens,12);
      assert.equal(rows[0].reports,2);
      assert.equal(rows[0].matched_calls,0);
      assert.equal(rows[0].universal_calls,0);
      assert.equal(rows[0].to_agent_bytes,0);
      assert.equal(rows[0].from_agent_bytes,0);
      db.recordMcpEstimates([{user_id:'owner',day:'2026-11-15',input_tokens:10,output_tokens:2,calls:1,
        partial_calls:0,to_agent_bytes:38,from_agent_bytes:75,matched_calls:1,universal_calls:0}]);
      const current=db.mcpEstimateDays('owner','2026-11-15')[0];
      assert.equal(current.input_tokens,40);
      assert.equal(current.reports,3);
      assert.equal(current.to_agent_bytes,38);
      assert.equal(current.matched_calls,1);
    }finally{db.close()}
  }finally{await fs.rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
});

test('actual authenticated agent WebSocket tool frames measured exactly and BPE runs off request path',
{timeout:22000},async()=>{
  const folder=mkdtempSync(path.join(os.tmpdir(),'brc-ws-estimate-'));
  const store=new SqliteStore(path.join(folder,'counts.sqlite'));
  const hub=new DeviceHub('2.0.7',()=>{});
  const collector=new McpTrafficEstimator(store,()=>{});
  hub.onWireTraffic=(owner,direction,bytes)=>collector.trackWireBytes(owner,direction,bytes);
  const wss=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve=>wss.once('listening',resolve));
  const serverUrl='ws://127.0.0.1:'+wss.address().port;
  wss.on('connection',socket=>hub.attach(socket,'owner-test','pc-101'));
  const client=new WebSocket(serverUrl);
  await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject)});
  const toolFrames=[];
  const resultFrames=[];
  client.on('message',buffer=>{
    const msg=JSON.parse(buffer.toString());
    if(msg.type==='call') {
      toolFrames.push(buffer.length);
      const result={type:'result',id:msg.id,result:{content:[{type:'text',text:'Hello from the device'}]}};
      const payload=JSON.stringify(result);
      resultFrames.push(Buffer.byteLength(payload));
      client.send(payload);
    }
  });
  client.send(JSON.stringify({type:'hello',protocol:1,device:{
    deviceId:'pc-101',name:'PC',platform:'win32',arch:'x64',hostname:'PC',agentVersion:'2.0.7',coreVersion:'2.0.7'},
    tools:[{name:'read_file',description:'read',inputSchema:{type:'object'}}]}));
  await waitFor(()=>hub.list('owner-test').length===1,'agent hello');
  const args={path:'src/index.ts'};
  const started=performance.now();
  const result=await hub.call('pc-101','read_file',args);
  const elapsed=performance.now()-started;
  assert.equal(result.content[0].text,'Hello from the device');
  collector.track('owner-test','read_file',args,result,'gpt-4-turbo');
  assert.ok(elapsed<5000);
  const result2=await hub.call('pc-101','read_file',args);
  collector.track('owner-test','read_file',args,result2,'claude-sonnet-4-5');
  const day=new Date().toISOString().slice(0,10);
  const row=await waitFor(async()=>{
    await collector.flush();
    const rows=store.mcpEstimateDays('owner-test',day);
    return rows[0]?.reports===2 && rows[0]?.to_agent_bytes>0 && rows[0]?.from_agent_bytes>0 ? rows[0] : null;
  },'wire bytes plus token estimates');
  assert.equal(row.to_agent_bytes,toolFrames.reduce((a,b)=>a+b,0));
  assert.equal(row.from_agent_bytes,resultFrames.reduce((a,b)=>a+b,0));
  assert.equal(row.matched_calls,1);
  assert.equal(row.universal_calls,1);
  assert.equal(row.reports,2);
  assert.equal(row.partial_calls,0);
  assert.equal(store.mcpEstimateDays('different-user',day).length,0);
  assert.equal(store.usageDays('owner-test',day).length,0,'actual provider usage stays separate');
  await collector.close();
  client.close();
  hub.close();
  await new Promise(resolve=>wss.close(resolve));
  store.close();
  await fs.rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});
