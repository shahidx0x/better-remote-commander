import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityLog,formatActivityEvent,MAX_ACTIVITY_LOG_BYTES,
  MAX_ACTIVITY_QUEUE_BYTES,MAX_ACTIVITY_EVENT_BYTES} from '../dist/runtime/activity.js';
import {summarizeToolOutcome} from '../dist/runtime/log-outcome.js';
import {formatHeartbeat,LOG_HEARTBEAT_INTERVAL_MS} from '../dist/runtime/heartbeat.js';

test('detailed timestamped start and completion logs include call ID and safe diagnostics',()=>{
 const start={timestamp:'2026-11-20T12:34:56.000Z',level:'info',phase:'START',
   tool:'run_command',id:'receipt-ABCDEFGH',action:'pnpm build in frontend',
   trace:'Sensitive raw output that must not appear'};
 const end={...start,phase:'OK',ms:1200,note:'exit 0'};
 const a=formatActivityEvent(start,'detailed',150);
 const b=formatActivityEvent(end,'detailed',150);
 assert.match(a,/\[START\] run_command/);
 assert.match(a,/receipt-ABCD/);
 assert.match(b,/\[OK\] run_command  1\.2s/);
 assert.match(b,/pnpm build in frontend/);
 assert.match(b,/exit 0/);
 assert.doesNotMatch(a+b,/Sensitive raw output/);
});

test('bounded activity stays under 500 KiB even with detailed output paused',async()=>{
 assert.equal(MAX_ACTIVITY_LOG_BYTES,500*1024);
 assert.equal(MAX_ACTIVITY_EVENT_BYTES+MAX_ACTIVITY_QUEUE_BYTES+32*1024,MAX_ACTIVITY_LOG_BYTES);
 const log=new ActivityLog(undefined,false);
 log.setConsoleMode('detailed');
 const resume=log.pauseConsole();
 for(let i=0;i<7000;i++){
   log.tool('START','read_file','id-'+i,undefined,undefined,'read @ src/file.ts');
   log.tool('OK','read_file','id-'+i,5,undefined,'read @ src/file.ts','2 lines');
 }
 const stats=log.status();
 assert.equal(stats.started,7000);
 assert.equal(stats.finished,7000);
 assert.equal(stats.failed,0);
 assert.ok(stats.retainedBytes<=500*1024,stats.retainedBytes);
 assert.ok(stats.historyBytes<=MAX_ACTIVITY_EVENT_BYTES);
 assert.ok(stats.queueBytes<=MAX_ACTIVITY_QUEUE_BYTES);
 assert.equal(log.rollingLines,undefined);
 assert.ok(stats.dropped>0);
 log.consoleQueue.length=0;log.queuedBytes=0;
 resume();await log.close();
});

test('30-second heartbeat is status-only and has a bounded log budget',()=>{
 assert.equal(LOG_HEARTBEAT_INTERVAL_MS,30_000);
 const line=formatHeartbeat({online:true,connecting:false,inFlight:2},
   {finished:120,failed:5,lastTool:'edit_block',retainedBytes:128*1024,
    maxRetainedBytes:500*1024,dropped:17});
 assert.match(line,/Heartbeat \| ONLINE \| active 2/);
 assert.match(line,/completed 120 \| errors 5/);
 assert.match(line,/log 128\/500 KiB/);
 assert.match(line,/evicted 17/);
 const unsafe=formatHeartbeat({online:false,connecting:false,inFlight:0},
   {finished:0,failed:0,lastTool:'password=hidden',retainedBytes:0,
    maxRetainedBytes:500*1024,dropped:0});
 assert.doesNotMatch(unsafe,/hidden/);
});

test('recent tool history has timestamp, call ID, action and failure code without raw arguments',async()=>{
 const {activity}=await import('../dist/runtime/activity.js');
 const {toolHistory}=await import('../dist/core/utils/toolHistory.js');
 activity.tool('ERROR','run_command','test-history-call-id',25,'COMMAND_FAILED',
   'pnpm test in frontend','exit 1',undefined);
 const records=await toolHistory.getRecentCalls({toolName:'run_command',maxResults:10});
 const found=records.find(r=>r.details?.callId==='test-history-cal');
 assert.ok(found,JSON.stringify(records));
 assert.deepEqual(found.arguments,{});
 assert.equal(found.details.phase,'ERROR');
 assert.equal(found.details.errorCode,'COMMAND_FAILED');
 assert.equal(found.duration,25);
 assert.match(found.details.action,/pnpm test/);
 assert.equal(toolHistory.getStats().historyFile,null);
 const formatted=await toolHistory.getRecentCallsFormatted({toolName:'run_command',maxResults:10});
 assert.ok(formatted.some(row=>typeof row.localTime==='string'&&row.localTime.length>=12));
});
test('get_recent_tool_calls pages newest-first without raw tool payloads',async()=>{
 const {activity}=await import('../dist/runtime/activity.js');
 const {handleGetRecentToolCalls}=await import('../dist/core/handlers/history-handlers.js');
 for(let i=0;i<5;i++)activity.tool('OK','sample_history_tool','page-'+i,5,
   undefined,'read /project/file.ts',undefined);
 const first=await handleGetRecentToolCalls({maxResults:2,offset:0,toolName:'sample_history_tool'});
 assert.equal(first.isError,undefined);
 assert.equal(first.structuredContent.returned,2);
 assert.equal(first.structuredContent.hasMore,true);
 assert.equal(first.structuredContent.nextOffset,2);
 assert.match(first.content[0].text,/page-4/);
 const second=await handleGetRecentToolCalls({maxResults:2,offset:2,toolName:'sample_history_tool'});
 assert.equal(second.structuredContent.returned,2);
 assert.doesNotMatch(second.content[0].text,/page-4/);
 assert.match(second.content[0].text,/page-2/);
});
test('tool outcome details use only allowlisted metadata',()=>{
 const result=summarizeToolOutcome('code_mode',{structuredContent:
   {completedCalls:50,allCallsSucceeded:false,source:'TOP SECRET',pending:false}});
 assert.match(result,/nested calls 50/);
 assert.match(result,/some calls failed/);
 assert.doesNotMatch(result,/TOP SECRET/);
 assert.equal(summarizeToolOutcome('read_file',{structuredContent:
   {read:{returnedLines:34,hasMoreLines:true},text:'private'}}),
   'lines 34 | more lines available');
});
