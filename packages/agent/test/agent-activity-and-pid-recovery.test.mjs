import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityLog,activityAction,MAX_ACTIVITY_LOG_BYTES,
  MAX_ACTIVITY_EVENT_BYTES,MAX_ACTIVITY_CONSOLE_BYTES} from '../dist/runtime/activity.js';
import {terminalManager} from '../dist/core/terminal-manager.js';
import {interactWithProcess} from '../dist/core/tools/improved-process-tools.js';

test('activity summarizes command and target without leaking arguments',()=>{
  const summary=activityAction('start_process',{
    command:"pnpm --dir 'D:\\client-project\\restaurants\\frontend' build --token=SUPERSECRET",
  });
  assert.match(summary,/pnpm build/);
  assert.match(summary,/frontend/);
  assert.doesNotMatch(summary,/SUPERSECRET|token/);
  const edit=activityAction('edit_block',{
    file_path:'D:\\custom-coding\\agent\\src\\jobs.ts',
    old_string:'private-password=SUPERSECRET',new_string:'secret',
  });
  assert.match(edit,/jobs\.ts/);
  assert.doesNotMatch(edit,/SUPERSECRET|private-password/);
  const input=activityAction('interact_with_process',{pid:3211,input:'VERYSECRET'});
  assert.equal(input,'PID 3211');
});

test('500 KiB is a bounded combined UTF-8 activity payload, PENDING is not OK',async()=>{
  assert.equal(MAX_ACTIVITY_LOG_BYTES,1024*1024);
  assert.equal(MAX_ACTIVITY_EVENT_BYTES+MAX_ACTIVITY_CONSOLE_BYTES+64*1024,MAX_ACTIVITY_LOG_BYTES);
  const logger=new ActivityLog(undefined,true);
  logger.tool('PENDING','run_command','pending-abc',1800,undefined,'pnpm build @ frontend');
  assert.equal(logger.recent().at(-1).phase,'PENDING');
  assert.match(logger.recent().at(-1).message,/PENDING.*pnpm build/);
  for(let i=0;i<9500;i++)logger.tool('OK','edit_block',String(i),i,undefined,'jobs.ts');
  const events=logger.recent();
  const size=events.reduce((sum,e)=>sum+Buffer.byteLength(JSON.stringify(e),'utf8'),0);
  assert.ok(size<=MAX_ACTIVITY_EVENT_BYTES,size);
  assert.equal(events.at(-1).id,'9499');
  assert.notEqual(events[0].id,'0');
  await logger.close();
});

test('interact_with_process returns actionable error for missing and exited PIDs',async()=>{
  const missing=await interactWithProcess({pid:2147483647,input:'hello',timeout_ms:100});
  assert.equal(missing.isError,true);
  assert.equal(missing.structuredContent.error.code,'PROCESS_NOT_ACTIVE');
  assert.equal(missing.structuredContent.commandExecuted,false);

  const finished=await terminalManager.executeCommand('node -p 42',2000,
    process.platform==='win32'?'cmd.exe':'/bin/sh');
  assert.ok(finished.pid>0,finished.output);
  const stale=await interactWithProcess({pid:finished.pid,input:'hello',timeout_ms:100});
  assert.equal(stale.isError,true);
  assert.equal(stale.structuredContent.error.code,'PROCESS_ALREADY_EXITED');
  assert.equal(stale.structuredContent.exitCode,0);
  assert.equal(stale.structuredContent.commandExecuted,false);
});