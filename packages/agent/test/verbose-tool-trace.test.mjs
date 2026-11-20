import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog,formatActivityEvent,
  MAX_ACTIVITY_LOG_BYTES,MAX_ACTIVITY_EVENT_BYTES,MAX_ACTIVITY_CONSOLE_BYTES } from '../dist/runtime/activity.js';
import { traceToolArguments,traceToolResult,redactTrace } from '../dist/runtime/tool-trace.js';
import { recentActivity } from '../dist/terminal-ui.js';

test('verbose mode is opt-in and returns multi-line received/completed previews', async()=>{
  const log = new ActivityLog(undefined,true);
  if(process.env.BRC_CONSOLE_MODE!=='verbose')assert.equal(log.getConsoleMode(),'compact');
  log.setConsoleMode('verbose');
  const args=traceToolArguments('start_process',{
    command:"pnpm --dir 'D:\\client-project\\restaurants\\frontend' build",
    timeout_ms:3000,verbose_timing:false,
  });
  const reply=traceToolResult('start_process',{
    content:[{type:'text',text:'Process started with PID 29620\nInitial output:\n$ tsc -p tsconfig.json\nProcess completed with exit code 0'}],
    structuredContent:{pid:29620,exitCode:0,durationMs:3350},
  });
  log.tool('START','start_process','call-test-001',undefined,undefined,'pnpm build',undefined,args);
  log.tool('OK','start_process','call-test-001',3350,undefined,'pnpm build',undefined,reply);
  const shown=log.recent().map(e=>formatActivityEvent(e,'verbose',120)).join('\n');
  assert.match(shown,/\[START\].*start_process/);
  assert.match(shown,/Arguments:/);
  assert.match(shown,/client-project/);
  assert.match(shown,/\[OK\].*start_process/);
  assert.match(shown,/29620/);
  assert.match(shown,/tsc -p tsconfig\.json/);
  assert.ok(shown.split('\n').length>=9,shown);
  const compactHistory=recentActivity(log.recent());
  assert.doesNotMatch(compactHistory,/Arguments:|Output preview/);
  await log.close();
});

test('process output preview is informative but redacts labelled credentials',()=>{
  const text=traceToolResult('read_process_output',{
    content:[{type:'text',text:'Reading 6 new lines\n' +
      'Build successful\npassword=absolutely-should-not-appear\nBearer very_secret_auth_token\nexit code 0'}],
    structuredContent:{exitCode:0},
  });
  assert.match(text,/Build successful/);
  assert.doesNotMatch(text,/absolutely-should-not-appear|very_secret_auth_token/);
  assert.match(text,/REDACTED/);
});

test('file content and edit inputs are never copied to the activity trace',()=>{
  const args=traceToolArguments('edit_block',{file_path:'D:\\repo\\src\\button.tsx',
    old_string:'secret project source text',new_string:'updated secret project source text'});
  assert.match(args,/button\.tsx/);
  assert.match(args,/\[.*omitted/);
  assert.doesNotMatch(args,/secret project source text/);
  const content=traceToolResult('read_file',{content:[{type:'text',text:'private customer record 12345'}],
    structuredContent:{path:'src/customers.txt'}});
  assert.match(content,/Response: 29 chars returned|Response: \d+ chars returned/);
  assert.doesNotMatch(content,/private customer record/);
});

test('untrusted inline scripts are not logged as raw source',()=>{
  const args=traceToolArguments('run_command',{command:'node -e "console.log(myUnlabelledSecret)"'});
  assert.match(args,/script omitted/);
  assert.doesNotMatch(args,/myUnlabelledSecret/);
  const masked=redactTrace('MONGODB_URI=mongodb://u:p@localhost/db\n--token abc-123\nAPI_KEY="hidden"');
  assert.doesNotMatch(masked,/abc-123|hidden|u:p@/);
});

test('verbose output wraps without 160-character truncation while bounded by 500 KiB', async()=>{
  const log=new ActivityLog(undefined,true);
  const text='a'.repeat(950);
  log.tool('OK','start_process','id1',200,undefined,'build',undefined,'Output preview:\n'+text);
  const event=log.recent()[0];
  const display=formatActivityEvent(event,'verbose',90);
  assert.ok(display.includes('aaaaaa'));
  assert.ok(display.replace(/\n/g,'').includes('a'.repeat(950)));
  assert.ok(display.split('\n').length>12,display);
  assert.equal(MAX_ACTIVITY_LOG_BYTES,500*1024);
  assert.equal(MAX_ACTIVITY_EVENT_BYTES+40*1024+32*1024,500*1024);
  for(let i=0;i<800;i++)log.tool('OK','run_command','id'+i,1,
    undefined,'pnpm build',undefined,'Output preview:\n'+text);
  const all=log.recent();
  assert.ok(all.length<800,'oldest events were evicted');
  assert.ok(all.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e),'utf8'),0)<=MAX_ACTIVITY_EVENT_BYTES);
  assert.equal(all.at(-1).id,'id799');
  await log.close();
});

test('paused console queue is byte-bounded, not limited to 200 activity messages',async()=>{
  const log=new ActivityLog(undefined,false);
  log.setConsoleMode('verbose');
  const resume=log.pauseConsole();
  for(let i=0;i<350;i++)log.tool('OK','read_file','item-'+i,1,undefined,'read example');
  assert.equal(log.consoleQueue.length,350);
  assert.equal(log.dropped,0);
  assert.ok(log.queuedBytes<=MAX_ACTIVITY_CONSOLE_BYTES);
  log.consoleQueue.length=0;log.queuedBytes=0;resume();await log.close();
});
