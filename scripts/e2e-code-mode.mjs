// End-to-end Code Mode over a real, throwaway relay + paired device.
// Source files are created only inside e2e-all.mjs's disposable scratch folder.
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';

const [base, username, password, scratch] = process.argv.slice(2);
if(!scratch)throw new Error('e2e-code-mode requires an isolated scratch directory.');
const fixture=path.join(scratch,'code-mode-e2e.js');
writeFileSync(fixture,'export const value = 10;\n','utf8');
const step=(name,ok,details='')=>{
 console.log((ok?'PASS':'FAIL')+'  '+name+(details?'  '+String(details).slice(0,260):''));
 assert.ok(ok,name);
};
const form=obj=>new URLSearchParams(obj);
let id=0;
async function rpc(url,method,params) {
 const response=await fetch(url,{method:'POST',headers:{
   accept:'application/json, text/event-stream','content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 const raw=await response.text();
 const messages=raw.trim().startsWith('{')?[JSON.parse(raw)]:
   raw.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
 return {status:response.status,result:messages.find(x=>x.result!==undefined||x.error!==undefined)?.result};
}
const login=await fetch(base+'/auth/login',{method:'POST',redirect:'manual',
 headers:{'content-type':'application/x-www-form-urlencoded'},
 body:form({username,password,returnTo:'/auth/links'})});
const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
step('Code Mode owner login',login.status===302&&cookie.startsWith('brc_session='));
const manager=await (await fetch(base+'/auth/links',{headers:{cookie}})).text();
const csrf=manager.match(/name="csrf" value="([^"]+)"/)?.[1];
step('Code Mode owner CSRF token available',!!csrf);
async function link(mode){
 const r=await fetch(base+'/auth/links',{method:'POST',
   headers:{cookie,'content-type':'application/x-www-form-urlencoded'},
   body:form({name:'code-mode-e2e-'+mode,mode,days:'1',csrf})});
 const html=await r.text();
 return html.match(/id="new-connection-url"[^>]+value="([^"]+)"/)?.[1]??'';
}
const fullUrl=await link('full'),readUrl=await link('read');
step('Code Mode test links created',fullUrl.includes('/c/brc_link_')&&readUrl.includes('/c/brc_link_'));
const listed=await rpc(fullUrl,'tools/list',{});
const names=(listed.result?.tools??[]).map(t=>t.name);
step('Code Mode is first in compact default catalog',listed.status===200&&names.length===15&&names[0]==='code_mode');
const readListed=await rpc(readUrl,'tools/list',{});
step('read-only MCP does not advertise Code Mode',!readListed.result?.tools?.some(t=>t.name==='code_mode'));
const rejected=await rpc(readUrl,'tools/call',{name:'code_mode',arguments:{
 source:'return await tools.call("run_command",{command:"echo NEVER"});'
}});
step('read-only MCP denies even hidden Code Mode calls',
 rejected.status===200&&rejected.result?.isError===true);

// All of the following operations go through one MCP tools/call request.
const source=[
 'const discovered=await tools.search("edit file");',
 'const schema=await tools.describe("edit_block");',
 'const before=await tools.call("read_file",{path:'+JSON.stringify(fixture)+'});',
 'const patched=await tools.call("edit_block",{',
 ' file_path:'+JSON.stringify(fixture)+',',
 ' old_string:"export const value = 10;",',
 ' new_string:"export const value = 42;"',
 '});',
 'const after=await tools.call("read_file",{path:'+JSON.stringify(fixture)+'});',
 'const verified=await tools.call("run_command",{',
 ' program:'+JSON.stringify(process.execPath)+',',
 ' args:["-e",'+JSON.stringify(
   "const s=require('node:fs').readFileSync(process.argv[1],'utf8');if(!s.includes('value = 42'))process.exit(3);process.stdout.write('VERIFIED');"
 )+','+JSON.stringify(fixture)+'],',
 ' cwd:'+JSON.stringify(scratch),
 '});',
 'return {discovered:discovered.length,schema:schema.name,',
 ' before:before.text.includes("value = 10"),after:after.text.includes("value = 42"),',
 ' exitCode:verified.structuredContent.exitCode};'
].join('\n');
const executed=await rpc(fullUrl,'tools/call',{name:'code_mode',arguments:{
 source,max_runtime_ms:45000,max_calls:9,
}});
const out=executed.result??{};
step('Code Mode performed a real edit and command through one MCP call',
 executed.status===200&&!out.isError&&out.structuredContent?.result?.after===true,
 out.content?.[0]?.text?.slice(0,300));
step('Code Mode returned actual verification exit code',
 out.structuredContent?.result?.exitCode===0 &&
 out.structuredContent?.executionCompleted===true &&
 out.structuredContent?.completedCalls===4,
 JSON.stringify(out.structuredContent?.result??{}));
step('Code Mode edited only the disposable fixture',
 existsSync(fixture)&&readFileSync(fixture,'utf8')==='export const value = 42;\n');
const pure=await rpc(fullUrl,'tools/call',{name:'code_mode',arguments:{
 source:'return {answer:6*7,process:typeof process,fetch:typeof fetch};'
}});
step('Pure Code Mode script has no Node or fetch globals',
 !pure.result?.isError && pure.result?.structuredContent?.result?.answer===42 &&
 pure.result?.structuredContent?.result?.process==='undefined' &&
 pure.result?.structuredContent?.result?.fetch==='undefined');
