import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityLog,activityAction,formatActivityEvent,MAX_ACTIVITY_LOG_BYTES} from '../dist/runtime/activity.js';
import {mymcpCallPreview,mymcpResultPreview,MYMCP_CONSOLE_PREVIEW_BYTES}
 from '../dist/runtime/mymcp-console.js';
import {heartbeatSignature,shouldPrintHeartbeat,HEARTBEAT_IDLE_REFRESH_MS,
 LOG_HEARTBEAT_INTERVAL_MS} from '../dist/runtime/heartbeat.js';
import {recentActivity} from '../dist/terminal-ui.js';

test('shows MyMCP remote-device received message with arguments and metadata',()=>{
 const trace=mymcpCallPreview('read_multiple_files',
   {paths:['D:/project/package.json','D:/project/README.md']},
   {name:'openai-mcp',version:'1.0.0'},true);
 const ev={timestamp:'2026-11-20T03:05:33.000Z',level:'info',phase:'START',
   tool:'read_multiple_files',id:'0a95f022-0206',trace};
 const line=formatActivityEvent(ev,'mymcp',160);
 assert.match(line,/^\[\d\d:\d\d:\d\d\] 🔧 Tool call read_multiple_files started/);
 assert.match(line,/started\s+#0a95f022/);
 assert.equal(line.split('\n').length,1);
 assert.doesNotMatch(line,/paths|metadata|openai-mcp|package\.json/);
});

test('shows MyMCP completion message with bounded JSON body',()=>{
 const trace=mymcpResultPreview('list_directory',{content:[{type:'text',
   text:'[DIR] .next\n[FILE] package.json\n[FILE] README.md'}]});
 const ev={timestamp:'2026-11-20T03:05:27.000Z',level:'info',phase:'OK',
   tool:'list_directory',id:'receipt-1234',ms:5,trace};
 const line=formatActivityEvent(ev,'mymcp',160);
 assert.match(line,/^\[\d\d:\d\d:\d\d\] ✅ Tool call list_directory completed/);
 assert.match(line,/Result preview/);
 assert.match(line,/Call #receipt/);
 assert.match(line,/5ms/);
 assert.match(line,/Directory listed successfully/);
 assert.match(line,/2 files, 1 folder/);
 assert.doesNotMatch(line,/package\.json|\{\s*"content"|\\n/);
});

test('activity console emits received and completed, retains bounded events',async()=>{
 const log=new ActivityLog(undefined,false);
 log.setConsoleMode('mymcp');
 const resume=log.pauseConsole();
 try{
  log.tool('START','read_file','file-123',undefined,undefined,'read @ file.ts',undefined,
    mymcpCallPreview('read_file',{path:'file.ts'}));
  assert.equal(log.consoleQueue.length,1);
  assert.match(log.consoleQueue[0],/🔧 Tool call read_file started/);
  log.tool('OK','read_file','file-123',3,undefined,'read @ file.ts','24 lines',
    mymcpResultPreview('read_file',{content:[{type:'text',text:'export const a=1;'}]}));
  assert.equal(log.consoleQueue.length,2);
  assert.match(log.consoleQueue[1],/✅ Tool call read_file completed/);
  assert.equal(log.recent().filter(e=>e.phase).length,2);
  assert.ok(log.status().retainedBytes<MAX_ACTIVITY_LOG_BYTES);
 }finally{log.consoleQueue.length=0;log.queuedBytes=0;resume();await log.close();}
});

test('errors use the matching failed label and safe structured JSON',()=>{
 const trace=mymcpResultPreview('run_command',{
   isError:true,content:[{type:'text',text:'exit 1'}],
   structuredContent:{exitCode:1,error:{code:'COMMAND_FAILED',message:'tests failed'}}});
 const ev={timestamp:'2026-11-20T03:05:35.000Z',level:'error',phase:'ERROR',
   tool:'run_command',id:'uuid-1',ms:25,code:'COMMAND_FAILED',trace};
 const out=formatActivityEvent(ev,'mymcp',160);
 assert.match(out,/^\[\d\d:\d\d:\d\d\] ❌ Tool call run_command failed/);
 assert.match(out,/Result preview/);
 assert.match(out,/Operation failed • COMMAND_FAILED • exit 1/);
 assert.match(out,/Next: Inspect the command output returned to ChatGPT/);
 assert.doesNotMatch(out,/"content"|"exitCode"/);
});

test('JSON previews remain <= 4096 UTF-8 bytes and source actions are omitted',()=>{
 const output=mymcpResultPreview('list_directory',{content:[{type:'text',
   text:'one file\n'.repeat(1500)}]});
 assert.ok(Buffer.byteLength(output,'utf8')<=MYMCP_CONSOLE_PREVIEW_BYTES);
 assert.doesNotThrow(()=>JSON.parse(output));
 const blocked=mymcpResultPreview('code_mode',{content:[{type:'text',text:'inline body sample'}]});
 assert.doesNotMatch(blocked,/inline body sample/);
 const batch=mymcpResultPreview('read_multiple_files',
   {content:[{type:'text',text:'non-public file content'}]},
   {files:[{path:'D:/project/.env'}]});
 assert.doesNotMatch(batch,/non-public file content|D:\/project\/\.env/);
 assert.match(batch,/Files read successfully/);
 assert.match(batch,/1 file/);
});

test('heartbeat remains suppressed when idle',()=>{
 assert.equal(LOG_HEARTBEAT_INTERVAL_MS,30000);
 assert.equal(HEARTBEAT_IDLE_REFRESH_MS,300000);
 const c={online:true,connecting:false,inFlight:0};
 const s={finished:14,failed:0,lastTool:'read_file',retainedBytes:9216,
   maxRetainedBytes:512000,dropped:0};
 const old={signature:heartbeatSignature(c,s),printedAt:30000};
 assert.equal(shouldPrintHeartbeat(old,c,s,60000),false);
 assert.equal(shouldPrintHeartbeat(old,c,{...s,finished:15},90000),true);
 assert.equal(shouldPrintHeartbeat(old,c,s,330000),true);
});

test('read_multiple_files counts actual file array',()=>{
 assert.equal(activityAction('read_multiple_files',{files:[{path:'a'},{path:'b'}]}),'2 files');
 assert.equal(activityAction('read_multiple_files',{paths:['x','y','z']}),'3 files');
});

test('recent activity is compatible with received and completed labels',()=>{
 const history=[
  {timestamp:'2026-11-20T02:53:33.000Z',level:'info',phase:'START',
   tool:'read_file',id:'abc',trace:'{"path":"example"} metadata: {}'},
  {timestamp:'2026-11-20T02:53:34.000Z',level:'info',phase:'OK',
   tool:'read_file',id:'abc',trace:'{"content":[{"type":"text","text":"ok"}]}'}
 ];
 const display=recentActivity(history,50,48*1024,'mymcp');
 assert.match(display,/Tool call read_file started/);
 assert.match(display,/Tool call read_file completed/);
 assert.doesNotMatch(display,/"content":/);
});
