import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens } from 'gpt-tokenizer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SqliteStore } from '../dist/store/sqlite.js';
import { McpTrafficEstimator, visibleMcpText } from '../dist/features/mcp-estimates.js';
import { usageView } from '../dist/features/usage.js';
import { dashboardPage } from '../dist/pages/dashboard.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=6500) {
  const t=Date.now();
  while(Date.now()-t<timeout) {
    const value=await fn();
    if(value)return value;
    await sleep(25);
  }
  throw Error('MCP estimate worker/storage timed out');
}

test('BPE counts MCP-visible tool text; skips base64 image data and explicit partials',()=>{
  const info=visibleMcpText('read_file',{path:'src/hello.ts',line:5},{
    content:[{type:'text',text:'hello world 世界'}],isError:false
  });
  assert.ok(info.modelOutputText.includes('read_file'));
  assert.ok(info.modelOutputText.includes('src/hello.ts'));
  assert.equal(info.modelInputText,'hello world 世界\n');
  assert.equal(info.partial,false);
  assert.ok(countTokens(info.modelInputText)>0);
  assert.ok(countTokens(info.modelOutputText)>0);
  const bigImage=Buffer.alloc(12*1024).toString('base64');
  const media=visibleMcpText('read_images',{image:{type:'image',data:bigImage}},{
    content:[{type:'image',data:bigImage,mimeType:'image/png'},
      {type:'text',text:'Image processed'}],
  });
  assert.equal(media.partial,true);
  assert.equal(media.modelInputText,'Image processed\n');
  assert.ok(!media.modelInputText.includes(bigImage.slice(0,40)));
  assert.ok(!media.modelOutputText.includes(bigImage.slice(0,40)));
  const long=visibleMcpText('run_command',{}, {content:[{type:'text',text:'a '.repeat(400000)}]});
  assert.equal(long.partial,true);
  assert.ok(long.modelInputText.length<=524288);
  const onlyStructured=visibleMcpText('tool',{}, {structuredContent:{result:'yes',count:12}});
  assert.ok(onlyStructured.modelInputText.includes('result'));
});

test('no tool response waits on counting or persistence, with SQLite daily/account scoping', {timeout:18000},async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'brc-mcp-estimates-'));
  const dbfile=path.join(folder,'usage.sqlite');
  const store=new SqliteStore(dbfile);
  let writes=0;
  const original=store.recordMcpEstimates.bind(store);
  store.recordMcpEstimates=(rows)=>{writes++;return original(rows)};
  const collector=new McpTrafficEstimator(store,()=>{});
  const day=new Date().toISOString().slice(0,10);
  try{
    const args={path:'src/readme.md',limit:3};
    const response={content:[{type:'text',text:'Hello local estimation! Here are several lines.'}]};
    const expected=visibleMcpText('read_file',args,response);
    const started=performance.now();
    collector.track('owner-one','read_file',args,response);
    const immediate=performance.now()-started;
    assert.ok(immediate<35,'report scheduling unexpectedly blocked tool handler: '+immediate.toFixed(2)+'ms');
    assert.equal(writes,0,'no SQLite writes on request hot path');

    // Include a malformed binary result to verify incomplete marker is durable.
    collector.track('owner-one','read_images',{mimeType:'image/png',data:Buffer.alloc(5000).toString('base64')},
      {content:[{type:'image',data:'AAAA',mimeType:'image/png'}]});
    collector.track('owner-two','list_devices',{}, {content:[{type:'text',text:'Other account device details'}]});

    await until(async()=>{
      await collector.flush();
      const rows=store.mcpEstimateDays('owner-one',day);
      return rows[0]?.reports===2?rows[0]:null;
    });
    const owner=store.mcpEstimateDays('owner-one',day)[0];
    assert.equal(owner.reports,2);
    assert.equal(owner.partial_calls,1);
    assert.equal(owner.input_tokens,countTokens(expected.modelInputText));
    assert.ok(owner.output_tokens>=countTokens(expected.modelOutputText));
    const other=store.mcpEstimateDays('owner-two',day)[0];
    assert.equal(other.reports,1);
    assert.equal(store.mcpEstimateDays('owner-three',day).length,0);
    const otherUsage=usageView(store.mcpEstimateDays('owner-two',day),'day');
    assert.equal(otherUsage.totals.reports,1);
    assert.equal(store.usageDays('owner-one',day).length,0,
      'provider-reported usage must not include local estimates');
    const html=dashboardPage('http://example.test',[],[],{total:0,failed:0,last24h:0},
      usageView([],'day'),'','',usageView(store.mcpEstimateDays('owner-one',day),'day'),
      store.mcpEstimateDays('owner-one',day));
    assert.match(html,/Estimated MCP token traffic/);
    assert.match(html,/Input · tool results/);
    assert.match(html,/Output · tool arguments/);
    assert.match(html,/2 MCP tool calls/);
    assert.match(html,/incomplete/);
    assert.match(html,/No model usage reported yet/);
    await collector.close();
    store.close();

    // Reopening the database preserves daily totals, not individual tool content.
    const reopened=new SqliteStore(dbfile);
    try{
      assert.equal(reopened.mcpEstimateDays('owner-one',day)[0].calls,undefined);
      assert.equal(reopened.mcpEstimateDays('owner-one',day)[0].reports,2);
      const savedObjects=reopened.db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table','mcp_estimate_daily');
      assert.ok(savedObjects);
      const cols=reopened.db.prepare('PRAGMA table_info(mcp_estimate_daily)').all().map(c=>c.name);
      assert.ok(!cols.includes('tool_arguments')&&!cols.includes('tool_result')&&!cols.includes('prompt'));
    }finally{reopened.close()}
  }finally{
    await collector.close().catch(()=>{});
    try{store.close()}catch{}
    await fs.rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:60});
  }
});
test('estimation can be disabled without starting worker or modifying store',async()=>{
  const store=new SqliteStore(':memory:');
  const collector=new McpTrafficEstimator(store,()=>{},false);
  try{
    assert.equal(collector.enabled,false);
    collector.track('owner','list_devices',{}, {content:[{type:'text',text:'status'}]});
    await collector.flush();
    assert.deepEqual(store.mcpEstimateDays('owner','2026-01-01'),[]);
  }finally{await collector.close();store.close()}
});
