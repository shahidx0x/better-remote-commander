// HTTP MCP -> background worker -> SQLite -> admin dashboard. No real LLM involved.
import assert from 'node:assert/strict';
import { SqliteStore } from '../packages/relay/dist/store/sqlite.js';
const [base,username,password,dbpath]=process.argv.slice(2);
const step=(name,ok)=>{console.log((ok?'PASS':'FAIL')+'  '+name);assert.ok(ok,name)};
const form=o=>new URLSearchParams(o);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const login=await fetch(base+'/auth/login',{method:'POST',redirect:'manual',
  headers:{'content-type':'application/x-www-form-urlencoded'},
  body:form({username,password,returnTo:'/admin'})});
const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
step('local estimate e2e login succeeds',login.status===302&&cookie.startsWith('brc_session='));
const userStore=new SqliteStore(dbpath);
const owner=userStore.getUserByName(username);
step('local estimate owner exists in test database',!!owner);
const before=userStore.mcpEstimateDays(owner.id,new Date().toISOString().slice(0,10));
const prior=before.reduce((s,row)=>s+row.reports,0);
const csrf=(await(await fetch(base+'/auth/links',{headers:{cookie}})).text()).match(/name="csrf" value="([^"]+)"/)?.[1];
const r=await fetch(base+'/auth/links',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},
  body:form({csrf,name:'mcp-visible-estimates',mode:'read',days:'1'})});
const html=await r.text();
const url=html.match(/id="new-connection-url"[^>]+value="([^"]+)"/)?.[1];
step('private link created without modifying production',!!url);
async function rpc(name,args,modelHint) {
  const headers={accept:'application/json, text/event-stream','content-type':'application/json'};
  if (modelHint) headers['x-brc-model']=modelHint;
  const response=await fetch(url,{method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',id:881,method:'tools/call',params:{name,arguments:args}})});
  const text=await response.text();
  const body=text.trim().startsWith('{')?JSON.parse(text):
    text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6))).find(x=>x.result||x.error);
  return {response,body};
}
const tool=await rpc('list_devices',{note:'Local MCP token measurement test, not ChatGPT model usage'},'gpt-4-turbo');
const fallbackTool=await rpc('list_devices',{note:'Universal fallback for an unknown AI model'},'claude-sonnet-4-5');
step('tool response returned normally before the async estimate is needed',
  tool.response.status===200&&Array.isArray(tool.body?.result?.content)&&fallbackTool.response.status===200);
let estimated,ui='';
const until=Date.now()+10000;
do {
  await sleep(220);
  const rows=userStore.mcpEstimateDays(owner.id,new Date().toISOString().slice(0,10));
  if(rows.reduce((s,row)=>s+row.reports,0)>=prior+2) {estimated=rows;break;}
}while(Date.now()<until);
step('worker stored estimated MCP tool tokens in SQLite without an explicit report',!!estimated);
step('input/output columns have nonzero BPE estimates',
  estimated.some(x=>x.input_tokens>0&&x.output_tokens>0));
step('explicit GPT model hint is encoding-matched and unknown model falls back',
  estimated.some(x=>x.matched_calls>=1&&x.universal_calls>=1));
ui=await (await fetch(base+'/admin?period=day',{headers:{cookie}})).text();
step('admin shows automatic MCP analytics independent from provider totals',
  ui.includes('Estimated MCP token traffic')&&ui.includes('TOTAL ESTIMATED MCP TOKENS')&&ui.includes('Model token analytics')&&ui.includes('GPT encoding matched')&&ui.includes('Universal fallback')&&ui.includes('Sent to agent'));
step('real provider reporting remains separate',ui.includes('Provider-reported tokens')||ui.includes('Waiting for real provider reports')||ui.includes('provider reports received'));
userStore.close();
